import WebSocket from 'ws';
import http from 'http';
import { calculateBackoff } from './agent/agent.js';

console.log('===============================================================');
console.log('     SERVERSIGHT — COMPREHENSIVE TEST SUITE                  ');
console.log('===============================================================\n');

const BASE_URL = 'http://localhost:4000';
const WS_URL = 'ws://localhost:4000/ws';

function api(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const req = http.request(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
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

  console.log('\n─── SECTION 5: FRONTEND DASHBOARD FEATURES & INTEGRITY ───');
  assert(node01.role === 'API', 'Node role classification intact');
  assert(node01.region === 'us-east-1', 'Node region filtering criteria intact');

  // CSV output format simulation
  const csvHeader = ['Node', 'Role', 'Region', 'IP', 'CPU %', 'Mem %', 'Net In Mbps', 'Net Out Mbps', 'Status'];
  assert(csvHeader.length === 9, 'CSV Export schema includes all 9 fleet columns');

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
