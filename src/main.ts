import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { authConfig, jwtVerifier } from './auth.js';
import { grantsSchema, UnavailableAdapter } from './domain.js';
import { makeHttpApplication } from './http.js';
import { remoteConfig } from './remote.js';

const mode = process.env.MCP_MODE ?? 'local';
if (mode !== 'local' && mode !== 'remote') throw new Error('MCP_MODE must be local or remote');
const config = authConfig(process.env);
const remote = mode === 'remote' ? remoteConfig(process.env) : undefined;
if (remote && config.requiredScope !== remote.scope) throw new Error('Required OAuth scope mismatch');
if (!process.env.MCP_ACCESS_REGISTRY) throw new Error('MCP_ACCESS_REGISTRY is required');
const grants = grantsSchema.parse(JSON.parse(await readFile(process.env.MCP_ACCESS_REGISTRY, 'utf8')));
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('PORT must be an integer from 1024 to 65535');
}
const fetch = makeHttpApplication(jwtVerifier(config), grants, new UnavailableAdapter(), remote);
const handler = toNodeHandler({ fetch });
const localhostHost = localhostHostValidation(), localhostOrigin = localhostOriginValidation();
const publicOrigin = remote ? new URL(remote.publicUrl) : undefined;
const bindHost = remote ? (process.env.MCP_BIND_HOST || '0.0.0.0') : '127.0.0.1';
const server = createServer((req, res) => {
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
server.listen(port, bindHost, () => {
  const endpoint = remote ? remote.publicUrl : 'http://127.0.0.1:' + port + '/mcp';
  console.log('Skunkworks 365 MCP (' + mode + '): ' + endpoint + ' — providers NOT connected');
});
process.on('SIGINT', () => server.close());
process.on('SIGTERM', () => server.close());
