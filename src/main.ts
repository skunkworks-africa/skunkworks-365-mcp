import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { authConfig, jwtVerifier } from './auth.js';
import { grantsSchema, UnavailableAdapter } from './domain.js';
import { makeHttpApplication } from './http.js';

const config = authConfig(process.env);
if (!process.env.MCP_ACCESS_REGISTRY) throw new Error('MCP_ACCESS_REGISTRY is required');
const grants = grantsSchema.parse(JSON.parse(await readFile(process.env.MCP_ACCESS_REGISTRY, 'utf8')));
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('PORT must be an integer from 1024 to 65535');
}
const fetch = makeHttpApplication(jwtVerifier(config), grants, new UnavailableAdapter());
const handler = toNodeHandler({ fetch });
const host = localhostHostValidation(), origin = localhostOriginValidation();
const server = createServer((req, res) => {
  if (!host(req, res) || !origin(req, res)) return;
  void handler(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end('Internal server error');
  });
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Local-only MCP preview: http://127.0.0.1:${port}/mcp — providers NOT connected`);
});
process.on('SIGINT', () => server.close());
process.on('SIGTERM', () => server.close());
