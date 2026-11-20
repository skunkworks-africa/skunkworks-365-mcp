# Skunkworks Cloud Manager

Conversational management for Microsoft Azure. Publisher: Skunkworks.

## Status

This directory contains an early, **unconnected prototype**, not a deployable service or a public plugin. It includes experimental MCP and HTTP request handlers, an Azure Resource Manager (ARM) client, an Entra access-token verifier, on-behalf-of token exchange and explicit in-memory grants. The components can be exercised with mocked responses and locally generated test identities. It does not currently provide a hosted MCP endpoint, a configured Microsoft sign-in, customer onboarding, persistent grants, subscription billing, notifications, or infrastructure changes. No live customer access has been established or verified.

## Prototype scope

`src/arm-client.ts` contains an ARM client with methods to:

- List virtual machines in a subscription.
- Retrieve instance-view status for a named virtual machine.
- Query subscription costs over a specified date range.

The service composition connects these components using request-scoped identity and explicit grants. Configuration, the HTTP hosting boundary, and customer enrollment are not supplied. The hand-written identity verification and token exchange are experimental; production must use supported security libraries, independent review, secure credential storage and verified configuration. Do not use mocked callbacks or sample identities to grant real customer access.

Azure cost results can be delayed or revised, and access depends on the user's role and billing scope. VM and cost results indicate when a response may be incomplete; the prototype does not follow continuation links. Verify actual permissions and API behavior in a controlled test environment before relying on results.

## Tests

From this directory, with Node.js 24 installed:

```sh
node --test test/*.test.mjs
```

Tests use mock dependencies and do not establish live connectivity or verify production security.

## Before public release

- Configure and verify customer-specific Microsoft Entra sign-in, consent and delegated Azure access.
- Replace or validate prototype identity components with supported production libraries; implement persistent enrollment, revocation, credential protection and audit logging.
- Deploy an authenticated MCP service with appropriate OAuth discovery, and test its real ChatGPT connection.
- Validate API behavior and Azure permissions against controlled accounts, including failures, pagination and cost data freshness.
- Complete operational security review, monitoring, support, privacy and terms, and public listing and review materials.

No pricing, subscriptions, uptime commitments or Microsoft endorsement are represented by this prototype.

