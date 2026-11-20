/**
 * Experimental Fetch-style HTTP adapter; this module does not open a port or
 * provide OAuth itself. A production ingress must preserve the canonical URL
 * and enforce TLS, rate limiting and a real token verifier. No credentials are
 * read from query parameters, JSON bodies, Forwarded headers or Host headers.
 */
type RpcResponse = { status: 200 | 202 | 401; body: Record<string, unknown> | null };
type RpcHandler = (message: unknown, authorization: string | null) => Promise<RpcResponse>;
type HttpConfig = { resourceUrl: string; authorizationServer: string; delegatedScope: string; handler: RpcHandler };
const MAX_BODY_BYTES = 64 * 1024;
const version = '2026-07-28';

function validateConfig(config: HttpConfig) {
  if (!config || typeof config.handler !== 'function') throw new Error('MCP handler is required.');
  let resource: URL, authority: URL;
  try { resource = new URL(config.resourceUrl); authority = new URL(config.authorizationServer); }
  catch { throw new Error('Valid HTTPS configuration URLs are required.'); }
  if (resource.protocol !== 'https:' || resource.username || resource.password || resource.search || resource.hash || resource.pathname === '/' || resource.pathname.endsWith('/'))
    throw new Error('A canonical HTTPS MCP resource URL is required.');
  const authorityPath = /^\/(?:organizations|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/v2\.0$/i;
  if (authority.protocol !== 'https:' || authority.hostname !== 'login.microsoftonline.com' || authority.port || authority.username || authority.password || authority.search || authority.hash || !authorityPath.test(authority.pathname))
    throw new Error('A trusted Microsoft Entra authorization server is required.');
  // The registered Entra App ID URI must be the canonical MCP resource URL.
  // A single simple scope name follows it; reject encoding or header syntax
  // so the same configured scope is safe in discovery and the challenge.
  const prefix = `${resource.href}/`;
  if (typeof config.delegatedScope !== 'string' || !config.delegatedScope.startsWith(prefix))
    throw new Error('A delegated scope for the MCP resource is required.');
  const scopeName = config.delegatedScope.slice(prefix.length);
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(scopeName) || scopeName === '.' || scopeName === '..')
    throw new Error('Invalid delegated scope.');
  const metadata = new URL(`/.well-known/oauth-protected-resource${resource.pathname}`, resource.origin);
  return { resource, authority, metadata, delegatedScope: config.delegatedScope };
}

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
}
function empty(status: number, extra: Record<string, string> = {}) {
  return new Response(null, { status, headers: { ...headers, ...extra } });
}
function rpcError(message: Record<string, unknown> | null, code: number, errorMessage: string, data?: unknown) {
  const candidate = message?.id;
  const id = typeof candidate === 'string' || (typeof candidate === 'number' && Number.isSafeInteger(candidate)) ? candidate : null;
  return jsonResponse({ jsonrpc: '2.0', id, error: { code, message: errorMessage, ...(data ? { data } : {}) } }, 400);
}
function decodeHeader(value: string | null): string | null {
  if (value === null || value.length > 4096 || !/^[\x20-\x7e\t]*$/.test(value)) return null;
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value;
  const encoded = value.slice(9, -2);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
  try {
    const binary = atob(encoded);
    if (btoa(binary) !== encoded) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, x => x.charCodeAt(0)));
  } catch { return null; }
}

async function boundedRead(request: Request): Promise<string | null> {
  const size = request.headers.get('content-length');
  if (size && (!/^\d+$/.test(size) || Number(size) > MAX_BODY_BYTES)) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return ''; }
}

/** The supplied URL and authority are operator config, never request input. */
export function createHttpHandler(config: HttpConfig) {
  const { resource, authority, metadata, delegatedScope } = validateConfig(config);
  const challenge = `Bearer resource_metadata="${metadata.href}", scope="${delegatedScope}"`;

  return async function handleHttp(request: Request): Promise<Response> {
    let requestUrl: URL;
    try { requestUrl = new URL(request.url); } catch { return empty(400); }
    if (requestUrl.origin !== resource.origin) return empty(404);
    // Reject browser-origin requests that would be cross-site. Requests without
    // Origin, as made by server-side MCP clients, may continue to authentication.
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== resource.origin) return empty(403);
    if (requestUrl.search || requestUrl.hash) return empty(400);

    if (requestUrl.pathname === metadata.pathname) {
      if (request.method !== 'GET') return empty(405, { Allow: 'GET' });
      return jsonResponse({ resource: resource.href, authorization_servers: [authority.href], bearer_methods_supported: ['header'], scopes_supported: [delegatedScope] });
    }
    if (requestUrl.pathname !== resource.pathname) return empty(404);
    if (request.method !== 'POST') return empty(405, { Allow: 'POST' });
    const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') return empty(415);
    const accept = request.headers.get('accept')?.toLowerCase().split(',').map(x => x.split(';', 1)[0]?.trim()) ?? [];
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) return empty(406);
    const requestBody = await boundedRead(request);
    if (requestBody === null) return empty(413);
    let message: unknown;
    try { message = JSON.parse(requestBody); }
    catch { return jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }

    // Transport and body versions must agree; the handler checks discovery and
    // request metadata in more detail. No version is inferred from Host headers.
    const m = message && typeof message === 'object' && !Array.isArray(message) ? message as Record<string, unknown> : null;
    const p = m && m.params && typeof m.params === 'object' && !Array.isArray(m.params) ? m.params as Record<string, unknown> : null;
    const meta = p && p._meta && typeof p._meta === 'object' && !Array.isArray(p._meta) ? p._meta as Record<string, unknown> : null;
    const protocol = request.headers.get('mcp-protocol-version');
    if (!protocol || !meta || meta['io.modelcontextprotocol/protocolVersion'] !== protocol || !m || typeof m.method !== 'string' || request.headers.get('mcp-method') !== m.method)
      return rpcError(m, -32020, 'Header mismatch');
    if (m.method === 'tools/call' && (!p || typeof p.name !== 'string' || decodeHeader(request.headers.get('mcp-name')) !== p.name))
      return rpcError(m, -32020, 'Header mismatch');
    if (protocol !== version) return rpcError(m, -32022, 'Unsupported protocol version', { supported: [version], requested: protocol });

    let result: RpcResponse;
    try { result = await config.handler(message, request.headers.get('authorization')); }
    catch { return empty(500); }
    if (result.status === 401) return empty(401, { 'WWW-Authenticate': challenge });
    if (result.status === 202) return empty(202);
    if (result.status !== 200 || !result.body || typeof result.body !== 'object' || Array.isArray(result.body)) return empty(500);
    const rpcErrorBody = result.body.error as Record<string, unknown> | undefined;
    return jsonResponse(result.body, rpcErrorBody?.code === -32601 ? 404 : 200);
  };
}

