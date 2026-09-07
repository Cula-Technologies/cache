/**
 * Trust-tier derivation for the pipeline cache buckets.
 *
 * The single source of this rule. It used to live in three places — a
 * composite action in cula-platform, a `case` in the cula/checkout fork, and
 * the IAM in cula-platform-infrastructure/projects/pipeline — of which only
 * the last is enforcement. Deriving it here means no consumer configures a
 * bucket or an identity at all: set the environment once per workflow and
 * every cache step lands in the right place.
 *
 * Getting the tier wrong fails closed rather than escalating. Each tier's
 * service account trusts only `principalSet://…/attribute.tier/<tier>`, so a
 * run asking for an identity its OIDC token does not map to is refused by
 * IAM, not silently upgraded.
 */

export type Tier = "main" | "develop" | "pr";

export interface PipelineTierConfig {
    tier: Tier;
    /** Own tier first, then the tiers it may read. */
    buckets: string[];
    wifProvider: string;
    serviceAccount: string;
}

/**
 * Which tiers a given tier may read, beyond its own.
 *
 * Mirrors TIERS.readsFrom in projects/pipeline, and the direction is the whole
 * point: reads go towards more-trusted tiers, never away from them. `pr` never
 * appears as a source, so nothing a pull request writes can reach a protected
 * branch's build.
 */
const READS_FROM: Record<Tier, Tier[]> = {
    main: ["develop"],
    develop: ["main"],
    pr: ["develop", "main"]
};

/**
 * The tier this run belongs to, from its ref.
 *
 * Mirrors the `attribute.tier` mapping on the Workload Identity Federation
 * provider. Only the two protected branches map to trusted tiers; every other
 * ref — pull request merge refs, feature branches, tags — is `pr`, and a pull
 * request cannot forge a protected-branch ref in its own token.
 */
export function getTier(ref = process.env["GITHUB_REF"] ?? ""): Tier {
    switch (ref) {
        case "refs/heads/main":
            return "main";
        case "refs/heads/develop":
            return "develop";
        default:
            return "pr";
    }
}

/**
 * The pipeline configuration for this run, or undefined when the workflow has
 * not been wired up for the tiered buckets — in which case every caller keeps
 * whatever behaviour it had before.
 *
 * All four variables are required together. A partial set would compose a
 * half-formed bucket name, or an identity with no provider to mint it, so it
 * is treated as absent rather than guessed at.
 */
export function getPipelineTierConfig(): PipelineTierConfig | undefined {
    const prefix = process.env["CULA_PIPELINE_BUCKET_PREFIX"];
    const location = process.env["CULA_PIPELINE_BUCKET_LOCATION"];
    const project = process.env["CULA_PIPELINE_PROJECT"];
    const wifProvider = process.env["CULA_PIPELINE_WIF_PROVIDER"];

    if (!prefix || !location || !project || !wifProvider) {
        return undefined;
    }

    const tier = getTier();
    const bucketFor = (t: Tier): string => `${prefix}-${t}-cache-${location}`;

    return {
        tier,
        // Own tier leads, and that ordering is load-bearing: a save writes
        // only the first bucket, so write-own-tier / read-upward falls out of
        // the list itself.
        buckets: [tier, ...READS_FROM[tier]].map(bucketFor),
        wifProvider,
        serviceAccount: `pipeline-tier-${tier}@${project}.iam.gserviceaccount.com`
    };
}
