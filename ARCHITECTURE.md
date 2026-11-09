# Architecture

## Current prototype
- Local HTTP MCP server (127.0.0.1:3000/mcp), read-only tool surface.
- JWT resource validation using configured issuer, audience and HTTPS JWKS.
- Server-side grants mapping verified principals to allowed tenant IDs.
- Seven upstream data adapters deliberately return connector_unavailable.
- No customer discovery, Microsoft Graph integration, billing integration or public remote OAuth server.

## Production target
```
ChatGPT / compliant MCP clients
          │ HTTPS, OAuth 2.1 / protected resource metadata
          ▼
Authenticated MCP edge
          │ verified audience + tenant authorizations + rate limit + audit
          ▼
Tenant-scoped adapters
  ├── Microsoft Graph: users, licenses, directory/service inventory
  ├── Partner Center: only eligible partner roles and API access
  └── Distributor and accounting APIs: subscriptions, charges, invoices
```

Trust boundaries: caller tenant selection is never authorization; server resolves grants independently. Graph tokens cannot simply be reused as MCP bearer tokens. Consent, GDAP roles and commercial partner rights are separate. Avoid placing secrets and customer data in this public GitHub repository.

Reference: [MCP authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization), [Microsoft Partner Center API access](https://learn.microsoft.com/en-us/partner-center/developer/get-started).
