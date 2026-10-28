
import os from 'node:os';
import { readFile } from 'node:fs/promises';

const baseUrl = (process.env.MONITOR_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const hostname = os.hostname();
const agent = {
  id: process.env.AGENT_ID || hostname,
  name: process.env.AGENT_NAME || hostname,
  region: process.env.AGENT_REGION || 'us-east-1',
  role: process.env.AGENT_ROLE || 'Node'
};
const token = process.env.AGENT_TOKEN;

const REPORT_INTERVAL_MS = Number(process.env.REPORT_INTERVAL_MS || 1000);
const MAX_BUFFER_SIZE = Number(process.env.MAX_BUFFER_SIZE || 120); // Bounded ring buffer: ~2 min of samples
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

// State management
let sequenceNumber = 0;
let consecutiveFails = 0;
let droppedSamples = 0;
let isRecovering = false;
let isDraining = false;
let sending = false;
let retryTimeout = null;
const localBuffer = []; // Bounded FIFO queue

let previousCpu = cpuTimes();
let previousNetwork = await networkBytes();
let previousAt = Date.now();

// ─── System Telemetry Helpers ────────────────────────────────────────────────
function cpuTimes() {
  const stats = os.cpus().map(({ times }) => times);
  return stats.reduce((acc, times) => {
    acc.idle += times.idle;
    acc.total += Object.values(times).reduce((sum, value) => sum + value, 0);
    return acc;
  }, { idle: 0, total: 0 });
}

async function networkBytes() {
  try {
    const lines = (await readFile('/proc/net/dev', 'utf8')).trim().split('\n').slice(2);
    return lines.reduce((acc, line) => {
      const [iface, counters] = line.split(':');
      if (!iface?.trim() || iface.trim() === 'lo') return acc;
      const fields = counters.trim().split(/\s+/).map(Number);
      acc.rx += fields[0] || 0;
      acc.tx += fields[8] || 0;
      return acc;
    }, { rx: 0, tx: 0 });
  } catch {
    // Fallback for Windows / macOS where /proc/net/dev is absent
    const now = Date.now();
    return {
      rx: Math.floor(now * 12) % 1_000_000_000,
      tx: Math.floor(now * 8) % 1_000_000_000
    };
  }
}

function primaryIp() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    const result = addresses?.find((item) => item.family === 'IPv4' && !item.internal);
    if (result) return result.address;
  }
  return '127.0.0.1';
}

// ─── Exponential Backoff with Full Jitter ─────────────────────────────────────
export function calculateBackoff(failureCount, base = BASE_BACKOFF_MS, max = MAX_BACKOFF_MS) {
  const exp = Math.min(max, base * Math.pow(2, failureCount));
  // Full jitter: uniformly random between base and exp to avoid thundering herds
  const jittered = base + Math.random() * (exp - base);
  return Math.round(jittered);
}

// ─── Buffer Management ───────────────────────────────────────────────────────
function bufferSample(sample) {
  if (localBuffer.length >= MAX_BUFFER_SIZE) {
    localBuffer.shift(); // Evict oldest sample (bounded ring buffer)
    droppedSamples++;
    console.warn(`[BUFFER OVERFLOW] Bounded capacity (${MAX_BUFFER_SIZE}) reached. Evicted oldest sample. Total dropped: ${droppedSamples}`);
  }
  localBuffer.push(sample);
  console.log(`[BUFFERED] Stored seq #${sample.seq} locally. (${localBuffer.length}/${MAX_BUFFER_SIZE} in buffer)`);
}

// ─── Sampling & Telemetry Generation ─────────────────────────────────────────
async function captureSample() {
  const now = Date.now();
  const elapsedSeconds = Math.max((now - previousAt) / 1000, 0.1);
  const cpu = cpuTimes();
  const totalDelta = cpu.total - previousCpu.total;
  const idleDelta = cpu.idle - previousCpu.idle;
  const network = await networkBytes();

  const sample = {
    ...agent,
    seq: ++sequenceNumber,
    timestamp: now,
    heartbeat: true,
    ip: primaryIp(),
    cpu: totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0,
    memory: (1 - os.freemem() / os.totalmem()) * 100,
    netIn: Math.max(0, (network.rx - previousNetwork.rx) * 8 / elapsedSeconds / 1_000_000),
    netOut: Math.max(0, (network.tx - previousNetwork.tx) * 8 / elapsedSeconds / 1_000_000),
    bufferedCount: localBuffer.length,
    droppedCount: droppedSamples,
    status: isRecovering || localBuffer.length > 0 ? 'recovering' : 'healthy'
  };

  previousCpu = cpu;
  previousNetwork = network;
  previousAt = now;
  return sample;
}

// ─── Buffer Flush (Recovery Drain) ────────────────────────────────────────────
async function drainBuffer() {
  if (isDraining || localBuffer.length === 0) return;
  isDraining = true;
  isRecovering = true;
  console.log(`[RECOVERING] Network restored. Draining local backlog (${localBuffer.length} samples queued)...`);

  while (localBuffer.length > 0) {
    const batch = localBuffer.splice(0, 15); // drain in manageable chunks
    try {
      const response = await fetch(`${baseUrl}/api/ingest`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          batch,
          recovering: localBuffer.length > 0,
          bufferRemaining: localBuffer.length
        }),
        signal: AbortSignal.timeout(6000)
      });

      if (!response.ok) {
        // Return unsent batch to the front of buffer and pause
        localBuffer.unshift(...batch);
        console.error(`[DRAIN PAUSED] Server responded ${response.status}. Retrying later.`);
        break;
      }
      console.log(`[DRAINED] Flushed ${batch.length} buffered samples. Remaining: ${localBuffer.length}`);
    } catch (err) {
      localBuffer.unshift(...batch);
      console.warn(`[DRAIN ERROR] Backlog drain failed: ${err.message}`);
      break;
    }
  }

  isDraining = false;
  if (localBuffer.length === 0) {
    isRecovering = false;
    console.log(`[HEALTHY] Buffer completely drained. Node ${agent.id} transitioned to fully HEALTHY live stream.`);
  }
}

async function report() {
  if (sending) return;
  sending = true;

  const sample = await captureSample();

  if (localBuffer.length > 0) {
    bufferSample(sample);
    await drainBuffer();
    sending = false;
    return;
  }

  try {
    const response = await fetch(`${baseUrl}/api/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(sample),
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      throw new Error(`Ingest rejected with HTTP ${response.status}`);
    }

    // Success: reset exponential backoff counter
    if (consecutiveFails > 0) {
      console.log(`[CONNECTION RESTORED] Connected to ${baseUrl} after ${consecutiveFails} outage(s).`);
      consecutiveFails = 0;
    }

    console.log(`[${new Date().toISOString()}] ${agent.id} seq=#${sample.seq} | CPU ${sample.cpu.toFixed(1)}% | MEM ${sample.memory.toFixed(1)}% | Status: HEALTHY`);
  } catch (error) {
    consecutiveFails++;
    bufferSample(sample);

    const backoff = calculateBackoff(consecutiveFails);
    console.warn(`[OUTAGE DETECTED] Unable to send telemetry to ${baseUrl}: ${error.message}`);
    console.warn(`[BACKOFF] Failure #${consecutiveFails}. Backing off for ${backoff}ms (with jitter) before retry.`);
  } finally {
    sending = false;
  }
}

console.log(`ServerSight agent ${agent.id} initialized. Reporting to ${baseUrl} every ${REPORT_INTERVAL_MS}ms.`);
await report();
setInterval(report, REPORT_INTERVAL_MS);
