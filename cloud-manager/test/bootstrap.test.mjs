import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createConfiguredHandler } from '../src/bootstrap.ts';
import { startLocalServer } from '../src/local-server.ts';

const tenant = '11111111-1111-4111-8111-111111111111';
const subscription = '22222222-2222-4222-8222-222222222222';
const client = '33333333-3333-4333-8333-333333333333';
const api = '44444444-4444-4444-8444-444444444444';
const resource = 'https://cloud.example/mcp';
const grant = { issuer: `https://login.microsoftonline.com/${tenant}/v2.0`, subject: 'test-subject', tenantId: tenant, subscriptionId: subscription, operations: ['vm.list'] };
const env = {
  CLOUD_MANAGER_RESOURCE_URL: resource,
  CLOUD_MANAGER_AUTHORIZATION_SERVER: 'https://login.microsoftonline.com/organizations/v2.0',
  CLOUD_MANAGER_DELEGATED_SCOPE: `${resource}/cloud.read`,
  CLOUD_MANAGER_TENANT_IDS: tenant,
  CLOUD_MANAGER_ALLOWED_CLIENT_IDS: client,
  CLOUD_MANAGER_API_CLIENT_ID: api,
  CLOUD_MANAGER_CLIENT_SECRET: 'test-secret-not-a-real-credential',
  CLOUD_MANAGER_GRANTS_JSON: JSON.stringify([grant]),
};

test('requires explicit valid identity, scope and tenant-bound grants', () => {
  assert.throws(() => createConfiguredHandler({}));
  assert.throws(() => createConfiguredHandler({ ...env, NODE_ENV: 'production' }));
  assert.throws(() => createConfiguredHandler({ ...env, CLOUD_MANAGER_GRANTS_JSON: '[]' }));
  assert.throws(() => createConfiguredHandler({ ...env, CLOUD_MANAGER_TENANT_IDS: '*' }));
  assert.throws(() => createConfiguredHandler({ ...env, CLOUD_MANAGER_DELEGATED_SCOPE: 'https://evil.example/mcp/cloud.read' }));
  assert.throws(() => createConfiguredHandler({ ...env, CLOUD_MANAGER_GRANTS_JSON: JSON.stringify([{ ...grant, issuer: 'https://evil.example' }]) }));
  assert.throws(() => createConfiguredHandler({ ...env, CLOUD_MANAGER_GRANTS_JSON: JSON.stringify([{ ...grant, tenantId: client }]) }));
  assert.throws(() => createConfiguredHandler({ ...env, CLOUD_MANAGER_AUTHORIZATION_SERVER: 'https://evil.example/organizations/v2.0' }));
  assert.throws(() => createConfiguredHandler({ ...env, CLOUD_MANAGER_CLIENT_SECRET: 'secret\r\nheader' }));
  assert.doesNotThrow(() => createConfiguredHandler(env));
});

test('local listener serves configured metadata and rejects unauthenticated or cross-origin access', async () => {
  let identityCalls = 0, exchangeCalls = 0, armCalls = 0;
  const handler = createConfiguredHandler(env, {
    identityFetch: async () => { identityCalls++; throw new Error('unexpected'); },
    exchangeFetch: async () => { exchangeCalls++; throw new Error('unexpected'); },
    armFetch: async () => { armCalls++; throw new Error('unexpected'); },
  });
  await assert.rejects(startLocalServer({ resourceUrl: resource, handler, host: '0.0.0.0' }));
  const server = await startLocalServer({ resourceUrl: resource, handler, port: 0 });
  try {
    const local = `http://127.0.0.1:${server.address().port}`;
    const metadata = await fetch(`${local}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(metadata.status, 200);
    const details = await metadata.json();
    assert.equal(details.resource, resource);
    assert.deepEqual(details.scopes_supported, [`${resource}/cloud.read`]);
    const payload = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } };
    const response = await fetch(`${local}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' }, body: JSON.stringify(payload) });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /resource_metadata=/);
    const crossOrigin = await fetch(`${local}/mcp`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(crossOrigin.status, 403);
    assert.equal(identityCalls + exchangeCalls + armCalls, 0);
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('signed user reaches only their granted Azure scope through the configured loopback listener', async () => {
  const otherTenant = '55555555-5555-4555-8555-555555555555';
  const otherSubscription = '66666666-6666-4666-8666-666666666666';
  const user = '77777777-7777-4777-8777-777777777777';
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: 'test-key' });
  const claims = encode({ iss: grant.issuer, aud: api, tid: tenant, oid: user, azp: client, sub: grant.subject, ver: '2.0', scp: 'cloud.read', nbf: now - 30, exp: now + 3600 });
  const input = `${header}.${claims}`;
  const token = `${input}.${sign('RSA-SHA256', Buffer.from(input), pair.privateKey).toString('base64url')}`;
  const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0' };
  const calls = { exchange: [], arm: [] };
  const config = {
    ...env,
    CLOUD_MANAGER_TENANT_IDS: `${tenant},${otherTenant}`,
    CLOUD_MANAGER_GRANTS_JSON: JSON.stringify([grant, { ...grant, issuer: `https://login.microsoftonline.com/${otherTenant}/v2.0`, tenantId: otherTenant }]),
  };
  const handler = createConfiguredHandler(config, {
    identityFetch: async url => String(url).endsWith('/.well-known/openid-configuration')
      ? Response.json({ issuer: grant.issuer, jwks_uri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys` })
      : Response.json({ keys: [jwk] }),
    exchangeFetch: async (url, init) => {
      calls.exchange.push({ url: String(url), assertion: init.body.get('assertion') });
      return Response.json({ access_token: 'fake-arm-token', token_type: 'Bearer', expires_in: 3600 });
    },
    armFetch: async (url, init) => {
      calls.arm.push({ url: String(url), bearer: init.headers.Authorization });
      return Response.json({ value: [{ id: '/synthetic', name: 'test-vm', location: 'test-region' }] });
    },
  });
  const server = await startLocalServer({ resourceUrl: resource, handler, port: 0 });
  try {
    const local = `http://127.0.0.1:${server.address().port}/mcp`;
    const request = async (tenantId, subscriptionId) => {
      const payload = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }, name: 'list_virtual_machines', arguments: { tenantId, subscriptionId } } };
      return fetch(local, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'list_virtual_machines' }, body: JSON.stringify(payload) });
    };
    const response = await request(tenant, subscription);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(JSON.parse(JSON.parse(text).result.content[0].text).items[0].name, 'test-vm');
    assert.ok(!text.includes(token) && !text.includes(env.CLOUD_MANAGER_CLIENT_SECRET) && !text.includes('fake-arm-token'));
    assert.equal(calls.exchange.length, 1);
    assert.equal(calls.exchange[0].assertion, token);
    assert.equal(calls.arm[0].bearer, 'Bearer fake-arm-token');
    assert.ok(calls.arm[0].url.includes(`/subscriptions/${subscription}/`));
    const grantQuery = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }, name: 'list_authorized_subscriptions', arguments: {} } };
    const grantedResponse = await fetch(local, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'list_authorized_subscriptions' }, body: JSON.stringify(grantQuery) });
    const granted = JSON.parse((await grantedResponse.json()).result.content[0].text);
    assert.deepEqual(granted, { subscriptions: [{ subscriptionId: subscription, operations: ['vm.list'] }], incomplete: false });
    const deniedTenant = await (await request(otherTenant, subscription)).json();
    const deniedSubscription = await (await request(tenant, otherSubscription)).json();
    assert.equal(deniedTenant.result.isError, true);
    assert.equal(deniedSubscription.result.isError, true);
    assert.equal(calls.exchange.length, 1);
    assert.equal(calls.arm.length, 1);
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

