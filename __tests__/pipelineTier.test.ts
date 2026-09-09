import { getPipelineTierConfig, getTier } from "../src/utils/pipelineTier";

const ENV = [
    "GITHUB_REF",
    "CULA_PIPELINE_BUCKET_PREFIX",
    "CULA_PIPELINE_BUCKET_LOCATION",
    "CULA_PIPELINE_PROJECT",
    "CULA_PIPELINE_WIF_PROVIDER",
    "CULA_PIPELINE_TRUSTED_TIERS",
    "CULA_PIPELINE_SA_PREFIX"
];

const PROVIDER =
    "projects/1/locations/global/workloadIdentityPools/github-actions/providers/github";

/** The four without which the configuration is treated as absent. */
const REQUIRED = ENV.slice(1, 5);

function configure(ref: string): void {
    process.env["GITHUB_REF"] = ref;
    process.env["CULA_PIPELINE_BUCKET_PREFIX"] = "pipe";
    process.env["CULA_PIPELINE_BUCKET_LOCATION"] = "ew3";
    process.env["CULA_PIPELINE_PROJECT"] = "proj";
    process.env["CULA_PIPELINE_WIF_PROVIDER"] = PROVIDER;
}

beforeEach(() => {
    for (const name of ENV) {
        delete process.env[name];
    }
});

describe("getTier", () => {
    test("only the protected branches map to trusted tiers", () => {
        expect(getTier("refs/heads/main")).toBe("main");
        expect(getTier("refs/heads/develop")).toBe("develop");
    });

    test("everything else is pr, including a pull request merge ref", () => {
        // The case that matters: a pull request cannot forge a
        // protected-branch ref, so it can only ever be the pr tier.
        expect(getTier("refs/pull/4287/merge")).toBe("pr");
        expect(getTier("refs/heads/feature/whatever")).toBe("pr");
        expect(getTier("refs/tags/v1.2.3")).toBe("pr");
        expect(getTier("refs/heads/mainline")).toBe("pr");
        expect(getTier("")).toBe("pr");
    });
});

describe("getPipelineTierConfig", () => {
    test("a pr run writes its own bucket and reads the trusted ones", () => {
        configure("refs/pull/1/merge");

        const config = getPipelineTierConfig();

        // Own tier first is load-bearing: a save writes only buckets[0].
        expect(config?.buckets).toEqual([
            "pipe-pr-cache-ew3",
            "pipe-develop-cache-ew3",
            "pipe-main-cache-ew3"
        ]);
        expect(config?.serviceAccount).toBe(
            "pipeline-tier-pr@proj.iam.gserviceaccount.com"
        );
        expect(config?.wifProvider).toBe(PROVIDER);
    });

    test("no tier reads the pr bucket", () => {
        for (const ref of ["refs/heads/main", "refs/heads/develop"]) {
            configure(ref);
            expect(getPipelineTierConfig()?.buckets).not.toContain(
                "pipe-pr-cache-ew3"
            );
        }
    });

    test("the two protected tiers read each other", () => {
        configure("refs/heads/main");
        expect(getPipelineTierConfig()?.buckets).toEqual([
            "pipe-main-cache-ew3",
            "pipe-develop-cache-ew3"
        ]);

        configure("refs/heads/develop");
        expect(getPipelineTierConfig()?.buckets).toEqual([
            "pipe-develop-cache-ew3",
            "pipe-main-cache-ew3"
        ]);
    });

    test("an unconfigured workflow gets nothing rather than a guess", () => {
        // Every caller that has not been wired up takes this path, and must
        // keep whatever behaviour it had.
        expect(getPipelineTierConfig()).toBeUndefined();
    });

    test.each(REQUIRED)("a partial environment is not used: %s", name => {
        configure("refs/heads/develop");
        delete process.env[name];
        // A half-set environment would compose a malformed bucket name or an
        // identity with no provider to mint it.
        expect(getPipelineTierConfig()).toBeUndefined();
    });
});

describe("a second repository sharing the project", () => {
    // The infrastructure repo: one protected branch, its own identities in the
    // same GCP project, its own WIF pool.
    function configureInfra(ref: string): void {
        configure(ref);
        process.env["CULA_PIPELINE_TRUSTED_TIERS"] = "main";
        process.env["CULA_PIPELINE_SA_PREFIX"] = "infra-tier";
    }

    test("a single trusted tier means main reads nothing but itself", () => {
        configureInfra("refs/heads/main");

        const config = getPipelineTierConfig();

        expect(config?.tier).toBe("main");
        expect(config?.buckets).toEqual(["pipe-main-cache-ew3"]);
        expect(config?.serviceAccount).toBe(
            "infra-tier-main@proj.iam.gserviceaccount.com"
        );
    });

    test("its pr tier reads up to main and nothing else", () => {
        configureInfra("refs/pull/7/merge");

        const config = getPipelineTierConfig();

        expect(config?.buckets).toEqual([
            "pipe-pr-cache-ew3",
            "pipe-main-cache-ew3"
        ]);
        // No develop bucket is probed: that domain has none, and a missing
        // bucket is indistinguishable from a cold cache, so probing one would
        // hide a misconfigured prefix rather than surface it.
        expect(config?.buckets).not.toContain("pipe-develop-cache-ew3");
        expect(config?.serviceAccount).toBe(
            "infra-tier-pr@proj.iam.gserviceaccount.com"
        );
    });

    test("develop is just another branch where it is not protected", () => {
        configureInfra("refs/heads/develop");
        expect(getTier()).toBe("pr");
    });

    test("the untrusted tier cannot be declared trusted", () => {
        configureInfra("refs/heads/main");
        process.env["CULA_PIPELINE_TRUSTED_TIERS"] = "main,pr";
        // Reading down is what the tiers exist to forbid; IAM enforces it, and
        // honouring a typo here would turn that into a confusing 403.
        expect(getPipelineTierConfig()?.buckets).not.toContain(
            "pipe-pr-cache-ew3"
        );
    });

    test("cula-platform needs neither variable to keep its three tiers", () => {
        configure("refs/pull/1/merge");

        const config = getPipelineTierConfig();

        expect(config?.buckets).toEqual([
            "pipe-pr-cache-ew3",
            "pipe-develop-cache-ew3",
            "pipe-main-cache-ew3"
        ]);
        expect(config?.serviceAccount).toBe(
            "pipeline-tier-pr@proj.iam.gserviceaccount.com"
        );
    });
});
