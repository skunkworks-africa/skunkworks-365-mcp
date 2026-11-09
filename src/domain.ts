import { z } from 'zod';

export const tenantIdSchema = z.uuid();
export const grantsSchema = z.array(z.object({
  issuer: z.url(),
  subject: z.string().min(1),
  tenants: z.array(z.object({
    id: tenantIdSchema,
    name: z.string().min(1)
  })).max(1000)
}).strict());

export type Grants = z.infer<typeof grantsSchema>;
export interface Principal { issuer: string; subject: string }
export type Operation =
  | 'users.list' | 'licenses.capacity' | 'subscriptions.list'
  | 'billing.records' | 'gdap.relationships'
  | 'policies.list' | 'applications.list';

export interface Adapter {
  read(operation: Operation, tenantId: string): Promise<unknown>
}

export class UnavailableAdapter implements Adapter {
  async read(operation: Operation, tenantId: string) {
    return {
      status: 'connector_unavailable', operation, tenantId, liveData: false,
      message: 'No Microsoft Graph, Partner Center, or distributor connector is configured. No provider request was made.'
    };
  }
}

export function authorizedTenants(principal: Principal, grants: Grants) {
  return grants
    .filter(g => g.issuer === principal.issuer && g.subject === principal.subject)
    .flatMap(g => g.tenants)
    .filter((t, i, all) => all.findIndex(x => x.id.toLowerCase() === t.id.toLowerCase()) === i);
}

export class TenantAccessDenied extends Error {
  constructor() { super('Tenant access denied'); }
}

export async function readTenant(
  principal: Principal, grants: Grants, tenantId: string,
  operation: Operation, adapter: Adapter
) {
  const parsed = tenantIdSchema.parse(tenantId).toLowerCase();
  if (!authorizedTenants(principal, grants).some(t => t.id.toLowerCase() === parsed)) {
    throw new TenantAccessDenied();
  }
  return adapter.read(operation, parsed);
}
