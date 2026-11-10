import { createMcpHandler } from '@modelcontextprotocol/server';
import { createHash, randomUUID } from 'node:crypto';
import { authenticate, type VerifyToken } from './auth.js';
import { authorizedTenants, type Grants, type Adapter } from './domain.js';
import { makeServer } from './mcp.js';
import { authenticationChallenge, protectedResourceMetadata, type RemoteConfig } from './remote.js';

export function makeHttpApplication(verify: VerifyToken, grants: Grants, adapter: Adapter, remote?: RemoteConfig) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (remote && url.pathname === '/.well-known/oauth-protected-resource') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      return Response.json(protectedResourceMetadata(remote), {
        headers: { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' }
      });
    }
    if (url.pathname === '/healthz' && request.method === 'GET') {
      return Response.json({ status: 'ok', liveProviderConnections: false }, {
        headers: { 'Cache-Control': 'no-store' }
      });
    }
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
    const principal = await authenticate(request, verify);
    if (!principal) return new Response('Unauthorized', {
      status: 401, headers: { 'WWW-Authenticate': authenticationChallenge(remote), 'Cache-Control': 'no-store' }
    });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const handler = createMcpHandler(() => makeServer(principal, grants, adapter, remote?.scope));
    try { return await handler.fetch(request); }
    finally { await handler.close(); }
  };
}
