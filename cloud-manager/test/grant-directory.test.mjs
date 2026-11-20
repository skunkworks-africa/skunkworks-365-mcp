import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGrantPolicy } from '../src/grants.ts';
import { createCloudManager } from '../src/service.ts';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SUB_A = '11111111-1111-4111-8111-111111111111';
const SUB_B = '22222222-2222-4222-8222-222222222222';
const SUB_C = '33333333-3333-4333-8333-333333333333';
const issuerA = `https://login.microsoftonline.com/${TENANT_A}/v2.0`;
const issuerB = `https://login.microsoftonline.com/${TENANT_B}/v2.0`;
const identity = (issuer, subject, tenantId) => ({ issuer, subject, tenantId, objectId: SUB_A, clientId: SUB_B });
const aliceA = identity(issuerA, 'alice', TENANT_A);
const bobA = identity(issuerA, 'bob', TENANT_A);
const aliceB = identity(issuerB, 'alice', TENANT_B);
const grants = [
  { issuer: issuerA, subject: 'alice', tenantId: TENANT_A, subscriptionId: SUB_A, operations: ['vm.list', 'vm.cpu'] },
  { issuer: issuerA, subject: 'bob', tenantId: TENANT_A, subscriptionId: SUB_B, operations: ['cost.query'] },
  { issuer: issuerB, subject: 'alice', tenantId: TENANT_B, subscriptionId: SUB_C, operations: ['vm.instanceView'] },
];
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const call = (args = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: meta, name: 'list_authorized_subscriptions', arguments: args } });

test('directory isolates principal and tenant, copies results and signals truncation', async () => {
  const policy = createGrantPolicy(grants);
  assert.deepEqual(await policy.list(aliceA, TENANT_A), { subscriptions: [{ subscriptionId: SUB_A, operations: ['vm.list', 'vm.cpu'] }], incomplete: false });
  assert.deepEqual(await policy.list(bobA, TENANT_A), { subscriptions: [{ subscriptionId: SUB_B, operations: ['cost.query'] }], incomplete: false });
  assert.deepEqual(await policy.list(aliceB, TENANT_B), { subscriptions: [{ subscriptionId: SUB_C, operations: ['vm.instanceView'] }], incomplete: false });
  assert.deepEqual(await policy.list(aliceA, TENANT_B), { subscriptions: [], incomplete: false });
  const result = await policy.list(aliceA, TENANT_A);
  result.subscriptions[0].operations.push('cost.query');
  assert.deepEqual((await policy.list(aliceA, TENANT_A)).subscriptions[0].operations, ['vm.list', 'vm.cpu']);
  const many = Array.from({ length: 101 }, (_, i) => ({ ...grants[0], subscriptionId: `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111` }));
  const bounded = await createGrantPolicy(many).list(aliceA, TENANT_A);
  assert.equal(bounded.subscriptions.length, 100);
  assert.equal(bounded.incomplete, true);
});

test('MCP tool uses only verified context and does not exchange credentials or call Azure', async () => {
  const policy = createGrantPolicy(grants);
  let exchangeCalls = 0, azureCalls = 0;
  const service = createCloudManager({
    verifyBearer: async token => {
      if (token === 'alice-token') return aliceA;
      if (token === 'bob-token') return bobA;
      if (token === 'alice-b-token') return aliceB;
      throw new Error('Invalid');
    },
    exchange: async () => { exchangeCalls++; throw new Error('Must not exchange'); },
    authorize: policy,
    listGrantedSubscriptions: policy.list,
    armFetch: async () => { azureCalls++; throw new Error('Must not call Azure'); },
  });
  const list = await service({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }, 'Bearer alice-token');
  assert.ok(list.body.result.tools.some(tool => tool.name === 'list_authorized_subscriptions'));
  for (const [token, expected] of [['alice-token', SUB_A], ['bob-token', SUB_B], ['alice-b-token', SUB_C]]) {
    const response = await service(call(), `Bearer ${token}`);
    const parsed = JSON.parse(response.body.result.content[0].text);
    assert.deepEqual(parsed.subscriptions.map(item => item.subscriptionId), [expected]);
    assert.ok(!JSON.stringify(response).includes(token));
  }
  for (const args of [{ tenantId: TENANT_B }, { subject: 'bob' }, { subscriptionId: SUB_B }]) {
    const response = await service(call(args), 'Bearer alice-token');
    assert.equal(response.body.error.code, -32602);
  }
  const withoutArguments = call();
  delete withoutArguments.params.arguments;
  const defaultArgs = await service(withoutArguments, 'Bearer alice-token');
  assert.deepEqual(JSON.parse(defaultArgs.body.result.content[0].text).subscriptions.map(item => item.subscriptionId), [SUB_A]);
  assert.equal((await service(call(null), 'Bearer alice-token')).body.error.code, -32602);
  assert.equal((await service(call(), 'Bearer bad-token')).status, 401);
  assert.equal(exchangeCalls, 0);
  assert.equal(azureCalls, 0);
});

