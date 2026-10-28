import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
app.use(express.json({ limit: '32kb' }));
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const PORT = Number(process.env.PORT || 4000);

const nodes = [
  { id: 'node-01', name: 'api-prod-us-east-1a', region: 'us-east-1', role: 'API', ip: '10.0.1.24', baseCpu: 31, baseMemory: 63, baseNetIn: 18, baseNetOut: 8, cpu: 31, memory: 63, netIn: 18, netOut: 8, lastSeen: Date.now(), lastSeq: 100, missingSamples: 0, bufferedSamples: 0, recovering: false },
  { id: 'node-02', name: 'api-prod-us-east-1b', region: 'us-east-1', role: 'API', ip: '10.0.1.31', baseCpu: 47, baseMemory: 71, baseNetIn: 24, baseNetOut: 11, cpu: 47, memory: 71, netIn: 24, netOut: 11, lastSeen: Date.now(), lastSeq: 100, missingSamples: 0, bufferedSamples: 0, recovering: false },
  { id: 'node-03', name: 'worker-prod-eu-west-1a', region: 'eu-west-1', role: 'Worker', ip: '10.2.4.16', baseCpu: 68, baseMemory: 54, baseNetIn: 12, baseNetOut: 19, cpu: 68, memory: 54, netIn: 12, netOut: 19, lastSeen: Date.now(), lastSeq: 100, missingSamples: 0, bufferedSamples: 0, recovering: false },
  { id: 'node-04', name: 'db-primary-eu-west-1', region: 'eu-west-1', role: 'Database', ip: '10.2.8.5', baseCpu: 24, baseMemory: 82, baseNetIn: 37, baseNetOut: 42, cpu: 24, memory: 82, netIn: 37, netOut: 42, lastSeen: Date.now(), lastSeq: 100, missingSamples: 0, bufferedSamples: 0, recovering: false },
  { id: 'node-05', name: 'cache-prod-ap-south-1', region: 'ap-south-1', role: 'Cache', ip: '10.4.2.11', baseCpu: 18, baseMemory: 46, baseNetIn: 8, baseNetOut: 6, cpu: 18, memory: 46, netIn: 8, netOut: 6, lastSeen: Date.now(), lastSeq: 100, missingSamples: 0, bufferedSamples: 0, recovering: false },
  { id: 'node-06', name: 'worker-prod-ap-south-1', region: 'ap-south-1', role: 'Worker', ip: '10.4.3.19', baseCpu: 55, baseMemory: 61, baseNetIn: 15, baseNetOut: 22, cpu: 55, memory: 61, netIn: 15, netOut: 22, lastSeen: Date.now(), lastSeq: 100, missingSamples: 0, bufferedSamples: 0, recovering: false }
];

const clients = new Set();
let tick = 0;
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

// Realistic fluctuation with natural harmonic wave and slight gaussian-like noise
function normalFluctuation(base, spread = 3) {
  const wave = Math.sin((tick + base) * 0.12) * (spread * 0.45);
  const noise = (Math.random() - 0.5) * (spread * 0.7);
  return clamp(base + wave + noise, 1, 99);
}

// Active anomaly state map: key `${nodeId}-${metric}` -> { nodeId, metric, value, expiry, startedAt }
const activeAnomalies = new Map();

// Active simulated outage map: key nodeId -> { outageStartedAt, outageUntil, recoveryUntil }
const simulatedOutages = new Map();

function injectAnomaly({ nodeId, metric = 'cpu', value, durationMs = 8000 }) {
  const node = nodes.find(n => n.id === nodeId) || nodes[0];
  const targetMetric = ['cpu', 'netIn', 'netOut'].includes(metric) ? metric : 'cpu';

  let targetVal;
  if (value !== undefined) {
    targetVal = Number(value);
  } else if (targetMetric === 'cpu') {
    targetVal = Math.min(node.baseCpu + 42, 85);
  } else if (targetMetric === 'netIn') {
    targetVal = Math.min(node.baseNetIn + 45, 95);
  } else {
    targetVal = Math.min(node.baseNetOut + 40, 85);
  }

  const expiry = Date.now() + durationMs;
  const anomalyObj = {
    nodeId: node.id,
    nodeName: node.name,
    metric: targetMetric,
    value: clamp(targetVal, 2, 98),
    baseline: node[`base${targetMetric[0].toUpperCase()}${targetMetric.slice(1)}`] || node[targetMetric],
    startedAt: Date.now(),
    expiry,
    durationMs
  };

  activeAnomalies.set(`${node.id}-${targetMetric}`, anomalyObj);
  console.log(`[ANOMALY INJECTED] Node: ${node.name} (${node.id}), Metric: ${targetMetric}, Baseline: ${anomalyObj.baseline}, Anomaly: ${anomalyObj.value}`);
  return anomalyObj;
}


function evaluateNodeHealth(node, now) {
  const sim = simulatedOutages.get(node.id);
  let effectiveLastSeen = node.lastSeen || now;
  let isSimRecovering = false;
  let simBufferCount = node.bufferedSamples || 0;

  if (sim) {
    if (now < sim.outageUntil) {
      // Outage in progress: hold lastSeen at the time the outage began
      effectiveLastSeen = sim.outageStartedAt;
    } else if (now < sim.recoveryUntil) {
      // Outage ended: reconnected, draining buffered telemetry
      effectiveLastSeen = now;
      isSimRecovering = true;
      const progress = (now - sim.outageUntil) / (sim.recoveryUntil - sim.outageUntil);
      simBufferCount = Math.max(0, Math.round((1 - progress) * 24));
    } else {
      // Outage fully resolved
      simulatedOutages.delete(node.id);
      node.lastSeen = now;
      effectiveLastSeen = now;
    }
  } else if (node.source !== 'agent') {
    node.lastSeen = now;
    effectiveLastSeen = now;
  }

  const ageMs = Math.max(0, now - effectiveLastSeen);
  const ageSec = Math.round(ageMs / 1000);

  let status = 'healthy';
  if (ageMs >= 9000) {
    status = 'offline';
  } else if (ageMs >= 3500) {
    status = 'stale';
  } else if (isSimRecovering || node.recovering || simBufferCount > 0) {
    status = 'recovering';
  } else if (node.memory > 88 || node.cpu > 92) {
    status = 'warning';
  } else {
    status = 'healthy';
  }

  return {
    status,
    lastSeen: effectiveLastSeen,
    lastSeenAgeSec: ageSec,
    recovering: status === 'recovering',
    bufferedSamples: simBufferCount
  };
}

function snapshot() {
  const timestamp = Date.now();

  // Expire finished anomalies
  for (const [key, anom] of activeAnomalies.entries()) {
    if (timestamp >= anom.expiry) {
      activeAnomalies.delete(key);
    }
  }

  const samples = nodes.map((node) => {
    if (node.source !== 'agent') {
      const anomCpu = activeAnomalies.get(`${node.id}-cpu`);
      const anomNetIn = activeAnomalies.get(`${node.id}-netIn`);
      const anomNetOut = activeAnomalies.get(`${node.id}-netOut`);

      node.cpu = anomCpu ? clamp(anomCpu.value + (Math.random() - 0.5) * 3, 2, 98) : normalFluctuation(node.baseCpu, 2.8);
      node.memory = normalFluctuation(node.baseMemory, 1.2);
      node.netIn = anomNetIn ? clamp(anomNetIn.value + (Math.random() - 0.5) * 4, 1, 99) : normalFluctuation(node.baseNetIn, 2.2);
      node.netOut = anomNetOut ? clamp(anomNetOut.value + (Math.random() - 0.5) * 3, 1, 95) : normalFluctuation(node.baseNetOut, 1.8);
    }

    const health = evaluateNodeHealth(node, timestamp);
    return {
      ...node,
      ...health,
      timestamp,
      lastSeq: node.lastSeq || 0,
      missingSamples: node.missingSamples || 0
    };
  });

  return {
    type: 'metrics',
    timestamp,
    sequence: ++tick,
    metrics: {
      cpu: samples.reduce((sum, node) => sum + node.cpu, 0) / samples.length,
      memory: samples.reduce((sum, node) => sum + node.memory, 0) / samples.length,
      networkIn: samples.reduce((sum, node) => sum + node.netIn, 0),
      networkOut: samples.reduce((sum, node) => sum + node.netOut, 0)
    },
    nodes: samples
  };
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok', nodes: nodes.length, clients: clients.size, uptime: process.uptime() }));
app.get('/api/nodes', (_req, res) => res.json(nodes.map((node) => ({ ...node }))));

// Endpoint to prune offline test nodes that are no longer reporting
app.all('/api/nodes/prune', (_req, res) => {
  const initialIds = new Set(['node-01', 'node-02', 'node-03', 'node-04', 'node-05', 'node-06']);
  const removed = [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (!initialIds.has(nodes[i].id) && (Date.now() - (nodes[i].lastSeen || 0) > 8000)) {
      removed.push(nodes[i].id);
      nodes.splice(i, 1);
    }
  }
  res.json({ success: true, removedCount: removed.length, removed });
});

app.all('/api/heartbeat', (req, res) => {
  const { id, seq } = req.method === 'POST' ? req.body : req.query;
  const targetId = String(id || 'node-01');
  const node = nodes.find(n => n.id === targetId);
  const now = Date.now();
  if (node) {
    node.lastSeen = now;
    node.lastHeartbeat = now;
    if (seq !== undefined && Number(seq) > 0) {
      const itemSeq = Number(seq);
      if (node.lastSeq > 0 && itemSeq > node.lastSeq + 1) {
        const gap = itemSeq - (node.lastSeq + 1);
        node.missingSamples = (node.missingSamples || 0) + gap;
      }
      node.lastSeq = Math.max(node.lastSeq || 0, itemSeq);
    }
  }
  res.json({
    acknowledged: true,
    nodeId: targetId,
    serverTime: now,
    status: node ? node.status : 'unknown',
    expectedSeq: node ? (node.lastSeq + 1) : 1
  });
});

// Outage and Recovery Simulation endpoint
app.all('/api/agent/simulate-outage', (req, res) => {
  const params = req.method === 'POST' ? req.body : req.query;
  const { nodeId, outageMs = 8000, recoveryMs = 5000 } = params || {};
  const targetId = String(nodeId || 'node-02');
  const node = nodes.find(n => n.id === targetId) || nodes[1];

  const now = Date.now();
  const outageStartedAt = now - 4000; // start 4s ago so it immediately enters 'stale' state!
  const outageUntil = now + Number(outageMs);
  const recoveryUntil = outageUntil + Number(recoveryMs);

  simulatedOutages.set(node.id, {
    nodeId: node.id,
    outageStartedAt,
    outageUntil,
    recoveryUntil
  });

  console.log(`[OUTAGE SIMULATED] Node ${node.name} (${node.id}): Outage until +${outageMs}ms, Recovery until +${Number(outageMs) + Number(recoveryMs)}ms`);

  res.json({
    success: true,
    nodeId: node.id,
    nodeName: node.name,
    outageStartedAt,
    outageUntil,
    recoveryUntil,
    timeline: {
      staleAt: 'Immediate (age > 3.5s)',
      offlineAt: `+${Math.max(0, 9000 - 4000)}ms (age > 9.0s)`,
      recoveringAt: `+${outageMs}ms (reconnected, draining buffer)`,
      healthyAt: `+${Number(outageMs) + Number(recoveryMs)}ms (buffer drained)`
    }
  });
});

// Endpoint to simulate an anomaly on-demand (used by UI button or test scripts)
app.all('/api/anomaly/simulate', (req, res) => {
  const params = req.method === 'POST' ? req.body : req.query;
  const { nodeId, metric, value, durationMs } = params || {};
  const targetNodeId = nodeId || nodes[Math.floor(Math.random() * nodes.length)].id;
  const result = injectAnomaly({
    nodeId: targetNodeId,
    metric: metric || 'cpu',
    value: value !== undefined ? Number(value) : undefined,
    durationMs: durationMs ? Number(durationMs) : 8000
  });
  res.json({ success: true, anomaly: result });
});

app.get('/api/anomalies/active', (_req, res) => {
  res.json(Array.from(activeAnomalies.values()));
});

app.all('/api/anomaly/clear', (_req, res) => {
  activeAnomalies.clear();
  res.json({ success: true, cleared: true });
});

// ─── Fault-Injection Lab Endpoints ──────────────────────────────────────────
let artificialIngestDelayMs = 0;
let artificialDelayUntil = 0;

// 1. Simulate Agent Crash (abrupt halt of reporting without clean shutdown)
app.all('/api/agent/simulate-crash', (req, res) => {
  const params = req.method === 'POST' ? req.body : req.query;
  const { nodeId = 'node-01', crashDurationMs = 12000 } = params || {};
  const target = nodes.find(n => n.id === String(nodeId)) || nodes[0];
  const now = Date.now();

  simulatedOutages.set(target.id, {
    nodeId: target.id,
    outageStartedAt: now - 4000,
    outageUntil: now + Number(crashDurationMs),
    recoveryUntil: now + Number(crashDurationMs) + 4000,
    isCrash: true
  });
  target.lastSeen = now - 4000;
  console.log(`[FAULT INJECTION] Agent crash simulated on ${target.name} (${target.id}) for ${crashDurationMs}ms`);

  res.json({
    success: true,
    fault: 'agent_crash',
    nodeId: target.id,
    nodeName: target.name,
    crashDurationMs: Number(crashDurationMs),
    recoveryAt: now + Number(crashDurationMs)
  });
});

// 2. Simulate Ingress Packet Delay / Network Jitter
app.all('/api/fault/delay-packets', (req, res) => {
  const params = req.method === 'POST' ? req.body : req.query;
  const { delayMs = 600, durationMs = 8000 } = params || {};
  artificialIngestDelayMs = Number(delayMs);
  artificialDelayUntil = Date.now() + Number(durationMs);
  console.log(`[FAULT INJECTION] Simulating ${delayMs}ms ingress packet delay for ${durationMs}ms`);
  res.json({ success: true, fault: 'delayed_packets', delayMs, durationMs });
});

// 3. Reset All Active Faults & Outages
app.all('/api/faults/reset', (_req, res) => {
  activeAnomalies.clear();
  simulatedOutages.clear();
  artificialIngestDelayMs = 0;
  artificialDelayUntil = 0;
  const now = Date.now();
  nodes.forEach(n => {
    n.lastSeen = now;
    n.status = 'healthy';
    n.recovering = false;
    n.bufferedSamples = 0;
  });
  console.log('[FAULT INJECTION] All faults cleared. Restored to nominal healthy fleet state.');
  res.json({ success: true, reset: true });
});

// 4. Query All Active Faults
app.get('/api/faults/active', (_req, res) => {
  const now = Date.now();
  const faults = [];
  if (activeAnomalies.size > 0) {
    faults.push(...Array.from(activeAnomalies.values()).map(a => ({ type: 'metric_spike', metric: a.metric, nodeId: a.nodeId, value: a.value })));
  }
  for (const [nodeId, o] of simulatedOutages.entries()) {
    if (now < o.outageUntil) {
      faults.push({ type: o.isCrash ? 'agent_crash' : 'network_outage', nodeId, remainingMs: Math.max(0, o.outageUntil - now) });
    } else if (now < o.recoveryUntil) {
      faults.push({ type: 'recovering', nodeId, remainingMs: Math.max(0, o.recoveryUntil - now) });
    }
  }
  if (artificialIngestDelayMs > 0 && now < artificialDelayUntil) {
    faults.push({ type: 'delayed_packets', delayMs: artificialIngestDelayMs, remainingMs: Math.max(0, artificialDelayUntil - now) });
  }
  res.json({ count: faults.length, faults });
});

// Periodic automatic anomaly demonstration
setInterval(() => {
  if (activeAnomalies.size === 0 && clients.size > 0) {
    const candidates = [
      { nodeId: 'node-01', metric: 'cpu', value: 74, durationMs: 7500 },
      { nodeId: 'node-05', metric: 'netIn', value: 52, durationMs: 8000 },
      { nodeId: 'node-02', metric: 'cpu', value: 78, durationMs: 7000 },
      { nodeId: 'node-04', metric: 'netOut', value: 76, durationMs: 7500 }
    ];
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    injectAnomaly(pick);
  }
}, 45000);

// Ingestion endpoint supporting single samples, sequence tracking, and buffered batches
app.post('/api/ingest', async (req, res) => {
  if (process.env.AGENT_TOKEN && req.get('authorization') !== `Bearer ${process.env.AGENT_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized agent' });
  }

  // Artificial ingress packet delay simulation if active
  if (artificialIngestDelayMs > 0 && Date.now() < artificialDelayUntil) {
    await new Promise(r => setTimeout(r, artificialIngestDelayMs));
  }

  const body = req.body || {};
  const items = Array.isArray(body) ? body : (Array.isArray(body.batch) ? body.batch : [body]);
  const isRecovering = Boolean(body.recovering || body.status === 'recovering' || (body.bufferRemaining && body.bufferRemaining > 0));
  const bufferRemaining = Number(body.bufferRemaining || 0);

  let targetNode = null;
  let acceptedCount = 0;

  for (const item of items) {
    const { id, name, region = 'unknown', role = 'Node', ip = '', cpu, memory, netIn = 0, netOut = 0, seq } = item || {};
    const values = [cpu, memory, netIn, netOut].map(Number);
    if (!id || !name || values.some(v => !Number.isFinite(v))) continue;

    const [cleanCpu, cleanMemory, cleanNetIn, cleanNetOut] = values;
    let node = nodes.find((n) => n.id === String(id));
    if (!node) {
      node = { id: String(id), missingSamples: 0, lastSeq: 0 };
      nodes.push(node);
    }
    targetNode = node;

    // Sequence Number Gap Identification
    const itemSeq = Number(seq);
    if (Number.isFinite(itemSeq) && itemSeq > 0) {
      if (node.lastSeq > 0 && itemSeq > node.lastSeq + 1) {
        const gap = itemSeq - (node.lastSeq + 1);
        node.missingSamples = (node.missingSamples || 0) + gap;
        console.warn(`[SEQUENCE GAP] Node ${name} (${id}) missed ${gap} sample(s)! Expected #${node.lastSeq + 1}, received #${itemSeq}`);
      }
      node.lastSeq = Math.max(node.lastSeq || 0, itemSeq);
    }

    Object.assign(node, {
      name: String(name).slice(0, 100),
      region: String(region).slice(0, 60),
      role: String(role).slice(0, 40),
      ip: String(ip).slice(0, 64),
      cpu: cleanCpu,
      memory: cleanMemory,
      netIn: cleanNetIn,
      netOut: cleanNetOut,
      source: 'agent',
      lastSeen: Date.now(),
      lastHeartbeat: Date.now(),
      recovering: isRecovering,
      bufferedSamples: bufferRemaining
    });

    acceptedCount++;
  }

  if (!targetNode) {
    return res.status(400).json({ error: 'Expected id, name and numeric metrics.' });
  }

  totalIngestCount += acceptedCount;

  res.status(202).json({
    accepted: true,
    acceptedCount,
    id: targetNode.id,
    status: targetNode.status || 'healthy',
    lastSeq: targetNode.lastSeq,
    missingSamples: targetNode.missingSamples || 0,
    serverTime: Date.now()
  });
});

const HIGH_WATERMARK = 64 * 1024;   // 64 KB: skip high-frequency broadcast for lagging client
const DROP_WATERMARK = 512 * 1024;  // 512 KB: terminate dead/zombie client
let totalIngestCount = 0;
let totalBroadcastCount = 0;
let backpressureDropCount = 0;

// Bounded Ring Buffer for historical fleet telemetry (strictly constant memory footprint)
class BoundedRingBuffer {
  constructor(capacity = 180) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.head = 0;
    this.length = 0;
  }
  push(item) {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.length < this.capacity) this.length++;
  }
  toArray() {
    const res = new Array(this.length);
    const start = (this.head - this.length + this.capacity) % this.capacity;
    for (let i = 0; i < this.length; i++) {
      res[i] = this.buffer[(start + i) % this.capacity];
    }
    return res;
  }
}

const fleetHistoryRing = new BoundedRingBuffer(180);

// Performance & Benchmark Stats endpoint
app.get('/api/benchmark/stats', (_req, res) => {
  const mem = process.memoryUsage();
  const now = Date.now();
  const activeFaults = [];
  if (activeAnomalies.size > 0) {
    activeFaults.push(...Array.from(activeAnomalies.values()).map(a => `spike_${a.metric}_${a.nodeId}`));
  }
  for (const [nodeId, o] of simulatedOutages.entries()) {
    if (now < o.outageUntil) activeFaults.push(o.isCrash ? `crash_${nodeId}` : `outage_${nodeId}`);
    else if (now < o.recoveryUntil) activeFaults.push(`recovering_${nodeId}`);
  }
  if (artificialIngestDelayMs > 0 && now < artificialDelayUntil) {
    activeFaults.push(`delay_${artificialIngestDelayMs}ms`);
  }

  res.json({
    status: 'ok',
    memory: {
      rssMb: Number((mem.rss / 1024 / 1024).toFixed(2)),
      heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
      heapTotalMb: Number((mem.heapTotal / 1024 / 1024).toFixed(2)),
      externalMb: Number((mem.external / 1024 / 1024).toFixed(2))
    },
    activeClients: clients.size,
    monitoredNodes: nodes.length,
    totalIngests: totalIngestCount,
    totalBroadcasts: totalBroadcastCount,
    backpressureDrops: backpressureDropCount,
    activeFaults,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: now
  });
});

app.get('/api/history', (_req, res) => {
  res.json(fleetHistoryRing.toArray());
});

server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});

wss.on('connection', (ws) => {
  clients.add(ws);
  const initial = snapshot();
  fleetHistoryRing.push({ timestamp: initial.timestamp, seq: initial.sequence, ...initial.metrics });
  ws.send(JSON.stringify({ ...initial, type: 'snapshot' }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// Broadcast fleet snapshot at 4 Hz with backpressure watermarks
setInterval(() => {
  if (!clients.size) return;
  const snap = snapshot();
  fleetHistoryRing.push({ timestamp: snap.timestamp, seq: snap.sequence, ...snap.metrics });
  const payload = JSON.stringify(snap);
  totalBroadcastCount++;

  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue;

    // Level 2 Backpressure: client buffer severely bloated (>512KB) -> terminate zombie connection
    if (client.bufferedAmount > DROP_WATERMARK) {
      console.warn(`[BACKPRESSURE] Terminating lagging consumer (${(client.bufferedAmount / 1024).toFixed(1)} KB buffer bloat).`);
      client.terminate();
      clients.delete(client);
      continue;
    }

    // Level 1 Backpressure: client buffer >64KB -> coalesce/skip tick to allow network buffer to drain
    if (client.bufferedAmount > HIGH_WATERMARK) {
      backpressureDropCount++;
      continue;
    }

    client.send(payload);
  }
}, 250);

server.listen(PORT, '0.0.0.0', () => console.log(`Metrics WebSocket server listening on ${PORT}`));
