/**
 * Experimental local bootstrap. It does not provide a production listener,
 * persistent grants, customer onboarding, or a verified ChatGPT connection.
 * Configuration must be supplied explicitly by the operator.
 */
import { EntraAuthenticator } from './entra-auth.ts';
import { createGrantPolicy, type Grant } from './grants.ts';
import { createOboExchange } from './obo.ts';
import { createCloudManager } from './service.ts';
import { createHttpHandler } from './http-handler.ts';

type Environment = Record<string, string | undefined>;
type Fetchers = { identityFetch?: typeof fetch; exchangeFetch?: typeof fetch; armFetch?: typeof fetch };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function required(env: Environment, name: string, maxLength = 4096): string {
  const value = env[name];
  if (typeof value !== 'string' || !value || value.length > maxLength || /[\x00-\x1f\x7f]/.test(value))
    throw new Error('Cloud Manager configuration is incomplete or invalid');
  return value;
}
function ids(env: Environment, name: string): string[] {
  const values = required(env, name).split(',').map(x => x.trim());
  if (values.length > 1000 || values.some(x => !uuid.test(x)) || new Set(values.map(x => x.toLowerCase())).size !== values.length)
    throw new Error('Cloud Manager configuration is incomplete or invalid');
  return values.map(x => x.toLowerCase());
}

export function createConfiguredHandler(env: Environment, fetchers: Fetchers = {}) {
  if (!env || env.NODE_ENV === 'production') throw new Error('Prototype is disabled in production');
  const resourceUrl = required(env, 'CLOUD_MANAGER_RESOURCE_URL');
  const authority = required(env, 'CLOUD_MANAGER_AUTHORIZATION_SERVER');
  const fullScope = required(env, 'CLOUD_MANAGER_DELEGATED_SCOPE');
  const prefix = `${resourceUrl}/`;
  if (!fullScope.startsWith(prefix)) throw new Error('Cloud Manager configuration is incomplete or invalid');
  const scopeName = fullScope.slice(prefix.length);
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(scopeName) || scopeName === '.' || scopeName === '..')
    throw new Error('Cloud Manager configuration is incomplete or invalid');
  const tenants = ids(env, 'CLOUD_MANAGER_TENANT_IDS');
  const clients = ids(env, 'CLOUD_MANAGER_ALLOWED_CLIENT_IDS');
  const appId = required(env, 'CLOUD_MANAGER_API_CLIENT_ID');
  const clientSecret = required(env, 'CLOUD_MANAGER_CLIENT_SECRET');
  let grants: Grant[];
  try {
    const parsed: unknown = JSON.parse(required(env, 'CLOUD_MANAGER_GRANTS_JSON', 65536));
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 1000) throw new Error();
    grants = parsed as Grant[];
    for (const grant of grants) {
      if (!grant || typeof grant.tenantId !== 'string' || !uuid.test(grant.tenantId) ||
          !tenants.includes(grant.tenantId.toLowerCase()) ||
          grant.issuer !== `https://login.microsoftonline.com/${grant.tenantId.toLowerCase()}/v2.0`)
        throw new Error();
    }
  } catch { throw new Error('Cloud Manager configuration is incomplete or invalid'); }
  const authorize = createGrantPolicy(grants);
  const authenticator = new EntraAuthenticator({
    audience: appId, tenantIds: tenants, requiredScope: scopeName, allowedClientIds: clients,
    ...(fetchers.identityFetch ? { fetch: fetchers.identityFetch } : {}),
  });
  const verifyBearer = (token: string) => authenticator.authenticate(token);
  const exchange = createOboExchange({
    clientId: appId, clientSecret, verifyBearer,
    ...(fetchers.exchangeFetch ? { fetch: fetchers.exchangeFetch } : {}),
  });
  const service = createCloudManager({ verifyBearer, exchange, authorize, ...(fetchers.armFetch ? { armFetch: fetchers.armFetch } : {}) });
  return createHttpHandler({ resourceUrl, authorizationServer: authority, delegatedScope: fullScope, handler: service });
}

