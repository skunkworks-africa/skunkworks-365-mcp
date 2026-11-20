/** Loopback-only, entirely synthetic demo. Never use as an authentication service. */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createMcpHandler } from './mcp-handler.ts';

const HOST = '127.0.0.1';
const MAX_BODY = 64 * 1024;
export const DEMO_TOKEN = 'demo-only-not-a-credential';
export const DEMO_TENANT = '11111111-1111-4111-8111-111111111111';
export const DEMO_SUBSCRIPTION = '22222222-2222-4222-8222-222222222222';

const client = {
  async listVirtualMachines(_principal: unknown, scope: { tenantId: string; subscriptionId: string }) {
    checkScope(scope);
    return { demo: true, items: [{ id: '/demo/demo-vm', name: 'demo-vm', location: 'example-region' }], incomplete: false };
  },
  async getVirtualMachineStatus(_principal: unknown, scope: { tenantId: string; subscriptionId: string }, group: string, name: string) {
    checkScope(scope);
    if (group !== 'demo-group' || name !== 'demo-vm') throw new Error('Unknown demo resource');
    return { demo: true, statuses: [{ code: 'PowerState/running', displayStatus: 'Demo running' }] };
  },
  async getVirtualMachineCpuMetrics(_principal: unknown, scope: { tenantId: string; subscriptionId: string }, group: string, name: string, from: string, to: string) {
    checkScope(scope);
    if (group !== 'demo-group' || name !== 'demo-vm') throw new Error('Unknown demo resource');
    return { demo: true, from, to, interval: 'PT1H', unit: 'Percent', series: [[{ time: from, average: 12.5 }]], noData: false, incomplete: false, note: 'Synthetic demonstration data; not Azure metrics.' };
  },
  async getSubscriptionCost(_principal: unknown, scope: { tenantId: string; subscriptionId: string }, from: string, to: string) {
    checkScope(scope);
    return { demo: true, from, to, items: [{ amount: 0, currency: 'USD' }], incomplete: false, retrievedAt: new Date().toISOString(), note: 'Synthetic demonstration data; not Azure costs.' };
  },
};
function checkScope(scope: { tenantId: string; subscriptionId: string }) {
  if (scope.tenantId.toLowerCase() !== DEMO_TENANT || scope.subscriptionId.toLowerCase() !== DEMO_SUBSCRIPTION) throw new Error('Unknown demo scope');
}
const handler = createMcpHandler({
  async authenticate(value) { return value === `Bearer ${DEMO_TOKEN}` ? { issuer: 'demo-only', subject: 'demo-user', tenantId: DEMO_TENANT } : null; },
  async clientForRequest() { return client; },
});

/**
 * Opens only 127.0.0.1. No request, credential, or client ever reaches Azure.
 * Port 0 asks the OS to choose a free port. Production mode is prohibited.
 */
export async function startDemoServer(options: { host?: string; port?: number } = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('Demo is disabled in production');
  if (options.host !== undefined && options.host !== HOST) throw new Error('Demo only binds to 127.0.0.1');
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid demo port');
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Cloud-Manager-Demo', 'synthetic-data-only');
    const reject = (status: number) => { if (!response.headersSent) response.writeHead(status); response.end(); };
    const addr = server.address();
    if (!addr || typeof addr === 'string') return reject(503);
    const remote = request.socket.remoteAddress;
    if (remote !== HOST && remote !== '::ffff:127.0.0.1') return reject(403);
    if (request.headers.host !== `${HOST}:${addr.port}`) return reject(403);
    if (request.headers.origin && request.headers.origin !== `http://${HOST}:${addr.port}`) return reject(403);
    if (request.url !== '/mcp') return reject(404);
    if (request.method !== 'POST') return reject(405);
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return reject(415);
    const rawLength = request.headers['content-length'];
    if (rawLength && (!/^\d+$/.test(rawLength) || Number(rawLength) > MAX_BODY)) { request.resume(); return reject(413); }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const value of request) {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += bytes.length;
        if (size > MAX_BODY) { request.resume(); return reject(413); }
        chunks.push(bytes);
      }
      const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      const result = await handler(input, request.headers.authorization);
      if (!result.body) return reject(result.status);
      response.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
      return response.end(JSON.stringify(result.body));
    } catch { return reject(400); }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, HOST, () => { server.removeListener('error', reject); resolve(); }); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDemoServer({ port: 8765 }).then(server => {
    const address = server.address();
    if (address && typeof address !== 'string') process.stdout.write(`DEMO ONLY - synthetic data at http://${HOST}:${address.port}/mcp\n`);
  }).catch(() => { process.stderr.write('Demo could not start.\n'); process.exitCode = 1; });
}

