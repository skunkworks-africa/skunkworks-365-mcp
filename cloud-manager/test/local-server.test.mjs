import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLocalServer } from '../src/local-server.ts';

test('local listener binds loopback, rejects unsafe config and maps requests to the trusted origin', async () => {
  const seen = [];
  const handler = async request => {
    seen.push({ url: request.url, host: request.headers.get('host'), auth: request.headers.get('authorization') });
    return new Response('ok', { status: 200, headers: { 'Cache-Control': 'no-store' } });
  };
  const resourceUrl = 'https://cloud.example/mcp';
  await assert.rejects(startLocalServer({ resourceUrl, handler, host: '0.0.0.0' }));
  await assert.rejects(startLocalServer({ resourceUrl: 'http://cloud.example/mcp', handler }));
  const server = await startLocalServer({ resourceUrl, handler, port: 0 });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: { authorization: 'Bearer local-test-only' }, body: '{}' });
    assert.equal(response.status, 200);
    assert.deepEqual(seen, [{ url: resourceUrl, host: null, auth: 'Bearer local-test-only' }]);
    assert.equal((await fetch(`${origin}/mcp`, { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${origin}/mcp`, { method: 'POST', body: 'x'.repeat(65537) })).status, 413);
    assert.equal(seen.length, 1);
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('production mode is refused', async () => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    await assert.rejects(startLocalServer({ resourceUrl: 'https://cloud.example/mcp', handler: async () => new Response() }));
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  }
});

