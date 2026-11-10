import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { authConfig, jwtVerifier } from './auth.js';
import { grantsSchema, UnavailableAdapter } from './domain.js';
import { makeHttpApplication } from './http.js';
import { remoteConfig } from './remote.js';
import { GraphReadAdapter, graphTokenProvider } from './graph.js';

const mode = process.env.MCP_MODE ?? 'local';
if (mode !== 'local' && mode !== 'remote') throw new Error('MCP_MODE must be local or remote');
const config = authConfig(process.env);
const remote = mode === 'remote' ? remoteConfig(process.env) : undefined;
if (remote && config.requiredScope !== remote.scope) throw new Error('Required OAuth scope mismatch');
if (!process.env.MCP_ACCESS_REGISTRY && !process.env.MCP_ACCESS_REGISTRY_JSON) throw new Error('Access registry is required');
if (process.env.MCP_ACCESS_REGISTRY && process.env.MCP_ACCESS_REGISTRY_JSON) throw new Error('Use one access registry source');
const grants = grantsSchema.parse(JSON.parse(process.env.MCP_ACCESS_REGISTRY_JSON ?? await readFile(process.env.MCP_ACCESS_REGISTRY!, 'utf8')));
const graphEnabled = process.env.GRAPH_ENABLED === 'true';
if (process.env.GRAPH_ENABLED && !['true','false'].includes(process.env.GRAPH_ENABLED)) throw new Error('Invalid GRAPH_ENABLED');
if (graphEnabled && (!config.entraTenantId || config.requiredRole !== 'M365.Read' || !config.requiredScope)) {
  throw new Error('Graph requires home-tenant Entra validation, M365.Read role and delegated scope');
}
const graphTenants = new Set(grants.flatMap(grant => grant.tenants.map(tenant => tenant.id.toLowerCase())));
const adapter = graphEnabled
  ? new GraphReadAdapter(graphTokenProvider(process.env, graphTenants), graphTenants)
  : new UnavailableAdapter();
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('PORT must be an integer from 1024 to 65535');
}
const fetch = makeHttpApplication(jwtVerifier(config), grants, adapter, remote, {
  graphConfigured: graphEnabled, audit: event => console.log(JSON.stringify(event))
});
const handler = toNodeHandler({ fetch });
const localhostHost = localhostHostValidation(), localhostOrigin = localhostOriginValidation();
const publicOrigin = remote ? new URL(remote.publicUrl) : undefined;
const bindHost = remote ? (process.env.MCP_BIND_HOST || '0.0.0.0') : '127.0.0.1';
const server = createServer((req, res) => {
  // Azure health probes use an internal Host. This endpoint carries no tenant data.
  if (req.url === '/healthz' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: 'ok', graphConfigured: graphEnabled, providerConnectivity: 'not_checked_by_health_probe' })); return;
  }
  if (remote) {
    // Only deploy behind a trusted TLS terminator that preserves the canonical Host.
    // Never rely on untrusted X-Forwarded-* headers for security decisions.
    if (req.headers.host?.toLowerCase() !== publicOrigin!.host.toLowerCase()) {
      res.writeHead(421); res.end('Misdirected request'); return;
    }
    if (req.headers.origin && req.headers.origin !== publicOrigin!.origin) {
      res.writeHead(403); res.end('Forbidden origin'); return;
    }
  } else if (!localhostHost(req, res) || !localhostOrigin(req, res)) {
    return;
  }
  void handler(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end('Internal server error');
  });
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(port, bindHost, () => {
  const endpoint = remote ? remote.publicUrl : 'http://127.0.0.1:' + port + '/mcp';
  console.log('Skunkworks 365 MCP (' + mode + '): ' + endpoint + ' — Graph ' + (graphEnabled ? 'configured; connectivity verified only by actual reads' : 'disabled'));
});
process.on('SIGINT', () => server.close());
process.on('SIGTERM', () => server.close());
