import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  authorizedTenants, readTenant, tenantIdSchema, TenantAccessDenied,
  type Principal, type Grants, type Adapter, type Operation, type ReadOptions
} from './domain.js';

export function makeServer(principal: Principal, grants: Grants, adapter: Adapter, requiredScope?: string) {
  const server = new McpServer({ name: 'skunkworks-365-mcp', version: '0.3.0' });
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
      description: ['users.list','users.get','licenses.capacity','service.health'].includes(operation)
        ? `Read ${operation} from Microsoft Graph for an explicitly authorized tenant. Returns connector_unavailable when Graph is not configured. License capacity is not billing data.`
        : `Read ${operation} for an authorized tenant. This provider is not implemented and returns connector_unavailable.`,
      inputSchema: z.object({ tenantId: tenantIdSchema,
        ...(operation === 'users.get' ? { userId: tenantIdSchema } : {}),
        ...(operation === 'users.list' ? { limit: z.number().int().min(1).max(100).optional() } : {}),
        ...(['users.list','licenses.capacity','service.health'].includes(operation)
          ? { cursor: z.string().min(1).max(8192).optional() } : {})
      }).strict(),
      annotations, ...security
    }, async ({ tenantId, ...options }) => {
      try {
        const value = await readTenant(principal, grants, tenantId, operation, adapter, options as ReadOptions);
        return result(value, Boolean(value && typeof value === 'object' && 'status' in value && value.status !== 'ok'));
      }
      catch (error) {
        if (error instanceof TenantAccessDenied) return result({ status: 'access_denied', message: error.message }, true);
        return result({ status: 'internal_error', message: 'Provider read failed; contact the service operator.' }, true);
      }
    });
  }
  return server;
}
