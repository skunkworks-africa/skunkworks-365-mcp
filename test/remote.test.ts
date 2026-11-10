import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, generateKeyPair } from 'jose';
import { authConfig, jwtVerifier } from '../src/auth.js';
import { remoteConfig, metadataUrl, protectedResourceMetadata } from '../src/remote.js';
import { makeHttpApplication } from '../src/http.js';
import { UnavailableAdapter } from '../src/domain.js';

const env = {
  MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
  MCP_AUTHORIZATION_SERVER: 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0',
  MCP_REQUIRED_SCOPE: 'access_as_user'
};
const remote = remoteConfig(env);
const app = makeHttpApplication(async () => { throw new Error('invalid'); }, [], new UnavailableAdapter(), remote);

test('strict remote-mode configuration', () => {
  assert.throws(() => remoteConfig({}));
  assert.throws(() => remoteConfig({ ...env, MCP_PUBLIC_URL: 'http://mcp.example.com/mcp' }));
  assert.throws(() => remoteConfig({ ...env, MCP_PUBLIC_URL: 'https://localhost/mcp' }));
  assert.throws(() => remoteConfig({ ...env, MCP_PUBLIC_URL: 'https://mcp.example.com/' }));
  assert.throws(() => remoteConfig({ ...env, MCP_AUTHORIZATION_SERVER: 'http://login.example.com' }));
  assert.throws(() => remoteConfig({ ...env, MCP_REQUIRED_SCOPE: 'bad scope' }));
});
test('resource discovery is complete and unauthenticated', async () => {
  assert.equal(metadataUrl(remote), 'https://mcp.example.com/.well-known/oauth-protected-resource');
  assert.deepEqual(protectedResourceMetadata(remote), {
    resource: env.MCP_PUBLIC_URL,
    authorization_servers: [env.MCP_AUTHORIZATION_SERVER],
    scopes_supported: ['access_as_user'],
    bearer_methods_supported: ['header']
  });
  const res = await app(new Request(metadataUrl(remote)));
  assert.equal(res.status, 200);
  assert.equal((await res.json() as { resource: string }).resource, env.MCP_PUBLIC_URL);
});
test('unauthenticated MCP calls receive resource metadata challenge', async () => {
  const res = await app(new Request(env.MCP_PUBLIC_URL, { method: 'POST' }));
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /resource_metadata="https:\/\/mcp.example.com\/\.well-known\/oauth-protected-resource"/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});
test('health probe does not publish customer data', async () => {
  const res = await app(new Request('https://mcp.example.com/healthz'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok', liveProviderConnections: false });
});
test('JWT verifier enforces audience and delegated OAuth scope', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const issuer = env.MCP_AUTHORIZATION_SERVER;
  const aud = '22222222-2222-4222-8222-222222222222';
  const verify = jwtVerifier(authConfig({
    MCP_TOKEN_ISSUER: issuer, MCP_TOKEN_AUDIENCE: aud,
    MCP_JWKS_URL: issuer + '/jwks', MCP_REQUIRED_SCOPE: 'access_as_user'
  }), publicKey);
  const sign = (claims: Record<string, unknown>) => new SignJWT({ sub: 'subject', scp: 'access_as_user', ...claims })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(issuer).setAudience(aud).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  assert.deepEqual(await verify(await sign({})), { issuer, subject: 'subject' });
  await assert.rejects(verify(await sign({ scp: 'User.Read' })));
  await assert.rejects(verify(await sign({ scp: undefined })));
  await assert.rejects(verify(await sign({ aud: 'https://graph.microsoft.com' })));
});
