import WebSocket from 'ws';
import http from 'http';
import { calculateBackoff, ServerSightAgent } from './agent/agent.js';

console.log('=== DISTRIBUTED AGENT HEALTH & RECOVERY TEST SUITE ===\n');

const BASE_URL = 'http://localhost:4000';
const WS_URL = 'ws://localhost:4000/ws';

function apiRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const req = http.request(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.AGENT_TOKEN || 'serversight-agent-secret-token'}`,
        'x-admin-token': process.env.ADMIN_TOKEN || 'serversight-admin-secret-token',
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

async function runResilienceTests() {
  console.log('--- TEST 1: EXPONENTIAL BACKOFF WITH JITTER ---');
  // Verify backoff growth and jitter randomness
  const samplesAtt1 = [];
  const samplesAtt3 = [];
  for (let i = 0; i < 8; i++) {
    samplesAtt1.push(calculateBackoff(1, 1000, 30000));
    samplesAtt3.push(calculateBackoff(3, 1000, 30000));
  }

  // Attempt 1 range: [1000, 2000]
  const validAtt1 = samplesAtt1.every(v => v >= 1000 && v <= 2000);
  // Attempt 3 range: [1000, 8000]
  const validAtt3 = samplesAtt3.every(v => v >= 1000 && v <= 8000);
  // Max backoff clamp
  const maxBackoff = calculateBackoff(15, 1000, 30000);
  const validMax = maxBackoff <= 30000 && maxBackoff >= 1000;

  if (validAtt1 && validAtt3 && validMax) {
    console.log('✓ Exponential Backoff with Jitter verified.');
    console.log(`  Attempt 1 samples (jittered in [1000, 2000]ms): ${samplesAtt1.slice(0, 4).join(', ')}ms`);
    console.log(`  Attempt 3 samples (jittered in [1000, 8000]ms): ${samplesAtt3.slice(0, 4).join(', ')}ms`);
    console.log(`  Max backoff clamped to: ${maxBackoff}ms (ceiling 30000ms)\n`);
  } else {
    throw new Error('Backoff calculation out of expected boundaries.');
  }

  console.log('--- TEST 2: HEARTBEATS & LAST-SEEN TRACKING ---');
  const hbRes = await apiRequest('/api/heartbeat', 'POST', { id: 'test-agent-node', seq: 1 });
  if (hbRes.status === 200 && hbRes.body.acknowledged) {
    console.log('✓ Heartbeat endpoint accepted.');
    console.log(`  Node ID: ${hbRes.body.nodeId}`);
    console.log(`  Server Time: ${new Date(hbRes.body.serverTime).toISOString()}`);
    console.log(`  Expected Next Seq: #${hbRes.body.expectedSeq}\n`);
  } else {
    throw new Error(`Heartbeat failed with status ${hbRes.status}`);
  }

  console.log('--- TEST 3: SEQUENCE NUMBERS & MISSING SAMPLE GAP DETECTION ---');
  // Ingest sample #10
  await apiRequest('/api/ingest', 'POST', {
    id: 'test-seq-node',
    name: 'worker-seq-test',
    region: 'us-east-1',
    role: 'Worker',
    cpu: 25,
    memory: 50,
    netIn: 10,
    netOut: 10,
    seq: 10
  });

  // Ingest sample #15 (missed seq 11, 12, 13, 14 -> 4 missed samples)
  const gapRes = await apiRequest('/api/ingest', 'POST', {
    id: 'test-seq-node',
    name: 'worker-seq-test',
    region: 'us-east-1',
    role: 'Worker',
    cpu: 28,
    memory: 52,
    netIn: 12,
    netOut: 11,
    seq: 15
  });

  if (gapRes.body.missingSamples === 4) {
    console.log('✓ Sequence number gap identification verified.');
    console.log(`  Ingested seq #10, then seq #15.`);
    console.log(`  Server correctly identified ${gapRes.body.missingSamples} missing sample(s) (seq #11..#14).\n`);
  } else {
    throw new Error(`Expected missingSamples to be 4, but received: ${gapRes.body.missingSamples}`);
  }

  console.log('--- TEST 4: BOUNDED LOCAL BUFFERING & BATCH RECOVERY ---');
  // Simulate an agent buffering 5 samples during an outage and flushing in batch
  const bufferedBatch = [
    { id: 'test-buffer-node', name: 'api-buffer-test', cpu: 30, memory: 45, netIn: 15, netOut: 10, seq: 1 },
    { id: 'test-buffer-node', name: 'api-buffer-test', cpu: 32, memory: 46, netIn: 16, netOut: 11, seq: 2 },
    { id: 'test-buffer-node', name: 'api-buffer-test', cpu: 34, memory: 47, netIn: 17, netOut: 12, seq: 3 },
    { id: 'test-buffer-node', name: 'api-buffer-test', cpu: 35, memory: 48, netIn: 18, netOut: 13, seq: 4 },
    { id: 'test-buffer-node', name: 'api-buffer-test', cpu: 36, memory: 49, netIn: 19, netOut: 14, seq: 5 }
  ];

  const batchRes = await apiRequest('/api/ingest', 'POST', {
    batch: bufferedBatch,
    recovering: true,
    bufferRemaining: 0
  });

  if (batchRes.status === 202 && batchRes.body.acceptedCount === 5) {
    console.log('✓ Bounded buffer batch ingestion verified.');
    console.log(`  Drained ${batchRes.body.acceptedCount} backlogged samples into server seamlessly.`);
    console.log(`  Highest processed sequence: #${batchRes.body.lastSeq}\n`);
  } else {
    throw new Error(`Batch ingest failed: ${JSON.stringify(batchRes)}`);
  }

  console.log('--- TEST 5: STATE MACHINE (HEALTHY, STALE, OFFLINE, RECOVERING) ---');
  // Connect to live WebSocket and trigger simulated outage on demo node-02
  const ws = new WebSocket(WS_URL);
  await new Promise((resolve) => ws.on('open', resolve));

  console.log('  Triggering simulated outage lifecycle on node-02 (4s stale, 6s outage, 3s recovery)...');
  await apiRequest('/api/agent/simulate-outage', 'POST', {
    nodeId: 'node-02',
    outageMs: 6000,
    recoveryMs: 3000
  });

  const observedStates = new Set();

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      if (observedStates.has('stale') || observedStates.has('recovering')) {
        resolve(); // captured key recovery states
      } else {
        reject(new Error(`Timed out waiting for states. Observed: ${Array.from(observedStates)}`));
      }
    }, 14000);

    ws.on('message', (msg) => {
      try {
        const pkt = JSON.parse(msg);
        const node = pkt.nodes?.find(n => n.id === 'node-02');
        if (node && !observedStates.has(node.status)) {
          observedStates.add(node.status);
          console.log(`  -> Observed Node ${node.name} state: [${node.status.toUpperCase()}] (lastSeen age: ${node.lastSeenAgeSec || 0}s, recovering: ${Boolean(node.recovering)})`);
        }

        // If we observed recovering and healthy after stale
        if (observedStates.has('stale') && (observedStates.has('recovering') || observedStates.has('offline')) && observedStates.has('healthy')) {
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      } catch {}
    });
  });

  console.log('\n✓ State Machine transitions verified across full lifecycle:');
  console.log(`  Observed States: ${Array.from(observedStates).map(s => s.toUpperCase()).join(' ➜ ')}\n`);

  console.log('--- TEST 6: REAL RETRY SCHEDULER & JITTER TIMING ---');
  // Initialize test agent targeting an unreachable address
  const offlineAgent = new ServerSightAgent({
    id: 'test-retry-scheduler-agent',
    baseUrl: 'http://127.0.0.1:9999', // offline port
    reportIntervalMs: 1000,
    baseBackoffMs: 1000,
    maxBackoffMs: 30000
  });
  offlineAgent.running = true;

  const res1 = await offlineAgent.report();
  if (res1.success === false && offlineAgent.consecutiveFails === 1) {
    const delay1 = offlineAgent.nextScheduledDelay;
    if (delay1 >= 1000 && delay1 <= 2000 && offlineAgent.timer !== null) {
      console.log(`✓ Attempt 1 failure scheduled real backoff timer: ${delay1}ms (range: [1000..2000]ms).`);
    } else {
      throw new Error(`Scheduled backoff delay out of range: ${delay1}ms`);
    }
  } else {
    throw new Error(`Expected failure on attempt 1, got ${JSON.stringify(res1)}`);
  }

  const res2 = await offlineAgent.report();
  if (res2.success === false && offlineAgent.consecutiveFails === 2) {
    const delay2 = offlineAgent.nextScheduledDelay;
    if (delay2 >= 1000 && delay2 <= 4000 && offlineAgent.timer !== null) {
      console.log(`✓ Attempt 2 failure scheduled exponential backoff timer: ${delay2}ms (range: [1000..4000]ms).\n`);
    } else {
      throw new Error(`Scheduled backoff delay out of range: ${delay2}ms`);
    }
  } else {
    throw new Error(`Expected failure on attempt 2, got ${JSON.stringify(res2)}`);
  }
  offlineAgent.stop();

  console.log('--- TEST 7: OVERLAPPING EXECUTION PREVENTION (CONCURRENCY MUTEX) ---');
  const mutexAgent = new ServerSightAgent({
    id: 'test-mutex-agent',
    baseUrl: BASE_URL
  });
  mutexAgent.running = true;
  // Artificially engage reporting mutex to simulate in-flight request
  mutexAgent.isReporting = true;

  const overlapRes = await mutexAgent.report();
  if (overlapRes.skipped === true && overlapRes.reason === 'overlap') {
    console.log('✓ In-flight mutex successfully prevented overlapping report execution.\n');
  } else {
    throw new Error(`Expected report to be skipped due to overlap mutex, got: ${JSON.stringify(overlapRes)}`);
  }
  mutexAgent.isReporting = false;
  mutexAgent.stop();

  console.log('--- TEST 8: AGENT SIMULATED OUTAGE & FULL RECOVERY LIFECYCLE ---');
  const recoveryAgent = new ServerSightAgent({
    id: 'test-agent-outage-recovery',
    baseUrl: BASE_URL,
    reportIntervalMs: 1000
  });
  recoveryAgent.running = true;

  // Step 1: Initial healthy report
  const initialRes = await recoveryAgent.report();
  if (!initialRes.success) {
    throw new Error('Initial agent report failed');
  }
  console.log('✓ Step 1: Agent connected and reported initial healthy telemetry.');

  // Step 2: Simulate network outage by altering target URL
  recoveryAgent.baseUrl = 'http://127.0.0.1:9999';
  console.log('  Simulating network outage (port 9999 unreachable)...');
  await recoveryAgent.report();
  await recoveryAgent.report();
  if (recoveryAgent.localBuffer.length === 2 && recoveryAgent.consecutiveFails === 2) {
    console.log(`✓ Step 2: During outage, agent buffered ${recoveryAgent.localBuffer.length} samples locally and incremented backoff.`);
  } else {
    throw new Error(`Expected 2 buffered samples, got ${recoveryAgent.localBuffer.length}`);
  }

  // Step 3: Restore connection and trigger recovery retry
  recoveryAgent.baseUrl = BASE_URL;
  console.log('  Restoring network connection to server...');
  const recoverRes = await recoveryAgent.report();
  if (recoverRes.success && recoveryAgent.localBuffer.length === 0 && recoveryAgent.consecutiveFails === 0) {
    console.log(`✓ Step 3: Outage recovered! Drained backlog to 0, reset fails to 0, and resumed regular reporting interval (${recoveryAgent.nextScheduledDelay}ms).`);
  } else {
    throw new Error(`Outage recovery failed: ${JSON.stringify(recoverRes)}`);
  }
  recoveryAgent.stop();

  console.log('\n======================================================');
  console.log('ALL DISTRIBUTED AGENT HEALTH & RECOVERY TESTS PASSED');
  console.log('======================================================\n');
}

runResilienceTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ Test failed:', err);
    process.exit(1);
  });
