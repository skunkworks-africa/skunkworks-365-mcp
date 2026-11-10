# Security policy

**This repository is a local prototype, not a production or hosted service.**

Report vulnerabilities using GitHub's private vulnerability reporting / security advisory feature if enabled, or contact the repository maintainers privately. Do not disclose a live exploit or sensitive credentials in a public issue.

Do not submit real access or refresh tokens, private keys, Entra tenant IDs, customer PII, invoices or confidential distributor information in source files, comments, issues or pull requests. Do not test on production customer environments without written authorization.

## Mandatory gates before publicly hosting the MCP runtime

- OAuth-protected resource metadata and appropriate authorization flows for clients.
- HTTPS, issuer/audience-bound access tokens, rotation, revocation and validation.
- Explicit per-principal and per-tenant authorization, consent and least-privilege roles.
- Tenant isolation, scoped adapter access and hard failure for unknown tenants.
- Approved distributor / Graph / partner permissions and commercial rights.
- Rate limits, replay controls, egress restrictions, secret management and monitoring.
- Immutable audit records and explicit human approval for every write operation.
- Threat modeling, security review and cross-tenant isolation tests.

The static GitHub Pages website contains **no private administrative API or production credentials**.

## Remote runtime security gate
The remote runtime adds OAuth resource metadata, configurable issuer/audience/scope validation, and strict inbound Host and Origin validation. Remote mode must only run behind a trusted TLS-terminating reverse proxy preserving the original Host. Prevent direct Internet access to Node's bound port; enforce network restrictions and rate limits at the edge.

Use a tenant-specific Microsoft Entra issuer and JWKS for the initial pilot. Cross-tenant sign-in requires independent issuer and signing-key issuer validation, explicit tenant onboarding and consent. Never use a tenant-independent issuer or key set as a shortcut. Production requires operational alerting, token/log redaction, revocation strategy and independent security review before real customer records are enabled.
