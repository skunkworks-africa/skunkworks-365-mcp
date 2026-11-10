import { createMcpHandler } from '@modelcontextprotocol/server';
import { createHash, randomUUID } from 'node:crypto';
import { authenticate, type VerifyToken } from './auth.js';
import { authorizedTenants, type Grants, type Adapter } from './domain.js';
import { makeServer } from './mcp.js';
import { authenticationChallenge, protectedResourceMetadata, type RemoteConfig } from './remote.js';

export interface HttpOptions { graphConfigured?: boolean; audit?: (event: Record<string, unknown>) => void; rateLimit?: number }
export function makeHttpApplication(verify: VerifyToken, grants: Grants, adapter: Adapter, remote?: RemoteConfig, options: HttpOptions = {}) {
  const windows = new Map<string, { count: number; expires: number }>();
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (remote && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      return Response.json(protectedResourceMetadata(remote), {
        headers: { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' }
      });
    }
    if (url.pathname === '/healthz' && request.method === 'GET') {
      return Response.json({ status: 'ok', graphConfigured: options.graphConfigured ?? false, providerConnectivity: 'not_checked_by_health_probe' }, {
        headers: { 'Cache-Control': 'no-store' }
      });
    }
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
    const principal = await authenticate(request, verify);
    if (!principal) return new Response('Unauthorized', {
      status: 401, headers: { 'WWW-Authenticate': authenticationChallenge(remote), 'Cache-Control': 'no-store' }
    });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (authorizedTenants(principal, grants).length === 0) return new Response('Forbidden', { status: 403 });
    const principalKey = createHash('sha256').update(principal.issuer + '\0' + (principal.objectId ?? principal.subject)).digest('hex');
    const now = Date.now();
    for (const [key, entry] of windows) if (entry.expires <= now) windows.delete(key);
    let window = windows.get(principalKey);
    if (!window) {
      if (windows.size >= 1000) return new Response('Busy', { status: 503 });
      window = { count: 0, expires: now + 60_000 }; windows.set(principalKey, window);
    }
    if (++window.count > (options.rateLimit ?? 60)) return new Response('Too many requests', { status: 429, headers: { 'Retry-After': '60' } });
    const reader = request.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65_536) { await reader.cancel(); return new Response('Request too large', { status: 413 }); }
        chunks.push(value);
      }
    }
    const body = Buffer.concat(chunks).toString('utf8');
    let method = 'invalid'; let tool: string | undefined;
    try {
      const rpc = JSON.parse(body);
      if (typeof rpc.method === 'string') method = rpc.method.slice(0, 64);
      if (rpc.method === 'tools/call' && typeof rpc.params?.name === 'string') tool = rpc.params.name.slice(0, 64);
    } catch { /* The SDK will return a protocol error. */ }
    const requestId = randomUUID();
    const handler = createMcpHandler(() => makeServer(principal, grants, adapter, remote?.advertisedScope ?? remote?.scope));
    try {
      const response = await handler.fetch(new Request(request.url, { method: request.method, headers: request.headers, body }));
      response.headers.set('Cache-Control', 'no-store');
      response.headers.set('X-Request-ID', requestId);
      // Never log bearer tokens, raw identities, arguments or provider response data.
      options.audit?.({ time: new Date().toISOString(), requestId, principalHash: principalKey, method, tool, httpStatus: response.status });
      return response;
    }
    finally { await handler.close(); }
  };
}
