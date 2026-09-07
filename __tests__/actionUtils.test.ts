import * as core from "@actions/core";

import { Events, Inputs, RefKey } from "../src/constants";
import * as actionUtils from "../src/utils/actionUtils";
import * as testUtils from "../src/utils/testUtils";

jest.mock("@actions/core");

let pristineEnv: NodeJS.ProcessEnv;

beforeAll(() => {
    pristineEnv = process.env;
    jest.spyOn(core, "getInput").mockImplementation((name, options) => {
        return jest.requireActual("@actions/core").getInput(name, options);
    });
});

beforeEach(() => {
    jest.resetModules();
    process.env = pristineEnv;
    delete process.env[Events.Key];
    delete process.env[RefKey];
});

afterAll(() => {
    process.env = pristineEnv;
});

test("isGhes returns true if server url is not github.com", () => {
    try {
        process.env["GITHUB_SERVER_URL"] = "http://example.com";
        expect(actionUtils.isGhes()).toBe(true);
    } finally {
        process.env["GITHUB_SERVER_URL"] = undefined;
    }
});

test("isGhes returns false when server url is github.com", () => {
    try {
        process.env["GITHUB_SERVER_URL"] = "http://github.com";
        expect(actionUtils.isGhes()).toBe(false);
    } finally {
        process.env["GITHUB_SERVER_URL"] = undefined;
    }
});

test("isExactKeyMatch with undefined cache key returns false", () => {
    const key = "linux-rust";
    const cacheKey = undefined;

    expect(actionUtils.isExactKeyMatch(key, cacheKey)).toBe(false);
});

test("isExactKeyMatch with empty cache key returns false", () => {
    const key = "linux-rust";
    const cacheKey = "";

    expect(actionUtils.isExactKeyMatch(key, cacheKey)).toBe(false);
});

test("isExactKeyMatch with different keys returns false", () => {
    const key = "linux-rust";
    const cacheKey = "linux-";

    expect(actionUtils.isExactKeyMatch(key, cacheKey)).toBe(false);
});

test("isExactKeyMatch with different key accents returns false", () => {
    const key = "linux-áccent";
    const cacheKey = "linux-accent";

    expect(actionUtils.isExactKeyMatch(key, cacheKey)).toBe(false);
});

test("isExactKeyMatch with same key returns true", () => {
    const key = "linux-rust";
    const cacheKey = "linux-rust";

    expect(actionUtils.isExactKeyMatch(key, cacheKey)).toBe(true);
});

test("isExactKeyMatch with same key and different casing returns true", () => {
    const key = "linux-rust";
    const cacheKey = "LINUX-RUST";

    expect(actionUtils.isExactKeyMatch(key, cacheKey)).toBe(true);
});

test("logWarning logs a message with a warning prefix", () => {
    const message = "A warning occurred.";

    const infoMock = jest.spyOn(core, "info");

    actionUtils.logWarning(message);

    expect(infoMock).toHaveBeenCalledWith(`[warning]${message}`);
});

test("isValidEvent returns false for event that does not have a branch or tag", () => {
    const event = "foo";
    process.env[Events.Key] = event;

    const isValidEvent = actionUtils.isValidEvent();

    expect(isValidEvent).toBe(false);
});

test("isValidEvent returns true for event that has a ref", () => {
    const event = Events.Push;
    process.env[Events.Key] = event;
    process.env[RefKey] = "ref/heads/feature";

    const isValidEvent = actionUtils.isValidEvent();

    expect(isValidEvent).toBe(true);
});

test("getInputAsArray returns empty array if not required and missing", () => {
    expect(actionUtils.getInputAsArray("foo")).toEqual([]);
});

test("getInputAsArray throws error if required and missing", () => {
    expect(() =>
        actionUtils.getInputAsArray("foo", { required: true })
    ).toThrowError();
});

test("getInputAsArray handles single line correctly", () => {
    testUtils.setInput("foo", "bar");
    expect(actionUtils.getInputAsArray("foo")).toEqual(["bar"]);
});

test("getInputAsArray handles multiple lines correctly", () => {
    testUtils.setInput("foo", "bar\nbaz");
    expect(actionUtils.getInputAsArray("foo")).toEqual(["bar", "baz"]);
});

test("getInputAsArray handles different new lines correctly", () => {
    testUtils.setInput("foo", "bar\r\nbaz");
    expect(actionUtils.getInputAsArray("foo")).toEqual(["bar", "baz"]);
});

test("getInputAsArray handles empty lines correctly", () => {
    testUtils.setInput("foo", "\n\nbar\n\nbaz\n\n");
    expect(actionUtils.getInputAsArray("foo")).toEqual(["bar", "baz"]);
});

test("getInputAsArray removes spaces after ! at the beginning", () => {
    testUtils.setInput(
        "foo",
        "!   bar\n!  baz\n! qux\n!quux\ncorge\ngrault! garply\n!\r\t waldo"
    );
    expect(actionUtils.getInputAsArray("foo")).toEqual([
        "!bar",
        "!baz",
        "!qux",
        "!quux",
        "corge",
        "grault! garply",
        "!waldo"
    ]);
});

test("getInputAsInt returns undefined if input not set", () => {
    expect(actionUtils.getInputAsInt("undefined")).toBeUndefined();
});

test("getInputAsInt returns value if input is valid", () => {
    testUtils.setInput("foo", "8");
    expect(actionUtils.getInputAsInt("foo")).toBe(8);
});

test("getInputAsInt returns undefined if input is invalid or NaN", () => {
    testUtils.setInput("foo", "bar");
    expect(actionUtils.getInputAsInt("foo")).toBeUndefined();
});

test("getInputAsInt throws if required and value missing", () => {
    expect(() =>
        actionUtils.getInputAsInt("undefined", { required: true })
    ).toThrowError();
});

test("getInputAsBool returns false if input not set", () => {
    expect(actionUtils.getInputAsBool("undefined")).toBe(false);
});

test("getInputAsBool returns value if input is valid", () => {
    testUtils.setInput("foo", "true");
    expect(actionUtils.getInputAsBool("foo")).toBe(true);
});

test("getInputAsBool returns false if input is invalid or NaN", () => {
    testUtils.setInput("foo", "bar");
    expect(actionUtils.getInputAsBool("foo")).toBe(false);
});

test("getInputAsBool throws if required and value missing", () => {
    expect(() =>
        actionUtils.getInputAsBool("undefined2", { required: true })
    ).toThrowError();
});

test("getGCSBucket returns gcs-bucket input when provided", () => {
    try {
        testUtils.setInput("gcs-bucket", "input-bucket");
        process.env["CULA_CACHE_GCS_BUCKET"] = "env-bucket";
        process.env["CONFIGURED_GCS_BUCKET"] = "configured-bucket";

        expect(actionUtils.getGCSBucket()).toBe("input-bucket");
    } finally {
        testUtils.clearInputs();
        delete process.env["CULA_CACHE_GCS_BUCKET"];
        delete process.env["CONFIGURED_GCS_BUCKET"];
    }
});

test("getGCSBucket falls back to CULA_CACHE_GCS_BUCKET", () => {
    try {
        process.env["CULA_CACHE_GCS_BUCKET"] = "env-bucket";

        expect(actionUtils.getGCSBucket()).toBe("env-bucket");
    } finally {
        delete process.env["CULA_CACHE_GCS_BUCKET"];
    }
});

test("getGCSBucket falls back to CONFIGURED_GCS_BUCKET", () => {
    try {
        process.env["CONFIGURED_GCS_BUCKET"] = "configured-bucket";

        expect(actionUtils.getGCSBucket()).toBe("configured-bucket");
    } finally {
        delete process.env["CONFIGURED_GCS_BUCKET"];
    }
});

test("getGCSBucket prefers CULA_CACHE_GCS_BUCKET over CONFIGURED_GCS_BUCKET", () => {
    try {
        process.env["CULA_CACHE_GCS_BUCKET"] = "env-bucket";
        process.env["CONFIGURED_GCS_BUCKET"] = "configured-bucket";

        expect(actionUtils.getGCSBucket()).toBe("env-bucket");
    } finally {
        delete process.env["CULA_CACHE_GCS_BUCKET"];
        delete process.env["CONFIGURED_GCS_BUCKET"];
    }
});

test("getGCSBucket returns empty string without input or environment variable", () => {
    try {
        testUtils.clearInputs();
        delete process.env["CULA_CACHE_GCS_BUCKET"];
        delete process.env["CONFIGURED_GCS_BUCKET"];

        expect(actionUtils.getGCSBucket()).toBe("");
    } finally {
        testUtils.clearInputs();
        delete process.env["CULA_CACHE_GCS_BUCKET"];
        delete process.env["CONFIGURED_GCS_BUCKET"];
    }
});

test("isCacheFeatureAvailable is true when a bucket is configured", () => {
    process.env["CULA_CACHE_GCS_BUCKET"] = "some-bucket";
    try {
        expect(actionUtils.isCacheFeatureAvailable()).toBe(true);
    } finally {
        delete process.env["CULA_CACHE_GCS_BUCKET"];
    }
});

test("isCacheFeatureAvailable is false, and says why, with no bucket", () => {
    // GCS is the only backend now, so this is a configuration error rather
    // than a cache-service outage. The GHES and githubstatus.com advice this
    // used to print was about GitHub's cache service, no longer consulted.
    const infoMock = jest.spyOn(core, "info");

    expect(actionUtils.isCacheFeatureAvailable()).toBe(false);
    expect(infoMock).toHaveBeenCalledWith(
        expect.stringContaining("No GCS bucket configured")
    );
});

test("isGhes returns false when the GITHUB_SERVER_URL environment variable is not defined", async () => {
    delete process.env["GITHUB_SERVER_URL"];
    expect(actionUtils.isGhes()).toBeFalsy();
});

test("isGhes returns false when the GITHUB_SERVER_URL environment variable is set to github.com", async () => {
    process.env["GITHUB_SERVER_URL"] = "https://github.com";
    expect(actionUtils.isGhes()).toBeFalsy();
});

test("isGhes returns false when the GITHUB_SERVER_URL environment variable is set to a GitHub Enterprise Cloud-style URL", async () => {
    process.env["GITHUB_SERVER_URL"] = "https://contoso.ghe.com";
    expect(actionUtils.isGhes()).toBeFalsy();
});

test("isGhes returns false when the GITHUB_SERVER_URL environment variable has a .localhost suffix", async () => {
    process.env["GITHUB_SERVER_URL"] = "https://mock-github.localhost";
    expect(actionUtils.isGhes()).toBeFalsy();
});

test("isGhes returns true when the GITHUB_SERVER_URL environment variable is set to some other URL", async () => {
    process.env["GITHUB_SERVER_URL"] = "https://src.onpremise.fabrikam.com";
    expect(actionUtils.isGhes()).toBeTruthy();
});

describe("getGCSBuckets", () => {
    afterEach(() => {
        testUtils.clearInputs();
        for (const name of [
            "CULA_CACHE_GCS_BUCKET",
            "GITHUB_REF",
            "CULA_PIPELINE_BUCKET_PREFIX",
            "CULA_PIPELINE_BUCKET_LOCATION",
            "CULA_PIPELINE_PROJECT",
            "CULA_PIPELINE_WIF_PROVIDER"
        ]) {
            delete process.env[name];
        }
    });

    test("a single bucket is unchanged", () => {
        testUtils.setInput(Inputs.GCSBuckets, "only-bucket");
        expect(actionUtils.getGCSBuckets()).toEqual(["only-bucket"]);
    });

    test("newlines and commas both separate, gs:// is stripped", () => {
        testUtils.setInput(
            Inputs.GCSBuckets,
            "  gs://own-tier\nupstream-a , gs://upstream-b \n\n"
        );
        expect(actionUtils.getGCSBuckets()).toEqual([
            "own-tier",
            "upstream-a",
            "upstream-b"
        ]);
    });

    test("repeats collapse but order survives", () => {
        // A caller composing "own tier + the tiers it reads from" can easily
        // name one of them twice.
        testUtils.setInput(Inputs.GCSBuckets, "a\nb\na");
        expect(actionUtils.getGCSBuckets()).toEqual(["a", "b"]);
    });

    test("falls back to the environment, and empty means none", () => {
        process.env["CULA_CACHE_GCS_BUCKET"] = "from-env";
        expect(actionUtils.getGCSBuckets()).toEqual(["from-env"]);
        delete process.env["CULA_CACHE_GCS_BUCKET"];
        expect(actionUtils.getGCSBuckets()).toEqual([]);
    });

    test("the deprecated singular alias is still honoured", () => {
        // Cula-Technologies/checkout passes gcs-bucket through to restore and
        // save at ~70 call sites. Dropping it would not error there — the
        // input would just be ignored — so this is the regression guard.
        testUtils.setInput(Inputs.GCSBucket, "legacy-name\nsecond");
        expect(actionUtils.getGCSBuckets()).toEqual(["legacy-name", "second"]);
    });

    test("gcs-buckets wins when both are set", () => {
        testUtils.setInput(Inputs.GCSBuckets, "new-name");
        testUtils.setInput(Inputs.GCSBucket, "old-name");
        expect(actionUtils.getGCSBuckets()).toEqual(["new-name"]);
    });

    test("the trust tier supplies the buckets when no input does", () => {
        process.env["GITHUB_REF"] = "refs/pull/9/merge";
        process.env["CULA_PIPELINE_BUCKET_PREFIX"] = "pipe";
        process.env["CULA_PIPELINE_BUCKET_LOCATION"] = "ew3";
        process.env["CULA_PIPELINE_PROJECT"] = "proj";
        process.env["CULA_PIPELINE_WIF_PROVIDER"] = "projects/1/x";

        expect(actionUtils.getGCSBuckets()).toEqual([
            "pipe-pr-cache-ew3",
            "pipe-develop-cache-ew3",
            "pipe-main-cache-ew3"
        ]);
        // A save writes the first, which is always the run's own tier.
        expect(actionUtils.getGCSBucket()).toBe("pipe-pr-cache-ew3");
    });

    test("an explicit input outranks the trust tier", () => {
        process.env["GITHUB_REF"] = "refs/heads/develop";
        process.env["CULA_PIPELINE_BUCKET_PREFIX"] = "pipe";
        process.env["CULA_PIPELINE_BUCKET_LOCATION"] = "ew3";
        process.env["CULA_PIPELINE_PROJECT"] = "proj";
        process.env["CULA_PIPELINE_WIF_PROVIDER"] = "projects/1/x";
        testUtils.setInput(Inputs.GCSBuckets, "chosen-by-hand");

        expect(actionUtils.getGCSBuckets()).toEqual(["chosen-by-hand"]);
    });

    test("the tier outranks the legacy single-bucket variable", () => {
        process.env["CULA_CACHE_GCS_BUCKET"] = "legacy";
        process.env["GITHUB_REF"] = "refs/heads/main";
        process.env["CULA_PIPELINE_BUCKET_PREFIX"] = "pipe";
        process.env["CULA_PIPELINE_BUCKET_LOCATION"] = "ew3";
        process.env["CULA_PIPELINE_PROJECT"] = "proj";
        process.env["CULA_PIPELINE_WIF_PROVIDER"] = "projects/1/x";

        expect(actionUtils.getGCSBuckets()[0]).toBe("pipe-main-cache-ew3");
    });

    test("unsetting one pipeline variable rolls back to the legacy bucket", () => {
        // This is the rollback path, so it is worth a test of its own: drop
        // the prefix and every caller returns to one bucket.
        process.env["CULA_CACHE_GCS_BUCKET"] = "legacy";
        process.env["GITHUB_REF"] = "refs/heads/main";
        process.env["CULA_PIPELINE_BUCKET_LOCATION"] = "ew3";
        process.env["CULA_PIPELINE_PROJECT"] = "proj";
        process.env["CULA_PIPELINE_WIF_PROVIDER"] = "projects/1/x";

        expect(actionUtils.getGCSBuckets()).toEqual(["legacy"]);
    });

    test("a save targets the first bucket only", () => {
        testUtils.setInput(Inputs.GCSBuckets, "own-tier\nupstream");
        expect(actionUtils.getGCSBucket()).toBe("own-tier");
    });
});
