import test from 'node:test';
import assert from 'node:assert/strict';
import { ArmClient } from '../src/arm-client.ts';
import { createGrantPolicy } from '../src/grants.ts';

const principal = { issuer: 'https://identity.example/tenant', subject: 'user-1' };
const scope = { tenantId: '11111111-1111-1111-1111-111111111111', subscriptionId: '22222222-2222-2222-2222-222222222222' };
const from = '2026-01-01T00:00:00Z', to = '2026-01-02T00:00:00Z';
const json = value => Response.json(value);
const response = points => ({ interval: 'PT1H', value: [{ name: { value: 'Percentage CPU' }, unit: 'Percent', timeseries: [{ data: points }] }] });

test('VM CPU query uses fixed ARM origin, exact VM, bounded dates and delegated grant', async () => {
  let request, seen;
  const client = new ArmClient({ authorize: async (...args) => { seen = args; return true; }, getDelegatedToken: async () => 'token', fetch: async (url, options) => {
    request = { url, options };
    return json(response([{ timeStamp: from, average: 10.25 }, { timeStamp: '2026-01-01T01:00:00Z' }]));
  } });
  const result = await client.getVirtualMachineCpuMetrics(principal, scope, 'Group 1', 'vm1', from, to);
  assert.deepEqual(seen, [principal, scope, 'vm.cpu']);
  assert.equal(request.url.origin, 'https://management.azure.com');
  assert.match(request.url.pathname, /resourceGroups\/Group%201\/providers\/Microsoft.Compute\/virtualMachines\/vm1\/providers\/Microsoft.Insights\/metrics$/);
  assert.equal(request.url.searchParams.get('metricnames'), 'Percentage CPU');
  assert.equal(request.url.searchParams.get('timespan'), `${from}/${to}`);
  assert.equal(request.url.searchParams.get('interval'), 'PT1H');
  assert.equal(request.url.searchParams.get('aggregation'), 'Average');
  assert.equal(request.options.redirect, 'error');
  assert.equal(result.unit, 'Percent');
  assert.deepEqual(result.series, [[{ time: '2026-01-01T00:00:00.000Z', average: 10.25 }, { time: '2026-01-01T01:00:00.000Z', average: null }]]);
  assert.equal(result.noData, false);
  assert.equal(result.incomplete, false);
});

test('CPU metrics require their own grant and deny before token acquisition or network', async () => {
  let tokens = 0, network = 0;
  const authorize = createGrantPolicy([{ ...principal, ...scope, operations: ['vm.list'] }]);
  const client = new ArmClient({ authorize, getDelegatedToken: async () => { tokens++; return 'token'; }, fetch: async () => { network++; return json(response([])); } });
  await assert.rejects(client.getVirtualMachineCpuMetrics(principal, scope, 'rg', 'vm', from, to), { code: 'forbidden' });
  assert.equal(tokens, 0);
  assert.equal(network, 0);
});

test('rejects invalid resource paths and invalid or excessive time ranges before network', async () => {
  let calls = 0;
  const client = new ArmClient({ authorize: async () => { calls++; return true; }, getDelegatedToken: async () => 'token', fetch: async () => json(response([])) });
  for (const [group, start, end] of [
    ['../other', from, to], ['rg', '2026-02-30T00:00:00Z', to], ['rg', from, from],
    ['rg', from, '2026-01-09T00:00:00Z'], ['rg', '2026-01-01', to],
  ]) await assert.rejects(client.getVirtualMachineCpuMetrics(principal, scope, group, 'vm', start, end));
  assert.equal(calls, 0);
});

test('reports missing or incomplete data without following continuation links', async () => {
  let calls = 0;
  const client = new ArmClient({ authorize: async () => true, getDelegatedToken: async () => 'token', fetch: async () => { calls++; return json({ ...response([{ timeStamp: from }]), nextLink: 'https://evil.example/' }); } });
  const result = await client.getVirtualMachineCpuMetrics(principal, scope, 'rg', 'vm', from, to);
  assert.equal(result.noData, true);
  assert.equal(result.incomplete, true);
  assert.equal(calls, 1);
});

test('rejects metric errors and invalid metric points without fabricating measurements', async () => {
  const run = payload => new ArmClient({ authorize: async () => true, getDelegatedToken: async () => 'token', fetch: async () => json(payload) }).getVirtualMachineCpuMetrics(principal, scope, 'rg', 'vm', from, to);
  await assert.rejects(run({ value: [{ name: { value: 'Percentage CPU' }, errorCode: 'AccessDenied', timeseries: [] }] }), { code: 'invalid_response' });
  await assert.rejects(run(response([{ timeStamp: 'bad', average: 50 }])), { code: 'invalid_response' });
  await assert.rejects(run(response([{ timeStamp: from, average: '50' }])), { code: 'invalid_response' });
  assert.equal((await run({ value: [] })).noData, true);
});

