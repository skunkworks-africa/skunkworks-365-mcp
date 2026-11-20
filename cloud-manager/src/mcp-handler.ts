/**
 * Experimental, transport-neutral MCP handler. The hosting transport must
 * enforce HTTPS, request size limits, OAuth discovery and challenge headers,
 * and provide a real bearer-token verifier. This module is not a running MCP
 * server and must not be used with a permissive authentication callback.
 */
import type { ArmClient } from './arm-client.ts';

type Principal = { issuer: string; subject: string };
type AuthContext = Principal & { tenantId: string };
type HandlerDeps = {
  authenticate: (authorization: string) => Promise<AuthContext | null>;
  clientForRequest: (context: AuthContext, authorization: string) => Promise<Pick<ArmClient, 'listVirtualMachines' | 'getVirtualMachineStatus' | 'getVirtualMachineCpuMetrics' | 'getSubscriptionCost'>>;
};
type JsonObject = Record<string, unknown>;
type Response = { status: 200 | 202 | 401; body: JsonObject | null };

const uuid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const scopeProperties = {
  tenantId: { type: 'string', pattern: uuid, description: 'Microsoft Entra tenant ID.' },
  subscriptionId: { type: 'string', pattern: uuid, description: 'Azure subscription ID.' },
};
const tools = [
  {
    name: 'get_virtual_machine_cpu_metrics', description: 'Read hourly average Azure Monitor VM CPU metrics for a UTC time range up to seven days. Missing datapoints are null.',
    inputSchema: { type: 'object', properties: { ...scopeProperties, resourceGroup: { type: 'string', minLength: 1, maxLength: 90 }, vmName: { type: 'string', minLength: 1, maxLength: 90 }, from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' } }, required: ['tenantId', 'subscriptionId', 'resourceGroup', 'vmName', 'from', 'to'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'list_virtual_machines', description: 'List virtual machines in an authorized Azure subscription. Results can be incomplete.',
    inputSchema: { type: 'object', properties: scopeProperties, required: ['tenantId', 'subscriptionId'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'get_virtual_machine_status', description: 'Read instance-view status for an authorized virtual machine.',
    inputSchema: { type: 'object', properties: { ...scopeProperties, resourceGroup: { type: 'string', minLength: 1, maxLength: 90 }, vmName: { type: 'string', minLength: 1, maxLength: 90 } }, required: ['tenantId', 'subscriptionId', 'resourceGroup', 'vmName'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'get_subscription_cost', description: 'Read pre-tax subscription costs for a date range. Results may be incomplete, delayed or revised.',
    inputSchema: { type: 'object', properties: { ...scopeProperties, from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, required: ['tenantId', 'subscriptionId', 'from', 'to'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
];

const protocolVersion = '2026-07-28';
const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const errorResponse = (id: unknown, code: number, message: string): Response => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });
const success = (id: unknown, result: JsonObject): Response => ({ status: 200, body: { jsonrpc: '2.0', id, result: { resultType: 'complete', ...result } } });

type ValidArguments = { tenantId: string; subscriptionId: string; resourceGroup?: string; vmName?: string; from?: string; to?: string };
function validArguments(name: string, args: unknown): args is ValidArguments {
  if (!isObject(args)) return false;
  const keys = name === 'list_virtual_machines' ? ['tenantId', 'subscriptionId'] : name === 'get_virtual_machine_status'
    ? ['tenantId', 'subscriptionId', 'resourceGroup', 'vmName'] : name === 'get_virtual_machine_cpu_metrics'
    ? ['tenantId', 'subscriptionId', 'resourceGroup', 'vmName', 'from', 'to'] : ['tenantId', 'subscriptionId', 'from', 'to'];
  if (Object.keys(args).length !== keys.length || !keys.every(k => Object.hasOwn(args, k) && typeof args[k] === 'string')) return false;
  if (typeof args.tenantId !== 'string' || typeof args.subscriptionId !== 'string' || !new RegExp(uuid).test(args.tenantId) || !new RegExp(uuid).test(args.subscriptionId)) return false;
  if ((name === 'get_virtual_machine_status' || name === 'get_virtual_machine_cpu_metrics') && ['resourceGroup', 'vmName'].some(k => {
    const value = args[k];
    return typeof value !== 'string' || !value.length || value.length > 90 || /[\\/\u0000-\u001f]/.test(value) || value === '.' || value === '..';
  })) return false;
  if (name === 'get_subscription_cost' && ['from', 'to'].some(k => typeof args[k] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args[k] as string))) return false;
  if (name === 'get_virtual_machine_cpu_metrics' && ['from', 'to'].some(k => typeof args[k] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(args[k] as string))) return false;
  return true;
}

/** The host validates the bearer and the client independently enforces scoped grants. */
export function createMcpHandler(deps: HandlerDeps) {
  if (!deps || typeof deps.authenticate !== 'function' || typeof deps.clientForRequest !== 'function')
    throw new Error('An authenticator and per-request scoped ARM client factory are required.');

  return async function handle(message: unknown, authorization: unknown): Promise<Response> {
    // Only the hosting transport may supply Authorization. It must not be read
    // from a JSON-RPC argument, client-provided principal, or resource name.
    if (typeof authorization !== 'string' || !/^Bearer [^\s]+$/i.test(authorization) || authorization.length > 16384) return { status: 401, body: null };
    let context: AuthContext | null;
    try { context = await deps.authenticate(authorization); } catch { return { status: 401, body: null }; }
    if (!context || typeof context.issuer !== 'string' || !context.issuer.trim() || typeof context.subject !== 'string' || !context.subject.trim() || typeof context.tenantId !== 'string' || !new RegExp(uuid).test(context.tenantId)) return { status: 401, body: null };
    const principal: Principal = { issuer: context.issuer, subject: context.subject };

    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !message.method)
      return errorResponse(null, -32600, 'Invalid Request');
    const hasId = Object.hasOwn(message, 'id');
    const id = message.id;
    if (hasId && !(typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id)))) return errorResponse(null, -32600, 'Invalid Request');
    // Notifications never receive a JSON-RPC response and never invoke tools.
    if (!hasId) return { status: 202, body: null };

    if (message.method === 'server/discover') {
      if (!isObject(message.params) || !isObject(message.params._meta) || message.params._meta['io.modelcontextprotocol/protocolVersion'] !== protocolVersion || !isObject(message.params._meta['io.modelcontextprotocol/clientCapabilities']))
        return errorResponse(id, -32602, 'Invalid discovery metadata');
      return success(id, { supportedVersions: [protocolVersion], capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'skunkworks-cloud-manager', version: '0.1.0' } } });
    }
    if (!isObject(message.params) || !isObject(message.params._meta) || message.params._meta['io.modelcontextprotocol/protocolVersion'] !== protocolVersion || !isObject(message.params._meta['io.modelcontextprotocol/clientCapabilities']))
      return errorResponse(id, -32022, 'Unsupported or missing protocol version');
    if (message.method === 'ping') return success(id, {});
    if (message.method === 'tools/list') return success(id, { tools: structuredClone(tools) });
    if (message.method !== 'tools/call') return errorResponse(id, -32601, 'Method not found');
    if (!isObject(message.params) || typeof message.params.name !== 'string') return errorResponse(id, -32602, 'Invalid params');
    const name = message.params.name;
    if (!tools.some(tool => tool.name === name)) return errorResponse(id, -32602, 'Unknown tool');
    const args = message.params.arguments;
    if (!validArguments(name, args)) return errorResponse(id, -32602, 'Invalid tool arguments');
    if (args.tenantId.toLowerCase() !== context.tenantId.toLowerCase())
      return success(id, { isError: true, content: [{ type: 'text', text: 'Unable to complete the requested Azure operation. Check access, scope, and connection.' }] });
    const scope = { tenantId: args.tenantId, subscriptionId: args.subscriptionId };
    try {
      const argument = (key: 'resourceGroup' | 'vmName' | 'from' | 'to'): string => {
        const value = args[key];
        if (typeof value !== 'string') throw new Error('Invalid tool argument');
        return value;
      };
      const client = await deps.clientForRequest(context, authorization);
      const value = name === 'list_virtual_machines' ? await client.listVirtualMachines(principal, scope)
        : name === 'get_virtual_machine_status' ? await client.getVirtualMachineStatus(principal, scope, argument('resourceGroup'), argument('vmName'))
        : name === 'get_virtual_machine_cpu_metrics' ? await client.getVirtualMachineCpuMetrics(principal, scope, argument('resourceGroup'), argument('vmName'), argument('from'), argument('to'))
        : await client.getSubscriptionCost(principal, scope, argument('from'), argument('to'));
      return success(id, { content: [{ type: 'text', text: JSON.stringify(value) }] });
    } catch {
      // Never echo exception details, resource metadata, tokens, or provider errors.
      return success(id, { isError: true, content: [{ type: 'text', text: 'Unable to complete the requested Azure operation. Check access, scope, and connection.' }] });
    }
  };
}

