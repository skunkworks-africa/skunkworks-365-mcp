import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler } from '../src/mcp-handler.ts';
import { ArmClient } from '../src/arm-client.ts';

const tenantA = '11111111-1111-1111-1111-111111111111';
const tenantB = '33333333-3333-3333-3333-333333333333';
const subscription = '22222222-2222-2222-2222-222222222222';
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const req = (method, params = { _meta: meta }, id = 1) => ({ jsonrpc: '2.0', method, params, id });
const call = (name, args, id = 1) => req('tools/call', { _meta: meta, name, arguments: args }, id);
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const context = { issuer: 'https://issuer.example', subject: 'alice', tenantId: tenantA };

function createFixture() {
  let factoryCalls = 0, tokenCalls = 0, networkCalls = 0;
  const handle = createMcpHandler({
    authenticate: async auth => auth === 'Bearer valid' ? context : null,
    clientForRequest: async (ctx, authorization) => {
      factoryCalls++;
      assert.equal(authorization, 'Bearer valid');
      return new ArmClient({
        authorize: async (principal, scope) => principal.subject === ctx.subject && scope.tenantId === ctx.tenantId && scope.subscriptionId === subscription,
        getDelegatedToken: async () => { tokenCalls++; return 'downstream-access-token'; },
        fetch: async () => { networkCalls++; return json({ value: [] }); },
      });
    },
  });
  return { handle, counts: () => ({ factoryCalls, tokenCalls, networkCalls }) };
}

test('requires host authentication and keeps provider errors private', async () => {
  const fixture = createFixture();
  for (const auth of [undefined, 'Basic bad', 'Bearer invalid', 'Bearer a b']) {
    const response = await fixture.handle(req('tools/list'), auth);
    assert.deepEqual(response, { status: 401, body: null });
  }
  const throwing = createMcpHandler({ authenticate: async () => { throw Error('secret'); }, clientForRequest: async () => { throw Error('unused'); } });
  assert.deepEqual(await throwing(req('tools/list'), 'Bearer token'), { status: 401, body: null });
  assert.deepEqual(fixture.counts(), { factoryCalls: 0, tokenCalls: 0, networkCalls: 0 });
});

test('negotiates 2026 discovery and exposes exactly four read-only tools', async () => {
  const { handle } = createFixture();
  const discovery = await handle(req('server/discover'), 'Bearer valid');
  assert.equal(discovery.body.result.resultType, 'complete');
  assert.deepEqual(discovery.body.result.supportedVersions, ['2026-07-28']);
  assert.equal(discovery.body.result.cacheScope, 'private');
  const listed = await handle(req('tools/list'), 'Bearer valid');
  assert.deepEqual(listed.body.result.tools.map(t => t.name), ['get_virtual_machine_cpu_metrics', 'list_virtual_machines', 'get_virtual_machine_status', 'get_subscription_cost']);
  assert.ok(listed.body.result.tools.every(t => t.annotations.readOnlyHint && t.inputSchema.additionalProperties === false));
  const wrong = await handle(req('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': 'bad' } }), 'Bearer valid');
  assert.equal(wrong.body.error.code, -32022);
  const malformed = await handle(req('server/discover', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }), 'Bearer valid');
  assert.equal(malformed.body.error.code, -32602);
});

test('validates JSON-RPC, inputs, unknown tools and notifications without calls', async () => {
  const { handle, counts } = createFixture();
  assert.equal((await handle({}, 'Bearer valid')).body.error.code, -32600);
  assert.equal((await handle(req('bogus'), 'Bearer valid')).body.error.code, -32601);
  assert.equal((await handle(call('bogus', {}), 'Bearer valid')).body.error.code, -32602);
  for (const args of [
    { tenantId: tenantA, subscriptionId: 'bad' },
    { tenantId: tenantA, subscriptionId: subscription, subject: 'fake' },
    { tenantId: tenantA, subscriptionId: subscription, authorization: 'Bearer attacker' },
  ]) assert.equal((await handle(call('list_virtual_machines', args), 'Bearer valid')).body.error.code, -32602);
  const notification = { jsonrpc: '2.0', method: 'tools/call', params: { _meta: meta, name: 'list_virtual_machines', arguments: { tenantId: tenantA, subscriptionId: subscription } } };
  assert.deepEqual(await handle(notification, 'Bearer valid'), { status: 202, body: null });
  assert.deepEqual(counts(), { factoryCalls: 0, tokenCalls: 0, networkCalls: 0 });
});

test('rejects a mismatched tenant before creating client and denies mismatched subscription', async () => {
  const { handle, counts } = createFixture();
  const crossTenant = await handle(call('list_virtual_machines', { tenantId: tenantB, subscriptionId: subscription }), 'Bearer valid');
  assert.equal(crossTenant.body.result.isError, true);
  assert.deepEqual(counts(), { factoryCalls: 0, tokenCalls: 0, networkCalls: 0 });
  const crossSubscription = await handle(call('list_virtual_machines', { tenantId: tenantA, subscriptionId: '44444444-4444-4444-4444-444444444444' }), 'Bearer valid');
  assert.equal(crossSubscription.body.result.isError, true);
  assert.deepEqual(counts(), { factoryCalls: 1, tokenCalls: 0, networkCalls: 0 });
});

test('routes four operations and suppresses factory and ARM exceptions', async () => {
  const seen = [];
  const clientForRequest = async () => ({
    listVirtualMachines: async (...args) => { seen.push(['list', ...args]); return { items: [] }; },
    getVirtualMachineStatus: async (...args) => { seen.push(['status', ...args]); return { statuses: [] }; },
    getVirtualMachineCpuMetrics: async (...args) => { seen.push(['cpu', ...args]); return { series: [] }; },
    getSubscriptionCost: async (...args) => { seen.push(['cost', ...args]); return { items: [], incomplete: false }; },
  });
  const handle = createMcpHandler({ authenticate: async () => context, clientForRequest });
  const base = { tenantId: tenantA, subscriptionId: subscription };
  for (const response of [
    await handle(call('list_virtual_machines', base), 'Bearer a'),
    await handle(call('get_virtual_machine_status', { ...base, resourceGroup: 'rg', vmName: 'vm' }), 'Bearer a'),
    await handle(call('get_virtual_machine_cpu_metrics', { ...base, resourceGroup: 'rg', vmName: 'vm', from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' }), 'Bearer a'),
    await handle(call('get_subscription_cost', { ...base, from: '2026-01-01', to: '2026-01-31' }), 'Bearer a'),
  ]) { assert.equal(response.body.result.resultType, 'complete'); assert.equal(response.body.result.content[0].type, 'text'); }
  assert.deepEqual(seen.map(x => x[0]), ['list', 'status', 'cpu', 'cost']);
  assert.ok(seen.every(x => x[1].subject === 'alice' && !('tenantId' in x[1])));
  const throwing = createMcpHandler({ authenticate: async () => context, clientForRequest: async () => { throw Error('secret-token'); } });
  const response = await throwing(call('list_virtual_machines', base), 'Bearer a');
  assert.equal(response.body.result.isError, true);
  assert.ok(!JSON.stringify(response).includes('secret-token'));
});

test('concurrent requests keep credentials bound to their verified contexts', async () => {
  const contexts = { 'Bearer token-a': context, 'Bearer token-b': { ...context, subject: 'bob', tenantId: tenantB } };
  const observed = [];
  const handle = createMcpHandler({
    authenticate: async authorization => contexts[authorization] ?? null,
    clientForRequest: async (ctx, authorization) => {
      await new Promise(resolve => setTimeout(resolve, ctx.subject === 'alice' ? 10 : 1));
      return {
        listVirtualMachines: async (principal, scope) => { observed.push([principal.subject, scope.tenantId, authorization]); return { items: [] }; },
        getVirtualMachineStatus: async () => ({}), getVirtualMachineCpuMetrics: async () => ({}), getSubscriptionCost: async () => ({}),
      };
    },
  });
  const responses = await Promise.all([
    handle(call('list_virtual_machines', { tenantId: tenantA, subscriptionId: subscription }, 'a'), 'Bearer token-a'),
    handle(call('list_virtual_machines', { tenantId: tenantB, subscriptionId: subscription }, 'b'), 'Bearer token-b'),
  ]);
  assert.ok(responses.every(r => !r.body.result.isError));
  assert.deepEqual(observed.sort((a,b) => a[0].localeCompare(b[0])), [['alice', tenantA, 'Bearer token-a'], ['bob', tenantB, 'Bearer token-b']]);
  assert.ok(!JSON.stringify(responses).includes('token-a'));
  assert.ok(!JSON.stringify(responses).includes('token-b'));
});

