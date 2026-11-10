# Skunkworks 365 MCP: identity and OAuth deployment

This public GitHub project is **not** a public administrative API. Every MCP tool is authenticated and access is restricted per principal and customer tenant. The code is an **OAuth protected resource server**: it validates access tokens but does not operate an authorization server, Entra registration, user login page or Graph credentials.

## Optional admin-reviewed bootstrap script

The repository includes [`scripts/register-entra-api.ps1`](../scripts/register-entra-api.ps1), a dry-run-by-default PowerShell bootstrap for the **initial single-tenant** MCP resource API. It does not register ChatGPT as an OAuth client, generate secrets, grant consent, or configure Graph customer access.

With PowerShell 7.2+ and the Microsoft Graph modules installed on **your own administrator workstation**:

```powershell
Install-Module Microsoft.Graph.Authentication,Microsoft.Graph.Applications -Scope CurrentUser
# Read-only plan (no Microsoft sign-in or mutation):
./scripts/register-entra-api.ps1 -TenantId '<YOUR-ENTRA-TENANT-GUID>'
# Only after reviewing the plan and granting tenant-admin authorization:
./scripts/register-entra-api.ps1 -TenantId '<YOUR-ENTRA-TENANT-GUID>' -Execute
```

The execution step opens an interactive Entra sign-in and requests delegated `Application.ReadWrite.All`, a **high-privilege** Microsoft Graph permission. An eligible Entra administrator must review/consent; never run this with unattended credentials, on an untrusted machine, or from public CI. The script refuses to create an app if its display name already exists and requires an interactive high-impact PowerShell confirmation. Save the returned IDs **privately** for your runtime's secret store. Do not paste access tokens or client secrets into chat or public GitHub issues.

## Initial Microsoft Entra ID pilot: one authorized tenant

1. In the Microsoft Entra admin center, create an application registration for a **Web API** in a test tenant you administer. Begin with *single-tenant*. In **Expose an API**, configure an Application ID URI and delegated `access_as_user` scope.
2. Record your Entra **Tenant ID**, API **Application (client) ID**, and delegated scope. Access tokens for this API must have the expected audience (`aud`) and scope (`scp`). A Graph access token cannot be reused as an MCP access token.
3. Approve/register the **ChatGPT OAuth client** with the redirect URI and authentication method the ChatGPT Plugins setup provides. Entra does not automatically support MCP client ID metadata document registration or DCR; a predefined client or compliant OAuth broker may be required. Do not assume direct Entra sign-in will work until tested.
4. Supply these private runtime variables through a secret manager (never commit tenant IDs, tokens or credentials):

```dotenv
MCP_MODE=remote
MCP_PUBLIC_URL=https://mcp.your-domain.example/mcp
MCP_AUTHORIZATION_SERVER=https://login.microsoftonline.com/<TENANT_ID>/v2.0
MCP_TOKEN_ISSUER=https://login.microsoftonline.com/<TENANT_ID>/v2.0
MCP_JWKS_URL=https://login.microsoftonline.com/<TENANT_ID>/discovery/v2.0/keys
MCP_TOKEN_AUDIENCE=<API_APPLICATION_CLIENT_ID_OR_API_IDENTIFIER_URI>
MCP_REQUIRED_SCOPE=access_as_user
MCP_ACCESS_REGISTRY=/run/secrets/access-registry.json
PORT=3000
```

5. Store explicit allowed `issuer` + `subject` -> `tenants` mappings in the server-side access registry. An authenticated user is not automatically permitted to see every customer.
6. Configure HTTPS termination, trusted proxy, audit and rate controls. Run with only test tenant grants. Keep provider connectors unavailable until actual Microsoft Graph/GDAP and distributor consent is provisioned.
7. Test `GET /.well-known/oauth-protected-resource`, unauthenticated `POST /mcp` (401 with WWW-Authenticate), valid and expired tokens, wrong audience, missing delegated scope and denial of a different customer tenant.

## ChatGPT OAuth compatibility

ChatGPT requires the MCP authorization protocol, including resource discovery, authorization code with PKCE, and a suitable authorization server/client registration. This repository provides **resource-server discovery and bearer validation only**. Microsoft Entra's direct OAuth endpoints may not offer all expected MCP features (e.g. Resource Indicators and client registration). Use an MCP-compatible broker or predefined client if necessary. Test actual ChatGPT token acquisition and renewal before declaring production readiness.

## Multi-tenant rollout

Publicly developed source can serve organizations independently. Cross-organization sign-in needs validated per-tenant issuers/signing keys, consent onboarding and access grants. **Never** accept a `common` issuer as a substitute for issuer validation: Microsoft's tenant-independent keys require signing-key issuer validation. Start with a single-tenant pilot; add independently reviewed federation later.

References: [MCP authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization), [Microsoft access-token validation](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens), [OpenAI OAuth plugin guide](https://developers.openai.com/plugins/build/auth).
