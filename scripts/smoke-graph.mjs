// Uses operator-supplied credentials; prints counts and outcomes, never customer records or tokens.
import { GraphReadAdapter, graphTokenProvider } from '../dist/src/graph.js';
const tenant = process.env.GRAPH_TEST_TENANT_ID;
if (!tenant) throw new Error('GRAPH_TEST_TENANT_ID required');
const allowed = new Set([tenant]);
const adapter = new GraphReadAdapter(graphTokenProvider(process.env, allowed), allowed);
const checks = [];
try {
  for (const operation of ['users.list', 'licenses.capacity', 'service.health']) {
    const result = await adapter.read(operation, tenant, { limit: 1 });
    if (result.status !== 'ok' || result.liveData !== true) throw new Error('Unexpected provider status');
    checks.push({ operation, success: true, returnedItems: result.items.length });
  }
  console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), source: 'microsoft_graph', checks, hostedMcpTested: false }, null, 2));
} catch {
  console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), checks, success: false, message: 'Graph smoke test failed. Inspect permissions and credential configuration privately.' }, null, 2));
  process.exitCode = 1;
}
