import { ClientAssertionCredential, ClientCertificateCredential, ManagedIdentityCredential } from '@azure/identity';
import { tenantIdSchema, UnavailableAdapter, type Adapter, type Operation, type ReadOptions } from './domain.js';

export type GraphToken = (tenantId: string) => Promise<string>;
const graphOrigin = 'https://graph.microsoft.com';
const userFields = 'id,displayName,userPrincipalName,accountEnabled,usageLocation,assignedLicenses';

/** A second allowlist prevents credentials being used for arbitrary tenants even outside MCP routing. */
export function graphTokenProvider(env: NodeJS.ProcessEnv, allowedTenants: Set<string>): GraphToken {
  const clientId = tenantIdSchema.parse(env.GRAPH_CLIENT_ID);
  const mode = env.GRAPH_CREDENTIAL_MODE;
  if (mode !== 'managed-identity' && mode !== 'certificate') throw new Error('Select a Graph credential mode');
  const identity = mode === 'managed-identity'
    ? new ManagedIdentityCredential({ clientId: tenantIdSchema.parse(env.AZURE_CLIENT_ID) }) : undefined;
  if (mode === 'certificate' && !env.GRAPH_CERTIFICATE_PATH) throw new Error('GRAPH_CERTIFICATE_PATH is required');
  const credentials = new Map<string, ClientAssertionCredential | ClientCertificateCredential>();
  return async tenantId => {
    const tenant = tenantIdSchema.parse(tenantId).toLowerCase();
    if (!allowedTenants.has(tenant)) throw new Error('Graph tenant is not allowlisted');
    let credential = credentials.get(tenant);
    if (!credential) {
      credential = identity
        ? new ClientAssertionCredential(tenant, clientId, async () => {
            const assertion = await identity.getToken('api://AzureADTokenExchange/.default');
            if (!assertion) throw new Error('Managed identity assertion unavailable');
            return assertion.token;
          })
        : new ClientCertificateCredential(tenant, clientId, env.GRAPH_CERTIFICATE_PATH!);
      credentials.set(tenant, credential);
    }
    const token = await credential.getToken('https://graph.microsoft.com/.default');
    if (!token) throw new Error('Graph token unavailable');
    return token.token;
  };
}

export class GraphReadError extends Error {
  constructor(public readonly status: number) { super('Microsoft Graph read failed'); }
}

export class GraphReadAdapter implements Adapter {
  private readonly unavailable = new UnavailableAdapter();
  constructor(private token: GraphToken, private allowedTenants: Set<string>, private request: typeof fetch = fetch) {}

  async read(operation: Operation, tenantId: string, options: ReadOptions = {}) {
    const tenant = tenantIdSchema.parse(tenantId).toLowerCase();
    if (!this.allowedTenants.has(tenant)) throw new Error('Graph tenant is not allowlisted');
    let path: string;
    const query = new URLSearchParams();
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid page limit');
    if (options.cursor && (options.cursor.length > 8192 || operation === 'users.get')) throw new Error('Invalid cursor');
    switch (operation) {
      case 'users.list': path = '/v1.0/users'; query.set('$select', userFields); query.set('$top', String(limit)); break;
      case 'users.get': path = '/v1.0/users/' + tenantIdSchema.parse(options.userId); query.set('$select', userFields); break;
      case 'licenses.capacity': path = '/v1.0/subscribedSkus'; query.set('$select', 'skuId,skuPartNumber,capabilityStatus,consumedUnits,prepaidUnits'); break;
      case 'service.health': path = '/v1.0/admin/serviceAnnouncement/healthOverviews'; query.set('$select', 'id,service,status'); break;
      default: return this.unavailable.read(operation, tenant);
    }
    if (options.cursor) query.set('$skiptoken', options.cursor);
    const url = new URL(path, graphOrigin); url.search = query.toString();
    const bearer = await this.token(tenant);
    const response = await this.request(url, {
      method: 'GET', headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new GraphReadError(response.status);
    }
    const data = await response.json() as Record<string, unknown>;
    let nextCursor: string | undefined;
    if (data['@odata.nextLink']) {
      const next = new URL(String(data['@odata.nextLink']));
      if (next.origin !== graphOrigin || next.pathname !== path || next.username || next.password || next.hash) {
        throw new Error('Unexpected Graph pagination destination');
      }
      nextCursor = next.searchParams.get('$skiptoken') ?? undefined;
      if (!nextCursor || nextCursor.length > 8192) throw new Error('Unsupported Graph pagination cursor');
    }
    // Explicit projection avoids returning accidentally expanded profile properties or provider links.
    const fields = operation === 'licenses.capacity'
      ? ['skuId','skuPartNumber','capabilityStatus','consumedUnits','prepaidUnits']
      : operation === 'service.health' ? ['id','service','status'] : userFields.split(',');
    const project = (row: unknown) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid Graph response');
      const record = row as Record<string, unknown>;
      return Object.fromEntries(fields.filter(key => key in record).map(key => [key, record[key]]));
    };
    if (operation !== 'users.get' && !Array.isArray(data.value)) throw new Error('Invalid Graph collection');
    return {
      status: 'ok', source: 'microsoft_graph', liveData: true, tenantId: tenant, operation,
      fetchedAt: new Date().toISOString(),
      ...(operation === 'users.get' ? { user: project(data) } : { items: (data.value as unknown[]).map(project), nextCursor: nextCursor ?? null }),
      ...(operation === 'licenses.capacity' ? { billingData: false } : {})
    };
  }
}
