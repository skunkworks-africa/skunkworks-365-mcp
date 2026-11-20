import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startDemoServer, DEMO_TOKEN, DEMO_TENANT, DEMO_SUBSCRIPTION } from '../src/demo-server.ts';

const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const rpc = (name, args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: meta, name, arguments: args } });
const scope = { tenantId: DEMO_TENANT, subscriptionId: DEMO_SUBSCRIPTION };

function send(server, body, headers = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', authorization: `Bearer ${DEMO_TOKEN}`, ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('refuses production and non-loopback listen configurations', async () => {
  const old = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    await assert.rejects(startDemoServer(), /disabled/);
    process.env.NODE_ENV = 'test';
    await assert.rejects(startDemoServer({ host: '0.0.0.0' }), /127\.0\.0\.1/);
    await assert.rejects(startDemoServer({ host: 'localhost' }), /127\.0\.0\.1/);
    await assert.rejects(startDemoServer({ port: 65536 }), /port/);
  } finally { if (old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old; }
});

test('synthetic demo accepts only local demo requests and returns labeled data', async t => {
  const server = await startDemoServer();
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal(server.address().address, '127.0.0.1');
  const body = JSON.stringify(rpc('list_virtual_machines', scope));
  const ok = await send(server, body);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['x-cloud-manager-demo'], 'synthetic-data-only');
  const output = JSON.parse(JSON.parse(ok.body).result.content[0].text);
  assert.equal(output.demo, true);
  assert.equal(output.items[0].name, 'demo-vm');
  assert.equal((await send(server, body, { authorization: 'Bearer real-azure-token' })).status, 401);
  assert.equal((await send(server, body, { host: `evil.example:${server.address().port}` })).status, 403);
  assert.equal((await send(server, body, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await send(server, 'x'.repeat(65537))).status, 413);
  const cross = await send(server, JSON.stringify(rpc('list_virtual_machines', { ...scope, subscriptionId: '33333333-3333-4333-8333-333333333333' })));
  assert.equal(JSON.parse(cross.body).result.isError, true);
  const status = await send(server, JSON.stringify(rpc('get_virtual_machine_status', { ...scope, resourceGroup: 'demo-group', vmName: 'demo-vm' })));
  assert.equal(JSON.parse(JSON.parse(status.body).result.content[0].text).statuses[0].displayStatus, 'Demo running');
  const cpu = await send(server, JSON.stringify(rpc('get_virtual_machine_cpu_metrics', { ...scope, resourceGroup: 'demo-group', vmName: 'demo-vm', from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' })));
  const syntheticCpu = JSON.parse(JSON.parse(cpu.body).result.content[0].text);
  assert.equal(syntheticCpu.demo, true);
  assert.match(syntheticCpu.note, /not Azure metrics/);
  const cost = await send(server, JSON.stringify(rpc('get_subscription_cost', { ...scope, from: '2026-01-01', to: '2026-01-31' })));
  const syntheticCost = JSON.parse(JSON.parse(cost.body).result.content[0].text);
  assert.equal(syntheticCost.demo, true);
  assert.match(syntheticCost.note, /not Azure costs/);
});

