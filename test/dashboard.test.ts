import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHttpApplication } from '../src/http.js';
import type { Adapter, Grants, Principal } from '../src/domain.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const principal: Principal = { issuer: 'https://issuer.example/v2.0', subject: 'approved' };
const grants: Grants = [{ issuer: principal.issuer, subject: principal.subject, tenants: [{ id: tenantId, name: 'Approved tenant' }] }];
const calls: string[] = [];
const adapter: Adapter = { async read(operation, tenant) {
  calls.push(`${tenant}:${operation}`);
  return { status: 'ok', liveData: true, items: [{ service: 'Exchange', status: 'serviceOperational' }] };
} };
const app = makeHttpApplication(async token => {
  if (token !== 'approved') throw new Error('invalid token');
  return principal;
}, grants, adapter);
const get = (path: string, token?: string, method = 'GET') => app(new Request(`https://example.test${path}`, {
  method, headers: token ? { Authorization: `Bearer ${token}` } : {}
}));

test('dashboard requires the existing authenticated access grant', async () => {
  assert.equal((await get('/dashboard/api/tenants')).status, 401);
  assert.equal((await get('/dashboard/api/tenants', 'unapproved')).status, 401);
  const res = await get('/dashboard/api/tenants', 'approved');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { tenants: [{ id: tenantId, name: 'Approved tenant' }] });
});

test('dashboard cannot read an unapproved tenant or write data', async () => {
  calls.length = 0;
  assert.equal((await get(`/dashboard/api/tenant/${otherId}/summary`, 'approved')).status, 404);
  assert.equal((await get(`/dashboard/api/tenant/${tenantId}/summary`, 'approved', 'POST')).status, 405);
  assert.deepEqual(calls, []);
  const res = await get(`/dashboard/api/tenant/${tenantId}/summary`, 'approved');
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [`${tenantId}:service.health`, `${tenantId}:licenses.capacity`]);
  const data = await res.json() as { tenantId: string; health: { liveData: boolean }; licences: { liveData: boolean } };
  assert.equal(data.tenantId, tenantId);
  assert.equal(data.health.liveData, true);
  assert.equal(data.licences.liveData, true);
});
