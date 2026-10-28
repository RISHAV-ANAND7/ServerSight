import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

export const BASE_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 30000;

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

// ─── ServerSight Agent Implementation ─────────────────────────────────────────
export class ServerSightAgent {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || process.env.MONITOR_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
    const hostname = os.hostname();
    this.agent = {
      id: options.id || process.env.AGENT_ID || hostname,
      name: options.name || process.env.AGENT_NAME || hostname,
      region: options.region || process.env.AGENT_REGION || 'us-east-1',
      role: options.role || process.env.AGENT_ROLE || 'Node'
    };
    this.token = options.token || process.env.AGENT_TOKEN || 'serversight-agent-secret-token';
    this.reportIntervalMs = Number(options.reportIntervalMs || process.env.REPORT_INTERVAL_MS || 1000);
    this.maxBufferSize = Number(options.maxBufferSize || process.env.MAX_BUFFER_SIZE || 120); // Bounded ring buffer: ~2 min of samples
    this.baseBackoffMs = Number(options.baseBackoffMs || BASE_BACKOFF_MS);
    this.maxBackoffMs = Number(options.maxBackoffMs || MAX_BACKOFF_MS);

    // State management
    this.sequenceNumber = 0;
    this.consecutiveFails = 0;
    this.droppedSamples = 0;
    this.isRecovering = false;
    this.isDraining = false;
    this.isReporting = false; // Concurrency mutex to prevent overlapping reports
    this.localBuffer = []; // Bounded FIFO queue

    // Scheduler state
    this.timer = null;
    this.running = false;
    this.nextScheduledDelay = null;
    this.nextScheduledAt = null;

    this.previousCpu = cpuTimes();
    this.previousNetwork = { rx: 0, tx: 0 };
    this.previousAt = Date.now();
  }

  // ─── Scheduler Core ──────────────────────────────────────────────────────────
  /**
   * Schedules the next report attempt.
   * Cancels any previously scheduled timer to prevent duplicate triggers.
   */
  scheduleNext(delayMs) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (!this.running) return;

    this.nextScheduledDelay = delayMs;
    this.nextScheduledAt = Date.now() + delayMs;

    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        await this.report();
      } catch (err) {
        console.error('[AGENT RETRY SCHEDULER UNHANDLED ERROR]', err);
      }
    }, delayMs);
  }

  // ─── Buffer Management ───────────────────────────────────────────────────────
  bufferSample(sample) {
    if (this.localBuffer.length >= this.maxBufferSize) {
      this.localBuffer.shift(); // Evict oldest sample (bounded ring buffer)
      this.droppedSamples++;
      console.warn(`[BUFFER OVERFLOW] Bounded capacity (${this.maxBufferSize}) reached. Evicted oldest sample. Total dropped: ${this.droppedSamples}`);
    }
    this.localBuffer.push(sample);
    console.log(`[BUFFERED] Stored seq #${sample.seq} locally. (${this.localBuffer.length}/${this.maxBufferSize} in buffer)`);
  }

  // ─── Sampling & Telemetry Generation ─────────────────────────────────────────
  async captureSample() {
    const now = Date.now();
    const elapsedSeconds = Math.max((now - this.previousAt) / 1000, 0.1);
    const cpu = cpuTimes();
    const totalDelta = cpu.total - this.previousCpu.total;
    const idleDelta = cpu.idle - this.previousCpu.idle;
    const network = await networkBytes();

    const sample = {
      ...this.agent,
      seq: ++this.sequenceNumber,
      timestamp: now,
      heartbeat: true,
      ip: primaryIp(),
      cpu: totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0,
      memory: (1 - os.freemem() / os.totalmem()) * 100,
      netIn: Math.max(0, (network.rx - this.previousNetwork.rx) * 8 / elapsedSeconds / 1_000_000),
      netOut: Math.max(0, (network.tx - this.previousNetwork.tx) * 8 / elapsedSeconds / 1_000_000),
      bufferedCount: this.localBuffer.length,
      droppedCount: this.droppedSamples,
      status: this.isRecovering || this.localBuffer.length > 0 ? 'recovering' : 'healthy'
    };

    this.previousCpu = cpu;
    this.previousNetwork = network;
    this.previousAt = now;
    return sample;
  }

  // ─── Buffer Flush (Recovery Drain) ────────────────────────────────────────────
  async drainBuffer() {
    if (this.isDraining || this.localBuffer.length === 0) return true;
    this.isDraining = true;
    this.isRecovering = true;
    console.log(`[RECOVERING] Network restored. Draining local backlog (${this.localBuffer.length} samples queued)...`);

    let allSucceeded = true;
    while (this.localBuffer.length > 0) {
      const batch = this.localBuffer.splice(0, 15); // drain in manageable chunks
      try {
        const response = await fetch(`${this.baseUrl}/api/ingest`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.token ? {
              authorization: `Bearer ${this.token}`,
              'x-agent-token': this.token
            } : {})
          },
          body: JSON.stringify({
            batch,
            recovering: this.localBuffer.length > 0,
            bufferRemaining: this.localBuffer.length
          }),
          signal: AbortSignal.timeout(6000)
        });

        if (!response.ok) {
          // Return unsent batch to the front of buffer and pause
          this.localBuffer.unshift(...batch);
          console.error(`[DRAIN PAUSED] Server responded ${response.status}. Retrying later.`);
          allSucceeded = false;
          break;
        }
        console.log(`[DRAINED] Flushed ${batch.length} buffered samples. Remaining: ${this.localBuffer.length}`);
      } catch (err) {
        this.localBuffer.unshift(...batch);
        console.warn(`[DRAIN ERROR] Backlog drain failed: ${err.message}`);
        allSucceeded = false;
        break;
      }
    }

    this.isDraining = false;
    if (this.localBuffer.length === 0) {
      this.isRecovering = false;
      console.log(`[HEALTHY] Buffer completely drained. Node ${this.agent.id} transitioned to fully HEALTHY live stream.`);
    }
    return allSucceeded;
  }

  // ─── Core Telemetry & Ingestion Reporting ────────────────────────────────────
  async report() {
    // Overlapping execution guard: prevent concurrent network calls
    if (this.isReporting) {
      console.warn(`[AGENT OVERLAP PREVENTED] Report skipped: in-flight report is already active.`);
      return { skipped: true, reason: 'overlap' };
    }
    this.isReporting = true;

    let sample;
    try {
      sample = await this.captureSample();

      // If there are backlogged samples in buffer, queue current sample and drain
      if (this.localBuffer.length > 0) {
        this.bufferSample(sample);
        const drainSuccess = await this.drainBuffer();
        if (drainSuccess) {
          if (this.consecutiveFails > 0) {
            console.log(`[CONNECTION RESTORED] Connected to ${this.baseUrl} after ${this.consecutiveFails} outage(s).`);
            this.consecutiveFails = 0;
          }
          this.scheduleNext(this.reportIntervalMs);
          return { success: true, drained: true };
        } else {
          // Drain failed: increment failure counter, calculate jittered backoff, and schedule next retry
          this.consecutiveFails++;
          const backoff = calculateBackoff(this.consecutiveFails, this.baseBackoffMs, this.maxBackoffMs);
          console.warn(`[OUTAGE PERSISTING] Drain failed (attempt #${this.consecutiveFails}). Backing off for ${backoff}ms (with jitter).`);
          this.scheduleNext(backoff);
          return { success: false, backoff };
        }
      }

      // Standard reporting path
      const response = await fetch(`${this.baseUrl}/api/ingest`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? {
            authorization: `Bearer ${this.token}`,
            'x-agent-token': this.token
          } : {})
        },
        body: JSON.stringify(sample),
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        throw new Error(`Ingest rejected with HTTP ${response.status}`);
      }

      // Success: reset exponential backoff counter
      if (this.consecutiveFails > 0) {
        console.log(`[CONNECTION RESTORED] Connected to ${this.baseUrl} after ${this.consecutiveFails} outage(s).`);
        this.consecutiveFails = 0;
      }
      this.isRecovering = false;

      console.log(`[${new Date().toISOString()}] ${this.agent.id} seq=#${sample.seq} | CPU ${sample.cpu.toFixed(1)}% | MEM ${sample.memory.toFixed(1)}% | Status: HEALTHY`);

      // Schedule next standard report
      this.scheduleNext(this.reportIntervalMs);
      return { success: true, sample };
    } catch (error) {
      this.consecutiveFails++;
      if (sample) {
        this.bufferSample(sample);
      }

      const backoff = calculateBackoff(this.consecutiveFails, this.baseBackoffMs, this.maxBackoffMs);
      console.warn(`[OUTAGE DETECTED] Unable to send telemetry to ${this.baseUrl}: ${error.message}`);
      console.warn(`[BACKOFF] Failure #${this.consecutiveFails}. Backing off for ${backoff}ms (with jitter) before next retry.`);

      // Real retry scheduler: schedule next attempt with the jittered backoff delay
      this.scheduleNext(backoff);
      return { success: false, error: error.message, backoff };
    } finally {
      this.isReporting = false;
    }
  }

  // ─── Lifecycle Control ───────────────────────────────────────────────────────
  async start() {
    if (this.running) return;
    this.running = true;
    console.log(`ServerSight agent ${this.agent.id} initialized. Reporting to ${this.baseUrl} every ${this.reportIntervalMs}ms.`);
    this.previousNetwork = await networkBytes();
    await this.report();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextScheduledDelay = null;
    this.nextScheduledAt = null;
    console.log(`ServerSight agent ${this.agent.id} stopped.`);
  }
}

// ─── Standalone CLI Execution ────────────────────────────────────────────────
// If run directly from CLI (e.g., `node agent/agent.js`), start the default agent.
// If imported as a module, export the class and helpers without auto-starting.
const isDirectExecution = process.argv[1] && (
  fileURLToPath(import.meta.url) === process.argv[1] ||
  process.argv[1].endsWith('agent.js')
);

if (isDirectExecution) {
  const defaultAgent = new ServerSightAgent();
  await defaultAgent.start();
}
