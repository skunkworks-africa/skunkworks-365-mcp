import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpHandler } from '../src/http-handler.ts';
import { createMcpHandler } from '../src/mcp-handler.ts';

const resourceUrl = 'https://cloud.example/mcp';
const authorizationServer = 'https://login.microsoftonline.com/organizations/v2.0';
const version = '2026-07-28';
const meta = { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {} };
const context = { issuer: 'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0', subject: 'user-a', tenantId: '11111111-1111-1111-1111-111111111111' };
const rpc = createMcpHandler({
  authenticate: async auth => auth === 'Bearer good' ? context : null,
  clientForRequest: async () => { throw Error('Not connected'); },
});
const make = () => createHttpHandler({ resourceUrl, authorizationServer, handler: rpc });
const discovery = { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } };
const post = (body = JSON.stringify(discovery), extra = {}) => {
  let parsed; try { parsed = JSON.parse(body); } catch { parsed = discovery; }
  return new Request(resourceUrl, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': version, 'mcp-method': parsed.method ?? 'server/discover', ...(parsed.method === 'tools/call' && parsed.params?.name ? { 'mcp-name': parsed.params.name } : {}), ...extra }, body,
  });
};

test('configuration rejects insecure URLs and non-Entra authorities', () => {
  const invalid = [
    { resourceUrl: 'http://cloud.example/mcp', authorizationServer },
    { resourceUrl: 'https://cloud.example/mcp?token=secret', authorizationServer },
    { resourceUrl: 'https://user:secret@cloud.example/mcp', authorizationServer },
    { resourceUrl, authorizationServer: 'https://login.microsoftonline.com.attacker.example/organizations/v2.0' },
    { resourceUrl, authorizationServer: 'https://login.microsoftonline.com/organizations/v2.0?next=bad' },
    { resourceUrl, authorizationServer: 'https://login.microsoftonline.com/common/v2.0' },
  ];
  for (const config of invalid) assert.throws(() => createHttpHandler({ ...config, handler: rpc }));
});

test('protected-resource metadata is built exclusively from trusted configuration', async () => {
  const handler = make();
  const metadata = await handler(new Request('https://cloud.example/.well-known/oauth-protected-resource/mcp', { headers: { Host: 'attacker.example', 'x-forwarded-host': 'attacker.example' } }));
  assert.equal(metadata.status, 200);
  assert.deepEqual(await metadata.json(), { resource: resourceUrl, authorization_servers: [authorizationServer], bearer_methods_supported: ['header'] });
  assert.equal(metadata.headers.get('cache-control'), 'no-store');
  assert.equal((await handler(new Request('https://attacker.example/.well-known/oauth-protected-resource/mcp'))).status, 404);
  assert.equal((await handler(new Request('https://cloud.example/.well-known/oauth-protected-resource/mcp', { method: 'POST' }))).status, 405);
});

test('rejects cross-origin, wrong methods, paths, query strings and types', async () => {
  const handler = make();
  assert.equal((await handler(post(undefined, { origin: 'https://attacker.example' }))).status, 403);
  assert.equal((await handler(new Request(resourceUrl))).status, 405);
  assert.equal((await handler(new Request('https://cloud.example/unknown'))).status, 404);
  assert.equal((await handler(new Request(`${resourceUrl}?token=abc`, { method: 'POST' }))).status, 400);
  assert.equal((await handler(new Request(resourceUrl, { method: 'POST', body: '{}' }))).status, 415);
});

test('bounds body and rejects invalid JSON or mismatched protocol metadata', async () => {
  const handler = make();
  assert.equal((await handler(post('x'.repeat(65537)))).status, 413);
  assert.equal((await handler(post('{'))).status, 400);
  assert.equal((await handler(post(JSON.stringify(discovery), { 'mcp-protocol-version': 'bad' }))).status, 400);
  const mismatch = { ...discovery, params: { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': 'bad' } } };
  assert.equal((await handler(post(JSON.stringify(mismatch)))).status, 400);
});

test('enforces required MCP header matches and decodes the base64 name sentinel', async () => {
  const handler = make();
  const message = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { _meta: meta, name: 'list_virtual_machines', arguments: { tenantId: context.tenantId, subscriptionId: '22222222-2222-2222-2222-222222222222' } } };
  const body = JSON.stringify(message);
  const badMethod = await handler(post(body, { authorization: 'Bearer good', 'mcp-method': 'tools/list' }));
  assert.equal(badMethod.status, 400);
  assert.equal((await badMethod.json()).error.code, -32020);
  const badName = await handler(post(body, { authorization: 'Bearer good', 'mcp-name': 'wrong' }));
  assert.equal((await badName.json()).error.code, -32020);
  const sentinel = `=?base64?${btoa('list_virtual_machines')}?=`;
  const encoded = await handler(post(body, { authorization: 'Bearer good', 'mcp-name': sentinel }));
  assert.equal(encoded.status, 200);
  assert.equal((await encoded.json()).result.isError, true); // Authenticated, but no ARM connection in this fixture.
  const missing = await handler(post(body, { authorization: 'Bearer good', 'mcp-name': '' }));
  assert.equal((await missing.json()).error.code, -32020);
  assert.equal((await handler(post(body, { accept: 'application/json' }))).status, 406);
});

test('401 challenge uses canonical metadata URL; verified requests reach handler', async () => {
  const handler = make();
  const unauthorized = await handler(post(undefined, { host: 'evil.example', 'x-forwarded-host': 'evil.example' }));
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('www-authenticate'), 'Bearer resource_metadata="https://cloud.example/.well-known/oauth-protected-resource/mcp"');
  const authorized = await handler(post(undefined, { authorization: 'Bearer good' }));
  assert.equal(authorized.status, 200);
  const result = await authorized.json();
  assert.equal(result.result.resultType, 'complete');
  assert.deepEqual(result.result.supportedVersions, [version]);
  assert.ok(!JSON.stringify(result).includes('Bearer good'));
});

test('does not leak unexpected handler errors', async () => {
  const handler = createHttpHandler({ resourceUrl, authorizationServer, handler: async () => { throw Error('secret token'); } });
  const response = await handler(post(undefined, { authorization: 'Bearer good' }));
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes('secret'));
});

