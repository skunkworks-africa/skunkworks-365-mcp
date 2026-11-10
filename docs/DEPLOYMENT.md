# Skunkworks 365 MCP: protected remote deployment

The GitHub Pages site https://365-mcp.skunkworks.africa is **public documentation**, not a hosted MCP runtime. This code adds protected-resource support; **no public cloud service, Microsoft Graph connection or distributor API has been deployed**.

## Build
```sh
npm install --ignore-scripts
npm test
npm start
```

See [AUTHENTICATION.md](AUTHENTICATION.md) for Entra OAuth application registration and scoped JWT configuration.

## Hosting checklist

1. Choose a **separate** HTTPS runtime endpoint (suggested `https://mcp.skunkworks.africa/mcp`, not provisioned). Configure DNS and a Node.js 24+ host or an approved container service.
2. Keep the server behind a trusted TLS-terminating ingress. Proxy the original Host header. Block direct public access to the Node.js process. Set `MCP_MODE=remote`; only then can it bind outside localhost.
3. Inject `MCP_PUBLIC_URL`, `MCP_AUTHORIZATION_SERVER`, `MCP_REQUIRED_SCOPE`, issuer, audience, JWKS URI and private access registry as environment settings/secrets. **No production tenant IDs or secrets in GitHub**.
4. Set ingress rate limits, access log token redaction, TLS renewal, monitoring, revocation strategy, backups and secret rotation before adding any customer information.
5. Verify `GET /.well-known/oauth-protected-resource`, `GET /healthz`, and `POST /mcp` returning HTTP 401 with the correct WWW-Authenticate resource metadata challenge without a token.
6. After provisioning a real identity provider, test authenticated MCP `initialize` and `tools/list` and reject unauthorized tenant requests. All seven upstream tools should still say `connector_unavailable`.
7. Confirm the actual ChatGPT OAuth authorization code / PKCE flow, permissions, renewal and disconnection against the deployed endpoint before announcing availability.

**Remaining release blockers:** Entra app registration, eligible OAuth client registration/broker, HTTPS hosting and DNS, cross-tenant authorization review, Microsoft delegated permissions, distributor data agreements and security review.
