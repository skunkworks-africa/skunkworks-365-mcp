/** Offline, redacted configuration inspection for the local prototype. */
import { pathToFileURL } from 'node:url';
import { createConfiguredHandler } from './bootstrap.ts';
import { createGrantPolicy, type Grant } from './grants.ts';

type Environment = Record<string, string | undefined>;
type Check = { name: string; status: 'pass' | 'fail' | 'blocked'; code: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\x00-\x1f\x7f]/;

function value(env: Environment, name: string, max = 4096): string {
  const input = env[name];
  if (typeof input !== 'string' || !input || input.length > max || CONTROL.test(input)) throw new Error('invalid');
  return input;
}
function uuidList(env: Environment, name: string): string[] {
  const entries = value(env, name).split(',').map(item => item.trim().toLowerCase());
  if (entries.length > 1000 || entries.some(item => !UUID.test(item)) || new Set(entries).size !== entries.length) throw new Error('invalid');
  return entries;
}
function resource(env: Environment): URL {
  const raw = value(env, 'CLOUD_MANAGER_RESOURCE_URL');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname === '/' || url.pathname.endsWith('/') || url.href !== raw)
    throw new Error('invalid');
  return url;
}
function authority(env: Environment): void {
  const url = new URL(value(env, 'CLOUD_MANAGER_AUTHORIZATION_SERVER'));
  if (url.protocol !== 'https:' || url.hostname !== 'login.microsoftonline.com' || url.port || url.username || url.password || url.search || url.hash ||
      !/^\/(?:organizations|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/v2\.0$/i.test(url.pathname)) throw new Error('invalid');
}
function scope(env: Environment): void {
  const prefix = `${resource(env).href}/`;
  const full = value(env, 'CLOUD_MANAGER_DELEGATED_SCOPE');
  if (!full.startsWith(prefix)) throw new Error('invalid');
  const name = full.slice(prefix.length);
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(name) || name === '.' || name === '..') throw new Error('invalid');
}
function grants(env: Environment): void {
  const tenants = uuidList(env, 'CLOUD_MANAGER_TENANT_IDS');
  const parsed: unknown = JSON.parse(value(env, 'CLOUD_MANAGER_GRANTS_JSON', 65536));
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 1000) throw new Error('invalid');
  for (const entry of parsed as Grant[]) {
    if (!entry || typeof entry.tenantId !== 'string' || !UUID.test(entry.tenantId) || !tenants.includes(entry.tenantId.toLowerCase()) ||
      entry.issuer !== `https://login.microsoftonline.com/${entry.tenantId.toLowerCase()}/v2.0`) throw new Error('invalid');
  }
  createGrantPolicy(parsed as Grant[]);
}

/** Does not issue requests, authenticate, print credentials or provision resources. */
export function inspectPreflight(env: Environment): { checks: Check[]; localConfigurationValid: boolean; stagingReady: false } {
  const checks: Check[] = [];
  function check(name: string, code: string, fn: () => void) {
    try { fn(); checks.push({ name, status: 'pass', code: 'OK' }); }
    catch { checks.push({ name, status: 'fail', code }); }
  }
  check('runtime_mode', 'LOCAL_MODE_REQUIRED', () => { if (!env || env.NODE_ENV === 'production') throw new Error('invalid'); });
  check('resource_url', 'INVALID_RESOURCE_URL', () => { resource(env); });
  check('authorization_server', 'INVALID_AUTHORITY', () => { authority(env); });
  check('delegated_scope', 'INVALID_SCOPE', () => { scope(env); });
  check('tenant_allowlist', 'INVALID_TENANTS', () => { uuidList(env, 'CLOUD_MANAGER_TENANT_IDS'); });
  check('client_allowlist', 'INVALID_CLIENTS', () => { uuidList(env, 'CLOUD_MANAGER_ALLOWED_CLIENT_IDS'); });
  check('api_client_id', 'INVALID_API_CLIENT', () => { if (!UUID.test(value(env, 'CLOUD_MANAGER_API_CLIENT_ID'))) throw new Error('invalid'); });
  check('confidential_credential', 'CREDENTIAL_MISSING_OR_INVALID', () => { if (!value(env, 'CLOUD_MANAGER_CLIENT_SECRET').trim()) throw new Error('invalid'); });
  check('explicit_grants', 'INVALID_GRANTS', () => { grants(env); });
  // The actual constructor is the final authority if prototype validation evolves.
  check('runtime_configuration', 'BOOTSTRAP_REJECTED', () => { createConfiguredHandler(env); });
  const localConfigurationValid = checks.every(item => item.status === 'pass');
  checks.push({ name: 'remote_staging', status: 'blocked', code: 'LOCAL_PROTOTYPE_ONLY' });
  return { checks, localConfigurationValid, stagingReady: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = inspectPreflight(process.env);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  // A successful local configuration is not a staging approval: fail closed.
  process.exitCode = result.localConfigurationValid ? 2 : 1;
}

