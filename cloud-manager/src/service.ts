/** Experimental composition; a secure HTTP transport and real configuration are still required. */
import { ArmClient } from './arm-client.ts';
import { createMcpHandler } from './mcp-handler.ts';
import type { VerifiedBearer } from './obo.ts';
import type { Principal, Scope, ReadOperation, GrantDirectory } from './grants.ts';

type Deps = {
  verifyBearer: (token: string) => Promise<VerifiedBearer>;
  exchange: (token: string, tenantId: string) => Promise<{ token: string; principal: VerifiedBearer }>;
  authorize: (principal: Principal, scope: Scope, operation: ReadOperation) => Promise<boolean>;
  listGrantedSubscriptions?: GrantDirectory;
  armFetch?: typeof fetch;
};

const bearer = (header: string) => {
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  if (!match || !match[1]) throw new Error('Unauthenticated');
  return match[1];
};
const same = (a: VerifiedBearer, b: VerifiedBearer) => a.issuer === b.issuer && a.subject === b.subject &&
  a.tenantId.toLowerCase() === b.tenantId.toLowerCase() && a.objectId === b.objectId && a.clientId === b.clientId;

export function createCloudManager(deps: Deps) {
  if (!deps || typeof deps.verifyBearer !== 'function' || typeof deps.exchange !== 'function' || typeof deps.authorize !== 'function')
    throw new Error('Identity and grant configuration are required');
  return createMcpHandler({
    authenticate: async header => deps.verifyBearer(bearer(header)),
    ...(deps.listGrantedSubscriptions ? { listGrantedSubscriptions: deps.listGrantedSubscriptions } : {}),
    clientForRequest: async (context, header) => {
      const identity = context as VerifiedBearer;
      if (typeof identity.objectId !== 'string' || typeof identity.clientId !== 'string') throw new Error('Invalid identity');
      const assertion = bearer(header);
      return new ArmClient({
        authorize: async (principal, scope, operation) => {
          if (principal.issuer !== identity.issuer || principal.subject !== identity.subject || scope.tenantId.toLowerCase() !== identity.tenantId.toLowerCase()) return false;
          return await deps.authorize(principal, scope, operation);
        },
        getDelegatedToken: async (principal, scope) => {
          if (principal.issuer !== identity.issuer || principal.subject !== identity.subject || scope.tenantId.toLowerCase() !== identity.tenantId.toLowerCase()) throw new Error('Invalid identity');
          const result = await deps.exchange(assertion, scope.tenantId);
          if (!result || !result.principal || !same(identity, result.principal)) throw new Error('Invalid identity');
          return result.token;
        },
        ...(deps.armFetch ? { fetch: deps.armFetch } : {}),
      });
    },
  });
}

