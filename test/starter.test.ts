import { generateKeyPair, SignJWT } from 'jose';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authConfig, authenticate, jwtVerifier } from '../src/auth.js';
import { authorizedTenants, readTenant, UnavailableAdapter, TenantAccessDenied, grantsSchema } from '../src/domain.js';
import { makeHttpApplication } from '../src/http.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const principal = { issuer: 'https://identity.example.invalid/', subject: 'test-only-user' };
const grants = grantsSchema.parse([{ ...principal, tenants: [{ id: tenantId, name: 'TEST ONLY' }] }]);

test('principal must match both issuer and subject', () => {
  assert.equal(authorizedTenants(principal, grants).length, 1);
  assert.equal(authorizedTenants({ ...principal, issuer: 'https://other.invalid/' }, grants).length, 0);
  assert.equal(authorizedTenants({ ...principal, subject: 'other' }, grants).length, 0);
});
test('unauthorized tenant never reaches provider adapter', async () => {
  let calls = 0;
  await assert.rejects(readTenant(principal, grants, other, 'users.list', { async read() { calls++; } }), TenantAccessDenied);
  assert.equal(calls, 0);
});
test('malformed tenant never reaches provider adapter', async () => {
  let calls = 0;
  await assert.rejects(readTenant(principal, grants, 'invalid-uuid', 'users.list', { async read() { calls++; } }));
  assert.equal(calls, 0);
});
test('default connector is explicitly unavailable', async () => {
  const r = await readTenant(principal, grants, tenantId, 'billing.records', new UnavailableAdapter()) as { status: string; liveData: boolean };
  assert.equal(r.status, 'connector_unavailable');
  assert.equal(r.liveData, false);
});
test('auth config rejects missing and insecure URLs', () => {
  assert.throws(() => authConfig({}));
  assert.throws(() => authConfig({ MCP_TOKEN_ISSUER: 'http://bad.invalid', MCP_TOKEN_AUDIENCE: 'https://safe.invalid/mcp', MCP_JWKS_URL: 'https://safe.invalid/jwks' }));
});
test('invalid auth denied', async () => {
  let calls = 0;
  const reject = async () => { calls++; throw new Error('bad token'); };
  assert.equal(await authenticate(new Request('http://localhost/mcp'), reject), null);
  assert.equal(await authenticate(new Request('http://localhost/mcp', { headers: { authorization: 'Basic fake' } }), reject), null);
  assert.equal(calls, 0);
  assert.equal(await authenticate(new Request('http://localhost/mcp', { headers: { authorization: 'Bearer invalid' } }), reject), null);
  assert.equal(calls, 1);
});
const app = makeHttpApplication(async token => { if (token !== 'test-only') throw new Error('invalid'); return principal; }, grants, new UnavailableAdapter());
function rpc(method: string, params: unknown = {}, token = 'test-only') {
  return app(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  }));
}
async function rpcBody(response: Response): Promise<any> {
  const raw = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const messages = raw.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    return messages.find(m => m.id === 1);
  }
  return JSON.parse(raw);
}
test('tool listing requires authentication', async () => {
  assert.equal((await rpc('tools/list', {}, 'wrong')).status, 401);
});
test('MCP initialization uses SDK', async () => {
  const response = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(response.status, 200);
  const body = await rpcBody(response);
  assert.equal(body.result.serverInfo.name, 'skunkworks-365-mcp');
});
test('ten read-only tools, provider reads require tenant ID', async () => {
  const body = await rpcBody(await rpc('tools/list'));
  assert.equal(body.result.tools.length, 10);
  for (const tool of body.result.tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    if (tool.name !== 'tenants_list_authorized') assert.deepEqual(tool.inputSchema.required, tool.name === 'users_get' ? ['tenantId','userId'] : ['tenantId']);
  }
});
test('unauthorized tool arguments denied', async () => {
  const body = await rpcBody(await rpc('tools/call', { name: 'users_list', arguments: { tenantId: other } }));
  assert.equal(body.result.isError, true);
  assert.equal(JSON.parse(body.result.content[0].text).status, 'access_denied');
});
test('provider tool returns connector unavailable', async () => {
  const body = await rpcBody(await rpc('tools/call', { name: 'users_list', arguments: { tenantId } }));
  assert.equal(body.result.isError, true);
  assert.equal(JSON.parse(body.result.content[0].text).status, 'connector_unavailable');
});
test('cannot smuggle extra privileges into tool args', async () => {
  const body = await rpcBody(await rpc('tools/call', { name: 'users_list', arguments: { tenantId: other, approved: true } }));
  assert.ok(body.error || body.result?.isError);
});
test('JWT checks signature issuer audience expiry and claims', async () => {
  const keys = await generateKeyPair('RS256'), otherKeys = await generateKeyPair('RS256');
  const config = { issuer: principal.issuer, audience: 'https://resource.example.invalid/mcp', jwksUrl: 'https://identity.example.invalid/keys' };
  const verify = jwtVerifier(config, keys.publicKey);
  const sign = async (overrides: Record<string, unknown> = {}, key = keys.privateKey) => new SignJWT({
    iss: config.issuer, aud: config.audience, sub: principal.subject,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...overrides
  }).setProtectedHeader({ alg: 'RS256' }).sign(key);
  assert.deepEqual(await verify(await sign()), principal);
  await assert.rejects(verify(await sign({}, otherKeys.privateKey)));
  await assert.rejects(verify(await sign({ iss: 'https://attacker.invalid/' })));
  await assert.rejects(verify(await sign({ aud: 'https://graph.microsoft.com' })));
  await assert.rejects(verify(await sign({ exp: 1 })));
  await assert.rejects(verify(await sign({ sub: undefined })));
  await assert.rejects(verify(await sign({ exp: undefined })));
});
test('provider failures must not leak sensitive upstream errors', async () => {
  const failing = makeHttpApplication(async () => principal, grants, { async read() { throw new Error('secret-test-sentinel'); } });
  const response = await failing(new Request('http://localhost/mcp', {
    method: 'POST', headers: { authorization: 'Bearer test-only', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'users_list', arguments: { tenantId } } })
  }));
  const body = await rpcBody(response);
  assert.equal(JSON.parse(body.result.content[0].text).status, 'internal_error');
  assert.equal(JSON.stringify(body).includes('secret-test-sentinel'), false);
});
