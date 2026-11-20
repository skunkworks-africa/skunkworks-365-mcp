import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGrantPolicy } from '../src/grants.ts';

const tenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const subscriptionId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const principal = { issuer: 'https://issuer.example/', subject: 'user-1' };
const scope = { tenantId, subscriptionId };
const entry = { ...principal, ...scope, operations: ['vm.list'] };

test('grants only the configured principal, tenant, subscription and operation', async () => {
  const authorize = createGrantPolicy([entry]);
  assert.equal(await authorize(principal, scope, 'vm.list'), true);
  assert.equal(await authorize({ ...principal, subject: 'user-2' }, scope, 'vm.list'), false);
  assert.equal(await authorize({ ...principal, issuer: 'https://other.example/' }, scope, 'vm.list'), false);
  assert.equal(await authorize(principal, { ...scope, tenantId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }, 'vm.list'), false);
  assert.equal(await authorize(principal, { ...scope, subscriptionId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }, 'vm.list'), false);
  assert.equal(await authorize(principal, scope, 'cost.query'), false);
  assert.equal(await authorize(principal, { ...scope, tenantId: tenantId.toUpperCase() }, 'vm.list'), true);
});

test('rejects malformed and duplicate configuration and copies grant permissions', async () => {
  assert.throws(() => createGrantPolicy([{ ...entry, tenantId: '*' }]));
  assert.throws(() => createGrantPolicy([{ ...entry, operations: ['*'] }]));
  assert.throws(() => createGrantPolicy([entry, entry]));
  const mutable = { ...entry, operations: ['vm.list'] };
  const authorize = createGrantPolicy([mutable]);
  mutable.operations.push('cost.query');
  assert.equal(await authorize(principal, scope, 'cost.query'), false);
  assert.equal(await createGrantPolicy([])(principal, scope, 'vm.list'), false);
});

