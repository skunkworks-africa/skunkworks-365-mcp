# Staging setup for Cloud Manager

This runbook prepares a **controlled test environment** for the experimental Cloud Manager service. It does not attest that an Azure resource, Microsoft Entra app, public plugin, or live connection exists. Do not use this prototype with production subscriptions or customer data. The current verifier and OBO implementation need replacement or independent validation with maintained security libraries before public use.

## Prerequisites and decisions

1. Choose a non-production Microsoft Entra tenant and Azure subscription, two test users with different access, and a test virtual machine. Record their IDs in a secure operator system, not in source control. Use a user who can register applications, grant the necessary consent, and arrange the limited Azure RBAC assignments.
2. Select an operator-controlled HTTPS origin and a canonical MCP endpoint with a nonempty path and no trailing slash. The local prototype itself binds to loopback, serves plain HTTP, and deliberately refuses production mode. A real external staging endpoint requires a separately built and reviewed TLS ingress and host; **do not forward the local prototype directly to the public Internet**. A stable public HTTPS endpoint is required for eventual public submission.
3. Obtain the exact callback URI from the ChatGPT connection configuration when that connection is created. Do not invent a callback ID. A callback-specific URI and the stable callback are used in different conditions; follow the actual connection's configuration and the [OpenAI authentication guidance](https://developers.openai.com/plugins/build/auth).
4. Keep tokens, the confidential app credential, grant configuration, tenant IDs, and subscription IDs out of chat, source control, URLs, issue comments, logs and demo screenshots. Use a managed secret store for real staging and restrict operator access.

## Register the resource API

Following [Microsoft's MCP server guidance](https://learn.microsoft.com/en-us/entra/agent-id/secure-mcp-server-with-entra-id):

1. In the test tenant, register a new application **for Cloud Manager**. Select the account types appropriate for the intended test; a single test tenant is safer while validating the prototype. Record its application (client) ID and tenant ID securely.
2. Under **Expose an API**, set the Application ID URI to the *exact canonical HTTPS MCP endpoint*. Expose one delegated scope, for example `mcp.access`. Its full URI is the canonical endpoint followed by `/mcp.access`; its short claim value is `mcp.access`. The prototype expects those values to match exactly.
3. Configure v2.0 access tokens for the API according to the current Entra registration guidance. For these tokens the expected `aud` is the API application's client-ID GUID; the short delegated scope appears in `scp`.
4. For the server's on-behalf-of (OBO) call to Azure Resource Manager, configure the necessary **delegated** Azure Service Management permission and arrange the tenant's applicable consent. OBO uses the user's incoming API access token as the assertion and obtains a separate ARM token. The requested ARM default scope is `https://management.azure.com//.default`; see [OBO](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-on-behalf-of-flow) and [Microsoft's `.default` explanation](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc).
5. Provision a staging-only confidential-client credential for the API app using the organisation's security process. The prototype currently expects a secret value; this is an experimental configuration choice, not a recommendation to use long-lived secrets. Store and inject the value securely. Never paste it into chat, a checked-in file or a terminal command history.

## Register a ChatGPT OAuth client

1. Create a separate client application appropriate to the ChatGPT connection and add the **exact callback URI shown for that connection** using the platform type required by the chosen client configuration. Configure authorization code with PKCE S256 and the API's delegated scope; grant consent only where authorised. Verify the actual flow, token and client settings against [OpenAI's OAuth documentation](https://developers.openai.com/plugins/build/auth) and the [Microsoft external MCP client example](https://learn.microsoft.com/en-us/power-bi/developer/mcp/remote-mcp-server-external-clients).
2. The prototype's `CLOUD_MANAGER_ALLOWED_CLIENT_IDS` must contain the actual OAuth client's GUID observed in the verified access token's `azp` claim. Do not guess it from examples. An arbitrary Site identity or token for Microsoft Graph is not a valid OBO assertion for this API.
3. Entra Client ID Metadata Documents (CIMD) require a different authority identifier and are [public preview, with no SLA and not recommended for production](https://learn.microsoft.com/en-us/entra/agent-id/client-id-metadata-documents). The current prototype only accepts a tenant-specific or `organizations` **`/v2.0`** authority and does not implement the preview CIMD authority. The registered-client route is a test candidate, not a verified ChatGPT integration.

## Limit Azure permissions

The user's Azure RBAC permissions and the API application's delegated permission both apply; neither replaces the application's explicit grant. Start with a dedicated test user and the narrowest practical resource scope:

- VM discovery and instance view need suitable read access; for the instance view, Azure documents `Microsoft.Compute/virtualMachines/instanceView/read`. A subscription-wide VM listing may require subscription scope and can expose metadata across that subscription. Restrict access or use a narrower custom role when appropriate.
- CPU metrics need read access to the VM and its Azure Monitor metrics; see [Azure Monitor access](https://learn.microsoft.com/en-us/azure/azure-monitor/fundamentals/roles-permissions-security).
- Cost queries need read access to the selected subscription's cost scope; [Cost Management scope and billing permissions](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/understand-work-scopes) vary by agreement. Do not assign billing roles without a business need.

Do not grant Contributor or Owner simply to make read-only tests work. Create a second test user or subscription without access for negative tests.

## Configure the local experimental host

The following are configuration **names**, not values. Populate them only through an approved secure local process; do not put a real secret in a shell command, `.env` committed to Git, or a support ticket. The process must be allowed to write only within its permitted workspace and must have a route to the configured Microsoft endpoints. If credentials or network access are missing, stop at mocked tests.

| Variable | Expected input |
| --- | --- |
| `CLOUD_MANAGER_RESOURCE_URL` | Canonical HTTPS endpoint registered as the API Application ID URI. |
| `CLOUD_MANAGER_AUTHORIZATION_SERVER` | Trusted Entra tenant-specific `https://login.microsoftonline.com/<tenant-id>/v2.0` or `https://login.microsoftonline.com/organizations/v2.0`. |
| `CLOUD_MANAGER_DELEGATED_SCOPE` | Full URI `CLOUD_MANAGER_RESOURCE_URL` plus `/` and the registered short scope name. |
| `CLOUD_MANAGER_TENANT_IDS` | Explicit comma-separated tenant GUID allowlist; begin with the controlled test tenant. |
| `CLOUD_MANAGER_ALLOWED_CLIENT_IDS` | Explicit comma-separated OAuth client GUID allowlist. |
| `CLOUD_MANAGER_API_CLIENT_ID` | GUID of the Cloud Manager API application; also the expected v2 token audience. |
| `CLOUD_MANAGER_CLIENT_SECRET` | Confidential-client secret **value**, supplied by a secure runtime secret mechanism. |
| `CLOUD_MANAGER_GRANTS_JSON` | Trusted, nonempty JSON array of principal, tenant, subscription and operation grants described below. Treat the file or value as sensitive operational configuration. |
| `CLOUD_MANAGER_LOCAL_PORT` | Optional local TCP port; defaults to `8766`. |

Each grant has `issuer`, `subject`, `tenantId`, `subscriptionId`, and `operations`. The issuer is the **verified** token issuer `https://login.microsoftonline.com/<issuing-tenant-guid>/v2.0`, and `subject` must match the verified token's `sub` for this API; don't substitute a name, email, or object ID. Operations are explicitly selected from `vm.list`, `vm.instanceView`, `vm.cpu`, and `cost.query`. Capture the verified identity through a controlled secure operator process, not by copying bearer tokens into chat. Configure only intended users and scopes, and don't set wildcard grants.

Run `node src/preflight.ts` to inspect local configuration without network calls or displaying values. Exit code 1 indicates invalid local configuration; exit code 2 indicates valid local configuration while remote staging remains blocked. This checks configuration format, not live authorization or deployment readiness.

With dependencies installed using the repository lockfile and secure config supplied, launch from `cloud-manager/`:

```text
node src/local-server.ts
```

The local server is experimental, accepts connections only on `127.0.0.1`, and refuses to start with `NODE_ENV=production`. It is not a hosted or publicly usable MCP endpoint. Its canonical HTTPS URL is logical configuration for the future protected resource; no TLS termination or remote proxy is provided by this command. The separate `src/demo-server.ts` uses only synthetic data and is not evidence of a real Azure connection.

## Validation gates

1. Run `node --test test/*.test.mjs` and the repository's Cloud Manager type-check in CI. Mocked success is necessary but does not establish live interoperability.
2. After a separately secured staging deployment exists, inspect its actual protected-resource metadata and 401 challenge, verify they contain the exact endpoint, authority and delegated scope, and verify the advertised Entra metadata and PKCE S256 support. Never use Host or forwarded headers as the source of canonical OAuth metadata.
3. Perform a fresh authorization-code sign-in through the actual ChatGPT connection with a controlled user. Confirm only the correct API-audience token is accepted, consent and OBO succeed, and a read-only VM request yields the expected test data. Check CPU and cost separately; costs can be delayed or unavailable depending on billing permissions.
4. Test missing/expired/wrong-audience tokens; an unapproved client; a user with no explicit grant; a different tenant; a different subscription; missing Azure RBAC; revoked consent; and concurrent users. A denial must happen before an unauthorized Azure call. Record test evidence without credentials or sensitive output.
5. Confirm redirects and errors do not disclose tokens; set request timeouts and rate limits; add credential rotation, auditable grant lifecycle, logging without sensitive data, and isolation tests. Replace or independently validate custom token verification and OBO with supported libraries before any real customer onboarding.

Keep customer-facing publication, billing and production deployment blocked until these checks, security review, privacy/terms/support pages, and platform review requirements are satisfied.

