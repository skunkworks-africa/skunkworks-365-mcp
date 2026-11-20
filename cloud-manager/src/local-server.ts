/** Local integration harness only; never deploy this listener to production. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

type Handler = (request: Request) => Promise<Response>;
type Options = { resourceUrl: string; handler: Handler; host?: string; port?: number };
const HOST = '127.0.0.1';
const MAX_BODY = 64 * 1024;

function fail(response: ServerResponse, status: number) {
  if (!response.headersSent) response.writeHead(status, { 'Cache-Control': 'no-store' });
  response.end();
}
async function readBody(request: IncomingMessage): Promise<Buffer | null> {
  const length = request.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) { request.resume(); return null; }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.byteLength;
    if (total > MAX_BODY) { request.resume(); return null; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function startLocalServer(options: Options) {
  if (process.env.NODE_ENV === 'production') throw new Error('Prototype is disabled in production');
  if (!options || typeof options.handler !== 'function' || (options.host !== undefined && options.host !== HOST))
    throw new Error('Prototype must bind to loopback');
  const resource = new URL(options.resourceUrl);
  if (resource.protocol !== 'https:' || resource.username || resource.password || resource.search || resource.hash)
    throw new Error('A canonical HTTPS resource URL is required');
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local port');

  const server = createServer(async (request, response) => {
    try {
      const address = server.address();
      if (!address || typeof address === 'string') return fail(response, 503);
      if (request.socket.remoteAddress !== HOST && request.socket.remoteAddress !== '::ffff:127.0.0.1') return fail(response, 403);
      if (request.headers.host !== `${HOST}:${address.port}`) return fail(response, 403);
      if (request.headers.origin && request.headers.origin !== resource.origin) return fail(response, 403);
      if (!request.url || !request.url.startsWith('/') || request.url.length > 4096 || !request.method) return fail(response, 400);
      const body = await readBody(request);
      if (body === null) return fail(response, 413);
      const headers = new Headers();
      // Host and proxy headers are untrusted and are never forwarded as authority.
      for (const name of ['accept', 'authorization', 'content-type', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'origin']) {
        const value = request.headers[name];
        if (typeof value === 'string') headers.set(name, value);
      }
      const target = new URL(request.url, resource.origin);
      if (target.origin !== resource.origin) return fail(response, 403);
      const init: RequestInit = { method: request.method, headers };
      if (request.method !== 'GET' && request.method !== 'HEAD' && body.length) init.body = new Uint8Array(body);
      const result = await options.handler(new Request(target, init));
      response.statusCode = result.status;
      result.headers.forEach((value, key) => response.setHeader(key, value));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch { return fail(response, 500); }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => { server.removeListener('error', reject); resolve(); });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    const { createConfiguredHandler } = await import('./bootstrap.ts');
    const handler = createConfiguredHandler(process.env);
    const resourceUrl = process.env.CLOUD_MANAGER_RESOURCE_URL;
    const portText = process.env.CLOUD_MANAGER_LOCAL_PORT ?? '8766';
    if (!resourceUrl || !/^\d{1,5}$/.test(portText)) throw new Error();
    const server = await startLocalServer({ resourceUrl, handler, port: Number(portText) });
    const address = server.address();
    if (address && typeof address !== 'string') process.stdout.write(`Experimental local listener started on 127.0.0.1:${address.port}\n`);
  })().catch(() => { process.stderr.write('Local listener could not start or its configuration is invalid.\n'); process.exitCode = 1; });
}

