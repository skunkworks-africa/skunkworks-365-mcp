# Entra-protected Graph read runtime

The server implements `users_list`, `users_get`, `licenses_capacity` and `service_health`. It only issues fixed Microsoft Graph GET requests. User pages contain at most 100 records (default 50); `nextCursor` can be passed to the same tool for the next page. `users_get` requires the user's object UUID. The Graph response is projected to documented fields. License capacity is not invoice, price or contract data.

Other provider tools remain explicitly unavailable. There is no write tool. The Graph app only needs application permissions `User.Read.All`, `LicenseAssignment.Read.All` and `ServiceHealth.Read.All`, consented independently in every authorized tenant.

## Authentication and private configuration

The resource API is single-tenant and requires a v2 token for its application-ID audience, delegated `access_as_user` scope and assigned `M365.Read` role. Tokens must also contain the expected `tid` and a valid `oid`. A Graph access token is not an MCP token. App-only callers cannot bypass the delegated-scope requirement.

Use the variables in `.env.example`. `MCP_OAUTH_SCOPE` advertises the full `api://<API_CLIENT_ID>/access_as_user` scope for Entra authorization; `MCP_REQUIRED_SCOPE` checks the bare value in the token's `scp` claim. The issuer and signing-key endpoint must exactly match `MCP_ENTRA_TENANT_ID`.

For Entra users, prefer stable object-ID grants instead of pairwise token subjects:

```json
[
  {
    "issuer": "https://login.microsoftonline.com/<HOME_TENANT_GUID>/v2.0",
    "objectId": "<APPROVED_USER_OBJECT_GUID>",
    "tenants": [{ "id": "<CONSENTED_TENANT_GUID>", "name": "Approved tenant" }]
  }
]
```

Store this registry privately. The union of these grants forms the separate Graph credential allowlist; each request must first pass the individual caller's grant. A shared Graph identity can read all consenting allowlisted tenants, so the per-caller gate must remain in place. Grant changes require a process restart/revision update. Roles carried by already-issued access tokens may remain valid until expiration; remove the caller from the registry and restart for immediate server-side revocation.

## Credentials

Production uses `GRAPH_CREDENTIAL_MODE=managed-identity`. A dedicated user-assigned managed identity obtains an `api://AzureADTokenExchange` assertion, then exchanges it as the multitenant Graph app in the requested allowed tenant. No Graph client secret is needed.

After deploying `infra/main.bicep`, use its managed-identity principal output to configure the Graph application's federation through `scripts/configure-managed-identity.ps1`. Use the Graph **application object ID**, not client ID. This bootstrap uses an administrator's current Graph session and changes only that application's managed identity trust. The deployment principal needs Azure resource permissions; it does not need Entra application management permissions.

For a controlled local check, certificate mode accepts a PEM containing the certificate and private key through `GRAPH_CERTIFICATE_PATH`. Protect the file with OS permissions, never commit it or copy it into an image. With `GRAPH_TEST_TENANT_ID` set, run `npm run build` then `node scripts/smoke-graph.mjs`. It prints outcomes and counts, not user records, tokens or private keys. Remove temporary credentials after testing.

Microsoft reference: [Configure an app to trust a managed identity](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-config-app-trust-managed-identity).

## Container and Azure deployment

`Dockerfile` builds a Node.js 24 image and runs as the unprivileged `node` user. `.dockerignore` allowlists only source and build inputs, excluding credentials and registries. `package-lock.json` fixes dependencies.

`infra/main.bicep` creates a separate Consumption Container Apps environment, one app, a user-assigned managed identity and a Log Analytics workspace. The app is limited to one replica with 0.25 vCPU / 0.5 GiB and can scale to zero. HTTPS is supplied by Azure's generated endpoint; no custom domain purchase is required. The registry is injected as an Azure Container Apps secret. There are no runtime authentication secrets requiring Key Vault in this configuration; introduce Key Vault references if future integrations add credentials.

**Deploying this template incurs usage-based Azure charges.** No deployment is triggered by a pull request. Review costs and approve the cloud deployment first. Log retention is 30 days with a 1-GB daily ingestion quota; this quota and the replica limit are not a hard monetary cap. The Azure free grant is shared across the subscription and cannot be assumed unused. See [Container Apps pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/).

The manually triggered `Deploy approved runtime` workflow uses GitHub OIDC and a digest-pinned image. An existing Azure registry can be used where organization policy forbids public packages. Create separate repository-scoped push and pull tokens; never grant the runtime registry-wide write access. Store the registry server and push/pull usernames/passwords in the production environment secrets named in the workflows. The pull token is injected into Container Apps encrypted secret storage; rotate it before its expiry. Before running it:

1. Create a dedicated approved resource group. Configure an Entra deployment identity with GitHub federation for `repo:<owner>/<repository>:environment:production`, and scope its Azure Contributor role to this group.
2. Configure required reviewers and allowed branches on the GitHub `production` environment. Store `AZURE_DEPLOY_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `MCP_API_CLIENT_ID`, `GRAPH_CLIENT_ID`, and `MCP_ACCESS_REGISTRY_JSON` as environment secrets so they are masked in workflow logs. Never commit the private values.
3. Build, scan and publish the approved image; supply its immutable digest to the workflow. The PR container workflow only builds; it does not publish or deploy.
4. Deploy, then configure the managed identity trust with the separate administrator bootstrap. A health probe only verifies the process, not Graph connectivity.
5. Configure the actual MCP client's OAuth callback and its Entra client registration. Verify authorization code + PKCE, consent, token renewal, role and tenant rejection, and live tools through the deployed endpoint. No connector callback is fabricated by these scripts.

Entra is the authorization server. This server supplies protected-resource metadata and token validation, not dynamic client registration or an OAuth broker. Client compatibility must be verified with the selected connector. The existing static documentation domain is not an MCP endpoint.

## Limits and audit

The HTTP runtime rejects authenticated bodies over 64 KiB and enforces 60 requests per principal per minute per process. This limit resets after restart and is not a distributed rate limiter; use an ingress rate policy before expanding deployment. Node header and request timeouts are bounded. Audit events contain a request ID, hashed principal, RPC/tool name and HTTP status, never raw tokens, arguments or provider results. HTTP status alone is not a claim of tool success. Production audit retention, access controls and alerts still need operator validation. Graph requests time out after 15 seconds and never follow redirects.

Run `npm test` for signed-token rejection, caller grants, independent Graph allowlisting, pagination safety, read-only routes, input bounds and redacted errors. Mocked protocol tests, direct live Graph checks and a real hosted OAuth/MCP test are distinct evidence; report them separately.
