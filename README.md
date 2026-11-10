# Skunkworks 365 MCP

[![Public developer preview](https://img.shields.io/badge/status-developer_preview-146a67)](https://365-mcp.skunkworks.africa/) [![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Public source:** https://github.com/skunkworks-africa/skunkworks-365-mcp  
**Project website:** https://365-mcp.skunkworks.africa/

An independent, publicly developed Model Context Protocol (MCP) project for secure **Microsoft 365, CSP customer and licensing administration** through ChatGPT and compatible clients.

> **Current status (v0.2.0 preview):** local prototype plus protected remote resource-server code; not a deployed MCP service. **Not** a Microsoft-connected implementation or public MCP SaaS endpoint. The website is static documentation—not an MCP server.

## Download

Download the [complete source ZIP](https://github.com/skunkworks-africa/skunkworks-365-mcp/archive/refs/heads/main.zip), or clone:

```bash
git clone https://github.com/skunkworks-africa/skunkworks-365-mcp.git
cd skunkworks-365-mcp
```

## Local development

Requires **Node.js 24+**.

```bash
npm ci --ignore-scripts
cp .env.example .env
cp access-registry.example.json access-registry.json
# Edit the four example settings to match a JWT issuer you control.
# Load your .env variables in your shell (or with your preferred secret manager).
npm run build
npm test
npm start
```

The prototype binds to `http://127.0.0.1:3000/mcp`, validates a JWT bearer token with configured issuer/audience/JWKS and checks tenant grants on the server. Example values are deliberately nonfunctional. Never expose the starter directly to the internet.

### Available tool names

| Tool | Behavior |
| --- | --- |
| `tenants_list_authorized` | Lists locally configured tenant IDs for the verified principal |
| `users_list` | Bounded Graph user page when configured; otherwise `connector_unavailable` |
| `users_get` | Read one user by object UUID |
| `licenses_capacity` | Graph subscribed SKU capacity; never billing data |
| `service_health` | Microsoft 365 subscribed-service health |
| `subscriptions_list` | `connector_unavailable` |
| `billing_records` | `connector_unavailable` |
| `gdap_relationships` | `connector_unavailable` |
| `policies_list` | `connector_unavailable` |
| `applications_list` | `connector_unavailable` |

Graph remains disabled by default. [Configure the Graph runtime](docs/GRAPH-RUNTIME.md) with a separate consented application, an assigned reader role and explicit per-caller tenant grants. Partner Center, billing, policies, applications and distributor connectors remain unavailable. All tools are read-only.

## Entra authentication and remote deployment

See the [Entra identity and OAuth setup guide](docs/AUTHENTICATION.md), [Graph runtime and deployment configuration](docs/GRAPH-RUNTIME.md) and [remote deployment runbook](docs/DEPLOYMENT.md). Graph mode validates token signature, home tenant, v2 audience, expiration, delegated scope, reader role and explicit customer-tenant grants. Registration and hosting are operator-managed. Never paste private tenant IDs or credentials in public issues or GitHub source.

## Entra authentication and remote deployment

See the [Entra identity and OAuth setup guide](docs/AUTHENTICATION.md) and [remote deployment runbook](docs/DEPLOYMENT.md). Remote mode serves OAuth protected-resource metadata and validates token signature, issuer, audience, expiration, delegated scope and explicit customer-tenant grants. The Microsoft Entra application registration, compatible OAuth client configuration and live HTTPS host have **not** been provisioned. Do not paste credentials in public issues or GitHub source.

## Connecting to ChatGPT (future remote deployment)

ChatGPT on the web supports custom MCP servers through **Plugins → + → Add custom MCP server**, subject to plan and workspace permissions. Enter the **actual HTTPS MCP endpoint** provided by the hosted runtime, configure the appropriate OAuth security, review tool scopes and install the plugin. The project website URL is **not** an MCP endpoint; the local prototype is **not** ready for remote connection.

Official instructions: [Connecting custom MCP servers in ChatGPT](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt).

## CSP integration limitations

**Microsoft does not support Partner Center API access for indirect resellers.** Eligible partner-role access, Microsoft Graph delegated tenant access, distributor API authorization and customer billing access are separate concerns. [Microsoft documentation](https://learn.microsoft.com/en-us/partner-center/developer/get-started).

See [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md), [ROADMAP.md](ROADMAP.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

**Public code, private credentials.** Never submit access tokens, production tenant identifiers, customer data, invoice records or confidential contracts.

MIT licensed. Independently developed by Skunkworks Africa. Not affiliated with Microsoft or OpenAI.
