import * as core from "@actions/core";

import { getFederatedAuthClient } from "../src/utils/federatedAuth";

// core.getInput reads INPUT_<NAME>, so the env is the honest way to drive
// these branches — no mock can disagree with the real input plumbing.
const PROVIDER =
    "projects/1/locations/global/workloadIdentityPools/pool/providers/gh";
const SERVICE_ACCOUNT = "tier@example.iam.gserviceaccount.com";

const OIDC_VARS = [
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN"
];
const TIER_VARS = [
    "GITHUB_REF",
    "CULA_PIPELINE_BUCKET_PREFIX",
    "CULA_PIPELINE_BUCKET_LOCATION",
    "CULA_PIPELINE_PROJECT",
    "CULA_PIPELINE_WIF_PROVIDER"
];
const INPUT_VARS = ["INPUT_WIF-PROVIDER", "INPUT_SERVICE-ACCOUNT"];

let warning: jest.SpyInstance;

beforeEach(() => {
    for (const name of [...OIDC_VARS, ...INPUT_VARS, ...TIER_VARS]) {
        delete process.env[name];
    }
    warning = jest.spyOn(core, "warning").mockImplementation(() => undefined);
    jest.spyOn(core, "info").mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

function withOidcEndpoint(): void {
    process.env["ACTIONS_ID_TOKEN_REQUEST_URL"] =
        "https://token.example/?api-version=1";
    process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "request-token";
}

test("no federation inputs leaves existing callers on ambient credentials", () => {
    expect(getFederatedAuthClient()).toBeUndefined();
    // Silence matters as much as the return value: every current caller takes
    // this path and must not start emitting warnings.
    expect(warning).not.toHaveBeenCalled();
});

test("one federation input without the other warns instead of half-federating", () => {
    process.env["INPUT_WIF-PROVIDER"] = PROVIDER;
    expect(getFederatedAuthClient()).toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("must be set together")
    );
});

test("federation without id-token permission falls back rather than throwing", () => {
    process.env["INPUT_WIF-PROVIDER"] = PROVIDER;
    process.env["INPUT_SERVICE-ACCOUNT"] = SERVICE_ACCOUNT;
    expect(getFederatedAuthClient()).toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("id-token: write")
    );
});

test("both inputs plus an OIDC endpoint build an impersonating client", () => {
    process.env["INPUT_WIF-PROVIDER"] = PROVIDER;
    process.env["INPUT_SERVICE-ACCOUNT"] = SERVICE_ACCOUNT;
    withOidcEndpoint();

    const client = getFederatedAuthClient();
    expect(client).toBeDefined();
    expect(client?.scopes).toEqual([
        "https://www.googleapis.com/auth/cloud-platform"
    ]);
    expect(warning).not.toHaveBeenCalled();
});

describe("identity from the trust tier", () => {
    function configureTier(): void {
        process.env["GITHUB_REF"] = "refs/heads/develop";
        process.env["CULA_PIPELINE_BUCKET_PREFIX"] = "pipe";
        process.env["CULA_PIPELINE_BUCKET_LOCATION"] = "ew3";
        process.env["CULA_PIPELINE_PROJECT"] = "proj";
        process.env["CULA_PIPELINE_WIF_PROVIDER"] = PROVIDER;
    }

    test("with no inputs, the tier supplies the identity", () => {
        configureTier();
        withOidcEndpoint();

        // This is the path every call site takes now: the tier buckets grant
        // the runner's ambient identity nothing, so a run must federate, and
        // only the environment says as whom.
        const client = getFederatedAuthClient();

        expect(client).toBeDefined();
        expect(warning).not.toHaveBeenCalled();
    });

    test("explicit inputs still outrank the tier", () => {
        configureTier();
        withOidcEndpoint();
        process.env["INPUT_WIF-PROVIDER"] = PROVIDER;
        process.env["INPUT_SERVICE-ACCOUNT"] =
            "chosen@example.iam.gserviceaccount.com";

        expect(getFederatedAuthClient()).toBeDefined();
        expect(warning).not.toHaveBeenCalled();
    });

    test("the tier without an OIDC endpoint falls back, loudly", () => {
        configureTier();

        expect(getFederatedAuthClient()).toBeUndefined();
        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining("id-token: write")
        );
    });
});
