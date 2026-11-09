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
