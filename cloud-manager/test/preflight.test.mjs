import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectPreflight } from '../src/preflight.ts';

const tenant = '11111111-1111-4111-8111-111111111111';
const subscription = '22222222-2222-4222-8222-222222222222';
const client = '33333333-3333-4333-8333-333333333333';
const api = '44444444-4444-4444-8444-444444444444';
const resource = 'https://cloud.example/mcp';
const secret = 'synthetic-secret-never-print';
const subject = 'synthetic-subject-never-print';
const env = {
  CLOUD_MANAGER_RESOURCE_URL: resource,
  CLOUD_MANAGER_AUTHORIZATION_SERVER: 'https://login.microsoftonline.com/organizations/v2.0',
  CLOUD_MANAGER_DELEGATED_SCOPE: `${resource}/cloud.read`,
  CLOUD_MANAGER_TENANT_IDS: tenant,
  CLOUD_MANAGER_ALLOWED_CLIENT_IDS: client,
  CLOUD_MANAGER_API_CLIENT_ID: api,
  CLOUD_MANAGER_CLIENT_SECRET: secret,
  CLOUD_MANAGER_GRANTS_JSON: JSON.stringify([{ issuer: `https://login.microsoftonline.com/${tenant}/v2.0`, subject, tenantId: tenant, subscriptionId: subscription, operations: ['vm.list'] }]),
};
const status = (result, name) => result.checks.find(item => item.name === name);

test('valid synthetic configuration is checked offline and never claimed staging-ready', () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected network request'); };
  let result;
  try { result = inspectPreflight(env); } finally { globalThis.fetch = originalFetch; }
  assert.equal(calls, 0);
  assert.equal(result.localConfigurationValid, true);
  assert.equal(result.stagingReady, false);
  assert.deepEqual(status(result, 'remote_staging'), { name: 'remote_staging', status: 'blocked', code: 'LOCAL_PROTOTYPE_ONLY' });
  const serialized = JSON.stringify(result);
  for (const sensitive of [secret, subject, tenant, subscription, client, api, resource]) assert.ok(!serialized.includes(sensitive));
});

test('CLI exits nonzero even for valid local configuration because staging is blocked', () => {
  const cliPath = fileURLToPath(new URL('../src/preflight.ts', import.meta.url));
  const ok = spawnSync(process.execPath, [cliPath], { env: { ...process.env, ...env, NODE_ENV: 'test' }, encoding: 'utf8' });
  assert.equal(ok.status, 2);
  assert.equal(JSON.parse(ok.stdout).stagingReady, false);
  assert.ok(!ok.stdout.includes(secret) && !ok.stderr.includes(secret));
  const bad = spawnSync(process.execPath, [cliPath], { env: { ...process.env, ...env, CLOUD_MANAGER_TENANT_IDS: '*' }, encoding: 'utf8' });
  assert.equal(bad.status, 1);
});

test('missing and unsafe values fail with stable codes and no leaked values', () => {
  const cases = [
    [{ ...env, NODE_ENV: 'production' }, 'runtime_mode', 'LOCAL_MODE_REQUIRED'],
    [{ ...env, CLOUD_MANAGER_RESOURCE_URL: 'http://evil.invalid/mcp' }, 'resource_url', 'INVALID_RESOURCE_URL'],
    [{ ...env, CLOUD_MANAGER_AUTHORIZATION_SERVER: 'https://evil.invalid/organizations/v2.0' }, 'authorization_server', 'INVALID_AUTHORITY'],
    [{ ...env, CLOUD_MANAGER_DELEGATED_SCOPE: `${resource}/read\r\nSECRET` }, 'delegated_scope', 'INVALID_SCOPE'],
    [{ ...env, CLOUD_MANAGER_TENANT_IDS: '*' }, 'tenant_allowlist', 'INVALID_TENANTS'],
    [{ ...env, CLOUD_MANAGER_ALLOWED_CLIENT_IDS: client + ',' + client }, 'client_allowlist', 'INVALID_CLIENTS'],
    [{ ...env, CLOUD_MANAGER_API_CLIENT_ID: 'invalid' }, 'api_client_id', 'INVALID_API_CLIENT'],
    [{ ...env, CLOUD_MANAGER_CLIENT_SECRET: '' }, 'confidential_credential', 'CREDENTIAL_MISSING_OR_INVALID'],
    [{ ...env, CLOUD_MANAGER_GRANTS_JSON: '[]' }, 'explicit_grants', 'INVALID_GRANTS'],
    [{ ...env, CLOUD_MANAGER_GRANTS_JSON: JSON.stringify([{ issuer: 'https://evil.invalid', subject, tenantId: tenant, subscriptionId: subscription, operations: ['vm.list'] }]) }, 'explicit_grants', 'INVALID_GRANTS'],
  ];
  for (const [config, name, code] of cases) {
    const result = inspectPreflight(config);
    assert.equal(result.localConfigurationValid, false);
    assert.deepEqual(status(result, name), { name, status: 'fail', code });
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal(result.stagingReady, false);
  }
});

