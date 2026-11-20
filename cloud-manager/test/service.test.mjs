import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { EntraAuthenticator } from '../src/entra-auth.ts';
import { createOboExchange } from '../src/obo.ts';
import { createGrantPolicy } from '../src/grants.ts';
import { createCloudManager } from '../src/service.ts';
import { createHttpHandler } from '../src/http-handler.ts';

const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
const apiId = '33333333-3333-4333-8333-333333333333';
const clientId = '44444444-4444-4444-8444-444444444444';
const userA = '55555555-5555-4555-8555-555555555555';
const userB = '66666666-6666-4666-8666-666666666666';
const subA = '77777777-7777-4777-8777-777777777777';
const subB = '88888888-8888-4888-8888-888888888888';
const issuer = `https://login.microsoftonline.com/${tenantA}/v2.0`;
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig', issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0' };
function accessToken(subject, oid) {
  const head = encode({ alg: 'RS256', typ: 'JWT', kid: 'key-1' });
  const body = encode({ iss: issuer, aud: apiId, tid: tenantA, oid, azp: clientId, sub: subject, ver: '2.0', scp: 'cloud.read', nbf: 1699999000, exp: 1700003600 });
  const text = `${head}.${body}`;
  return `${text}.${sign('RSA-SHA256', Buffer.from(text), pair.privateKey).toString('base64url')}`;
}
const alice = accessToken('alice', userA);
const bob = accessToken('bob', userB);
const req = (tenantId, subscriptionId, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }, name: 'list_virtual_machines', arguments: { tenantId, subscriptionId } } });

function setup() {
  const network = { token: [], arm: [] };
  const auth = new EntraAuthenticator({ audience: apiId, tenantIds: [tenantA], requiredScope: 'cloud.read', allowedClientIds: [clientId], now: () => 1700000000000, fetch: async url => {
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer, jwks_uri: `https://login.microsoftonline.com/${tenantA}/discovery/v2.0/keys` });
    return Response.json({ keys: [jwk] });
  } });
  const exchange = createOboExchange({ clientId: apiId, clientSecret: 'test-only-secret', verifyBearer: t => auth.authenticate(t), fetch: async (url, init) => {
    const incoming = init.body.get('assertion');
    network.token.push({ url, incoming });
    const value = incoming === alice ? 'alice-arm-token' : incoming === bob ? 'bob-arm-token' : 'invalid';
    return Response.json({ access_token: value, token_type: 'Bearer', expires_in: 3600 });
  } });
  const authorize = createGrantPolicy([
    { issuer, subject: 'alice', tenantId: tenantA, subscriptionId: subA, operations: ['vm.list'] },
    { issuer, subject: 'bob', tenantId: tenantA, subscriptionId: subB, operations: ['vm.list'] },
    // Deliberate misconfiguration proves request tenant cannot override verified tenant.
    { issuer, subject: 'alice', tenantId: tenantB, subscriptionId: subA, operations: ['vm.list'] },
  ]);
  const service = createCloudManager({ verifyBearer: t => auth.authenticate(t), exchange, authorize, armFetch: async (url, init) => {
    network.arm.push({ url: String(url), bearer: init.headers.Authorization });
    return Response.json({ value: [{ id: '/mock', name: 'example-vm', location: 'test' }] });
  } });
  return { service, network };
}

test('signed delegated access token traverses verifier, grant, OBO and scoped ARM request', async () => {
  const { service, network } = setup();
  const response = await service(req(tenantA, subA), `Bearer ${alice}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.result.isError, undefined);
  assert.equal(network.token.length, 1);
  assert.equal(network.token[0].incoming, alice);
  assert.equal(network.arm.length, 1);
  assert.equal(network.arm[0].bearer, 'Bearer alice-arm-token');
  assert.match(network.arm[0].url, new RegExp(`/subscriptions/${subA}/`));
});

test('different tenant is rejected even if an explicit cross-tenant grant exists', async () => {
  const { service, network } = setup();
  const response = await service(req(tenantB, subA), `Bearer ${alice}`);
  assert.equal(response.body.result.isError, true);
  assert.equal(network.token.length, 0);
  assert.equal(network.arm.length, 0);
});

test('wrong subscription and tampered token fail before OBO or ARM', async () => {
  const { service, network } = setup();
  const response = await service(req(tenantA, subB), `Bearer ${alice}`);
  assert.equal(response.body.result.isError, true);
  const broken = `${alice.slice(0, -3)}xyz`;
  assert.equal((await service(req(tenantA, subA), `Bearer ${broken}`)).status, 401);
  assert.equal(network.token.length, 0);
  assert.equal(network.arm.length, 0);
});

test('concurrent requests keep each user assertion, grant and delegated token isolated', async () => {
  const { service, network } = setup();
  const responses = await Promise.all([
    service(req(tenantA, subA, 1), `Bearer ${alice}`),
    service(req(tenantA, subB, 2), `Bearer ${bob}`),
  ]);
  assert.ok(responses.every(r => r.status === 200 && r.body.result.isError === undefined));
  assert.equal(network.token.length, 2);
  assert.equal(network.arm.length, 2);
  const aliceRequest = network.arm.find(x => x.url.includes(subA));
  const bobRequest = network.arm.find(x => x.url.includes(subB));
  assert.equal(aliceRequest.bearer, 'Bearer alice-arm-token');
  assert.equal(bobRequest.bearer, 'Bearer bob-arm-token');
});

test('HTTP transport carries a signed bearer through the composed Azure operation', async () => {
  const { service, network } = setup();
  const endpoint = 'https://cloud.example/mcp';
  const http = createHttpHandler({ resourceUrl: endpoint, authorizationServer: 'https://login.microsoftonline.com/organizations/v2.0', delegatedScope: `${endpoint}/cloud.read`, handler: service });
  const request = new Request(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${alice}`, 'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call', 'mcp-name': 'list_virtual_machines',
    },
    body: JSON.stringify(req(tenantA, subA)),
  });
  const response = await http(request);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.result.isError, undefined);
  assert.equal(JSON.parse(body.result.content[0].text).items[0].name, 'example-vm');
  assert.ok(!JSON.stringify(body).includes(alice));
  assert.equal(network.token.length, 1);
  assert.equal(network.arm.length, 1);
  assert.equal(network.arm[0].bearer, 'Bearer alice-arm-token');
});

