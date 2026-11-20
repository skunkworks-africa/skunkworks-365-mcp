# Skunkworks Cloud Manager

Conversational management for Microsoft Azure. Publisher: Skunkworks.

## Status

This directory contains an early, **unconnected prototype**, not a deployable service or a public plugin. Its read-only Azure Resource Manager (ARM) client can be exercised with mocked responses. It does not currently provide a ChatGPT or Model Context Protocol (MCP) endpoint, Microsoft sign-in, customer onboarding, persistent grants, subscription billing, notifications, or infrastructure changes. No live customer access has been established or verified.

## Prototype scope

`src/arm-client.ts` contains an ARM client with methods to:

- List virtual machines in a subscription.
- Retrieve instance-view status for a named virtual machine.
- Query subscription costs over a specified date range.

The client accepts an authorization callback and a delegated-token provider supplied by its host. **These are interfaces, not an authentication or authorization implementation.** The host must validate each caller and token, verify tenant and subscription grants, and acquire appropriately scoped delegated credentials before using the client. Do not use mocked callbacks or sample identities to grant real customer access.

Azure cost results can be delayed or revised, and access depends on the user's role and billing scope. VM and cost results indicate when a response may be incomplete; the prototype does not follow continuation links. Verify actual permissions and API behavior in a controlled test environment before relying on results.

## Tests

From this directory, with Node.js 24 installed:

```sh
node --test test/*.test.mjs
```

Tests use mock dependencies and do not establish live connectivity or verify production security.

## Before public release

- Implement and verify customer-specific Microsoft Entra sign-in, consent and delegated Azure access.
- Enforce and test caller, tenant and subscription isolation; handle revocation, credential protection and audit logging.
- Implement and test the authenticated MCP service and its real ChatGPT connection.
- Validate API behavior and Azure permissions against controlled accounts, including failures, pagination and cost data freshness.
- Complete operational security review, monitoring, support, privacy and terms, and public listing and review materials.

No pricing, subscriptions, uptime commitments or Microsoft endorsement are represented by this prototype.

