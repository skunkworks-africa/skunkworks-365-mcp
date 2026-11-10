import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { GraphReadAdapter, GraphReadError, graphTokenProvider } from '../src/graph.js';
import { authConfig, jwtVerifier } from '../src/auth.js';
import { authorizedTenants, grantsSchema } from '../src/domain.js';
import { makeHttpApplication } from '../src/http.js';
import { protectedResourceMetadata, remoteConfig } from '../src/remote.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const user = '33333333-3333-4333-8333-333333333333';
const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
const principal = { issuer, subject: 'pairwise-subject', objectId: user };
const grants = grantsSchema.parse([{ issuer, objectId: user, tenants: [{ id: tenant, name: 'Test tenant' }] }]);
const allowed = new Set([tenant]);

test('Entra object-ID grants survive pairwise subjects but require the exact issuer and object ID', () => {
  assert.equal(authorizedTenants({ ...principal, subject: 'different-client-subject' }, grants).length, 1);
  assert.equal(authorizedTenants({ ...principal, objectId: other }, grants).length, 0);
  assert.equal(authorizedTenants({ issuer, subject: user }, grants).length, 0);
  assert.equal(authorizedTenants({ ...principal, issuer: 'https://other.invalid/' }, grants).length, 0);
  assert.throws(() => grantsSchema.parse([{ ...principal, tenants: [] }]));
});

test('Graph allowlist is enforced before credential acquisition and network access', async () => {
  let tokens = 0, requests = 0;
  const adapter = new GraphReadAdapter(async () => { tokens++; return 'token'; }, allowed, async () => { requests++; return Response.json({}); });
  await assert.rejects(adapter.read('users.list', other));
  await assert.rejects(adapter.read('users.list', 'invalid'));
  assert.equal(tokens, 0); assert.equal(requests, 0);
  const token = graphTokenProvider({ GRAPH_CLIENT_ID: other, GRAPH_CREDENTIAL_MODE: 'certificate', GRAPH_CERTIFICATE_PATH: 'nonexistent.pem' }, allowed);
  await assert.rejects(token(other), /not allowlisted/);
});

test('Graph users use fixed GET endpoint, bounded select and encoded cursor; responses are projected', async () => {
  const adapter = new GraphReadAdapter(async t => { assert.equal(t, tenant); return 'private-token'; }, allowed, async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://graph.microsoft.com'); assert.equal(url.pathname, '/v1.0/users');
    assert.equal(url.searchParams.get('$top'), '2'); assert.equal(url.searchParams.get('$skiptoken'), 'opaque&$select=password');
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error');
    return Response.json({ value: [{ id: user, displayName: 'Test', secretField: 'DO-NOT-RETURN' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=next' });
  });
  const result: any = await adapter.read('users.list', tenant, { limit: 2, cursor: 'opaque&$select=password' });
  assert.equal(result.status, 'ok'); assert.equal(result.nextCursor, 'next');
  assert.deepEqual(result.items, [{ id: user, displayName: 'Test' }]);
  await assert.rejects(adapter.read('users.list', tenant, { limit: 101 }));
});

test('individual user lookup only accepts UUIDs, never URL/path injection', async () => {
  let requests = 0;
  const adapter = new GraphReadAdapter(async () => 'token', allowed, async input => {
    requests++; assert.equal(new URL(String(input)).pathname, '/v1.0/users/' + user);
    return Response.json({ id: user, displayName: 'Test' });
  });
  await assert.rejects(adapter.read('users.get', tenant, { userId: '../applications' }));
  const result: any = await adapter.read('users.get', tenant, { userId: user });
  assert.equal(result.user.id, user); assert.equal(requests, 1);
});

test('license capacity and health do not request billing, write or unrelated Graph data', async () => {
  const paths: string[] = [];
  const adapter = new GraphReadAdapter(async () => 'token', allowed, async (input, init) => {
    paths.push(new URL(String(input)).pathname); assert.equal(init?.method, 'GET');
    return Response.json({ value: [] });
  });
  const capacity: any = await adapter.read('licenses.capacity', tenant);
  await adapter.read('service.health', tenant);
  const unavailable = await adapter.read('billing.records', tenant);
  assert.equal(capacity.billingData, false); assert.equal(unavailable.status, 'connector_unavailable');
  assert.deepEqual(paths, ['/v1.0/subscribedSkus','/v1.0/admin/serviceAnnouncement/healthOverviews']);
});

test('foreign next links and provider failures fail without leaking upstream data', async () => {
  const adapter = new GraphReadAdapter(async () => 'token', allowed, async () => Response.json({ value: [], '@odata.nextLink': 'https://attacker.invalid/?$skiptoken=x' }));
  await assert.rejects(adapter.read('users.list', tenant), /pagination destination/);
  const failed = new GraphReadAdapter(async () => 'token', allowed, async () => new Response('UPSTREAM-SECRET', { status: 403 }));
  await assert.rejects(failed.read('users.list', tenant), (error: any) => error instanceof GraphReadError && error.status === 403 && !String(error).includes('UPSTREAM-SECRET'));
});

test('Entra tokens require home tenant, v2, object identity, read role and delegated scope', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const config = authConfig({ MCP_TOKEN_ISSUER: issuer, MCP_TOKEN_AUDIENCE: other,
    MCP_JWKS_URL: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
    MCP_ENTRA_TENANT_ID: tenant, MCP_REQUIRED_ROLE: 'M365.Read', MCP_REQUIRED_SCOPE: 'access_as_user' });
  const verify = jwtVerifier(config, publicKey);
  const sign = (overrides: Record<string, unknown> = {}) => new SignJWT({ iss: issuer, aud: other,
    sub: principal.subject, tid: tenant, oid: user, ver: '2.0', roles: ['M365.Read'], scp: 'access_as_user', ...overrides })
    .setProtectedHeader({ alg: 'RS256' }).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  assert.deepEqual(await verify(await sign()), principal);
  for (const claims of [{ tid: other }, { ver: '1.0' }, { oid: undefined }, { roles: [] }, { roles: ['M365.Write'] }, { scp: undefined }, { aud: 'https://graph.microsoft.com' }]) {
    await assert.rejects(verify(await sign(claims)));
  }
  assert.throws(() => authConfig({ MCP_TOKEN_ISSUER: issuer, MCP_TOKEN_AUDIENCE: other, MCP_ENTRA_TENANT_ID: tenant, MCP_JWKS_URL: 'https://attacker.invalid/keys' }));
});

function rpc(body: object) { return new Request('http://localhost/mcp', { method: 'POST', headers: {
  authorization: 'Bearer token', 'content-type': 'application/json', accept: 'application/json, text/event-stream'
}, body: JSON.stringify(body) }); }

test('authenticated MCP Graph call returns success and cross-tenant request never reaches Graph', async () => {
  let calls = 0; const audits: Record<string, unknown>[] = [];
  const adapter = new GraphReadAdapter(async () => 'token', allowed, async () => { calls++; return Response.json({ value: [] }); });
  const app = makeHttpApplication(async () => principal, grants, adapter, undefined, { audit: event => audits.push(event) });
  async function call(tenantId: string) {
    const res = await app(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'users_list', arguments: { tenantId } } }));
    const text = await res.text();
    const json = res.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(text.split('\n').find(l => l.startsWith('data: '))!.slice(6)) : JSON.parse(text);
    return json.result;
  }
  assert.equal((await call(tenant)).isError, false);
  assert.equal((await call(other)).isError, true);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(audits).includes(tenant), false);
  assert.equal(JSON.stringify(audits).includes('Bearer'), false);
});

test('HTTP denies unregistered caller, oversized body and excessive authenticated requests', async () => {
  const adapter = new GraphReadAdapter(async () => 'token', allowed);
  const denied = makeHttpApplication(async () => ({ ...principal, objectId: other }), grants, adapter);
  assert.equal((await denied(rpc({}))).status, 403);
  const app = makeHttpApplication(async () => principal, grants, adapter, undefined, { rateLimit: 1 });
  assert.equal((await app(rpc({ large: 'x'.repeat(66_000) }))).status, 413);
  assert.equal((await app(rpc({}))).status, 429);
});

test('Entra discovery advertises full resource scope while token verifier checks bare scp', () => {
  const config = remoteConfig({ MCP_PUBLIC_URL: 'https://mcp.example.com/mcp', MCP_AUTHORIZATION_SERVER: issuer,
    MCP_REQUIRED_SCOPE: 'access_as_user', MCP_OAUTH_SCOPE: `api://${other}/access_as_user` });
  assert.deepEqual(protectedResourceMetadata(config).scopes_supported, [`api://${other}/access_as_user`]);
  assert.equal(config.scope, 'access_as_user');
});
