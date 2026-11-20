import test from 'node:test';
import assert from 'node:assert/strict';
import { createOboExchange } from '../src/obo.ts';

const tenant = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const app = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const user = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const client = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const context = { tenantId: tenant, issuer: `https://login.microsoftonline.com/${tenant}/v2.0`, subject: 'subject', objectId: user, clientId: client };
const secret = 'SECRET!do-not-disclose';
const assertion = 'api-token-do-not-disclose';
const downstream = 'arm-token-do-not-disclose';

function make(options = {}) {
  return createOboExchange({ clientId: app, clientSecret: secret, verifyBearer: async () => context, ...options });
}

function success(token = downstream) {
  return new Response(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 3600 }), { status: 200 });
}

test('requires explicit confidential client configuration and verifier', () => {
  for (const options of [null, {}, { clientId: app, clientSecret: '', verifyBearer: async () => context },
    { clientId: '../../common', clientSecret: secret, verifyBearer: async () => context },
    { clientId: app, clientSecret: secret }]) {
    assert.throws(() => createOboExchange(options), e => e.code === 'not_configured');
  }
});

test('verifies the exact incoming assertion and requests a delegated ARM token at the fixed tenant authority', async () => {
  let verified = null;
  let recorded;
  const exchange = make({ verifyBearer: async token => { verified = token; return context; }, fetch: async (url, init) => { recorded = { url, init }; return success(); } });
  const result = await exchange(assertion, tenant.toUpperCase());
  assert.equal(verified, assertion);
  assert.deepEqual(result, { token: downstream, principal: context });
  assert.equal(recorded.url, `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`);
  assert.equal(recorded.init.method, 'POST');
  assert.equal(recorded.init.redirect, 'error');
  assert.equal(recorded.init.body.get('assertion'), assertion);
  assert.equal(recorded.init.body.get('client_id'), app);
  assert.equal(recorded.init.body.get('client_secret'), secret);
  assert.equal(recorded.init.body.get('scope'), 'https://management.azure.com//.default');
  assert.equal(recorded.init.body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(recorded.init.body.get('requested_token_use'), 'on_behalf_of');
  assert.equal(recorded.init.body.has('offline_access'), false);
});

test('rejects injection and invalid input before verifier or network', async () => {
  let called = 0;
  const exchange = make({ verifyBearer: async () => { called++; return context; }, fetch: async () => { called++; return success(); } });
  for (const bad of ['', '../common', `${tenant}/../../other`, 'https://evil.example', 'common']) {
    await assert.rejects(exchange(assertion, bad), e => e.code === 'invalid_tenant');
  }
  for (const bad of ['', 'abc\r\nInjected', 'a b', 'x'.repeat(32769)]) {
    await assert.rejects(exchange(bad, tenant), e => e.code === 'invalid_assertion');
  }
  assert.equal(called, 0);
});

test('rejects failed verification, tenant mismatch and false issuer without requesting a token', async () => {
  let networkCalls = 0;
  const fetch = async () => { networkCalls++; return success(); };
  for (const verifyBearer of [
    async () => { throw new Error(secret); },
    async () => ({ ...context, tenantId: user }),
    async () => ({ ...context, issuer: `https://login.microsoftonline.com.evil.example/${tenant}/v2.0` }),
    async () => ({ ...context, subject: '' }),
    async () => ({ ...context, objectId: 'not-a-guid' }),
  ]) {
    await assert.rejects(make({ verifyBearer, fetch })(assertion, tenant), e => e.code === 'invalid_context' && !e.message.includes(secret));
  }
  assert.equal(networkCalls, 0);
});

test('supports the documented v1 tenant issuer when the verifier authorizes it', async () => {
  const v1 = { ...context, issuer: `https://sts.windows.net/${tenant}/` };
  const result = await make({ verifyBearer: async () => v1, fetch: async () => success() })(assertion, tenant);
  assert.deepEqual(result.principal, v1);
});

test('sanitizes upstream failures and malformed token responses', async () => {
  for (const fetch of [
    async () => { throw new Error(`leaked ${assertion} ${secret}`); },
    async () => new Response(`echo ${secret} ${assertion}`, { status: 400 }),
    async () => new Response('not json', { status: 200 }),
    async () => new Response(JSON.stringify({ access_token: downstream, token_type: 'Bearer', expires_in: 0 }), { status: 200 }),
    async () => new Response(JSON.stringify({ access_token: 'token\nwith whitespace', token_type: 'Bearer', expires_in: 3600 }), { status: 200 }),
    async () => new Response('x'.repeat(65537), { status: 200 }),
  ]) {
    await assert.rejects(make({ fetch })(assertion, tenant), e => {
      assert.ok(['identity_unavailable', 'exchange_failed'].includes(e.code));
      assert.ok(!String(e).includes(secret) && !String(e).includes(assertion) && !String(e).includes(downstream));
      return true;
    });
  }
});

