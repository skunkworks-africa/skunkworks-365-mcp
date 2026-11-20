# Skunkworks Cloud Manager

Conversational management for Microsoft Azure. Publisher: Skunkworks.

## Status

This directory contains an early, **unconnected prototype**, not a deployable service or a public plugin. It includes experimental MCP and HTTP request handlers, an Azure Resource Manager (ARM) client, an Entra access-token verifier, on-behalf-of token exchange and explicit in-memory grants. The components can be exercised with mocked responses and locally generated test identities. It does not currently provide a hosted MCP endpoint, a configured Microsoft sign-in, customer onboarding, persistent grants, subscription billing, notifications, or infrastructure changes. No live customer access has been established or verified.

## Prototype scope

`src/arm-client.ts` contains an ARM client with methods to:

- List virtual machines in a subscription.
- Retrieve instance-view status for a named virtual machine.
- Read hourly average CPU metrics for a named virtual machine over a bounded UTC time range, when separately authorized.
- Query subscription costs over a specified date range.

The service composition connects these components using request-scoped identity and explicit grants. Configuration, the HTTP hosting boundary, and customer enrollment are not supplied. The hand-written identity verification and token exchange are experimental; production must use supported security libraries, independent review, secure credential storage and verified configuration. Do not use mocked callbacks or sample identities to grant real customer access.

Azure cost results can be delayed or revised, and access depends on the user's role and billing scope. CPU metrics preserve missing readings and should not be interpreted as a diagnosis on their own. VM, metrics and cost results indicate when a response may be incomplete; the prototype does not follow continuation links. Verify actual permissions and API behavior in a controlled test environment before relying on results.

## Tests

From this directory, with Node.js 24 installed:

```sh
node --test test/*.test.mjs
```

Tests use mock dependencies and do not establish live connectivity or verify production security.
The repository CI also runs a separate TypeScript check using its locked dependencies.

## Local synthetic demonstration

The demo starts a plain HTTP server bound **only to `127.0.0.1`**, and refuses to start when `NODE_ENV=production`. It uses a hard-coded demo token and returns fabricated data; it does not connect to Azure, Microsoft Entra or ChatGPT. Do not use it as a production server, an authentication service or evidence of live connectivity. It does not demonstrate the protected-resource metadata or the production HTTP transport.

With Node.js 24, run from this directory:

```sh
node src/demo-server.ts
```

The demonstration listens at `http://127.0.0.1:8765/mcp`. Example PowerShell request:

```powershell
$body = @{
  jsonrpc = '2.0'; id = 1; method = 'tools/call'
  params = @{
    _meta = @{ 'io.modelcontextprotocol/protocolVersion' = '2026-07-28'; 'io.modelcontextprotocol/clientCapabilities' = @{} }
    name = 'list_virtual_machines'
    arguments = @{ tenantId = '11111111-1111-4111-8111-111111111111'; subscriptionId = '22222222-2222-4222-8222-222222222222' }
  }
} | ConvertTo-Json -Depth 8
Invoke-RestMethod -Uri 'http://127.0.0.1:8765/mcp' -Method Post -ContentType 'application/json' -Headers @{ Authorization = 'Bearer demo-only-not-a-credential' } -Body $body
```

Every successful demo response carries `X-Cloud-Manager-Demo: synthetic-data-only`. The local token, tenant and subscription IDs are examples only; do not send actual Azure tokens or credentials to this demonstration. Stop the server with Ctrl+C.

## Before public release

- Configure and verify customer-specific Microsoft Entra sign-in, consent and delegated Azure access.
- Replace or validate prototype identity components with supported production libraries; implement persistent enrollment, revocation, credential protection and audit logging.
- Deploy an authenticated MCP service with appropriate OAuth discovery, and test its real ChatGPT connection.
- Validate API behavior and Azure permissions against controlled accounts, including failures, pagination and cost data freshness.
- Complete operational security review, monitoring, support, privacy and terms, and public listing and review materials.

No pricing, subscriptions, uptime commitments or Microsoft endorsement are represented by this prototype.

