import * as core from "@actions/core";
import {
    BaseExternalAccountClient,
    ExternalAccountClient
} from "google-auth-library";

import { Inputs } from "../constants";

interface FederationConfig {
    wifProvider: string;
    serviceAccount: string;
}

/**
 * Federation inputs, or undefined when the caller did not supply any.
 *
 * Both are required together. A provider with no service account, or the
 * reverse, would otherwise fall through to ambient credentials and write the
 * bucket as whatever identity the runner happens to carry — the confusion this
 * exists to remove.
 */
function getFederationConfig(): FederationConfig | undefined {
    const wifProvider = core.getInput(Inputs.WIFProvider);
    const serviceAccount = core.getInput(Inputs.ServiceAccount);

    if (!wifProvider && !serviceAccount) {
        return undefined;
    }
    if (!wifProvider || !serviceAccount) {
        core.warning(
            "wif-provider and service-account must be set together; " +
                "falling back to ambient credentials."
        );
        return undefined;
    }
    return { wifProvider, serviceAccount };
}

/**
 * An auth client for `service-account`, obtained by exchanging this workflow
 * run's OIDC token through Workload Identity Federation. Returns undefined
 * when no federation inputs were given, which is every existing caller: the
 * Storage client then uses Application Default Credentials exactly as before.
 *
 * Built as an external account credential rather than a hand-rolled STS
 * exchange, so google-auth-library owns the token refresh and the service
 * account impersonation. `credential_source.url` is GitHub's own OIDC
 * endpoint, the same shape google-github-actions/auth writes into the
 * credentials file it exports.
 */
export function getFederatedAuthClient():
    | BaseExternalAccountClient
    | undefined {
    const config = getFederationConfig();
    if (!config) {
        return undefined;
    }

    // Only read the token endpoint once federation is actually requested. It
    // exists solely in jobs that grant `permissions: id-token: write`, so
    // reaching for it unconditionally would break every caller that does not.
    const requestUrl = process.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
    const requestToken = process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
    if (!requestUrl || !requestToken) {
        core.warning(
            "wif-provider was set but no OIDC token endpoint is available; " +
                "the job needs `permissions: id-token: write`. Falling back " +
                "to ambient credentials."
        );
        return undefined;
    }

    const audience = `//iam.googleapis.com/${config.wifProvider}`;
    try {
        const authClient = ExternalAccountClient.fromJSON({
            type: "external_account",
            audience,
            subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
            token_url: "https://sts.googleapis.com/v1/token",
            service_account_impersonation_url:
                "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" +
                `${config.serviceAccount}:generateAccessToken`,
            credential_source: {
                url: `${requestUrl}&audience=${encodeURIComponent(audience)}`,
                headers: { Authorization: `Bearer ${requestToken}` },
                format: { type: "json", subject_token_field_name: "value" }
            }
        });
        if (!authClient) {
            core.warning(
                "Could not build a federated credential; falling back to " +
                    "ambient credentials."
            );
            return undefined;
        }
        authClient.scopes = ["https://www.googleapis.com/auth/cloud-platform"];
        core.info(`Authenticating to GCS as ${config.serviceAccount}`);
        return authClient;
    } catch (error) {
        core.warning(
            `Failed to build a federated credential: ${
                (error as Error).message
            }. Falling back to ambient credentials.`
        );
        return undefined;
    }
}
