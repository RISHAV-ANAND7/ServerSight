# ServerSight — Real-Time High-Throughput Infrastructure Monitor

A production-grade, full-stack infrastructure telemetry and monitoring engine featuring a responsive React/Chart.js dashboard, a Node.js WebSocket streaming server with multi-tier backpressure, intelligent baseline anomaly detection, and a distributed zero-dependency agent with self-healing reconnection resilience.

---

## ⚡ Quick Start

```bash
npm install
npm run server     # API + WebSocket streaming on http://localhost:4000
npm run dev        # Vite dashboard on http://localhost:5173
```

---

## 🧪 Fault-Injection & Benchmark Lab

ServerSight includes a built-in, reproducible **Fault-Injection and Benchmark Lab** designed to simulate real-world failure scenarios, inject controlled stress, and profile end-to-end performance under load.

### Executing the Testbed CLI Suites

| Command | Description | Concurrency & Duration | Status |
| :--- | :--- | :--- | :---: |
| `npm run build` | **Production Bundle Build** | Compiles React/Vite dashboard bundle (`vite build`) | ✅ **PASS** (4.75s) |
| `npm test` | **Master Test Suite (76 Assertions)** | Runs all 7 core modules: REST APIs, 4 Hz streaming, Z-score anomalies, agent retry/recovery, schema, security & auth boundaries, and demo isolation (`node test-everything.js`) | ✅ **PASS** (76/76, 100%) |
| `npm run lab` | **Full Fault Lab Suite** | Runs all 6 failure modules + steady-state benchmark: 25 agents (~8.3 req/s each), 15 WebSocket subscribers, 6s duration (`node benchmark-lab.js`) | ✅ **PASS** (6/6 modules) |
| `npm run load-test` | **High-Throughput Load Test** | Concurrently streams 20 agents (~6.7 req/s each) and 12 WebSocket subscribers, 8s duration (`node load-test.js`) | ✅ **PASS** (420 packets) |

---

## 🖥️ Verified Benchmark Machine Specifications

The figures below were independently verified on a clean installation running under the following hardware and software environment:

| Specification | Machine Profile |
| :--- | :--- |
| **Operating System** | Windows 11 Home Single Language (`x64`, Build `26300`) |
| **Processor (CPU)** | 13th Gen Intel(R) Core(TM) i5-1335U (12 logical cores, base clock ~2496 MHz) |
| **Installed RAM** | 7.69 GB Total (8,259,321,856 bytes) |
| **Runtime Environment** | Node.js `v22.17.0` |
| **Package Manager** | npm `10.9.2` |
| **Frontend Bundler** | Vite `v6.4.5` (Production bundle generated in `dist/`) |
| **Test Execution Date** | Verified October 2026 |

---

## 📊 Empirical Benchmark Results

Below are the empirical metrics recorded from clean reproducible executions of the streaming engine suites (`npm run lab` and `npm run load-test`):

### 1. High-Throughput Steady-State Engine (`benchmark-lab.js` [Lab 6/6])

- **Producer Concurrency**: 25 concurrent telemetry agents (~8.3 requests/sec each)
- **Consumer Concurrency**: 15 concurrent WebSocket dashboard subscribers (4 Hz stream)
- **Test Duration**: 6.0 seconds
- **Total Ingestion Requests**: 1,069 requests (0 failed, **0.00% error rate**)
- **Total Broadcast Packets**: 405 messages delivered across 15 clients

| Metric | Empirically Measured | Target / SLA | Status |
| :--- | :--- | :--- | :---: |
| **Ingestion Throughput** | **178.2 requests / sec** | > 100 req/sec | ✅ PASS |
| **Ingestion Sample Rate** | **178.2 metrics / sec** | > 100 samples/sec | ✅ PASS |
| **Ingest Request Error Rate** | **0.00%** (0 / 1,069 failed) | < 0.1% | ✅ PASS |
| **Min Delivery Latency** | **1.0 ms** | — | ✅ PASS |
| **Mean Delivery Latency** | **9.20 ms** | < 25 ms | ✅ PASS |
| **p50 (Median) Latency** | **8.0 ms** | < 20 ms | ✅ PASS |
| **p90 Latency** | **16.0 ms** | < 35 ms | ✅ PASS |
| **p95 Delivery Latency** | **19.0 ms** | **< 50 ms** | ✅ **KEY PASS** |
| **p99 Latency** | **24.0 ms** | < 80 ms | ✅ PASS |
| **Max Delivery Latency** | **37.0 ms** | < 100 ms | ✅ PASS |
| **Initial Server Heap** | `13.19 MB` | — | Stable baseline |
| **Peak Load Heap** | `18.33 MB` | < 100 MB | Controlled buffer |
| **Net Heap Growth ($\Delta$)** | **`+5.14 MB`** | Strictly bounded via `BoundedRingBuffer` (180 entries) | ✅ PASS |
| **Process RSS Memory** | `37.18 MB` | < 128 MB | Clean footprint |

### 2. High-Throughput Load Test (`load-test.js`)

- **Producer Concurrency**: 20 concurrent telemetry agents (~6.7 updates/sec/agent)
- **Consumer Concurrency**: 12 concurrent WebSocket dashboard subscribers
- **Test Duration**: 8.0 seconds
- **Total Ingestion Requests**: 963 requests (0 failed, **0.00% error rate**)
- **Total Packets Delivered**: 420 packets (**0 out-of-order packets**)

| Metric | Empirically Measured | Target / SLA | Status |
| :--- | :--- | :--- | :---: |
| **Ingestion Throughput** | **120.4 requests / sec** | > 100 req/sec | ✅ PASS |
| **Min Delivery Latency** | **0.0 ms** | — | ✅ PASS |
| **Mean Delivery Latency** | **4.79 ms** | < 25 ms | ✅ PASS |
| **p50 (Median) Latency** | **4.0 ms** | < 20 ms | ✅ PASS |
| **p90 Latency** | **10.0 ms** | < 35 ms | ✅ PASS |
| **p95 Delivery Latency** | **14.0 ms** | **< 50 ms** | ✅ **KEY PASS** |
| **p99 Latency** | **20.0 ms** | < 80 ms | ✅ PASS |
| **Max Delivery Latency** | **23.0 ms** | < 100 ms | ✅ PASS |
| **Initial Server Heap** | `16.00 MB` | — | Baseline |
| **Mid-Test Peak Heap** | `19.80 MB` | — | Under load |
| **Final Server Heap** | `15.63 MB` | — | Garbage collected |
| **Net Heap Delta ($\Delta$)** | **`-0.37 MB`** | Strictly bounded memory profile | ✅ PASS |
| **Process RSS Memory** | `39.06 MB` | < 128 MB | Stable footprint |
| **Backpressure Socket Drops** | `0` (healthy clients) | 0 drops on unlagged sockets | ✅ PASS |

### 3. Reconnect Storm (Thundering Herd) (`benchmark-lab.js` [Lab 4/6])

- **Simulated Load**: 40 concurrent WebSocket clients connecting simultaneously within a 100 ms burst window.
- **Connection Success Rate**: **100% (40 / 40 connected)** in **66 ms**.
- **Connection Latency**: Min: `40 ms` \| Median (p50): `49 ms` \| **p95: `53 ms`** \| Max: `54 ms`.
- **Server Degradation**: **0 unhandled errors, 0 dropped socket descriptors, 0.00% connection failures**.

---

## 🛡️ Failure Scenarios & Recovery Behaviors

### 1. Agent Crash & Sequence Gap Recovery
- **Failure**: An agent abruptly terminates or is disconnected from the network without a graceful socket FIN/shutdown.
- **Detection**:
  - The server tracks monotonic sequence numbers (`seq`) and timestamp freshness (`lastSeen`).
  - At $t > 3.5\text{ s}$ without a heartbeat/sample, the node transitions to **`stale`** (amber).
  - At $t > 9.0\text{ s}$, the node transitions to **`offline`** (red).
- **Recovery & Sequence Replay**:
  - When the agent recovers and transmits its next sample, the server identifies the missing sequence gap:
    $$\text{missingSamples} = \text{incomingSeq} - (\text{lastSeq} + 1)$$
  - The agent replays backlogged historical points from its bounded FIFO buffer (`MAX_BUFFER_SIZE = 120`) in chunks of 15.
  - The node transitions to **`recovering`** (cyan) with an active backlog counter, then returns to **`healthy`** (green) once drained.

### 2. Thundering Herd & Reconnection Jitter
- **Failure**: Following an outage, dozens or hundreds of distributed agents or dashboard clients reconnect simultaneously, threatening to overload the network stack.
- **Recovery**: Both the agent and dashboard frontend implement **Exponential Backoff with Full Random Jitter**:
  $$\text{Delay} = \text{round}\Big(\text{Base} + \text{random}() \times (\min(\text{Max}, \text{Base} \cdot \text{Multiplier}^{\text{attempt}}) - \text{Base})\Big)$$
- Uniform distribution across the backoff window avoids lockstep synchronized retry waves.

### 3. Slow Consumer Backpressure & Isolation
- **Failure**: A slow or unresponsive client fails to consume WebSocket data frames, threatening to bloat server memory via unbounded socket write buffers.
- **Multi-Tier Protection**:
  1. **Level 1 Backpressure (High Watermark = 64 KB)**: When `client.bufferedAmount > 64 KB`, the server skips sending non-essential high-frequency broadcasts to that specific socket, allowing network buffers to drain.
  2. **Level 2 Backpressure (Drop Watermark = 512 KB)**: If consumer lag persists and `bufferedAmount > 512 KB`, the server terminates the zombie socket, freeing resources.
  3. **Consumer Isolation**: Fast, healthy clients continue receiving unthrottled 4 Hz frames with zero latency penalty.

### 4. Intelligent Anomaly Detection & Auto-Resolution
- **Failure**: Metric spikes or abnormal behaviors occurring relative to a node's normal baseline (e.g. CPU rising to 78% on a node whose baseline is 31%, which static 90% threshold alerts would completely miss).
- **Detection Algorithm**:
  - Maintains a sliding historical window ($N = 80$ samples at 4 Hz).
  - Uses the oldest 75% as a rolling baseline to compute mean ($\mu$) and standard deviation ($\sigma$):
    $$Z = \frac{x - \mu}{\sigma}$$
  - Evaluates deviations:
    - **Medium**: $|Z| \ge 2.5$
    - **High**: $|Z| \ge 3.0$ (or sustained $> 10$ ticks)
    - **Critical**: $|Z| \ge 3.5$ (or sustained $> 20$ ticks)
- **Deduplication & Auto-Resolution**:
  - Ongoing anomalies update existing incident cards without firing duplicate alerts.
  - Incidents automatically resolve after 6 consecutive readings within normal thresholds ($|Z| < 2.5$).

### 5. Controlled Client Chart Rendering Frequency
- **Mechanism**: The React dashboard decouples the 4 Hz WebSocket ingestion stream from Chart.js canvas redraws using an intermediate buffer ref (`histBufferRef`).
- **Optimization**:
  - Chart canvas refreshes are throttled to a controlled **1 Hz frequency** (1000 ms), eliminating layout thrashing and animation overhead (`animation: false`, `normalized: true`, `spanGaps: true`).
  - Top KPI cards and node health status badges remain instantaneous at 4 Hz.

---

## 📡 Distributed Telemetry Agent

To run the telemetry agent on a live node:

```bash
MONITOR_URL=http://<monitor-host>:4000 \
AGENT_ID=worker-01 \
AGENT_NAME=worker-prod-01 \
AGENT_REGION=us-east-1 \
AGENT_ROLE=Worker \
node agent/agent.js
```

### Agent Payload Format

```json
{
  "id": "worker-01",
  "name": "worker-prod-01",
  "region": "us-east-1",
  "role": "Worker",
  "ip": "10.0.1.24",
  "cpu": 34.2,
  "memory": 62.1,
  "netIn": 18.4,
  "netOut": 8.7,
  "seq": 105,
  "timestamp": 1793120800000,
  "status": "healthy"
}
```

---

## 🔒 Security, Authentication & Production Configuration

ServerSight is built with a fail-secure architecture that separates telemetry ingestion, administrative controls, and public observability views.

### 1. Agent Ingestion Authentication (`AGENT_TOKEN`)

All telemetry ingestion endpoints (`/api/ingest`, `/api/heartbeat`) require authentication:
- **Header Format**: `Authorization: Bearer <AGENT_TOKEN>` or `x-agent-token: <AGENT_TOKEN>`
- **Development Default**: If `AGENT_TOKEN` is unset in development (`NODE_ENV !== 'production'`), ServerSight falls back to a standard lab token (`serversight-agent-secret-token`) to facilitate zero-friction local testing.
- **Production Enforcement**: When `NODE_ENV === 'production'`, `AGENT_TOKEN` **MUST** be explicitly set in the environment. Unauthenticated requests are rejected with `HTTP 401 Unauthorized` and invalid tokens with `HTTP 403 Forbidden`. If `AGENT_TOKEN` is missing in production, ingestion fails closed with `HTTP 503`.

```bash
# Production Agent Deployment
export AGENT_TOKEN="prod-secure-random-agent-token-xyz"
export MONITOR_URL="https://monitoring.internal.yourcorp.com"
node agent/agent.js
```

### 2. Fault-Injection & Simulation Restrictions (`ADMIN_TOKEN` & `ENABLE_CHAOS_LAB`)

Simulation endpoints (`/api/anomaly/simulate`, `/api/agent/simulate-crash`, `/api/agent/simulate-outage`, `/api/fault/delay-packets`, `/api/faults/reset`, `/api/nodes/prune`) can alter fleet health states and must **NEVER** be left exposed to public networks.

- **Production Lockout**: In production (`NODE_ENV === 'production'`), all simulation endpoints return `HTTP 403 Forbidden` by default.
- **Enabling in Staging / Labs**: Set `ENABLE_CHAOS_LAB=true` and configure `ADMIN_TOKEN=<secret>`.
- **Authorization Header**: `Authorization: Bearer <ADMIN_TOKEN>` or `x-admin-token: <ADMIN_TOKEN>`.
- **Localhost Loopback**: In development, loopback callers (`127.0.0.1`, `::1`) are permitted without an explicit token. Callers outside loopback are strictly rejected without a valid token.

### 3. Request Parameter Boundaries & Input Capping

To protect against memory exhaustion, denial-of-service, or corrupt analytics, all incoming request parameters are strictly validated and clamped:

| Endpoint | Parameter | Type | Validation / Bounds | Default / Fallback |
| :--- | :--- | :--- | :--- | :--- |
| `/api/ingest` | `batch` | Array | **Capped at max 100 items** | Rejects with HTTP 400 if > 100 |
| `/api/ingest` | `cpu` | Number | **Clamped [0.0, 100.0]%** | Rejects item if NaN |
| `/api/ingest` | `memory` | Number | **Clamped [0.0, 100.0]%** | Rejects item if NaN |
| `/api/ingest` | `netIn` / `netOut` | Number | **Clamped [0, 100,000] Mbps** | Negative values clamped to 0 |
| `/api/ingest` | `id` | String | Alphanumeric, max 64 chars | Sanitized / stripped |
| `/api/ingest` | `name` | String | Sanitized string, max 100 chars | Sanitized |
| `/api/anomaly/simulate` | `metric` | String | Strictly `'cpu'`, `'netIn'`, or `'netOut'` | Rejects with HTTP 400 if invalid |
| `/api/anomaly/simulate` | `value` | Number | CPU: [0, 100]%, Net: [0, 5000] Mbps | Auto-calculated spike |
| `/api/anomaly/simulate` | `durationMs` | Number | **Clamped [500ms, 60,000ms]** | 8000 ms |
| `/api/agent/simulate-crash` | `crashDurationMs` | Number | **Clamped [1,000ms, 60,000ms]** | 12000 ms |
| `/api/agent/simulate-outage` | `outageMs` / `recoveryMs` | Number | **Clamped [1,000ms, 60,000ms]** | 8000 ms / 5000 ms |
| `/api/fault/delay-packets` | `delayMs` | Number | **Clamped [10ms, 5,000ms]** | 600 ms |

---

## 🔌 REST & WebSocket API Reference

| Endpoint | Method | Auth Required | Description |
| :--- | :---: | :---: | :--- |
| `/ws` | `WS` | None (Public) | 4 Hz sequenced fleet metrics broadcast stream. |
| `/api/health` | `GET` | None (Public) | Health check returning node count, active clients, and uptime. |
| `/api/nodes` | `GET` | None (Public) | Returns latest snapshot of all registered nodes (supports `?view=live` or `?view=simulated`). |
| `/api/demo/status` | `GET` | None (Public) | Returns Demo Mode status and counts of live vs simulated nodes. |
| `/api/demo/toggle` | `POST` | **Admin / Lab** | Toggles Demo Mode on/off (pauses/resumes synthetic metric fluctuations). |
| `/api/history` | `GET` | None (Public) | Returns historical fleet telemetry samples from the circular ring buffer. |
| `/api/benchmark/stats` | `GET` | None (Public) | Real-time memory (RSS, Heap), throughput, active faults, and drops. |
| `/api/ingest` | `POST` | **Agent Token** | Agent telemetry ingestion (supports single samples and batches $\le 100$). |
| `/api/heartbeat` | `POST` | **Agent Token** | Lightweight agent heartbeat and sequence tracking. |
| `/api/agent/simulate-crash` | `POST` | **Admin / Lab** | Simulates abrupt agent crash for a specified duration (capped $\le 60\text{s}$). |
| `/api/agent/simulate-outage` | `POST` | **Admin / Lab** | Simulates temporary outage and buffer recovery drain (capped $\le 60\text{s}$). |
| `/api/fault/delay-packets` | `POST` | **Admin / Lab** | Injects artificial transport delay / network jitter (capped $\le 5\text{s}$). |
| `/api/anomaly/simulate` | `POST` | **Admin / Lab** | Injects on-demand metric spikes (CPU, NetIn, NetOut, capped $\le 60\text{s}$). |
| `/api/faults/reset` | `POST` | **Admin / Lab** | Clears all active faults and restores nominal fleet health. |
| `/api/nodes/prune` | `POST` | **Admin / Lab** | Prunes disconnected dynamic test nodes not seen in $> 8\text{s}$. |
