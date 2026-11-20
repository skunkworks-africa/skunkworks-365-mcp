import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { EntraAuthenticator } from '../src/entra-auth.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const API = '33333333-3333-4333-8333-333333333333';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const ISS = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const key1 = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key2 = generateKeyPairSync('rsa', { modulusLength: 2048 });
const encode = data => Buffer.from(JSON.stringify(data)).toString('base64url');
const jwk = (pair, kid = 'key-1', issuer = 'https://login.microsoftonline.com/{tenantid}/v2.0') => ({ ...pair.publicKey.export({ format: 'jwk' }), kid, use: 'sig', issuer });
const baseClaims = { iss: ISS, aud: API, tid: TENANT, oid: USER, azp: CLIENT, sub: 'subject', ver: '2.0', scp: 'cloud.read', nbf: 1699999000, exp: 1700003600 };
function token(claims = {}, key = key1, header = {}) {
  const payload = `${encode({ alg: 'RS256', typ: 'JWT', kid: 'key-1', ...header })}.${encode({ ...baseClaims, ...claims })}`;
  return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), key.privateKey).toString('base64url')}`;
}
function harness({ keys = [jwk(key1)], metadata = {}, now: initial = 1700000000000 } = {}) {
  let currentTime = initial;
  let keyset = keys;
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: ISS, jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`, ...metadata });
    return Response.json({ keys: keyset });
  };
  const auth = new EntraAuthenticator({ audience: API, tenantIds: [TENANT], requiredScope: 'cloud.read', allowedClientIds: [CLIENT], fetch: fetcher, now: () => currentTime });
  return { auth, calls, setTime(value) { currentTime = value; }, setKeys(value) { keyset = value; } };
}

test('verifies real RS256 signature and returns immutable tenant and user context', async () => {
  const h = harness();
  assert.deepEqual(await h.auth.authenticate(token()), { issuer: ISS, subject: 'subject', tenantId: TENANT, objectId: USER, clientId: CLIENT });
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].options.redirect, 'error');
  assert.ok(h.calls.every(c => new URL(c.url).origin === 'https://login.microsoftonline.com'));
  assert.deepEqual(await h.auth.authenticate(token()), { issuer: ISS, subject: 'subject', tenantId: TENANT, objectId: USER, clientId: CLIENT });
  assert.equal(h.calls.length, 2);
});

test('rejects missing configuration and disabled tenant allowlists', () => {
  assert.throws(() => new EntraAuthenticator({ audience: API, tenantIds: [], requiredScope: 'cloud.read', allowedClientIds: [CLIENT] }));
  assert.throws(() => new EntraAuthenticator({ audience: API, tenantIds: [TENANT], requiredScope: '', allowedClientIds: [CLIENT] }));
  assert.throws(() => new EntraAuthenticator({ audience: API, tenantIds: [TENANT], requiredScope: 'cloud.read', allowedClientIds: [] }));
});

test('fails closed for wrong tenant, issuer, audience, actor, scope and app-only claims before network', async () => {
  const h = harness();
  for (const changed of [{ tid: OTHER }, { iss: `https://login.microsoftonline.com/${OTHER}/v2.0` }, { aud: OTHER }, { azp: OTHER }, { scp: 'other' }, { scp: undefined, roles: ['Reader'] }, { oid: 'not-a-guid' }, { sub: '' }, { ver: '1.0' }]) {
    await assert.rejects(h.auth.authenticate(token(changed)), { message: 'Authentication failed.' });
  }
  assert.equal(h.calls.length, 0);
});

test('rejects unsigned, modified, expired and not-yet-valid tokens', async () => {
  const h = harness();
  const bad = token().split('.');
  bad[1] = encode({ ...baseClaims, sub: 'attacker' });
  for (const value of [bad.join('.'), token({}, key2), token({ exp: 1700000000 }), token({ nbf: 1700000001 }), token({}, key1, { alg: 'none' }), token({}, key1, { jku: 'https://evil.example/keys' }), 'not.a.jwt']) {
    await assert.rejects(h.auth.authenticate(value), { message: 'Authentication failed.' });
  }
});

test('rejects attacker-controlled key headers, missing required claims and undersized RSA keys', async () => {
  const h = harness();
  for (const value of [
    token({}, key1, { jwk: jwk(key2) }),
    token({}, key1, { x5u: 'https://evil.example/cert' }),
    token({}, key1, { crit: ['custom'], custom: true }),
    token({ exp: undefined }), token({ nbf: undefined }),
  ]) await assert.rejects(h.auth.authenticate(value), { message: 'Authentication failed.' });
  assert.equal(h.calls.length, 0);
  const small = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const weak = harness({ keys: [jwk(small)] });
  await assert.rejects(weak.auth.authenticate(token({}, small)), { message: 'Authentication failed.' });
});

test('checks metadata issuer and pins the JWKS URL', async () => {
  for (const metadata of [{ issuer: 'https://evil.example' }, { jwks_uri: 'https://evil.example/keys' }, { jwks_uri: `https://login.microsoftonline.com/${OTHER}/discovery/v2.0/keys` }]) {
    const h = harness({ metadata });
    await assert.rejects(h.auth.authenticate(token()), { message: 'Authentication failed.' });
    assert.equal(h.calls.length, 1);
  }
});

test('rejects keys issued for a different tenant and duplicate key identifiers', async () => {
  for (const keys of [[jwk(key1, 'key-1', `https://login.microsoftonline.com/${OTHER}/v2.0`)], [jwk(key1), jwk(key1)]]) {
    const h = harness({ keys });
    await assert.rejects(h.auth.authenticate(token()), { message: 'Authentication failed.' });
  }
});

test('refreshes unknown key once after cooldown and handles signing-key rollover', async () => {
  const h = harness();
  await h.auth.authenticate(token());
  h.setKeys([jwk(key2, 'key-2')]);
  const rotated = token({}, key2, { kid: 'key-2' });
  await assert.rejects(h.auth.authenticate(rotated));
  assert.equal(h.calls.length, 2);
  h.setTime(1700000000000 + 5 * 60 * 1000);
  await h.auth.authenticate(rotated);
  assert.equal(h.calls.length, 4);
});

test('sanitizes provider exceptions and does not expose incoming token', async () => {
  const secret = 'provider-secret';
  const auth = new EntraAuthenticator({ audience: API, tenantIds: [TENANT], requiredScope: 'cloud.read', allowedClientIds: [CLIENT], now: () => 1700000000000, fetch: async () => { throw new Error(secret); } });
  const accessToken = token();
  await assert.rejects(auth.authenticate(accessToken), error => {
    assert.equal(error.message, 'Authentication failed.');
    assert.ok(!String(error.stack).includes(secret));
    assert.ok(!String(error.stack).includes(accessToken));
    return true;
  });
});

test('caps concurrent tenant discovery, shares same-tenant work and releases capacity after failure', async () => {
  const tenants = Array.from({ length: 5 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i + 1).padStart(12, '0')}`);
  const issued = tenant => token({ tid: tenant, iss: `https://login.microsoftonline.com/${tenant}/v2.0` });
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const auth = new EntraAuthenticator({
    audience: API, tenantIds: tenants, requiredScope: 'cloud.read', allowedClientIds: [CLIENT],
    now: () => 1700000000000,
    fetch: async url => {
      const tenant = new URL(url).pathname.split('/')[1];
      calls.push({ tenant, url });
      if (url.endsWith('/.well-known/openid-configuration')) {
        await gate;
        if (tenant === tenants[0]) throw new Error('private provider details');
        return Response.json({ issuer: `https://login.microsoftonline.com/${tenant}/v2.0`, jwks_uri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys` });
      }
      return Response.json({ keys: [jwk(key1)] });
    },
  });
  const pending = tenants.slice(0, 4).map(t => auth.authenticate(issued(t)));
  const duplicate = auth.authenticate(issued(tenants[0]));
  await assert.rejects(auth.authenticate(issued(tenants[4])), { message: 'Authentication failed.' });
  assert.equal(calls.length, 4, 'duplicate and over-budget tenants do not start new requests');
  release();
  const results = await Promise.allSettled([...pending, duplicate]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[4].status, 'rejected');
  assert.ok(results.slice(1, 4).every(result => result.status === 'fulfilled'));
  assert.equal(await auth.authenticate(issued(tenants[4])).then(p => p.tenantId), tenants[4]);
  assert.equal(calls.filter(call => call.tenant === tenants[0]).length, 1);
});

