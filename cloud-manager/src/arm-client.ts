/**
 * Isolated prototype. This module does not authenticate callers, issue tokens,
 * persist grants, expose MCP tools, or establish a trustworthy tenant mapping.
 * Those duties belong to its production host and must be implemented before use.
 */

type Scope = { tenantId: string; subscriptionId: string };
type Principal = { issuer: string; subject: string };
type Operation = 'vm.list' | 'vm.instanceView' | 'cost.query';
type Dependencies = {
  authorize: (principal: Principal, scope: Scope, operation: Operation) => Promise<boolean>;
  getDelegatedToken: (principal: Principal, scope: Scope) => Promise<string>;
  fetch?: typeof fetch;
};

const ORIGIN = 'https://management.azure.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 1_048_576;
const MAX_ITEMS = 100;
const TIMEOUT_MS = 10_000;

export class ArmError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

function validScope(input: Scope): Scope {
  if (!input || !UUID.test(input.tenantId) || !UUID.test(input.subscriptionId))
    throw new ArmError('invalid_scope', 'Tenant and subscription must be UUIDs.');
  return { tenantId: input.tenantId.toLowerCase(), subscriptionId: input.subscriptionId.toLowerCase() };
}

function pathPart(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 90 || /[\\/\u0000-\u001f]/.test(value) || value === '.' || value === '..')
    throw new ArmError('invalid_resource', 'Invalid resource group or virtual machine name.');
  return encodeURIComponent(value);
}

function timestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ArmError('invalid_date', 'Dates must use YYYY-MM-DD.');
  const ms = Date.parse(value + 'T00:00:00.000Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value)
    throw new ArmError('invalid_date', 'Invalid calendar date.');
  return ms;
}

async function boundedJson(response: Response): Promise<any> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BYTES) throw new ArmError('response_too_large', 'Azure response exceeds the size limit.');
  if (!response.body) throw new ArmError('invalid_response', 'Azure returned an empty response.');
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel(); throw new ArmError('response_too_large', 'Azure response exceeds the size limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw new ArmError('invalid_response', 'Azure returned invalid JSON.'); }
}

export class ArmClient {
  private fetcher: typeof fetch;
  private deps: Dependencies;
  constructor(deps: Dependencies) {
    if (!deps || typeof deps.authorize !== 'function' || typeof deps.getDelegatedToken !== 'function')
      throw new ArmError('not_configured', 'Authorization and delegated token providers are required.');
    this.deps = deps;
    this.fetcher = deps.fetch ?? fetch;
  }

  private async request(principal: Principal, requestedScope: Scope, operation: Operation, path: string, method: 'GET' | 'POST' = 'GET', payload?: unknown): Promise<any> {
    const scope = validScope(requestedScope);
    if (!principal || typeof principal.issuer !== 'string' || !principal.issuer.trim() || typeof principal.subject !== 'string' || !principal.subject.trim())
      throw new ArmError('unauthenticated', 'A verified principal is required.');
    // The host must validate issuer, signature, audience, expiration, and binding.
    let authorized: boolean;
    try { authorized = await this.deps.authorize(principal, scope, operation); }
    catch { throw new ArmError('authorization_unavailable', 'Authorization service is unavailable.'); }
    if (authorized !== true)
      throw new ArmError('forbidden', 'This principal is not authorized for the requested scope.');
    let token: string;
    try { token = await this.deps.getDelegatedToken(principal, scope); }
    catch { throw new ArmError('credential_unavailable', 'A delegated Azure credential is unavailable.'); }
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token))
      throw new ArmError('credential_unavailable', 'A delegated Azure credential is unavailable.');
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || !url.pathname.startsWith(`/subscriptions/${scope.subscriptionId}/`))
      throw new ArmError('invalid_scope', 'Invalid Azure endpoint or subscription.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetcher(url, {
        method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json' } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      if (!response.ok) throw new ArmError('azure_error', `Azure request failed (HTTP ${response.status}).`);
      return await boundedJson(response);
    } catch (error) {
      if (error instanceof ArmError) throw error;
      throw new ArmError('azure_unavailable', 'Azure request failed or timed out.');
    } finally { clearTimeout(timer); }
  }

  async listVirtualMachines(principal: Principal, requestedScope: Scope) {
    const scope = validScope(requestedScope);
    const result = await this.request(principal, scope, 'vm.list', `/subscriptions/${scope.subscriptionId}/providers/Microsoft.Compute/virtualMachines?api-version=2025-04-01`);
    if (!Array.isArray(result?.value)) throw new ArmError('invalid_response', 'Azure returned an unexpected VM list.');
    const items = result.value.slice(0, MAX_ITEMS).map((v: any) => ({
      id: typeof v.id === 'string' ? v.id.slice(0, 1024) : null,
      name: typeof v.name === 'string' ? v.name.slice(0, 256) : null,
      location: typeof v.location === 'string' ? v.location.slice(0, 128) : null,
    }));
    return { items, incomplete: result.value.length > MAX_ITEMS || typeof result.nextLink === 'string' };
  }

  async getVirtualMachineStatus(principal: Principal, requestedScope: Scope, resourceGroup: string, vmName: string) {
    const scope = validScope(requestedScope);
    const path = `/subscriptions/${scope.subscriptionId}/resourceGroups/${pathPart(resourceGroup)}/providers/Microsoft.Compute/virtualMachines/${pathPart(vmName)}/instanceView?api-version=2025-04-01`;
    const result = await this.request(principal, scope, 'vm.instanceView', path);
    if (!Array.isArray(result?.statuses)) throw new ArmError('invalid_response', 'Azure returned an unexpected instance view.');
    return { statuses: result.statuses.slice(0, 20).map((s: any) => ({
      code: typeof s.code === 'string' ? s.code.slice(0, 128) : null,
      displayStatus: typeof s.displayStatus === 'string' ? s.displayStatus.slice(0, 256) : null,
    })) };
  }

  async getSubscriptionCost(principal: Principal, requestedScope: Scope, from: string, to: string) {
    const scope = validScope(requestedScope);
    const first = timestamp(from), last = timestamp(to);
    // Both endpoints are inclusive, so 370 calendar dates are 369 days apart.
    if (last < first || last - first >= 370 * 86_400_000) throw new ArmError('invalid_date', 'Date range must be ordered and at most 370 days inclusive.');
    const result = await this.request(principal, scope, 'cost.query', `/subscriptions/${scope.subscriptionId}/providers/Microsoft.CostManagement/query?api-version=2025-03-01`, 'POST', {
      type: 'ActualCost', timeframe: 'Custom', timePeriod: { from: `${from}T00:00:00Z`, to: `${to}T23:59:59Z` },
      dataset: { granularity: 'None', aggregation: { totalCost: { name: 'PreTaxCost', function: 'Sum' } } },
    });
    const columns = result?.properties?.columns, rows = result?.properties?.rows;
    if (!Array.isArray(columns) || !Array.isArray(rows)) throw new ArmError('invalid_response', 'Azure returned an unexpected cost response.');
    const amountIndex = columns.findIndex((c: any) => typeof c?.name === 'string' && ['pretaxcost', 'cost', 'totalcost'].includes(c.name.toLowerCase()));
    const currencyIndex = columns.findIndex((c: any) => typeof c?.name === 'string' && c.name.toLowerCase() === 'currency');
    if (amountIndex < 0 || currencyIndex < 0) throw new ArmError('invalid_response', 'Azure cost response omitted amount or currency.');
    const items = rows.slice(0, MAX_ITEMS).map((r: any) => {
      if (!Array.isArray(r) || typeof r[amountIndex] !== 'number' || !Number.isFinite(r[amountIndex]) || typeof r[currencyIndex] !== 'string' || !/^[A-Za-z]{3}$/.test(r[currencyIndex]))
        throw new ArmError('invalid_response', 'Azure returned an invalid cost row.');
      return { amount: r[amountIndex], currency: r[currencyIndex].toUpperCase() };
    });
    return { from, to, items, incomplete: rows.length > MAX_ITEMS || typeof result?.properties?.nextLink === 'string', retrievedAt: new Date().toISOString(), note: 'Costs are pre-tax and may be delayed or revised.' };
  }
}

