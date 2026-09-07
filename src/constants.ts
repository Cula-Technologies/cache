export enum Inputs {
    Key = "key", // Input for cache, restore, save action
    Path = "path", // Input for cache, restore, save action
    RestoreKeys = "restore-keys", // Input for cache, restore action
    UploadChunkSize = "upload-chunk-size", // Input for cache, save action
    EnableCrossOsArchive = "enableCrossOsArchive", // Input for cache, restore, save action
    FailOnCacheMiss = "fail-on-cache-miss", // Input for cache, restore action
    LookupOnly = "lookup-only", // Input for cache, restore action
    GCSBuckets = "gcs-buckets", // Input for cache, restore, save action
    // Superseded by GCSBuckets; still read so existing callers, and
    // Cula-Technologies/checkout, keep working.
    GCSBucket = "gcs-bucket", // Deprecated alias of GCSBuckets
    GCSPathPrefix = "gcs-path-prefix", // Input for cache, restore, save action
    WIFProvider = "wif-provider", // Input for cache, restore, save action
    ServiceAccount = "service-account" // Input for cache, restore, save action
}

export enum Outputs {
    CacheHit = "cache-hit", // Output from cache, restore action
    CachePrimaryKey = "cache-primary-key", // Output from restore action
    CacheMatchedKey = "cache-matched-key" // Output from restore action
}

export enum State {
    CachePrimaryKey = "CACHE_KEY",
    CacheMatchedKey = "CACHE_RESULT",
    // The resolved `path` input, newline-separated. A composite action's post
    // step cannot see sibling step outputs, so `path: ${{ steps.x.outputs.y }}`
    // arrives empty there; the save falls back to what restore saw.
    CachePaths = "CACHE_PATHS"
}

export enum Events {
    Key = "GITHUB_EVENT_NAME",
    Push = "push",
    PullRequest = "pull_request"
}

export const RefKey = "GITHUB_REF";
