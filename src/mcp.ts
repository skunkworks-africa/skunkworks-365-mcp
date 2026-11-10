import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  authorizedTenants, readTenant, tenantIdSchema, TenantAccessDenied,
  type Principal, type Grants, type Adapter, type Operation, type ReadOptions
} from './domain.js';

export function makeServer(principal: Principal, grants: Grants, adapter: Adapter, requiredScope?: string) {
  const server = new McpServer({ name: 'skunkworks-365-mcp', version: '0.2.0' });
  const result = (value: unknown, isError = false) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError
  });
  const security = requiredScope ? {
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: [requiredScope] }] }
  } : {};
  const annotations = {
    readOnlyHint: true, destructiveHint: false,
    idempotentHint: true, openWorldHint: true
  };
  server.registerTool('tenants_list_authorized', {
    description: "List tenant IDs from this identity's local access registry. Not Microsoft customer discovery.",
    inputSchema: z.object({}).strict(), annotations, ...security
  }, async () => result({
    source: 'local_access_registry',
    liveData: false,
    tenants: authorizedTenants(principal, grants)
  }));

  const operations: Operation[] = [
    'users.list', 'licenses.capacity', 'subscriptions.list',
    'billing.records', 'gdap.relationships', 'policies.list', 'applications.list', 'service.health', 'users.get'
  ];
  for (const operation of operations) {
    server.registerTool(operation.replace('.', '_'), {
      description: `Read ${operation} for an authorized tenant. Currently returns connector_unavailable; never live Microsoft data.`,
      inputSchema: z.object({ tenantId: tenantIdSchema }).strict(),
      annotations, ...security
    }, async ({ tenantId }) => {
      try { return result(await readTenant(principal, grants, tenantId, operation, adapter), true); }
      catch (error) {
        if (error instanceof TenantAccessDenied) return result({ status: 'access_denied', message: error.message }, true);
        return result({ status: 'internal_error', message: 'Provider read failed; contact the service operator.' }, true);
      }
    });
  }
  return server;
}
