/**
 * Trust-tier derivation for the pipeline cache buckets.
 *
 * The single source of this rule on the consumer side. Enforcement lives in
 * the IAM of `projects/pipeline` in cula-platform-infrastructure; deriving it
 * here means no consumer configures a bucket or an identity at all: set the
 * environment once per workflow and every cache step lands in the right place.
 *
 * Getting the tier wrong fails closed rather than escalating. Each tier's
 * service account trusts only `principalSet://…/attribute.tier/<tier>` within
 * its own pool, so a run asking for an identity its OIDC token does not map to
 * is refused by IAM, not silently upgraded.
 */

/** A tier name. Which names exist is per-repository, so this is not a union. */
export type Tier = string;

/**
 * The tier every ref that is not a protected branch maps to. Never trusted,
 * therefore never read by any other tier.
 */
const UNTRUSTED_TIER = "pr";

/**
 * cula-platform's protected branches, least to most trusted. A repository with
 * a different branch model sets CULA_PIPELINE_TRUSTED_TIERS; this default is
 * what the majority of callers want, so they set nothing.
 */
const DEFAULT_TRUSTED_TIERS = ["develop", "main"];

/** Matches `tierSaPrefix` in projects/pipeline, whose default is the same. */
const DEFAULT_SERVICE_ACCOUNT_PREFIX = "pipeline-tier";

export interface PipelineTierConfig {
    tier: Tier;
    /** Own tier first, then the tiers it may read. */
    buckets: string[];
    wifProvider: string;
    serviceAccount: string;
}

/**
 * This repository's protected branches, least to most trusted.
 *
 * Mirrors `trustedTiers` in the stack that creates the buckets. The untrusted
 * tier is filtered out rather than trusted: it is never readable, and letting a
 * typo put it here would produce a confusing 403 from IAM — which does enforce
 * the boundary — instead of the intended read chain.
 */
function getTrustedTiers(): Tier[] {
    const configured = process.env["CULA_PIPELINE_TRUSTED_TIERS"];
    const tiers = configured
        ? configured.split(",").map(tier => tier.trim())
        : DEFAULT_TRUSTED_TIERS;
    return tiers.filter(tier => tier && tier !== UNTRUSTED_TIER);
}

/**
 * The tier this run belongs to, from its ref.
 *
 * Mirrors the `attribute.tier` mapping on the Workload Identity Federation
 * provider, which is generated from the same list. Only a protected branch maps
 * to a trusted tier; every other ref — pull request merge refs, feature
 * branches, tags — is the untrusted tier, and a pull request cannot forge a
 * protected-branch ref in its own token.
 */
export function getTier(
    ref = process.env["GITHUB_REF"] ?? "",
    trustedTiers = getTrustedTiers()
): Tier {
    return (
        trustedTiers.find(tier => ref === `refs/heads/${tier}`) ??
        UNTRUSTED_TIER
    );
}

/**
 * The pipeline configuration for this run, or undefined when the workflow has
 * not been wired up for the tiered buckets — in which case every caller keeps
 * whatever behaviour it had before.
 *
 * The four variables below are required together. A partial set would compose a
 * half-formed bucket name, or an identity with no provider to mint it, so it is
 * treated as absent rather than guessed at. The two optional ones exist so a
 * second repository can share one GCP project: its identities cannot reuse the
 * default prefix, and its branch model may have fewer tiers.
 */
export function getPipelineTierConfig(): PipelineTierConfig | undefined {
    const prefix = process.env["CULA_PIPELINE_BUCKET_PREFIX"];
    const location = process.env["CULA_PIPELINE_BUCKET_LOCATION"];
    const project = process.env["CULA_PIPELINE_PROJECT"];
    const wifProvider = process.env["CULA_PIPELINE_WIF_PROVIDER"];

    if (!prefix || !location || !project || !wifProvider) {
        return undefined;
    }

    const serviceAccountPrefix =
        process.env["CULA_PIPELINE_SA_PREFIX"] ||
        DEFAULT_SERVICE_ACCOUNT_PREFIX;
    const trustedTiers = getTrustedTiers();
    const tier = getTier(undefined, trustedTiers);
    const bucketFor = (name: Tier): string =>
        `${prefix}-${name}-cache-${location}`;

    return {
        tier,
        // Own tier leads, and that ordering is load-bearing: a save writes only
        // the first bucket, so write-own-tier / read-upward falls out of the
        // list itself. A tier reads every trusted tier except itself — the same
        // one-line rule the stack derives its IAM grants from.
        buckets: [tier, ...trustedTiers.filter(name => name !== tier)].map(
            bucketFor
        ),
        wifProvider,
        serviceAccount: `${serviceAccountPrefix}-${tier}@${project}.iam.gserviceaccount.com`
    };
}
