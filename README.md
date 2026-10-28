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

| Command | Description | What it Tests |
| :--- | :--- | :--- |
| `npm run lab` | **Full Fault Lab Suite** | Runs all 6 modules: CPU/Net spikes, agent crash & buffer drain, delayed packets, reconnect storm, slow consumer backpressure, and steady-state benchmark. |
| `npm run load-test` | **High-Throughput Load Test** | Concurrently streams 20 agents and 12 WebSocket subscribers; measures p50/p90/p95/p99 delivery latency and memory bounds. |
| `npm run test` | **Master Test Suite (34 Tests)** | End-to-end verification of REST endpoints, WebSocket schemas, anomaly Z-scores, agent health state machines, and CSV export. |

---

## 📊 Empirical Benchmark Results

Below are the empirical metrics recorded from reproducible runs on the local streaming engine (`npm run lab` & `npm run load-test`):

### 1. Throughput & Delivery Latency Profile

| Metric | Measured Value | Target / SLA | Status |
| :--- | :--- | :--- | :---: |
| **Ingestion Throughput** | **181.7 requests / sec** | > 100 req/sec | ✅ PASS |
| **Ingestion Sample Rate** | **181.7 metrics / sec** | > 100 samples/sec | ✅ PASS |
| **Ingest Request Error Rate** | **0.00%** (0 / 1,090 failed) | < 0.1% | ✅ PASS |
| **Min Delivery Latency** | **1.0 ms** | — | ✅ PASS |
| **Mean Delivery Latency** | **7.37 ms** | < 25 ms | ✅ PASS |
| **p50 (Median) Latency** | **6.0 ms** | < 20 ms | ✅ PASS |
| **p90 Latency** | **13.0 ms** | < 35 ms | ✅ PASS |
| **p95 Delivery Latency** | **16.0 ms** | **< 50 ms** | ✅ **KEY PASS** |
| **p99 Latency** | **25.0 ms** | < 80 ms | ✅ PASS |
| **Max Delivery Latency** | **26.0 ms** | < 100 ms | ✅ PASS |
| **Out-of-Order Packets** | **0** | 0 | ✅ PASS |

### 2. Memory Footprint & Resource Stability

| Resource Metric | Measurement | Behavior |
| :--- | :--- | :--- |
| **Baseline Heap Used** | `11.59 MB` | Stable idle allocation |
| **Peak Load Heap Used** | `15.17 MB` | High-frequency 25-agent stream |
| **Net Heap Delta ($\Delta$)** | **`+3.58 MB`** | Strictly bounded via `BoundedRingBuffer` (180 entries) |
| **Process RSS Memory** | `63.52 MB` | Clean footprint without uncontrolled growth |
| **Backpressure Frame Drops** | `0` (on healthy clients) | Isolated to lagging sockets exceeding watermarks |

### 3. Reconnect Storm (Thundering Herd)

- **Simulated Load**: 40 concurrent WebSocket clients connecting simultaneously within a 100 ms burst window.
- **Connection Success Rate**: **100% (40 / 40 connected)**.
- **Connection Latency**: Min: `97 ms` \| Median (p50): `108 ms` \| **p95: `111 ms`** \| Max: `112 ms`.
- **Server Degradation**: **0 unhandled errors, 0 dropped socket descriptors**.

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

## 🔌 REST & WebSocket API Reference

| Endpoint | Method | Description |
| :--- | :---: | :--- |
| `/ws` | `WS` | 4 Hz sequenced fleet metrics broadcast stream. |
| `/api/health` | `GET` | Health check returning node count, active clients, and uptime. |
| `/api/nodes` | `GET` | Returns latest snapshot of all registered nodes. |
| `/api/history` | `GET` | Returns historical fleet telemetry samples from the circular ring buffer. |
| `/api/benchmark/stats` | `GET` | Real-time memory (RSS, Heap), throughput, active faults, and drops. |
| `/api/ingest` | `POST` | Agent telemetry ingestion (supports single samples and batches). |
| `/api/heartbeat` | `POST` | Lightweight agent heartbeat and sequence tracking. |
| `/api/agent/simulate-crash` | `POST` | Simulates abrupt agent crash for a specified duration. |
| `/api/agent/simulate-outage` | `POST` | Simulates temporary outage and buffer recovery drain. |
| `/api/fault/delay-packets` | `POST` | Injects artificial transport delay / network jitter. |
| `/api/anomaly/simulate` | `POST` | Injects on-demand metric spikes (CPU, NetIn, NetOut). |
| `/api/faults/reset` | `POST` | Clears all active faults and restores nominal fleet health. |
