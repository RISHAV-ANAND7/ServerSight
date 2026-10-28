import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
app.use(express.json({ limit: '32kb' }));

// ─── Cross-Origin Resource Sharing (CORS) ─────────────────────────────────────
// Enables separately hosted dashboards (e.g. Vercel, Netlify, custom domains)
// to communicate with the ServerSight backend API securely.
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-agent-token, x-admin-token');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const PORT = Number(process.env.PORT || 4000);

// ─── Environment & Security Configuration ─────────────────────────────────────
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_DEV = NODE_ENV !== 'production';

// Agent Ingestion Authentication
// In development/test: defaults to 'serversight-agent-secret-token' if AGENT_TOKEN is unset.
// In production: AGENT_TOKEN MUST be explicitly provided; unauthenticated ingest is rejected.
const DEFAULT_AGENT_TOKEN = 'serversight-agent-secret-token';
const AGENT_TOKEN = process.env.AGENT_TOKEN || (IS_DEV ? DEFAULT_AGENT_TOKEN : null);

// Administrative / Fault-Injection Access
// In development/test: permitted from localhost/loopback or with ADMIN_TOKEN.
// In production: simulation endpoints are disabled unless ENABLE_CHAOS_LAB='true'
// and a valid ADMIN_TOKEN is provided.
const DEFAULT_ADMIN_TOKEN = 'serversight-admin-secret-token';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || (IS_DEV ? DEFAULT_ADMIN_TOKEN : null);
const ENABLE_CHAOS_LAB = process.env.ENABLE_CHAOS_LAB === 'true' || IS_DEV;

// ─── Sanitization & Validation Helpers ────────────────────────────────────────
function sanitizeString(val, maxLen = 64, fallback = '') {
  if (typeof val !== 'string' && typeof val !== 'number') return fallback;
  const cleaned = String(val).trim().replace(/[^\w\.\-\:\/]/g, '').slice(0, maxLen);
  return cleaned || fallback;
}

function parseBoundedNumber(val, min, max, fallback) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

// ─── Authentication Middlewares ───────────────────────────────────────────────
function authenticateAgent(req, res, next) {
  if (!AGENT_TOKEN) {
    console.error('[SECURITY ERROR] Ingestion rejected: AGENT_TOKEN is not configured in production environment.');
    return res.status(503).json({
      error: 'Ingestion service unavailable: AGENT_TOKEN is not configured in production environment.'
    });
  }

  const authHeader = req.get('authorization') || '';
  const tokenFromBearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const providedToken = req.get('x-agent-token') || tokenFromBearer;

  if (!providedToken) {
    return res.status(401).json({
      error: 'Authentication required: provide agent token via "Authorization: Bearer <token>" or "x-agent-token" header.'
    });
  }

  if (providedToken !== AGENT_TOKEN) {
    return res.status(403).json({ error: 'Forbidden: invalid agent token.' });
  }

  next();
}

function requireSimulationAuth(req, res, next) {
  if (!ENABLE_CHAOS_LAB) {
    return res.status(403).json({
      error: 'Forbidden: Fault-injection and simulation endpoints are disabled in production. Set ENABLE_CHAOS_LAB=true to permit in staging/lab environments.'
    });
  }

  const authHeader = req.get('authorization') || '';
  const tokenFromBearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const providedToken = req.get('x-admin-token') || tokenFromBearer || (req.query && req.query.admin_token);

  const clientIp = req.ip || req.socket.remoteAddress || '';
  const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'].some(ip => clientIp.includes(ip));

  // In local development environment, permit requests without explicit token if coming from loopback
  if (IS_DEV && isLoopback && !providedToken) {
    return next();
  }

  if (!ADMIN_TOKEN) {
    return res.status(503).json({
      error: 'Simulation authorization unavailable: ADMIN_TOKEN must be configured in non-development environments.'
    });
  }

  if (providedToken !== ADMIN_TOKEN) {
    return res.status(401).json({
      error: 'Unauthorized: valid admin token required (Authorization: Bearer <ADMIN_TOKEN> or x-admin-token header).'
    });
  }

  next();
}

const DEMO_MODE = process.env.DEMO_MODE !== 'false';
let demoModeEnabled = DEMO_MODE;

const nodes = [
  { id: 'node-01', name: 'api-prod-us-east-1a', region: 'us-east-1', role: 'API', ip: '10.0.1.24', baseCpu: 31, baseMemory: 63, baseNetIn: 18, baseNetOut: 8, cpu: 31, memory: 63, netIn: 18, netOut: 8, lastSeen: Date.now(), lastSeq: 100, missingSamples: 0, bufferedSamples: 0, recovering: false, source: 'simulated', isSimulated: true },
  { id: 'node-02', name: 'api-prod-us-east-1b', region: 'us-east-1', role: 'API', ip: '10.0.1.31', baseCpu: 47, baseMemory: 71, baseNetIn: 24, baseNetOut: 11, cpu: 47, memory: 71, netIn: 24, netOut: 11, lastSeen: Date.now(), lastSeq: 100, missingSamples: 0, bufferedSamples: 0, recovering: false, source: 'simulated', isSimulated: true },
  { id: 'node-03', name: 'worker-prod-eu-west-1a', region: 'eu-west-1', role: 'Worker', ip: '10.2.4.16', baseCpu: 68, baseMemory: 54, baseNetIn: 12, baseNetOut: 19, cpu: 68, memory: 54, netIn: 12, netOut: 19, lastSeen: Date.now(), lastSeq: 100, missingSamples: 0, bufferedSamples: 0, recovering: false, source: 'simulated', isSimulated: true },
  { id: 'node-04', name: 'db-primary-eu-west-1', region: 'eu-west-1', role: 'Database', ip: '10.2.8.5', baseCpu: 24, baseMemory: 82, baseNetIn: 37, baseNetOut: 42, cpu: 24, memory: 82, netIn: 37, netOut: 42, lastSeen: Date.now(), lastSeq: 100, missingSamples: 0, bufferedSamples: 0, recovering: false, source: 'simulated', isSimulated: true },
  { id: 'node-05', name: 'cache-prod-ap-south-1', region: 'ap-south-1', role: 'Cache', ip: '10.4.2.11', baseCpu: 18, baseMemory: 46, baseNetIn: 8, baseNetOut: 6, cpu: 18, memory: 46, netIn: 8, netOut: 6, lastSeen: Date.now(), lastSeq: 100, missingSamples: 0, bufferedSamples: 0, recovering: false, source: 'simulated', isSimulated: true },
  { id: 'node-06', name: 'worker-prod-ap-south-1', region: 'ap-south-1', role: 'Worker', ip: '10.4.3.19', baseCpu: 55, baseMemory: 61, baseNetIn: 15, baseNetOut: 22, cpu: 55, memory: 61, netIn: 15, netOut: 22, lastSeen: Date.now(), lastSeq: 100, missingSamples: 0, bufferedSamples: 0, recovering: false, source: 'simulated', isSimulated: true }
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
    const anomCpu = activeAnomalies.get(`${node.id}-cpu`);
    const anomNetIn = activeAnomalies.get(`${node.id}-netIn`);
    const anomNetOut = activeAnomalies.get(`${node.id}-netOut`);

    if (anomCpu) {
      node.cpu = clamp(anomCpu.value + (Math.random() - 0.5) * 3, 2, 98);
    } else if (node.source !== 'agent' && demoModeEnabled) {
      node.cpu = normalFluctuation(node.baseCpu, 2.8);
    }

    if (node.source !== 'agent' && demoModeEnabled) {
      node.memory = normalFluctuation(node.baseMemory, 1.2);
    }

    if (anomNetIn) {
      node.netIn = clamp(anomNetIn.value + (Math.random() - 0.5) * 4, 1, 99);
    } else if (node.source !== 'agent' && demoModeEnabled) {
      node.netIn = normalFluctuation(node.baseNetIn, 2.2);
    }

    if (anomNetOut) {
      node.netOut = clamp(anomNetOut.value + (Math.random() - 0.5) * 3, 1, 95);
    } else if (node.source !== 'agent' && demoModeEnabled) {
      node.netOut = normalFluctuation(node.baseNetOut, 1.8);
    }

    const health = evaluateNodeHealth(node, timestamp);
    return {
      ...node,
      ...health,
      source: node.source || 'simulated',
      isSimulated: Boolean(node.source !== 'agent' && node.isSimulated !== false),
      timestamp,
      lastSeq: node.lastSeq || 0,
      missingSamples: node.missingSamples || 0
    };
  });

  const liveAgents = samples.filter(n => n.source === 'agent' && !n.isSimulated);
  const liveMetrics = liveAgents.length > 0 ? {
    cpu: liveAgents.reduce((sum, node) => sum + node.cpu, 0) / liveAgents.length,
    memory: liveAgents.reduce((sum, node) => sum + node.memory, 0) / liveAgents.length,
    networkIn: liveAgents.reduce((sum, node) => sum + node.netIn, 0),
    networkOut: liveAgents.reduce((sum, node) => sum + node.netOut, 0),
    count: liveAgents.length
  } : null;

  return {
    type: 'metrics',
    timestamp,
    sequence: ++tick,
    demoMode: demoModeEnabled,
    metrics: {
      cpu: samples.reduce((sum, node) => sum + node.cpu, 0) / samples.length,
      memory: samples.reduce((sum, node) => sum + node.memory, 0) / samples.length,
      networkIn: samples.reduce((sum, node) => sum + node.netIn, 0),
      networkOut: samples.reduce((sum, node) => sum + node.netOut, 0)
    },
    liveMetrics,
    counts: {
      total: samples.length,
      simulated: samples.filter(n => n.isSimulated).length,
      liveAgents: liveAgents.length
    },
    nodes: samples
  };
}

app.get('/api/health', (_req, res) => {
  const liveCount = nodes.filter(n => n.source === 'agent' && !n.isSimulated).length;
  const simCount = nodes.filter(n => n.source !== 'agent' || n.isSimulated).length;
  res.json({
    status: 'ok',
    demoMode: demoModeEnabled,
    nodes: nodes.length,
    liveAgents: liveCount,
    simulatedNodes: simCount,
    clients: clients.size,
    uptime: process.uptime()
  });
});

app.get('/api/nodes', (req, res) => {
  const view = req.query.view || req.query.filter;
  if (view === 'live' || view === 'agents') {
    return res.json(nodes.filter(n => n.source === 'agent' && !n.isSimulated).map(n => ({ ...n })));
  }
  if (view === 'simulated' || view === 'demo') {
    return res.json(nodes.filter(n => n.source !== 'agent' || n.isSimulated).map(n => ({ ...n })));
  }
  res.json(nodes.map((node) => ({ ...node })));
});

// Demo Mode status & toggle endpoints
app.get('/api/demo/status', (_req, res) => {
  const simCount = nodes.filter(n => n.source !== 'agent' || n.isSimulated).length;
  const liveCount = nodes.filter(n => n.source === 'agent' && !n.isSimulated).length;
  res.json({
    demoMode: demoModeEnabled,
    simulatedNodesCount: simCount,
    liveAgentsCount: liveCount,
    totalNodesCount: nodes.length
  });
});

app.post('/api/demo/toggle', requireSimulationAuth, (req, res) => {
  const { enabled } = req.body || {};
  demoModeEnabled = enabled !== undefined ? Boolean(enabled) : !demoModeEnabled;
  console.log(`[DEMO MODE] Demo mode toggled to: ${demoModeEnabled ? 'ACTIVE' : 'DISABLED'}`);
  res.json({
    success: true,
    demoMode: demoModeEnabled,
    message: demoModeEnabled ? 'Demo mode enabled (synthetic fluctuations active)' : 'Demo mode disabled (simulated fluctuations paused)'
  });
});

// Endpoint to prune offline test nodes that are no longer reporting (Protected by simulation auth)
app.all('/api/nodes/prune', requireSimulationAuth, (_req, res) => {
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

// Dedicated Heartbeat endpoint for lightweight agent health checking (Protected by agent auth)
app.all('/api/heartbeat', authenticateAgent, (req, res) => {
  const { id, seq } = req.method === 'POST' ? req.body : req.query;
  const targetId = sanitizeString(id, 64, 'node-01');
  const node = nodes.find(n => n.id === targetId);
  const now = Date.now();
  if (node) {
    node.lastSeen = now;
    node.lastHeartbeat = now;
    if (!['node-01', 'node-02', 'node-03', 'node-04', 'node-05', 'node-06'].includes(node.id)) {
      node.source = 'agent';
      node.isSimulated = false;
    }
    const itemSeq = parseBoundedNumber(seq, 0, Number.MAX_SAFE_INTEGER, 0);
    if (itemSeq > 0) {
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

// Outage and Recovery Simulation endpoint (Restricted to development or authorized admin users)
app.all('/api/agent/simulate-outage', requireSimulationAuth, (req, res) => {
  const params = req.method === 'POST' ? req.body : req.query;
  const { nodeId, outageMs, recoveryMs } = params || {};
  const targetId = sanitizeString(nodeId, 64, 'node-02');
  const node = nodes.find(n => n.id === targetId) || nodes[1];

  // Parameter validation and capping (1s to 60s)
  const cleanOutageMs = parseBoundedNumber(outageMs, 1000, 60000, 8000);
  const cleanRecoveryMs = parseBoundedNumber(recoveryMs, 1000, 60000, 5000);

  const now = Date.now();
  const outageStartedAt = now - 4000;
  const outageUntil = now + cleanOutageMs;
  const recoveryUntil = outageUntil + cleanRecoveryMs;

  simulatedOutages.set(node.id, {
    nodeId: node.id,
    outageStartedAt,
    outageUntil,
    recoveryUntil
  });

  console.log(`[OUTAGE SIMULATED] Node ${node.name} (${node.id}): Outage until +${cleanOutageMs}ms, Recovery until +${cleanOutageMs + cleanRecoveryMs}ms`);

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
      recoveringAt: `+${cleanOutageMs}ms (reconnected, draining buffer)`,
      healthyAt: `+${cleanOutageMs + cleanRecoveryMs}ms (buffer drained)`
    }
  });
});

// Endpoint to simulate an anomaly on-demand (Restricted to development or authorized admin users)
app.all('/api/anomaly/simulate', requireSimulationAuth, (req, res) => {
  const params = req.method === 'POST' ? req.body : req.query;
  const { nodeId, metric, value, durationMs } = params || {};

  const cleanNodeId = sanitizeString(nodeId, 64);
  const targetNode = nodes.find(n => n.id === cleanNodeId) || nodes[0];

  const allowedMetrics = ['cpu', 'netIn', 'netOut'];
  if (metric && !allowedMetrics.includes(metric)) {
    return res.status(400).json({
      error: `Invalid metric '${metric}'. Must be one of: ${allowedMetrics.join(', ')}.`
    });
  }
  const cleanMetric = metric || 'cpu';

  let cleanValue = undefined;
  if (value !== undefined) {
    if (cleanMetric === 'cpu') {
      cleanValue = parseBoundedNumber(value, 0, 100, 75);
    } else {
      cleanValue = parseBoundedNumber(value, 0, 5000, 80);
    }
  }

  // Duration capped between 500ms and 60000ms
  const cleanDurationMs = parseBoundedNumber(durationMs, 500, 60000, 8000);

  const result = injectAnomaly({
    nodeId: targetNode.id,
    metric: cleanMetric,
    value: cleanValue,
    durationMs: cleanDurationMs
  });

  res.json({ success: true, anomaly: result });
});

app.get('/api/anomalies/active', (_req, res) => {
  res.json(Array.from(activeAnomalies.values()));
});

app.all('/api/anomaly/clear', requireSimulationAuth, (_req, res) => {
  activeAnomalies.clear();
  res.json({ success: true, cleared: true });
});

// ─── Fault-Injection Lab Endpoints ──────────────────────────────────────────
let artificialIngestDelayMs = 0;
let artificialDelayUntil = 0;

// 1. Simulate Agent Crash (abrupt halt of reporting without clean shutdown)
app.all('/api/agent/simulate-crash', requireSimulationAuth, (req, res) => {
  const params = req.method === 'POST' ? req.body : req.query;
  const { nodeId, crashDurationMs } = params || {};
  const cleanNodeId = sanitizeString(nodeId, 64, 'node-01');
  const target = nodes.find(n => n.id === cleanNodeId) || nodes[0];
  const cleanDurationMs = parseBoundedNumber(crashDurationMs, 1000, 60000, 12000);
  const now = Date.now();

  simulatedOutages.set(target.id, {
    nodeId: target.id,
    outageStartedAt: now - 4000,
    outageUntil: now + cleanDurationMs,
    recoveryUntil: now + cleanDurationMs + 4000,
    isCrash: true
  });
  target.lastSeen = now - 4000;
  console.log(`[FAULT INJECTION] Agent crash simulated on ${target.name} (${target.id}) for ${cleanDurationMs}ms`);

  res.json({
    success: true,
    fault: 'agent_crash',
    nodeId: target.id,
    nodeName: target.name,
    crashDurationMs: cleanDurationMs,
    recoveryAt: now + cleanDurationMs
  });
});

// 2. Simulate Ingress Packet Delay / Network Jitter
app.all('/api/fault/delay-packets', requireSimulationAuth, (req, res) => {
  const params = req.method === 'POST' ? req.body : req.query;
  const { delayMs, durationMs } = params || {};
  const cleanDelayMs = parseBoundedNumber(delayMs, 10, 5000, 600);
  const cleanDurationMs = parseBoundedNumber(durationMs, 500, 60000, 8000);

  artificialIngestDelayMs = cleanDelayMs;
  artificialDelayUntil = Date.now() + cleanDurationMs;
  console.log(`[FAULT INJECTION] Simulating ${cleanDelayMs}ms ingress packet delay for ${cleanDurationMs}ms`);
  res.json({ success: true, fault: 'delayed_packets', delayMs: cleanDelayMs, durationMs: cleanDurationMs });
});

// 3. Reset All Active Faults & Outages
app.all('/api/faults/reset', requireSimulationAuth, (_req, res) => {
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
    if (['node-01', 'node-02', 'node-03', 'node-04', 'node-05', 'node-06'].includes(n.id)) {
      n.source = 'simulated';
      n.isSimulated = true;
    }
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

// Periodic automatic anomaly demonstration (strictly restricted to demo mode and simulated nodes)
setInterval(() => {
  if (!demoModeEnabled) return;
  if (activeAnomalies.size === 0 && clients.size > 0) {
    const simulatedCandidates = nodes.filter(n => n.source !== 'agent' && n.isSimulated !== false);
    if (simulatedCandidates.length === 0) return;

    const candidates = [
      { nodeId: 'node-01', metric: 'cpu', value: 74, durationMs: 7500 },
      { nodeId: 'node-05', metric: 'netIn', value: 52, durationMs: 8000 },
      { nodeId: 'node-02', metric: 'cpu', value: 78, durationMs: 7000 },
      { nodeId: 'node-04', metric: 'netOut', value: 76, durationMs: 7500 }
    ].filter(c => simulatedCandidates.some(n => n.id === c.nodeId));

    if (candidates.length > 0) {
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      injectAnomaly({ ...pick, isSimulatedDemo: true });
    }
  }
}, 45000);

// Ingestion endpoint supporting single samples, sequence tracking, and buffered batches
// Protected by mandatory agent authentication and parameter validation/capping
app.post('/api/ingest', authenticateAgent, async (req, res) => {
  // Artificial ingress packet delay simulation if active
  if (artificialIngestDelayMs > 0 && Date.now() < artificialDelayUntil) {
    await new Promise(r => setTimeout(r, artificialIngestDelayMs));
  }

  const body = req.body || {};
  const rawItems = Array.isArray(body) ? body : (Array.isArray(body.batch) ? body.batch : [body]);

  // Cap batch size to max 100 items to prevent resource exhaustion / DoS
  if (rawItems.length > 100) {
    return res.status(400).json({ error: 'Batch size exceeds maximum limit of 100 items.' });
  }

  const isRecovering = Boolean(body.recovering || body.status === 'recovering' || (body.bufferRemaining && body.bufferRemaining > 0));
  const bufferRemaining = parseBoundedNumber(body.bufferRemaining, 0, 10000, 0);

  let targetNode = null;
  let acceptedCount = 0;

  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue;
    const { id, name, region, role, ip, cpu, memory, netIn, netOut, seq } = item;

    const cleanId = sanitizeString(id, 64);
    const cleanName = sanitizeString(name, 100);
    if (!cleanId || !cleanName) continue;

    const numCpu = Number(cpu);
    const numMem = Number(memory);
    const numNetIn = Number(netIn !== undefined ? netIn : 0);
    const numNetOut = Number(netOut !== undefined ? netOut : 0);

    if (!Number.isFinite(numCpu) || !Number.isFinite(numMem) || !Number.isFinite(numNetIn) || !Number.isFinite(numNetOut)) {
      continue;
    }

    // Strictly validate and cap metrics to realistic domain boundaries
    const cleanCpu = clamp(numCpu, 0, 100);
    const cleanMemory = clamp(numMem, 0, 100);
    const cleanNetIn = clamp(numNetIn, 0, 100000); // capped at 100 Gbps
    const cleanNetOut = clamp(numNetOut, 0, 100000);
    const cleanRegion = sanitizeString(region, 60, 'unknown');
    const cleanRole = sanitizeString(role, 40, 'Node');
    const cleanIp = sanitizeString(ip, 45, '127.0.0.1');

    let node = nodes.find((n) => n.id === cleanId);
    if (!node) {
      node = { id: cleanId, missingSamples: 0, lastSeq: 0 };
      nodes.push(node);
    }
    targetNode = node;

    // Sequence Number Gap Identification
    const itemSeq = parseBoundedNumber(seq, 0, Number.MAX_SAFE_INTEGER, 0);
    if (itemSeq > 0) {
      if (node.lastSeq > 0 && itemSeq > node.lastSeq + 1) {
        const gap = itemSeq - (node.lastSeq + 1);
        node.missingSamples = (node.missingSamples || 0) + gap;
        console.warn(`[SEQUENCE GAP] Node ${cleanName} (${cleanId}) missed ${gap} sample(s)! Expected #${node.lastSeq + 1}, received #${itemSeq}`);
      }
      node.lastSeq = Math.max(node.lastSeq || 0, itemSeq);
    }

    const isBuiltinDemoNode = ['node-01', 'node-02', 'node-03', 'node-04', 'node-05', 'node-06'].includes(cleanId);
    Object.assign(node, {
      name: cleanName,
      region: cleanRegion,
      role: cleanRole,
      ip: cleanIp,
      cpu: cleanCpu,
      memory: cleanMemory,
      netIn: cleanNetIn,
      netOut: cleanNetOut,
      source: isBuiltinDemoNode ? 'simulated' : 'agent',
      isSimulated: isBuiltinDemoNode ? true : false,
      lastSeen: Date.now(),
      lastHeartbeat: Date.now(),
      recovering: isRecovering,
      bufferedSamples: bufferRemaining
    });

    acceptedCount++;
  }

  if (!targetNode || acceptedCount === 0) {
    return res.status(400).json({ error: 'Expected valid id, name and numeric metrics.' });
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
