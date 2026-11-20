import test from 'node:test';
import assert from 'node:assert/strict';
import { ArmClient, ArmError } from '../src/arm-client.ts';

const principal = { issuer: 'https://identity.example/tenant', subject: 'user-1' };
const scope = { tenantId: '11111111-1111-1111-1111-111111111111', subscriptionId: '22222222-2222-2222-2222-222222222222' };
const json = (x, init = {}) => new Response(JSON.stringify(x), { headers: { 'Content-Type': 'application/json' }, ...init });
const code = expected => error => error instanceof ArmError && error.code === expected;

test('authorization denies before token acquisition or network access', async () => {
  let called = false;
  const client = new ArmClient({ authorize: async () => false, getDelegatedToken: async () => { called = true; return 'token'; }, fetch: async () => { called = true; throw Error(); } });
  await assert.rejects(client.listVirtualMachines(principal, scope), code('forbidden'));
  assert.equal(called, false);
});

test('authorization receives the exact principal, normalized scope, and operation', async () => {
  let seen;
  const client = new ArmClient({ authorize: async (...args) => { seen = args; return true; }, getDelegatedToken: async () => 'token', fetch: async () => json({ value: [] }) });
  await client.listVirtualMachines(principal, { ...scope, tenantId: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA' });
  assert.deepEqual(seen, [principal, { ...scope, tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }, 'vm.list']);
});

test('tenant, subscription and principal must all match the host grant', async () => {
  let requests = 0;
  let tokens = 0;
  const client = new ArmClient({
    authorize: async (p, s) => p.issuer === principal.issuer && p.subject === principal.subject && s.tenantId === scope.tenantId && s.subscriptionId === scope.subscriptionId,
    getDelegatedToken: async () => { tokens++; return 'token'; },
    fetch: async () => { requests++; return json({ value: [] }); },
  });
  await client.listVirtualMachines(principal, scope);
  await assert.rejects(client.listVirtualMachines({ ...principal, subject: 'other-user' }, scope), code('forbidden'));
  await assert.rejects(client.listVirtualMachines(principal, { ...scope, tenantId: '33333333-3333-3333-3333-333333333333' }), code('forbidden'));
  await assert.rejects(client.listVirtualMachines(principal, { ...scope, subscriptionId: '44444444-4444-4444-4444-444444444444' }), code('forbidden'));
  assert.equal(requests, 1);
  assert.equal(tokens, 1);
});

test('provider exceptions never leak credential or other details', async () => {
  const sensitive = 'secret-token-or-provider-details';
  const authFailure = new ArmClient({ authorize: async () => { throw new Error(sensitive); }, getDelegatedToken: async () => { throw Error('must not run'); }, fetch: async () => { throw Error('must not run'); } });
  const tokenFailure = new ArmClient({ authorize: async () => true, getDelegatedToken: async () => { throw new Error(sensitive); }, fetch: async () => { throw Error('must not run'); } });
  for (const [client, expected] of [[authFailure, 'authorization_unavailable'], [tokenFailure, 'credential_unavailable']]) {
    await assert.rejects(client.listVirtualMachines(principal, scope), error => error.code === expected && !error.message.includes(sensitive));
  }
});

test('invalid principal, scope, and resource segments fail before network', async () => {
  let called = false;
  const client = new ArmClient({ authorize: async () => true, getDelegatedToken: async () => 'token', fetch: async () => { called = true; throw Error(); } });
  await assert.rejects(client.listVirtualMachines(principal, { ...scope, subscriptionId: '../evil' }), code('invalid_scope'));
  await assert.rejects(client.listVirtualMachines({ issuer: '', subject: 'x' }, scope), code('unauthenticated'));
  await assert.rejects(client.getVirtualMachineStatus(principal, scope, '../../other', 'vm'), code('invalid_resource'));
  assert.equal(called, false);
});

test('VM list uses fixed Azure origin, disables redirects and exposes only a bounded projection', async () => {
  let seen;
  const client = new ArmClient({ authorize: async () => true, getDelegatedToken: async () => 'delegated-token', fetch: async (url, options) => {
    seen = { url, options };
    return json({ value: [{ id: '/resource', name: 'vm1', location: 'westus', secret: 'do-not-return' }], nextLink: 'https://attacker.example/steal' });
  } });
  const result = await client.listVirtualMachines(principal, scope);
  assert.equal(seen.url.origin, 'https://management.azure.com');
  assert.equal(seen.options.redirect, 'error');
  assert.equal(seen.options.headers.Authorization, 'Bearer delegated-token');
  assert.deepEqual(result, { items: [{ id: '/resource', name: 'vm1', location: 'westus' }], incomplete: true });
});

test('instance view projects status and encodes allowed resource names', async () => {
  let url;
  const client = new ArmClient({ authorize: async () => true, getDelegatedToken: async () => 'token', fetch: async u => { url = u; return json({ statuses: [{ code: 'PowerState/running', displayStatus: 'VM running', message: 'private' }] }); } });
  assert.deepEqual(await client.getVirtualMachineStatus(principal, scope, 'Test Group', 'vm1'), { statuses: [{ code: 'PowerState/running', displayStatus: 'VM running' }] });
  assert.match(url.pathname, /resourceGroups\/Test%20Group\/providers\/Microsoft.Compute/);
});

test('cost query reports the selected period and actual currency without guessing', async () => {
  let args;
  const client = new ArmClient({ authorize: async () => true, getDelegatedToken: async () => 'token', fetch: async (url, options) => {
    args = { url, options };
    return json({ properties: { columns: [{ name: 'PreTaxCost' }, { name: 'Currency' }], rows: [[12.5, 'ZAR']] } });
  } });
  const result = await client.getSubscriptionCost(principal, scope, '2026-01-01', '2026-01-31');
  assert.deepEqual(result.items, [{ amount: 12.5, currency: 'ZAR' }]);
  assert.match(result.note, /pre-tax/);
  assert.equal(args.options.method, 'POST');
  assert.equal(JSON.parse(args.options.body).timeframe, 'Custom');
  assert.equal(JSON.parse(args.options.body).dataset.aggregation.totalCost.name, 'PreTaxCost');
});

test('cost result handles recognized columns and flags pagination', async () => {
  const client = new ArmClient({ authorize: async () => true, getDelegatedToken: async () => 'token', fetch: async () => json({ properties: { columns: [{ name: 'Cost' }, { name: 'Currency' }], rows: [[12.5, 'ZAR']], nextLink: 'https://attacker.example' } }) });
  const cost = await client.getSubscriptionCost(principal, scope, '2026-01-01', '2026-01-31');
  assert.deepEqual(cost.items, [{ amount: 12.5, currency: 'ZAR' }]);
  assert.equal(cost.incomplete, true);
  await assert.rejects(client.getSubscriptionCost(principal, scope, '2026-02-31', '2026-03-01'), code('invalid_date'));
});

test('missing currency, oversized and invalid responses fail closed', async () => {
  const mock = response => new ArmClient({ authorize: async () => true, getDelegatedToken: async () => 'token', fetch: async () => response });
  await assert.rejects(mock(json({ properties: { columns: [{ name: 'Cost' }], rows: [[1]] } })).getSubscriptionCost(principal, scope, '2026-01-01', '2026-01-31'), code('invalid_response'));
  await assert.rejects(mock(json({}, { headers: { 'content-length': '2000000' } })).listVirtualMachines(principal, scope), code('response_too_large'));
  await assert.rejects(mock(new Response('not-json')).listVirtualMachines(principal, scope), code('invalid_response'));
});

test('upstream errors do not expose response body or token', async () => {
  const client = new ArmClient({ authorize: async () => true, getDelegatedToken: async () => 'sensitive-token', fetch: async () => new Response('secret from upstream', { status: 403 }) });
  await assert.rejects(client.listVirtualMachines(principal, scope), e => e.code === 'azure_error' && !e.message.includes('secret') && !e.message.includes('token'));
});

