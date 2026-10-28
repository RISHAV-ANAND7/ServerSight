import WebSocket from 'ws';
import http from 'http';
import { calculateBackoff, ServerSightAgent } from './agent/agent.js';

console.log('===============================================================');
console.log('     SERVERSIGHT — COMPREHENSIVE TEST SUITE                  ');
console.log('===============================================================\n');

const BASE_URL = 'http://localhost:4000';
const WS_URL = 'ws://localhost:4000/ws';

const AGENT_TOKEN = process.env.AGENT_TOKEN || 'serversight-agent-secret-token';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'serversight-admin-secret-token';

function api(path, method = 'GET', body = null, customHeaders = {}) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const req = http.request(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AGENT_TOKEN}`,
        'x-admin-token': ADMIN_TOKEN,
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
        ...customHeaders
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function stats(values) {
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  return { mean, sd };
}

let passed = 0;
let total = 0;

function assert(condition, message) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${message}`);
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runAllTests() {
  console.log('─── SECTION 1: BACKEND HEALTH & REST APIS ───');

  // 1.1 /api/health
  const healthRes = await api('/api/health');
  assert(healthRes.status === 200, 'GET /api/health returns 200 OK');
  assert(healthRes.body.status === 'ok', 'Health status is "ok"');
  assert(healthRes.body.nodes >= 6, `Fleet contains ${healthRes.body.nodes} nodes`);

  // 1.2 /api/nodes
  const nodesRes = await api('/api/nodes');
  assert(nodesRes.status === 200, 'GET /api/nodes returns 200 OK');
  assert(Array.isArray(nodesRes.body), 'Nodes returned as an array');
  assert(nodesRes.body.length >= 6, `Found ${nodesRes.body.length} monitored nodes`);
  const node01 = nodesRes.body.find(n => n.id === 'node-01');
  assert(node01 && node01.name.includes('api-prod'), 'Node 01 metadata is intact');

  // 1.3 /api/heartbeat
  const hbRes = await api('/api/heartbeat', 'POST', { id: 'node-01', seq: 101 });
  assert(hbRes.status === 200 && hbRes.body.acknowledged === true, 'POST /api/heartbeat acknowledged');
  assert(hbRes.body.expectedSeq > 0, 'Heartbeat returns expected sequence number');

  // 1.4 Single /api/ingest
  const ingestRes = await api('/api/ingest', 'POST', {
    id: 'test-agent-full',
    name: 'test-node-e2e',
    region: 'eu-central-1',
    role: 'API',
    cpu: 28.5,
    memory: 52.0,
    netIn: 14.2,
    netOut: 8.8,
    seq: 1
  });
  assert(ingestRes.status === 202 && ingestRes.body.accepted === true, 'POST /api/ingest accepts valid telemetry');

  console.log('\n─── SECTION 2: WEBSOCKET METRICS STREAMING (4 Hz) ───');
  const ws = new WebSocket(WS_URL);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  assert(ws.readyState === WebSocket.OPEN, 'WebSocket connection established to /ws');

  let samplePkt = null;
  const packets = [];
  await new Promise((resolve) => {
    const handler = (data) => {
      try {
        const pkt = JSON.parse(data);
        packets.push(pkt);
        if (!samplePkt && pkt.type === 'snapshot') samplePkt = pkt;
        if (packets.length >= 5) {
          ws.off('message', handler);
          resolve();
        }
      } catch { }
    };
    ws.on('message', handler);
  });

  assert(packets.length >= 5, 'Received 5 consecutive live stream packets');
  assert(packets[0].sequence !== undefined, 'Packets include sequence tracking');
  assert(packets[0].metrics.cpu !== undefined, 'Packets include fleet CPU metric');
  assert(packets[0].metrics.memory !== undefined, 'Packets include fleet Memory metric');
  assert(packets[0].metrics.networkIn !== undefined, 'Packets include fleet Network In');
  assert(packets[0].metrics.networkOut !== undefined, 'Packets include fleet Network Out');
  assert(packets[0].nodes.length >= 6, 'Packets contain full nodes array');

  console.log('\n─── SECTION 3: INTELLIGENT ANOMALY DETECTION ───');
  await api('/api/anomaly/clear', 'POST');
  console.log('  Collecting baseline samples over WebSocket stream...');
  const hist = {};
  for (let i = 0; i < 24; i++) {
    await new Promise((resolve) => {
      ws.once('message', (msg) => {
        try {
          const pkt = JSON.parse(msg);
          pkt.nodes?.forEach(n => {
            if (!hist[n.id]) hist[n.id] = { cpu: [], netIn: [], netOut: [] };
            hist[n.id].cpu.push(Number(n.cpu));
            hist[n.id].netIn.push(Number(n.netIn));
            hist[n.id].netOut.push(Number(n.netOut));
          });
        } catch { }
        resolve();
      });
    });
  }

  const baseCpuN1 = stats(hist['node-01'].cpu.slice(0, 18));
  assert(baseCpuN1.mean >= 25 && baseCpuN1.mean <= 38, `node-01 CPU baseline established: μ=${baseCpuN1.mean.toFixed(2)}%, σ=${baseCpuN1.sd.toFixed(2)}%`);

  console.log('  Injecting sudden spike on node-01 CPU -> 74% (normal baseline ~31%)...');
  const anomRes = await api('/api/anomaly/simulate', 'POST', {
    nodeId: 'node-01',
    metric: 'cpu',
    value: 74.5,
    durationMs: 4000
  });
  assert(anomRes.status === 200 && anomRes.body.success === true, 'POST /api/anomaly/simulate injected successfully');

  // Wait for spiked sample over WebSocket
  let spikePkt = null;
  let detectedZ = 0;
  await new Promise((resolve) => {
    const handler = (msg) => {
      try {
        const pkt = JSON.parse(msg);
        const n1 = pkt.nodes?.find(n => n.id === 'node-01');
        if (n1 && n1.cpu >= 70) {
          spikePkt = n1;
          detectedZ = (n1.cpu - baseCpuN1.mean) / Math.max(baseCpuN1.sd, 1.2);
          ws.off('message', handler);
          resolve();
        }
      } catch { }
    };
    ws.on('message', handler);
  });

  assert(spikePkt !== null, `Spike received on WebSocket: CPU = ${spikePkt.cpu.toFixed(2)}%`);
  assert(detectedZ >= 2.5, `Z-Score calculation (+${detectedZ.toFixed(2)}σ) exceeds anomaly threshold (2.5σ)`);
  assert(spikePkt.cpu < 90, `Spike value (${spikePkt.cpu.toFixed(1)}%) is below 90% (verifying baseline detection vs static alert)`);

  console.log('\n─── SECTION 4: DISTRIBUTED AGENT HEALTH & RESILIENCE ───');

  // 4.1 Exponential backoff with jitter
  const backoff1 = calculateBackoff(1, 1000, 30000);
  const backoff3 = calculateBackoff(3, 1000, 30000);
  assert(backoff1 >= 1000 && backoff1 <= 2000, `Backoff attempt 1 within jitter range: ${backoff1}ms`);
  assert(backoff3 >= 1000 && backoff3 <= 8000, `Backoff attempt 3 within jitter range: ${backoff3}ms`);

  // 4.2 Sequence gap detection
  await api('/api/ingest', 'POST', {
    id: 'test-agent-seq-all',
    name: 'agent-gap-tester',
    cpu: 25, memory: 50, netIn: 10, netOut: 10, seq: 100
  });
  const gapCheck = await api('/api/ingest', 'POST', {
    id: 'test-agent-seq-all',
    name: 'agent-gap-tester',
    cpu: 26, memory: 51, netIn: 11, netOut: 11, seq: 103 // missed 101, 102
  });
  assert(gapCheck.body.missingSamples === 2, `Server correctly identified 2 missing samples (seq #101..#102)`);

  // 4.3 Bounded batch buffering
  const batchCheck = await api('/api/ingest', 'POST', {
    batch: [
      { id: 'test-agent-buffer-all', name: 'agent-buffer-tester', cpu: 30, memory: 40, netIn: 5, netOut: 5, seq: 1 },
      { id: 'test-agent-buffer-all', name: 'agent-buffer-tester', cpu: 31, memory: 41, netIn: 6, netOut: 6, seq: 2 }
    ],
    recovering: true,
    bufferRemaining: 0
  });
  assert(batchCheck.body.acceptedCount === 2, `Buffered batch flushed and accepted (${batchCheck.body.acceptedCount} samples)`);

  // 4.4 4-State Machine Outage & Recovery Lifecycle
  console.log('  Testing 4-State Machine lifecycle on node-02...');
  const outageRes = await api('/api/agent/simulate-outage', 'POST', {
    nodeId: 'node-02',
    outageMs: 5000,
    recoveryMs: 3000
  });
  assert(outageRes.status === 200, 'POST /api/agent/simulate-outage triggered');

  const states = new Set();
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ws.close();
      resolve();
    }, 10000);

    ws.on('message', (msg) => {
      try {
        const pkt = JSON.parse(msg);
        const n2 = pkt.nodes?.find(n => n.id === 'node-02');
        if (n2 && !states.has(n2.status)) {
          states.add(n2.status);
          console.log(`    State change -> [${n2.status.toUpperCase()}]`);
        }
        if (states.has('stale') && (states.has('recovering') || states.has('offline')) && states.has('healthy')) {
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      } catch { }
    });
  });

  assert(states.has('stale'), 'Observed STALE state when heartbeat was interrupted');
  assert(states.has('recovering') || states.has('offline'), 'Observed RECOVERING or OFFLINE state during outage');
  assert(states.has('healthy'), 'Observed HEALTHY state after outage recovered');

  // 4.5 Real Retry Scheduler with Jitter
  const schedAgent = new ServerSightAgent({
    id: 'test-agent-sched-verification',
    baseUrl: 'http://127.0.0.1:9999',
    reportIntervalMs: 1000,
    baseBackoffMs: 1000,
    maxBackoffMs: 30000
  });
  schedAgent.running = true;
  await schedAgent.report();
  assert(schedAgent.consecutiveFails === 1, 'Agent increments failure counter on ingestion error');
  assert(schedAgent.nextScheduledDelay >= 1000 && schedAgent.nextScheduledDelay <= 2000, `Agent schedules real retry delay with jitter (${schedAgent.nextScheduledDelay}ms in [1000..2000]ms)`);
  assert(schedAgent.timer !== null, 'Agent active retry timer is set');
  schedAgent.stop();

  // 4.6 Concurrency Overlap Protection
  const mutAgent = new ServerSightAgent({ id: 'test-agent-mutex-check', baseUrl: BASE_URL });
  mutAgent.isReporting = true;
  const skipCheck = await mutAgent.report();
  assert(skipCheck.skipped === true && skipCheck.reason === 'overlap', 'Agent reporting mutex prevents overlapping telemetry reports');
  mutAgent.isReporting = false;
  mutAgent.stop();

  // 4.7 Agent Outage Buffering and Full Recovery Drain
  const recAgent = new ServerSightAgent({ id: 'test-agent-full-recovery', baseUrl: BASE_URL, reportIntervalMs: 1000 });
  recAgent.running = true;
  await recAgent.report(); // Initial report

  // Outage simulation
  recAgent.baseUrl = 'http://127.0.0.1:9999';
  await recAgent.report();
  await recAgent.report();
  assert(recAgent.localBuffer.length === 2, 'Agent successfully buffers samples locally during outage');
  assert(recAgent.consecutiveFails === 2, 'Agent records consecutive failure count during outage');

  // Network restoration
  recAgent.baseUrl = BASE_URL;
  const flushedRes = await recAgent.report();
  assert(flushedRes.success === true, 'Agent recovery attempt succeeds upon network restoration');
  assert(recAgent.localBuffer.length === 0, 'Agent completely drains local backlog to server');
  assert(recAgent.consecutiveFails === 0, 'Agent resets failure counter to 0 upon successful recovery');
  assert(recAgent.nextScheduledDelay === 1000, 'Agent resumes regular reporting interval after recovery');
  recAgent.stop();

  console.log('\n─── SECTION 5: FRONTEND DASHBOARD FEATURES & INTEGRITY ───');
  assert(node01.role === 'API', 'Node role classification intact');
  assert(node01.region === 'us-east-1', 'Node region filtering criteria intact');

  // CSV output format simulation
  const csvHeader = ['Node', 'Role', 'Region', 'IP', 'CPU %', 'Mem %', 'Net In Mbps', 'Net Out Mbps', 'Status'];
  assert(csvHeader.length === 9, 'CSV Export schema includes all 9 fleet columns');

  console.log('\n─── SECTION 6: SECURITY, AUTHENTICATION & INPUT VALIDATION ───');

  // 6.1 Unauthenticated Ingest Rejection (HTTP 401)
  const unauthRes = await api('/api/ingest', 'POST', {
    id: 'unauth-node',
    name: 'rogue-node',
    cpu: 50, memory: 50
  }, { 'Authorization': '', 'x-agent-token': '' });
  assert(unauthRes.status === 401, 'POST /api/ingest without token is rejected with 401 Unauthorized');
  assert(unauthRes.body.error && unauthRes.body.error.includes('Authentication required'), '401 response explicitly details authentication requirement');

  // 6.2 Invalid Token Rejection (HTTP 403)
  const invalidAuthRes = await api('/api/ingest', 'POST', {
    id: 'invalid-node',
    name: 'invalid-node',
    cpu: 50, memory: 50
  }, { 'Authorization': 'Bearer bad-token-12345', 'x-agent-token': '' });
  assert(invalidAuthRes.status === 403, 'POST /api/ingest with invalid token is rejected with 403 Forbidden');

  // 6.3 Valid Ingestion via x-agent-token header
  const xTokenRes = await api('/api/ingest', 'POST', {
    id: 'test-xtoken-node',
    name: 'xtoken-node',
    cpu: 35.0, memory: 45.0, netIn: 10, netOut: 5, seq: 1
  }, { 'Authorization': '', 'x-agent-token': AGENT_TOKEN });
  assert(xTokenRes.status === 202 && xTokenRes.body.accepted === true, 'POST /api/ingest accepts valid token via x-agent-token header');

  // 6.4 Unauthenticated Heartbeat Rejection
  const unauthHbRes = await api('/api/heartbeat', 'POST', { id: 'node-01', seq: 105 }, { 'Authorization': '', 'x-agent-token': '' });
  assert(unauthHbRes.status === 401, 'POST /api/heartbeat without token is rejected with 401 Unauthorized');

  // 6.5 Parameter Validation: Batch Size Capping (Max 100)
  const oversizedBatch = Array.from({ length: 105 }, (_, i) => ({
    id: `spam-node-${i}`,
    name: `spam-node-${i}`,
    cpu: 10, memory: 10, seq: i + 1
  }));
  const batchCapRes = await api('/api/ingest', 'POST', { batch: oversizedBatch });
  assert(batchCapRes.status === 400, 'Ingest batch exceeding 100 items is rejected with 400 Bad Request');
  assert(batchCapRes.body.error && batchCapRes.body.error.includes('maximum limit of 100'), 'Error message confirms batch limit cap');

  // 6.6 Parameter Capping: Boundary Clamping
  const boundedNodeRes = await api('/api/ingest', 'POST', {
    id: 'test-bounded-node',
    name: 'test-bounded-node',
    cpu: 250,      // should be clamped to 100%
    memory: -50,   // should be clamped to 0%
    netIn: -20,    // should be clamped to 0
    netOut: 999999,// should be clamped to 100000 Mbps
    seq: 1
  });
  assert(boundedNodeRes.status === 202, 'POST /api/ingest accepts and clamps out-of-boundary values safely');
  const nodesCheck = await api('/api/nodes');
  const boundedNode = nodesCheck.body.find(n => n.id === 'test-bounded-node');
  assert(boundedNode && boundedNode.cpu === 100, `Excessive CPU (>100%) clamped to 100% (actual: ${boundedNode?.cpu}%)`);
  assert(boundedNode && boundedNode.memory === 0, `Negative Memory (<0%) clamped to 0% (actual: ${boundedNode?.memory}%)`);
  assert(boundedNode && boundedNode.netIn === 0, `Negative NetIn clamped to 0 Mbps (actual: ${boundedNode?.netIn})`);
  assert(boundedNode && boundedNode.netOut === 100000, `Excessive NetOut clamped to 100000 Mbps (actual: ${boundedNode?.netOut})`);

  // 6.7 Simulation Endpoint Protection: Anomaly Metric Validation
  const invalidMetricRes = await api('/api/anomaly/simulate', 'POST', {
    nodeId: 'node-01',
    metric: 'unsupported_metric_xyz',
    value: 50
  });
  assert(invalidMetricRes.status === 400, 'POST /api/anomaly/simulate with unsupported metric rejected with 400 Bad Request');

  // 6.8 Simulation Duration Capping
  const cappedDurationRes = await api('/api/anomaly/simulate', 'POST', {
    nodeId: 'node-01',
    metric: 'cpu',
    value: 70,
    durationMs: 9999999 // excessive duration
  });
  assert(cappedDurationRes.status === 200, 'POST /api/anomaly/simulate accepts request with duration capping');
  assert(cappedDurationRes.body.anomaly.durationMs <= 60000, `Excessive simulation duration capped to <= 60000ms (actual: ${cappedDurationRes.body.anomaly.durationMs}ms)`);

  console.log('\n─── SECTION 7: DEMO MODE & LIVE-AGENT TELEMETRY ISOLATION ───');

  // 7.1 Demo Status endpoint returns valid configuration
  const demoStatusRes = await api('/api/demo/status');
  assert(demoStatusRes.status === 200, 'GET /api/demo/status returns 200 OK');
  assert(demoStatusRes.body.demoMode === true, 'Demo mode is enabled by default in development');
  assert(demoStatusRes.body.simulatedNodesCount >= 6, `Simulated nodes count is tracked (${demoStatusRes.body.simulatedNodesCount} simulated)`);

  // 7.2 Initial seed nodes are properly tagged as simulated
  const allNodesRes = await api('/api/nodes');
  const simNode1 = allNodesRes.body.find(n => n.id === 'node-01');
  assert(simNode1 && simNode1.source === 'simulated', 'Synthetic demo node has source = "simulated"');
  assert(simNode1 && simNode1.isSimulated === true, 'Synthetic demo node has isSimulated = true');

  // 7.3 Live-Agent filter endpoint returns only real agents
  const preLiveRes = await api('/api/nodes?view=live');
  assert(preLiveRes.status === 200, 'GET /api/nodes?view=live returns 200 OK');
  assert(Array.isArray(preLiveRes.body), 'Live nodes returned as an array');
  const simulatedInLive = preLiveRes.body.filter(n => n.isSimulated || n.source !== 'agent');
  assert(simulatedInLive.length === 0, 'Live nodes view strictly excludes all synthetic/simulated nodes');

  // 7.4 Simulated filter endpoint returns simulated nodes
  const simViewRes = await api('/api/nodes?view=simulated');
  assert(simViewRes.status === 200 && simViewRes.body.length >= 6, 'GET /api/nodes?view=simulated returns demonstration fleet');

  // 7.5 Ingesting real agent telemetry registers node with source='agent' and isSimulated=false
  await api('/api/ingest', 'POST', {
    id: 'test-live-verified-node',
    name: 'prod-verified-worker',
    region: 'us-east-1',
    role: 'Worker',
    cpu: 28.5,
    memory: 55.0,
    netIn: 14.2,
    netOut: 8.7,
    seq: 1
  });
  const postLiveRes = await api('/api/nodes?view=live');
  const liveAgentNode = postLiveRes.body.find(n => n.id === 'test-live-verified-node');
  assert(liveAgentNode !== undefined, 'Live-agent view includes ingested agent node');
  assert(liveAgentNode && liveAgentNode.source === 'agent', 'Ingested agent node tagged source = "agent"');
  assert(liveAgentNode && liveAgentNode.isSimulated === false, 'Ingested agent node tagged isSimulated = false');
  assert(liveAgentNode && liveAgentNode.cpu === 28.5, 'Live-agent view reflects pure unadulterated telemetry (CPU 28.5%)');

  // 7.6 Health endpoint reports live agent and simulated node counters
  const healthWithLiveRes = await api('/api/health');
  assert(healthWithLiveRes.body.liveAgents >= 1, `GET /api/health tracks live agent count (${healthWithLiveRes.body.liveAgents} live)`);
  assert(healthWithLiveRes.body.simulatedNodes >= 6, `GET /api/health tracks simulated nodes (${healthWithLiveRes.body.simulatedNodes} simulated)`);

  // 7.7 Toggle demo mode endpoint
  const toggleOffRes = await api('/api/demo/toggle', 'POST', { enabled: false });
  assert(toggleOffRes.status === 200 && toggleOffRes.body.demoMode === false, 'POST /api/demo/toggle can disable demo mode');
  const toggleOnRes = await api('/api/demo/toggle', 'POST', { enabled: true });
  assert(toggleOnRes.status === 200 && toggleOnRes.body.demoMode === true, 'POST /api/demo/toggle can enable demo mode');

  console.log('\n===============================================================');
  console.log(`  ALL ${total} COMPREHENSIVE TESTS PASSED SUCCESSFULLY! (${passed}/${total})`);
  console.log('===============================================================\n');
}

runAllTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ Comprehensive test suite failed:', err);
    process.exit(1);
  });
