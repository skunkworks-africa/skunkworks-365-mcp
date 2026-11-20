/** Explicit, in-memory bootstrap grants. Populate only from trusted configuration. */
export type ReadOperation = 'vm.list' | 'vm.instanceView' | 'vm.cpu' | 'cost.query';
export type Principal = { issuer: string; subject: string };
export type Scope = { tenantId: string; subscriptionId: string };
export type Grant = Principal & Scope & { operations: readonly ReadOperation[] };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const operations = new Set<ReadOperation>(['vm.list', 'vm.instanceView', 'vm.cpu', 'cost.query']);

/**
 * This policy is deliberately separate from authentication and token validation.
 * Only verified claims may be used as principal and tenant inputs by its host.
 */
export function createGrantPolicy(grants: readonly Grant[]) {
  if (!Array.isArray(grants)) throw new Error('Invalid grant configuration');
  const records = new Map<string, Set<ReadOperation>>();
  const key = (p: Principal, s: Scope) => JSON.stringify([p.issuer, p.subject, s.tenantId.toLowerCase(), s.subscriptionId.toLowerCase()]);
  for (const grant of grants) {
    if (!grant || typeof grant.issuer !== 'string' || !grant.issuer.trim() || grant.issuer.length > 500 ||
        typeof grant.subject !== 'string' || !grant.subject.trim() || grant.subject.length > 500 ||
        typeof grant.tenantId !== 'string' || !uuid.test(grant.tenantId) ||
        typeof grant.subscriptionId !== 'string' || !uuid.test(grant.subscriptionId) ||
        !Array.isArray(grant.operations) || grant.operations.length === 0 ||
        grant.operations.some(op => !operations.has(op))) throw new Error('Invalid grant configuration');
    const id = key(grant, grant);
    if (records.has(id) || new Set(grant.operations).size !== grant.operations.length) throw new Error('Duplicate grant configuration');
    records.set(id, new Set(grant.operations));
  }
  return async (principal: Principal, scope: Scope, operation: ReadOperation): Promise<boolean> => {
    if (!principal || typeof principal.issuer !== 'string' || typeof principal.subject !== 'string' ||
        !scope || typeof scope.tenantId !== 'string' || !uuid.test(scope.tenantId) ||
        typeof scope.subscriptionId !== 'string' || !uuid.test(scope.subscriptionId) || !operations.has(operation)) return false;
    return records.get(key(principal, scope))?.has(operation) === true;
  };
}

