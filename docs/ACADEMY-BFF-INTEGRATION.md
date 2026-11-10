# Academy Entra BFF ↔ Skunkworks 365 MCP integration contract

Status: integration architecture / **not deployed**. Release gate required.

## Identity and trust boundaries

The Academy same-origin Entra BFF and the Skunkworks 365 MCP OAuth resource server have separate audiences, sessions, permissions, and responsibilities.

- Academy browser: `GET /session` at **its own origin**, with host-only Secure HttpOnly cookies. An Academy UI session authorizes only Academy UI navigation; it is **not** an MCP access token and must never be forwarded as a Microsoft Graph credential.
- Academy backend: validates the Academy session and route entitlement server-side. A future MCP orchestration backend must request a **separate** token whose `aud` targets the MCP resource. Never accept the Academy BFF cookie, Academy ID token, or Microsoft Graph token as MCP authorization.
- MCP resource server: validates JWT signature, issuer, audience, expiry, delegated scope or permitted application role, and **explicit per-principal per-customer-tenant grants**. Its `src/auth.ts` and `src/http.ts` enforce this boundary; client-provided tenant IDs do not confer permissions.
- Graph connector: uses its **own** consented application identity to call Microsoft Graph. GDAP/Partner Center procurement permissions are independent of Academy roles and customer grants.

## Identity mapping

| Record | System of record | Mapping and protection |
| --- | --- | --- |
| Academy subject | Academy identity store | Immutable internal `subject_id` mapped from Entra issuer + object ID; never join on email/UPN |
| Academy profile | Academy application or optional Dataverse profile | Link to `subject_id`; role assignments must be verified from the protected backend |
| Organisation | Approved Academy organisation registry / optional Dataverse | Immutable organisation identifier and lifecycle status; no automatic customer-tenant grant |
| Microsoft customer tenant | MCP access registry | Entra tenant ID, authorization status, caller grant, audit and expiry |
| Commercial CSP customer/subscription | Authorised Partner Center/distributor ledger | Not inferred from `/subscribedSkus` or Academy enrolment |

**Dataverse verification prerequisite:** Confirm the active Dynamics environment URL, tenant, publisher prefix, solution, existing profile/organisation table names, alternate keys and security roles using authenticated Dataverse tools. No table, row or relationship should be created before that read-only inventory and owner approval. Never equate a Sales Agent security group with a Graph admin grant.

## Approved request path

1. User authenticates to the **same-origin Academy BFF** through Entra OIDC authorization code + PKCE.
2. Application calls its own no-store `GET /session`; backend authorizes the requested UI action using stable Academy subject and roles.
3. Where a 365 action is explicitly requested, an Azure-hosted backend authorizes that distinct action and obtains a **MCP-audience token** through a separately approved delegated On-Behalf-Of or application permission flow. Never assume OBO is available from a browser session alone.
4. MCP validates its own JWT and explicit caller/customer grant, enforces rate controls, and audits correlation IDs without tokens or raw customer payloads.
5. Graph connector uses its separately consented app. No licence writes, tenant provisioning or billing changes until durable approvals, idempotency and customer authorization are implemented and independently tested.

## Release gates

- Entra app registrations have distinct API audiences, issuer validation, consent and least-privilege scopes; production secrets in Azure Key Vault.
- Same-origin Azure reverse-proxy/BFF routes, host-only cookies, callback browser binding, PKCE S256, nonce, one-time state and CSRF-protected logout verified.
- Reject wrong audience, tenant, scope, role, missing grants, expired tokens, cross-customer access, session fixation, replay and forged Origin/Host.
- Per-user and per-customer grants verified against Dataverse *only if* an explicit reviewed integration is approved; Dataverse is never a replacement for Entra authentication.
- CI tests, security checks, staging smoke tests, negative authorization tests, live deployment evidence and rollback plan documented.
- No Netlify/Vercel; GitHub Actions and Microsoft Azure resources only.

References: `docs/AUTHENTICATION.md`, `docs/GRAPH-RUNTIME.md`, Academy `docs/identity-session-contract.md`, `api/identityBffFunctions.ts`.
