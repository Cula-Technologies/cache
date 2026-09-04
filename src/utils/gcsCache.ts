import * as cache from "@actions/cache";
import * as utils from "@actions/cache/lib/internal/cacheUtils";
import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import {
    createTar,
    extractTar,
    listTar
} from "@actions/cache/lib/internal/tar";
import { DownloadOptions, UploadOptions } from "@actions/cache/lib/options";
import * as core from "@actions/core";
import { Storage } from "@google-cloud/storage";
import * as path from "path";

import { CacheSource, Inputs } from "../constants";
import { getGCSBucket, getGCSBuckets, isGCSAvailable } from "./actionUtils";
import { getFederatedAuthClient } from "./federatedAuth";

const DEFAULT_PATH_PREFIX = "github-cache";

export interface RestoreResult {
    key: string;
    source: CacheSource;
}

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

export async function restoreCache(
    paths: string[],
    primaryKey: string,
    restoreKeys?: string[],
    options?: DownloadOptions,
    enableCrossOsArchive?: boolean
): Promise<RestoreResult | undefined> {
    // Check if GCS is available
    if (isGCSAvailable()) {
        try {
            const result = await restoreFromGCS(
                paths,
                primaryKey,
                restoreKeys,
                options
            );

            if (result) {
                core.info(`Cache restored from GCS with key: ${result}`);
                return { key: result, source: CacheSource.GCS };
            }

            core.info("Cache not found in GCS, falling back to GitHub cache");
        } catch (error) {
            core.warning(
                `Failed to restore from GCS: ${(error as Error).message}`
            );
            core.info("Falling back to GitHub cache");
        }
    } else {
        core.info("GCS not configured, using GitHub cache");
    }

    // Fall back to GitHub cache
    const key = await cache.restoreCache(
        paths,
        primaryKey,
        restoreKeys,
        options,
        enableCrossOsArchive
    );
    return key ? { key, source: CacheSource.GitHub } : undefined;
}

/**
 * Saves to GCS when it is configured, otherwise (or when the GCS upload
 * fails) to the GitHub cache. `fallbackToGitHub: false` is for backfilling a
 * GCS miss the GitHub cache already covered: a second GitHub save would only
 * fail on the existing entry.
 */
export async function saveCache(
    paths: string[],
    key: string,
    options?: UploadOptions,
    enableCrossOsArchive?: boolean,
    fallbackToGitHub = true
): Promise<number> {
    if (isGCSAvailable()) {
        try {
            const result = await saveToGCS(paths, key);
            if (result) {
                core.info(`Cache saved to GCS with key: [${key} | ${result}]`);
                return 1; // Success ID
            }

            core.warning("Failed to save to GCS");
        } catch (error) {
            core.warning(`Failed to save to GCS: ${(error as Error).message}`);
        }
        if (!fallbackToGitHub) {
            return -1;
        }
        core.info("Falling back to GitHub cache");
    } else {
        if (!fallbackToGitHub) {
            return -1;
        }
        core.info("GCS not configured, using GitHub cache");
    }

    // Fall back to GitHub cache
    return await cache.saveCache(paths, key, options, enableCrossOsArchive);
}

// Function that checks if the cache feature is available (either GCS or GitHub cache)
export function isFeatureAvailable(): boolean {
    return isGCSAvailable() || cache.isFeatureAvailable();
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
