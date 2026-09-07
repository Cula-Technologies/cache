import * as core from "@actions/core";

import { Inputs, RefKey } from "../constants";
import { getPipelineTierConfig } from "./pipelineTier";

export function isGhes(): boolean {
    const ghUrl = new URL(
        process.env["GITHUB_SERVER_URL"] || "https://github.com"
    );

    const hostname = ghUrl.hostname.trimEnd().toUpperCase();
    const isGitHubHost = hostname === "GITHUB.COM";
    const isGitHubEnterpriseCloudHost = hostname.endsWith(".GHE.COM");
    const isLocalHost = hostname.endsWith(".LOCALHOST");

    return !isGitHubHost && !isGitHubEnterpriseCloudHost && !isLocalHost;
}

export function isExactKeyMatch(key: string, cacheKey?: string): boolean {
    return !!(
        cacheKey &&
        cacheKey.localeCompare(key, undefined, {
            sensitivity: "accent"
        }) === 0
    );
}

export function logWarning(message: string): void {
    const warningPrefix = "[warning]";
    core.info(`${warningPrefix}${message}`);
}

// Cache token authorized for all events that are tied to a ref
// See GitHub Context https://help.github.com/actions/automating-your-workflow-with-github-actions/contexts-and-expression-syntax-for-github-actions#github-context
export function isValidEvent(): boolean {
    return RefKey in process.env && Boolean(process.env[RefKey]);
}

export function getInputAsArray(
    name: string,
    options?: core.InputOptions
): string[] {
    return core
        .getInput(name, options)
        .split("\n")
        .map(s => s.replace(/^!\s+/, "!").trim())
        .filter(x => x !== "");
}

export function getInputAsInt(
    name: string,
    options?: core.InputOptions
): number | undefined {
    const value = parseInt(core.getInput(name, options));
    if (isNaN(value) || value < 0) {
        return undefined;
    }
    return value;
}

export function getInputAsBool(
    name: string,
    options?: core.InputOptions
): boolean {
    const result = core.getInput(name, options);
    return result.toLowerCase() === "true";
}

/**
 * Buckets to consider, in the caller's order of preference.
 *
 * `gcs-buckets` may name several, one per line or comma separated, and when
 * it is omitted the trust tier supplies them (see ./pipelineTier). A restore
 * walks them in order; a save only ever writes the first. That is what lets a
 * caller read from buckets it may only read — a more-trusted tier's cache —
 * while writing solely to its own.
 */
export function getGCSBuckets(): string[] {
    // An explicit input wins, then this run's trust tier, then the legacy
    // single-bucket environment. That last rung is the rollback: unset
    // CULA_PIPELINE_BUCKET_PREFIX and every caller returns to one bucket
    // without touching a workflow's cache steps.
    const tiered = getPipelineTierConfig();
    const configured =
        core.getInput(Inputs.GCSBuckets) ||
        // The singular alias, for callers not yet updated — notably
        // Cula-Technologies/checkout, which passes gcs-bucket through to
        // restore and save.
        core.getInput(Inputs.GCSBucket) ||
        tiered?.buckets.join("\n") ||
        process.env["CULA_CACHE_GCS_BUCKET"] ||
        process.env["CONFIGURED_GCS_BUCKET"] ||
        "";
    const buckets = configured
        .split(/[\n,]/)
        .map(bucket => bucket.trim().replace(/^gs:\/\//, ""))
        .filter(bucket => bucket !== "");
    // Preserve order while dropping repeats: a caller composing its own tier
    // with the tiers it reads from can easily name one of them twice.
    return [...new Set(buckets)];
}

/** The single bucket a save writes to: the first the caller named. */
export function getGCSBucket(): string {
    return getGCSBuckets()[0] ?? "";
}

// Check if GCS is configured and available
export function isGCSAvailable(): boolean {
    try {
        const bucket = getGCSBucket();
        if (!bucket) {
            core.info(
                "GCS bucket name not provided, falling back to GitHub cache"
            );
            return false;
        }

        // We're not doing an actual authentication check here as it would require
        // making an API call. The Storage client will handle authentication later
        // via Application Default Credentials (ADC) which supports multiple auth methods:
        // - Service account JSON key file (GOOGLE_APPLICATION_CREDENTIALS)
        // - Workload Identity Federation
        // - Metadata server-based auth (GCE, GKE)
        // - User credentials from gcloud CLI

        core.info(`GCS bucket configured: ${bucket}`);
        return true;
    } catch (error) {
        logWarning(
            `Failed to check GCS availability: ${(error as Error).message}`
        );
        return false;
    }
}

export function isCacheFeatureAvailable(): boolean {
    if (isGCSAvailable()) {
        return true;
    }

    // GCS is the only backend, so this is a configuration error rather than a
    // service outage. The GHES and githubstatus.com advice this used to print
    // was about GitHub's cache service, which is no longer consulted.
    logWarning(
        "No GCS bucket configured: set gcs-buckets, or the CULA_PIPELINE_* " +
            "environment, or CULA_CACHE_GCS_BUCKET."
    );
    return false;
}
