import * as utils from "@actions/cache/lib/internal/cacheUtils";
import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import {
    createTar,
    extractTar,
    listTar
} from "@actions/cache/lib/internal/tar";
import { DownloadOptions } from "@actions/cache/lib/options";
import * as core from "@actions/core";
import { Storage } from "@google-cloud/storage";
import * as path from "path";

import { Inputs } from "../constants";
import { getGCSBucket, getGCSBuckets, isGCSAvailable } from "./actionUtils";
import { getFederatedAuthClient } from "./federatedAuth";

const DEFAULT_PATH_PREFIX = "github-cache";

// Initializes the GCS client. Uses Application Default Credentials unless
// wif-provider and service-account were given, in which case the run
// federates into that service account instead — which is how a bucket that
// grants no access to the runner's own identity becomes writable.
function getGCSClient(): Storage | null {
    try {
        core.info("Initializing GCS client");
        const authClient = getFederatedAuthClient();
        return authClient ? new Storage({ authClient }) : new Storage();
    } catch (error) {
        core.warning(
            `Failed to initialize GCS client: ${(error as Error).message}`
        );
        return null;
    }
}

/**
 * The key constraints @actions/cache enforced. They came with GitHub's cache
 * API, and removing that backend removed the only code that checked them —
 * but two still earn their place here: a comma would collide with the
 * separator `gcs-buckets` uses, and the restore-key limit bounds a prefix
 * scan that now runs once per bucket in the read chain rather than once.
 */
const MAX_KEY_LENGTH = 512;
const MAX_RESTORE_KEYS = 10;

function validateKeys(keys: string[]): void {
    if (keys.length > MAX_RESTORE_KEYS) {
        throw new Error(
            `Key Validation Error: Keys are limited to a maximum of ${MAX_RESTORE_KEYS}.`
        );
    }
    for (const key of keys) {
        if (key.length > MAX_KEY_LENGTH) {
            throw new Error(
                `Key Validation Error: ${key} cannot be larger than ${MAX_KEY_LENGTH} characters.`
            );
        }
        if (key.includes(",")) {
            throw new Error(
                `Key Validation Error: ${key} cannot contain commas.`
            );
        }
    }
}

/**
 * Restores from GCS. There is deliberately no GitHub Actions cache fallback:
 * an entry here is 0.5–1.6 GiB against a 10 GB repo-wide quota, so falling
 * back cannot hold the working set, and an entry that lands there is served to
 * later jobs in preference — meaning GCS never receives the key at all.
 *
 * A miss returns undefined, which is ordinary: the caller does the work and
 * saves. A transport failure is a different thing and fails the step, because
 * a cache that silently stopped working is the expensive kind of broken.
 */
export async function restoreCache(
    paths: string[],
    primaryKey: string,
    restoreKeys?: string[],
    options?: DownloadOptions
): Promise<string | undefined> {
    validateKeys([primaryKey, ...(restoreKeys ?? [])]);

    if (!isGCSAvailable()) {
        core.setFailed(
            "No GCS bucket configured: set gcs-buckets, or the " +
                "CULA_PIPELINE_* environment, or CULA_CACHE_GCS_BUCKET."
        );
        return undefined;
    }

    try {
        const result = await restoreFromGCS(
            paths,
            primaryKey,
            restoreKeys,
            options
        );

        if (result) {
            core.info(`Cache restored from GCS with key: ${result}`);
            return result;
        }

        core.info("Cache not found in GCS");
        return undefined;
    } catch (error) {
        core.setFailed(
            `Failed to restore from GCS: ${(error as Error).message}`
        );
        return undefined;
    }
}

/**
 * Saves to GCS. No GitHub Actions cache fallback, for the reasons on
 * restoreCache — and one more on this side: a fallback reports success from
 * the wrong destination, so a broken configuration looks green.
 *
 * A failure fails the step. That does mean a transient GCS outage reddens an
 * otherwise good build; the alternative is a cache that quietly stopped being
 * written, which costs far more and for far longer. A caller that would rather
 * absorb it can set `continue-on-error` on the step.
 */
export async function saveCache(paths: string[], key: string): Promise<number> {
    validateKeys([key]);

    if (!isGCSAvailable()) {
        core.setFailed(
            "No GCS bucket configured: set gcs-buckets, or the " +
                "CULA_PIPELINE_* environment, or CULA_CACHE_GCS_BUCKET."
        );
        return -1;
    }

    try {
        const result = await saveToGCS(paths, key);
        if (result) {
            core.info(`Cache saved to GCS with key: [${key} | ${result}]`);
            return 1; // Success ID
        }
        core.setFailed("Failed to save to GCS");
        return -1;
    } catch (error) {
        core.setFailed(`Failed to save to GCS: ${(error as Error).message}`);
        return -1;
    }
}

/** GCS is the only backend, so this is simply whether it is configured. */
export function isFeatureAvailable(): boolean {
    return isGCSAvailable();
}

async function restoreFromGCS(
    _paths: string[], // validate paths?
    primaryKey: string,
    restoreKeys: string[] = [],
    options?: DownloadOptions
): Promise<string | undefined> {
    const storage = getGCSClient();
    if (!storage) {
        return undefined;
    }

    const buckets = getGCSBuckets();
    const pathPrefix =
        core.getInput(Inputs.GCSPathPrefix) || DEFAULT_PATH_PREFIX;
    const compressionMethod = await utils.getCompressionMethod();

    const archiveFolder = await utils.createTempDirectory();
    const archivePath = path.join(
        archiveFolder,
        utils.getCacheFileName(compressionMethod)
    );

    const keys = [primaryKey, ...restoreKeys];
    const match = await findFileOnGCS(
        storage,
        buckets,
        pathPrefix,
        keys,
        compressionMethod
    );

    if (!match) {
        core.info(`No matching cache found`);
        return undefined;
    }

    // Preserve the @actions/cache contract: return the matched cache KEY
    // (primaryKey or a restoreKey), not the GCS object path. The caller
    // (restoreImpl) compares the return value against primaryKey to set the
    // `cache-hit` output — returning the gcs path makes `cache-hit` always
    // false, re-triggering downstream install/build steps that gate on it.
    const { key: matchedKey, path: gcsPath, bucket } = match;

    // If lookup only, just return the key
    if (options?.lookupOnly) {
        core.info(`Cache found in GCS with key: ${matchedKey}`);
        return matchedKey;
    }

    try {
        core.info(`Downloading from GCS: ${bucket}/${gcsPath}`);
        const file = storage.bucket(bucket).file(gcsPath);
        await file.download({ destination: archivePath });

        if (core.isDebug()) {
            await listTar(archivePath, compressionMethod);
        }

        const archiveFileSize = utils.getArchiveFileSizeInBytes(archivePath);
        core.info(
            `Cache Size: ~${Math.round(
                archiveFileSize / (1024 * 1024)
            )} MB (${archiveFileSize} B)`
        );

        await extractTar(archivePath, compressionMethod);
        core.info("Cache restored successfully");

        return matchedKey;
    } catch (error) {
        core.warning(`Failed to restore: ${(error as Error).message}`);
    } finally {
        try {
            await utils.unlinkFile(archivePath);
        } catch (error) {
            core.debug(`Failed to delete archive: ${error}`);
        }
    }
}

function getGCSPath(
    pathPrefix: string,
    key: string,
    compressionMethod: CompressionMethod
): string {
    return `${pathPrefix}/${key}.${utils.getCacheFileName(compressionMethod)}`;
}

async function saveToGCS(
    paths: string[],
    key: string
): Promise<string | undefined> {
    const storage = getGCSClient();
    if (!storage) {
        return undefined;
    }

    const bucket = getGCSBucket();
    const pathPrefix =
        core.getInput(Inputs.GCSPathPrefix) || DEFAULT_PATH_PREFIX;
    const compressionMethod = await utils.getCompressionMethod();

    const cachePaths = await utils.resolvePaths(paths);
    core.debug("Cache Paths:");
    core.debug(`${JSON.stringify(cachePaths)}`);

    if (cachePaths.length === 0) {
        throw new Error(
            `Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.`
        );
    }

    // Skip a key the bucket already holds, before paying for the tar.
    //
    // GitHub's own cache backend refuses to overwrite an existing key, so a
    // repeat save of one was never meant to transfer anything; on GCS it
    // silently re-uploaded instead. Skipping matches that behaviour, and it is
    // required on a write-once bucket — objectCreator without objects.delete —
    // where GCS rejects the overwrite outright and every repeat save fails on
    // an entry that was already there.
    const gcsPath = getGCSPath(pathPrefix, key, compressionMethod);
    if (await checkFileExists(storage, bucket, gcsPath)) {
        core.info(
            `Cache already exists at ${bucket}/${gcsPath}; not uploading`
        );
        return gcsPath;
    }

    const archiveFolder = await utils.createTempDirectory();
    const archivePath = path.join(
        archiveFolder,
        utils.getCacheFileName(compressionMethod)
    );

    core.debug(`Archive Path: ${archivePath}`);

    try {
        await createTar(archiveFolder, cachePaths, compressionMethod);
        if (core.isDebug()) {
            await listTar(archivePath, compressionMethod);
        }

        core.info(`Uploading to GCS: ${bucket}/${gcsPath}`);
        const [file] = await storage.bucket(bucket).upload(archivePath, {
            destination: gcsPath,
            resumable: false
        });

        return file.metadata.id;
    } catch (error) {
        core.warning(
            `Error creating or uploading cache: ${(error as Error).message}`
        );
        throw new Error(
            `Error creating or uploading cache: ${(error as Error).message}`
        );
    } finally {
        try {
            await utils.unlinkFile(archivePath);
        } catch (error) {
            core.debug(`Failed to delete archive: ${error}`);
        }
    }
}

async function findFileOnGCS(
    storage: Storage,
    buckets: string[],
    pathPrefix: string,
    keys: string[],
    compressionMethod: CompressionMethod
): Promise<{ key: string; path: string; bucket: string } | undefined> {
    const [primaryKey, ...restoreKeys] = keys;
    const fileName = utils.getCacheFileName(compressionMethod);

    // Key quality outranks bucket order, hence the loop nesting: every bucket
    // is tried for the primary key before any bucket is tried for a restore
    // key. An exact match is the content the caller asked for; a prefix match
    // is something older. Preferring the earlier bucket instead would restore
    // a stale entry from it while an exact one sat in the next.

    // Primary key: exact match only. The `cache-hit` output compares the
    // returned key against the primary key, so a prefix match here would
    // report false hits.
    const primaryPath = getGCSPath(pathPrefix, primaryKey, compressionMethod);
    for (const bucket of buckets) {
        if (await checkFileExists(storage, bucket, primaryPath)) {
            core.info(
                `Found file on bucket: ${bucket} with key: ${primaryPath}`
            );
            return { key: primaryKey, path: primaryPath, bucket };
        }
    }

    // Restore keys: prefix match, newest entry wins — mirrors the
    // actions/cache restore-keys contract that callers rely on for rolling
    // caches (e.g. `nx-` matching `nx-<sha>` saved by an earlier run).
    for (const key of restoreKeys) {
        for (const bucket of buckets) {
            const [files] = await storage
                .bucket(bucket)
                .getFiles({ prefix: `${pathPrefix}/${key}` });
            const newest = files
                .filter(file => file.name.endsWith(`.${fileName}`))
                .sort(
                    (a, b) =>
                        new Date(b.metadata.updated ?? 0).getTime() -
                        new Date(a.metadata.updated ?? 0).getTime()
                )[0];

            if (newest) {
                const matchedKey = newest.name.slice(
                    pathPrefix.length + 1,
                    -(fileName.length + 1)
                );
                core.info(
                    `Found file on bucket: ${bucket} with key: ${newest.name}`
                );
                return { key: matchedKey, path: newest.name, bucket };
            }
        }
    }
    return undefined;
}

async function checkFileExists(
    storage: Storage,
    bucket: string,
    path: string
): Promise<boolean> {
    const [exists] = await storage.bucket(bucket).file(path).exists();
    return exists;
}
