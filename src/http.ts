import { createMcpHandler } from '@modelcontextprotocol/server';
import { authenticate, type VerifyToken } from './auth.js';
import type { Grants, Adapter } from './domain.js';
import { makeServer } from './mcp.js';

export function makeHttpApplication(verify: VerifyToken, grants: Grants, adapter: Adapter) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
    const principal = await authenticate(request, verify);
    if (!principal) return new Response('Unauthorized', {
      status: 401, headers: { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' }
    });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const handler = createMcpHandler(() => makeServer(principal, grants, adapter));
    try { return await handler.fetch(request); }
    finally { await handler.close(); }
  };
}
