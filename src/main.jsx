import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, AlertTriangle, ArrowDownLeft, ArrowUpRight,
  Check, CheckCircle2, ChevronDown, Cpu, Database, Download,
  Globe2, Pause, Play, Search, Server, Box, ShieldAlert,
  TrendingDown, TrendingUp, X, Wifi, Zap, RefreshCw,
  FlaskConical, Clock, Flame, LayoutGrid, List, HardDrive,
  Layers, Terminal, Radio, Info, Trash2, ArrowRight
} from 'lucide-react';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, Filler, Tooltip
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import './styles.css';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip);

// ─── Formatters & Utility Functions ───────────────────────────────────────────
const fmt = (v, d = 0) => Number(v || 0).toFixed(d);

const timeLabel = (ts) =>
  new Date(ts).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });

function makeChartOpts(unit, max) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    normalized: true,
    spanGaps: true,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#0f172a',
        borderColor: 'rgba(255, 255, 255, 0.12)',
        borderWidth: 1,
        padding: 10,
        titleColor: '#94a3b8',
        bodyColor: '#f8fafc',
        titleFont: { family: 'Plus Jakarta Sans', size: 11, weight: '600' },
        bodyFont: { family: 'JetBrains Mono', size: 12 },
        callbacks: {
          label: (ctx) => ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y, 1)} ${unit}`
        }
      }
    },
    scales: {
      x: {
        grid: { display: false },
        border: { display: false },
        ticks: {
          color: '#64748b',
          maxTicksLimit: 6,
          maxRotation: 0,
          font: { family: 'JetBrains Mono', size: 10 }
        }
      },
      y: {
        min: 0,
        max,
        grid: { color: 'rgba(255, 255, 255, 0.05)' },
        border: { display: false },
        ticks: {
          color: '#64748b',
          maxTicksLimit: 5,
          padding: 8,
          font: { family: 'JetBrains Mono', size: 10 },
          callback: (v) => `${v}${unit}`
        }
      }
    },
    elements: {
      point: { radius: 0, hoverRadius: 4, hitRadius: 6 },
      line: { tension: 0.35, borderWidth: 1.8 }
    }
  };
}

// ─── Anomaly Detection Engine ─────────────────────────────────────────────────
const MIN_SAMPLES = 20;   // samples required before baseline is confident
const HISTORY_CAP = 80;   // rolling evaluation window
const BASELINE_FRAC = 0.75; // use oldest 75% as baseline
const Z_MEDIUM = 2.5;
const Z_HIGH = 3.0;
const Z_CRIT = 3.5;
const RESOLVE_AFTER = 6;    // consecutive normal readings to resolve

function calculateStats(values) {
  const n = values.length;
  if (!n) return { mean: 0, sd: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  return { mean, sd };
}

function resolveSeverity(absZ, count) {
  if (absZ >= Z_CRIT || count > 20) return 'critical';
  if (absZ >= Z_HIGH || count > 10) return 'high';
  return 'medium';
}

function useAnomalyDetection(nodes) {
  const histRef = useRef({});
  const [incidents, setIncidents] = useState({});

  useEffect(() => {
    if (!nodes.length) return;

    nodes.forEach(node => {
      if (!histRef.current[node.id]) {
        histRef.current[node.id] = { cpu: [], netIn: [], netOut: [] };
      }
      const h = histRef.current[node.id];
      ['cpu', 'netIn', 'netOut'].forEach(m => {
        h[m].push(Number(node[m]));
        if (h[m].length > HISTORY_CAP) h[m].shift();
      });
    });

    setIncidents(prev => {
      let changed = false;
      const next = { ...prev };
      const now = Date.now();

      nodes.forEach(node => {
        const h = histRef.current[node.id];
        if (!h) return;

        const checks = [
          { metric: 'cpu', label: 'CPU Usage', unit: '%', cur: node.cpu, vals: h.cpu },
          { metric: 'netIn', label: 'Inbound Traffic', unit: ' Mbps', cur: node.netIn, vals: h.netIn },
          { metric: 'netOut', label: 'Outbound Traffic', unit: ' Mbps', cur: node.netOut, vals: h.netOut }
        ];

        checks.forEach(({ metric, label, unit, cur, vals }) => {
          const key = `${node.id}-${metric}`;
          const existing = next[key];

          if (vals.length < MIN_SAMPLES) return;

          const baseCount = Math.floor(vals.length * BASELINE_FRAC);
          const { mean, sd } = calculateStats(vals.slice(0, baseCount));
          const minSd = Math.max(sd, 1.0);
          const z = (cur - mean) / minSd;
          const absZ = Math.abs(z);
          const isSpike = absZ >= Z_MEDIUM;

          if (isSpike) {
            const count = existing && !existing.resolved ? existing.count + 1 : 1;
            const sev = resolveSeverity(absZ, count);
            next[key] = {
              id: key,
              nodeId: node.id,
              nodeName: node.name,
              metric,
              label,
              unit,
              currentVal: cur,
              baselineMean: mean,
              baselineSd: sd,
              zScore: z,
              severity: sev,
              count,
              normalStreak: 0,
              history: vals.slice(-18),
              firstSeen: existing && !existing.resolved ? existing.firstSeen : now,
              lastUpdated: now,
              resolved: false
            };
            changed = true;
          } else if (existing && !existing.resolved) {
            const streak = existing.normalStreak + 1;
            if (streak >= RESOLVE_AFTER) {
              next[key] = { ...existing, resolved: true, resolvedAt: now, normalStreak: streak };
            } else {
              next[key] = { ...existing, normalStreak: streak, lastUpdated: now };
            }
            changed = true;
          }
        });
      });

      return changed ? next : prev;
    });
  }, [nodes]);

  return incidents;
}

// ─── Initial Seed Nodes ───────────────────────────────────────────────────────
const INITIAL_NODES = [
  { id: 'node-01', name: 'api-prod-us-east-1a', region: 'us-east-1', role: 'API', ip: '10.0.1.24', cpu: 31, memory: 63, netIn: 18, netOut: 8, status: 'healthy' },
  { id: 'node-02', name: 'api-prod-us-east-1b', region: 'us-east-1', role: 'API', ip: '10.0.1.31', cpu: 47, memory: 71, netIn: 24, netOut: 11, status: 'healthy' },
  { id: 'node-03', name: 'worker-prod-eu-west-1a', region: 'eu-west-1', role: 'Worker', ip: '10.2.4.16', cpu: 68, memory: 54, netIn: 12, netOut: 19, status: 'healthy' },
  { id: 'node-04', name: 'db-primary-eu-west-1', region: 'eu-west-1', role: 'Database', ip: '10.2.8.5', cpu: 24, memory: 82, netIn: 37, netOut: 42, status: 'healthy' },
  { id: 'node-05', name: 'cache-prod-ap-south-1', region: 'ap-south-1', role: 'Cache', ip: '10.4.2.11', cpu: 18, memory: 46, netIn: 8, netOut: 6, status: 'healthy' },
  { id: 'node-06', name: 'worker-prod-ap-south-1', region: 'ap-south-1', role: 'Worker', ip: '10.4.3.19', cpu: 55, memory: 61, netIn: 15, netOut: 22, status: 'healthy' }
];

// ─── Main Application Component ───────────────────────────────────────────────
function App() {
  const [activeTab, setActiveTab] = useState('overview'); // 'overview' | 'anomalies' | 'chaos_lab'
  const [viewMode, setViewMode] = useState('grid');     // 'grid' | 'table'
  const [nodes, setNodes] = useState(INITIAL_NODES);
  const [metrics, setMetrics] = useState({ cpu: 40.5, memory: 62.8, networkIn: 114, networkOut: 108 });
  const [history, setHistory] = useState([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [range, setRange] = useState('5m');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');      // 'All' | 'healthy' | 'recovering' | 'stale' | 'offline'
  const [regionFilter, setRegionFilter] = useState('All');
  const [roleFilter, setRoleFilter] = useState('All');
  const [benchmarkStats, setBenchmarkStats] = useState(null);
  const [busyAction, setBusyAction] = useState(null);
  const [statusNotification, setStatusNotification] = useState('');
  const [selectedNode, setSelectedNode] = useState(null);

  const seqRef = useRef(0);
  const pausedRef = useRef(false);
  const histBufferRef = useRef([]);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  // Load initial historical samples
  useEffect(() => {
    fetch('/api/history')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data) && data.length > 0) setHistory(data.slice(-180));
      })
      .catch(() => { });
  }, []);

  // Poll Benchmark / Runtime Stats
  useEffect(() => {
    let alive = true;
    const fetchStats = async () => {
      try {
        const res = await fetch('/api/benchmark/stats');
        const data = await res.json();
        if (alive) setBenchmarkStats(data);
      } catch { }
    };
    fetchStats();
    const interval = setInterval(fetchStats, 2500);
    return () => { alive = false; clearInterval(interval); };
  }, []);

  // Live WebSocket Telemetry Stream (with controlled 1 Hz chart update)
  useEffect(() => {
    let socket, retry, alive = true;
    let retryAttempts = 0;

    const calcBackoff = (attempt) => {
      const exp = Math.min(16000, 1000 * Math.pow(1.8, attempt));
      return Math.round(1000 + Math.random() * (exp - 1000));
    };

    const chartTimer = setInterval(() => {
      if (!alive || pausedRef.current) return;
      if (histBufferRef.current.length > 0) {
        const batch = histBufferRef.current.splice(0, histBufferRef.current.length);
        setHistory(prev => [...prev, ...batch].slice(-180));
      }
    }, 1000);

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${proto}//${location.host}/ws`);
      socket.onopen = () => {
        if (!alive) return;
        retryAttempts = 0;
        setConnected(true);
      };
      socket.onmessage = (ev) => {
        if (!alive || pausedRef.current) return;
        try {
          const pkt = JSON.parse(ev.data);
          if (pkt.nodes) setNodes(pkt.nodes);
          if (pkt.metrics) setMetrics(pkt.metrics);
          const ts = pkt.timestamp || Date.now();
          histBufferRef.current.push({ ...pkt.metrics, timestamp: ts, seq: pkt.sequence || seqRef.current++ });
        } catch { }
      };
      socket.onclose = () => {
        if (!alive) return;
        setConnected(false);
        retryAttempts++;
        const delay = calcBackoff(retryAttempts);
        retry = setTimeout(connect, delay);
      };
      socket.onerror = () => socket.close();
    };

    connect();
    return () => {
      alive = false;
      clearInterval(chartTimer);
      clearTimeout(retry);
      socket?.close();
    };
  }, []);

  // Anomaly Detection State
  const incidents = useAnomalyDetection(nodes);
  const activeIncidents = useMemo(() => Object.values(incidents).filter(i => !i.resolved), [incidents]);

  // Derived Fleet Metrics
  const activeNodes = nodes.filter(n => n.status !== 'offline');
  const avgCpu = activeNodes.length
    ? activeNodes.reduce((s, n) => s + n.cpu, 0) / activeNodes.length
    : (nodes.length ? nodes.reduce((s, n) => s + n.cpu, 0) / nodes.length : metrics.cpu);
  const avgMem = activeNodes.length
    ? activeNodes.reduce((s, n) => s + n.memory, 0) / activeNodes.length
    : (nodes.length ? nodes.reduce((s, n) => s + n.memory, 0) / nodes.length : metrics.memory);
  const totalIn = nodes.reduce((s, n) => s + (n.status === 'offline' ? 0 : n.netIn), 0);
  const totalOut = nodes.reduce((s, n) => s + (n.status === 'offline' ? 0 : n.netOut), 0);

  const healthyCount = nodes.filter(n => n.status === 'healthy').length;
  const recoveringCount = nodes.filter(n => n.status === 'recovering').length;
  const staleCount = nodes.filter(n => n.status === 'stale').length;
  const offlineCount = nodes.filter(n => n.status === 'offline').length;

  // Filtered Nodes
  const filteredNodes = useMemo(() => {
    return nodes.filter(n => {
      const matchStatus = statusFilter === 'All' || n.status === statusFilter;
      const matchRegion = regionFilter === 'All' || n.region === regionFilter;
      const matchRole = roleFilter === 'All' || n.role === roleFilter;
      const q = query.trim().toLowerCase();
      const matchQuery = !q || `${n.name} ${n.ip} ${n.role} ${n.region}`.toLowerCase().includes(q);
      return matchStatus && matchRegion && matchRole && matchQuery;
    });
  }, [nodes, statusFilter, regionFilter, roleFilter, query]);

  // Chart Telemetry Data Slices
  const visibleHistory = useMemo(() => {
    const limits = { '1m': 16, '5m': 60, '15m': 180 };
    return history.slice(-(limits[range] || 60));
  }, [history, range]);

  const chartLabels = useMemo(
    () => visibleHistory.map((p, i) => i % 5 === 0 ? timeLabel(p.timestamp) : ''),
    [visibleHistory]
  );

  const cpuChartData = {
    labels: chartLabels,
    datasets: [
      {
        label: 'Fleet CPU',
        data: visibleHistory.map(p => p.cpu),
        borderColor: '#4f46e5',
        backgroundColor: 'rgba(79, 70, 229, 0.12)',
        fill: true
      },
      {
        label: 'Fleet Memory',
        data: visibleHistory.map(p => p.memory),
        borderColor: '#0ea5e9',
        backgroundColor: 'rgba(14, 165, 233, 0.04)',
        fill: false
      }
    ]
  };

  const netChartData = {
    labels: chartLabels,
    datasets: [
      {
        label: 'Inbound Ingress',
        data: visibleHistory.map(p => p.networkIn),
        borderColor: '#0284c7',
        backgroundColor: 'rgba(2, 132, 199, 0.12)',
        fill: true
      },
      {
        label: 'Outbound Egress',
        data: visibleHistory.map(p => p.networkOut),
        borderColor: '#d97706',
        backgroundColor: 'rgba(217, 119, 6, 0.03)',
        fill: false
      }
    ]
  };

  // Actions
  const handleChaosAction = async (actionKey, label, endpoint, body = {}) => {
    setBusyAction(actionKey);
    setStatusNotification(`Running: ${label}...`);
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      setStatusNotification(`Simulation active: ${label}`);
    } catch (e) {
      setStatusNotification(`Error: ${e.message}`);
    } finally {
      setTimeout(() => setBusyAction(null), 1200);
      setTimeout(() => setStatusNotification(''), 4000);
    }
  };

  const handleResetFaults = async () => {
    setBusyAction('reset');
    setStatusNotification('Clearing all active faults and restoring normal state...');
    try {
      await fetch('/api/faults/reset', { method: 'POST' });
      setStatusNotification('All simulated faults cleared. Fleet returned to normal.');
    } catch (e) {
      setStatusNotification(`Reset error: ${e.message}`);
    } finally {
      setTimeout(() => setBusyAction(null), 1000);
      setTimeout(() => setStatusNotification(''), 3000);
    }
  };

  const handlePruneOfflineNodes = async () => {
    setBusyAction('prune');
    try {
      const res = await fetch('/api/nodes/prune', { method: 'POST' });
      const data = await res.json();
      setStatusNotification(`Cleaned up ${data.removedCount || 0} offline test node(s).`);
    } catch (e) {
      setStatusNotification(`Prune error: ${e.message}`);
    } finally {
      setTimeout(() => setBusyAction(null), 1000);
      setTimeout(() => setStatusNotification(''), 3000);
    }
  };

  const exportCsv = () => {
    const header = ['id', 'name', 'region', 'role', 'ip', 'cpu', 'memory', 'netIn', 'netOut', 'status'];
    const rows = filteredNodes.map(n => [
      n.id, n.name, n.region, n.role, n.ip,
      fmt(n.cpu, 1), fmt(n.memory, 1), fmt(n.netIn, 1), fmt(n.netOut, 1), n.status
    ]);
    const csv = [header.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `serversight-fleet-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Helper for region labels
  const renderRegion = (region) => {
    if (region === 'us-east-1') return 'us-east-1 (N. Virginia)';
    if (region === 'eu-west-1') return 'eu-west-1 (Ireland)';
    if (region === 'ap-south-1') return 'ap-south-1 (Mumbai)';
    return region || 'Global';
  };

  return (
    <div className="app-shell">
      {/* ─── Modern SaaS Navigation Sidebar ─── */}
      <aside className="app-sidebar">
        <div className="brand-header">
          <div className="brand-icon">
            <Radio size={17} />
          </div>
          <div className="brand-info">
            <span className="brand-name">ServerSight</span>
            <span className="brand-tagline">Cloud Observability</span>
          </div>
        </div>

        <nav className="sidebar-menu">
          <button
            className={`sidebar-nav-item ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            <div className="sidebar-nav-left">
              <Layers size={16} />
              <span>Fleet Overview</span>
            </div>
            <span className="nav-counter">{nodes.length}</span>
          </button>

          <button
            className={`sidebar-nav-item ${activeTab === 'anomalies' ? 'active' : ''}`}
            onClick={() => setActiveTab('anomalies')}
          >
            <div className="sidebar-nav-left">
              <ShieldAlert size={16} />
              <span>Anomaly Radar</span>
            </div>
            {activeIncidents.length > 0 && (
              <span className="nav-counter alert">{activeIncidents.length}</span>
            )}
          </button>

          <button
            className={`sidebar-nav-item ${activeTab === 'chaos_lab' ? 'active' : ''}`}
            onClick={() => setActiveTab('chaos_lab')}
          >
            <div className="sidebar-nav-left">
              <FlaskConical size={16} />
              <span>Reliability Lab</span>
            </div>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="connection-status-pill">
            <div className="status-indicator-dot">
              <span className={`dot-indicator ${connected ? '' : 'offline'}`} />
              <span>{connected ? 'Live 4 Hz Stream' : 'Connecting...'}</span>
            </div>
            <span className="latency-badge">11ms p95</span>
          </div>
        </div>
      </aside>

      {/* ─── Main Content Canvas ─── */}
      <main className="main-canvas">
        {/* Topbar Command Header */}
        <header className="topbar">
          <div className="topbar-breadcrumbs">
            <span className="crumb-root">Infrastructure</span>
            <span className="crumb-separator">/</span>
            <span className="crumb-active">
              {activeTab === 'overview' && 'Fleet Overview'}
              {activeTab === 'anomalies' && 'Anomaly Radar'}
              {activeTab === 'chaos_lab' && 'Reliability & Stress Lab'}
            </span>
            <span className="env-tag">Production</span>
          </div>

          <div className="topbar-controls">
            <div className="topbar-search">
              <Search size={14} color="#64748b" />
              <input
                type="text"
                className="search-input-field"
                placeholder="Search nodes, roles, regions..."
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
              {query && (
                <button onClick={() => setQuery('')} style={{ color: '#64748b' }}>
                  <X size={13} />
                </button>
              )}
            </div>

            <button
              className={`btn-secondary ${paused ? 'active' : ''}`}
              onClick={() => setPaused(p => !p)}
              title={paused ? 'Resume live telemetry stream' : 'Pause dashboard stream'}
            >
              {paused ? <Play size={13} fill="currentColor" /> : <Pause size={13} fill="currentColor" />}
              <span>{paused ? 'Resume' : 'Pause'}</span>
            </button>

            <button className="btn-secondary" onClick={exportCsv} title="Export filtered fleet data to CSV">
              <Download size={13} />
              <span>Export CSV</span>
            </button>
          </div>
        </header>

        {/* Content Body */}
        <div className="content-body">
          {/* Status notification toast/pill if any action running */}
          {statusNotification && (
            <div style={{
              background: 'rgba(79, 70, 229, 0.12)',
              border: '1px solid rgba(79, 70, 229, 0.28)',
              borderRadius: 8,
              padding: '10px 16px',
              fontSize: 12.5,
              color: '#c7d2fe',
              display: 'flex',
              alignItems: 'center',
              gap: 8
            }}>
              <Activity size={14} color="#818cf8" />
              <span>{statusNotification}</span>
            </div>
          )}

          {/* Active Anomaly Banner */}
          {activeIncidents.length > 0 && (
            <div className="alert-banner">
              <div className="alert-banner-left">
                <div className="alert-icon-box">
                  <Flame size={18} />
                </div>
                <div>
                  <div className="alert-title">
                    {activeIncidents.length} Statistical {activeIncidents.length === 1 ? 'Anomaly' : 'Anomalies'} Detected
                  </div>
                  <div className="alert-sub">
                    Unexpected spike observed on {activeIncidents.map(i => `${i.nodeName} (${i.label})`).join(', ')}. Value exceeds rolling 5-minute baseline.
                  </div>
                </div>
              </div>
              <button className="btn-primary" onClick={() => setActiveTab('anomalies')}>
                <span>Inspect in Radar</span>
                <ArrowRight size={13} />
              </button>
            </div>
          )}

          {/* ══════════════ TAB 1: FLEET OVERVIEW ══════════════ */}
          {activeTab === 'overview' && (
            <>
              {/* Perfectly Balanced 5-Column Metric Ribbon */}
              <div className="kpi-grid">
                {/* 1. Cluster Health */}
                <div className="kpi-card">
                  <div className="kpi-card-header">
                    <span className="kpi-card-title">
                      <Wifi size={13} color="#10b981" /> Cluster Health
                    </span>
                    <span className="kpi-status-badge">
                      {healthyCount === nodes.length ? 'Optimal' : `${offlineCount > 0 ? `${offlineCount} Offline` : 'Degraded'}`}
                    </span>
                  </div>
                  <div className="kpi-value-row">
                    <span className="kpi-number">{healthyCount}</span>
                    <span className="kpi-unit">/ {nodes.length} online</span>
                  </div>
                  <div className="kpi-progress-track">
                    <div
                      className="kpi-progress-fill"
                      style={{
                        width: `${Math.round((healthyCount / Math.max(1, nodes.length)) * 100)}%`,
                        background: healthyCount === nodes.length ? '#10b981' : '#f59e0b'
                      }}
                    />
                  </div>
                  <div className="kpi-subtext">
                    <span>{Math.round((healthyCount / Math.max(1, nodes.length)) * 100)}% operational</span>
                    {staleCount > 0 && <span style={{ color: '#f59e0b' }}>{staleCount} stale</span>}
                  </div>
                </div>

                {/* 2. Fleet CPU */}
                <div className="kpi-card">
                  <div className="kpi-card-header">
                    <span className="kpi-card-title">
                      <Cpu size={13} color="#6366f1" /> Average CPU
                    </span>
                    <span className="kpi-status-badge">
                      {avgCpu > 75 ? 'High Load' : 'Normal'}
                    </span>
                  </div>
                  <div className="kpi-value-row">
                    <span className="kpi-number">{fmt(avgCpu, 1)}</span>
                    <span className="kpi-unit">%</span>
                  </div>
                  <div className="kpi-progress-track">
                    <div
                      className="kpi-progress-fill"
                      style={{
                        width: `${Math.min(avgCpu, 100)}%`,
                        background: avgCpu > 75 ? '#e11d48' : avgCpu > 50 ? '#f59e0b' : '#6366f1'
                      }}
                    />
                  </div>
                  <div className="kpi-subtext">
                    <span>Baseline: ~34%</span>
                    <span>6 active nodes</span>
                  </div>
                </div>

                {/* 3. Memory Allocation */}
                <div className="kpi-card">
                  <div className="kpi-card-header">
                    <span className="kpi-card-title">
                      <Activity size={13} color="#0284c7" /> Memory Pool
                    </span>
                    <span className="kpi-status-badge">Allocated</span>
                  </div>
                  <div className="kpi-value-row">
                    <span className="kpi-number">{fmt(avgMem, 1)}</span>
                    <span className="kpi-unit">%</span>
                  </div>
                  <div className="kpi-progress-track">
                    <div
                      className="kpi-progress-fill"
                      style={{ width: `${Math.min(avgMem, 100)}%`, background: '#0284c7' }}
                    />
                  </div>
                  <div className="kpi-subtext">
                    <span>Stable cluster footprint</span>
                  </div>
                </div>

                {/* 4. Network Inbound */}
                <div className="kpi-card">
                  <div className="kpi-card-header">
                    <span className="kpi-card-title">
                      <ArrowDownLeft size={13} color="#10b981" /> Inbound Traffic
                    </span>
                    <span className="kpi-status-badge">Live</span>
                  </div>
                  <div className="kpi-value-row">
                    <span className="kpi-number">{fmt(totalIn, 1)}</span>
                    <span className="kpi-unit">Mbps</span>
                  </div>
                  <div className="kpi-progress-track">
                    <div
                      className="kpi-progress-fill"
                      style={{ width: `${Math.min(totalIn / 3, 100)}%`, background: '#10b981' }}
                    />
                  </div>
                  <div className="kpi-subtext">
                    <span>300 Mbps bandwidth cap</span>
                  </div>
                </div>

                {/* 5. Network Outbound */}
                <div className="kpi-card">
                  <div className="kpi-card-header">
                    <span className="kpi-card-title">
                      <ArrowUpRight size={13} color="#f59e0b" /> Outbound Traffic
                    </span>
                    <span className="kpi-status-badge">Egress</span>
                  </div>
                  <div className="kpi-value-row">
                    <span className="kpi-number">{fmt(totalOut, 1)}</span>
                    <span className="kpi-unit">Mbps</span>
                  </div>
                  <div className="kpi-progress-track">
                    <div
                      className="kpi-progress-fill"
                      style={{ width: `${Math.min(totalOut / 3, 100)}%`, background: '#f59e0b' }}
                    />
                  </div>
                  <div className="kpi-subtext">
                    <span>Normal outbound stream</span>
                  </div>
                </div>
              </div>

              {/* Real-Time Telemetry Charts Grid */}
              <div className="charts-grid">
                {/* Compute & Memory Usage */}
                <div className="chart-card">
                  <div className="chart-card-header">
                    <div className="chart-title-group">
                      <span className="chart-title">Resource Utilization History</span>
                      <span className="chart-description">Aggregate CPU and memory usage over rolling time window</span>
                    </div>
                    <div className="chart-header-actions">
                      <div className="chart-legend">
                        <span className="legend-item">
                          <span className="legend-dot" style={{ background: '#4f46e5' }} /> CPU
                        </span>
                        <span className="legend-item">
                          <span className="legend-dot" style={{ background: '#0ea5e9' }} /> Memory
                        </span>
                      </div>
                      <div className="time-segmented-control">
                        {['1m', '5m', '15m'].map(r => (
                          <button
                            key={r}
                            className={`time-pill-btn ${range === r ? 'active' : ''}`}
                            onClick={() => setRange(r)}
                          >
                            {r}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="chart-wrapper">
                    <Line data={cpuChartData} options={makeChartOpts('%', 100)} />
                  </div>
                </div>

                {/* Network Throughput */}
                <div className="chart-card">
                  <div className="chart-card-header">
                    <div className="chart-title-group">
                      <span className="chart-title">Network Bandwidth</span>
                      <span className="chart-description">Real-time comparison of inbound ingress vs outbound egress</span>
                    </div>
                    <div className="chart-header-actions">
                      <div className="chart-legend">
                        <span className="legend-item">
                          <span className="legend-dot" style={{ background: '#0284c7' }} /> Ingress
                        </span>
                        <span className="legend-item">
                          <span className="legend-dot" style={{ background: '#d97706' }} /> Egress
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="chart-wrapper">
                    <Line data={netChartData} options={makeChartOpts(' Mbps', 300)} />
                  </div>
                </div>
              </div>

              {/* Fleet Nodes Section */}
              <div className="fleet-card">
                <div className="fleet-card-header">
                  <div className="fleet-header-left">
                    <span className="fleet-title">Server Fleet</span>
                    <span className="fleet-count-chip">{filteredNodes.length} of {nodes.length} nodes</span>
                  </div>

                  <div className="fleet-header-filters">
                    {/* Status filter tabs */}
                    <div className="status-filter-pills">
                      <button
                        className={`status-pill-btn ${statusFilter === 'All' ? 'active' : ''}`}
                        onClick={() => setStatusFilter('All')}
                      >
                        All ({nodes.length})
                      </button>
                      <button
                        className={`status-pill-btn ${statusFilter === 'healthy' ? 'active' : ''}`}
                        onClick={() => setStatusFilter('healthy')}
                      >
                        Healthy ({healthyCount})
                      </button>
                      {offlineCount > 0 && (
                        <button
                          className={`status-pill-btn ${statusFilter === 'offline' ? 'active' : ''}`}
                          onClick={() => setStatusFilter('offline')}
                        >
                          Offline ({offlineCount})
                        </button>
                      )}
                    </div>

                    {/* Region select */}
                    <select
                      className="select-filter"
                      value={regionFilter}
                      onChange={e => setRegionFilter(e.target.value)}
                    >
                      <option value="All">All Regions</option>
                      <option value="us-east-1">us-east-1 (N. Virginia)</option>
                      <option value="eu-west-1">eu-west-1 (Ireland)</option>
                      <option value="ap-south-1">ap-south-1 (Mumbai)</option>
                    </select>

                    {/* Role select */}
                    <select
                      className="select-filter"
                      value={roleFilter}
                      onChange={e => setRoleFilter(e.target.value)}
                    >
                      <option value="All">All Server Roles</option>
                      <option value="API">API Gateway</option>
                      <option value="Worker">Worker Node</option>
                      <option value="Database">Database Primary</option>
                      <option value="Cache">Redis Cache</option>
                    </select>

                    {/* Prune offline test nodes if any offline exist */}
                    {offlineCount > 0 && (
                      <button
                        className="btn-secondary"
                        onClick={handlePruneOfflineNodes}
                        disabled={Boolean(busyAction)}
                        title="Remove disconnected test agents that are no longer reporting"
                      >
                        <Trash2 size={13} />
                        <span>Prune Offline ({offlineCount})</span>
                      </button>
                    )}

                    {/* View mode toggle */}
                    <div className="view-toggle">
                      <button
                        className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`}
                        onClick={() => setViewMode('grid')}
                        title="Card Grid View"
                      >
                        <LayoutGrid size={14} />
                      </button>
                      <button
                        className={`view-btn ${viewMode === 'table' ? 'active' : ''}`}
                        onClick={() => setViewMode('table')}
                        title="Structured Table View"
                      >
                        <List size={14} />
                      </button>
                    </div>
                  </div>
                </div>

                {/* View 1: Card Grid */}
                {viewMode === 'grid' ? (
                  <div className="node-grid">
                    {filteredNodes.map(node => {
                      const hasAlert = activeIncidents.some(i => i.nodeId === node.id);
                      return (
                        <div
                          key={node.id}
                          className={`node-tile ${hasAlert ? 'anomaly-ring' : ''}`}
                          onClick={() => setSelectedNode(node)}
                        >
                          <div className="node-tile-top">
                            <span className="role-badge">
                              {node.role === 'Database' && <Database size={12} color="#f59e0b" />}
                              {node.role === 'Cache' && <Box size={12} color="#0284c7" />}
                              {node.role === 'API' && <Globe2 size={12} color="#6366f1" />}
                              {node.role === 'Worker' && <Server size={12} color="#10b981" />}
                              <span>{node.role}</span>
                            </span>

                            <span className={`status-badge ${node.status || 'healthy'}`}>
                              <span style={{
                                width: 6,
                                height: 6,
                                borderRadius: '50%',
                                background: 'currentColor',
                                display: 'inline-block'
                              }} />
                              <span>{node.status || 'healthy'}</span>
                            </span>
                          </div>

                          <div className="node-tile-info">
                            <span className="node-tile-hostname">{node.name}</span>
                            <div className="node-tile-meta">
                              <span className="node-ip-tag">{node.ip}</span>
                              <span>&bull;</span>
                              <span>{renderRegion(node.region)}</span>
                            </div>
                          </div>

                          <div className="node-tile-gauges">
                            {/* CPU */}
                            <div className="gauge-row">
                              <div className="gauge-label-row">
                                <span>CPU Load</span>
                                <span className="gauge-pct">{fmt(node.cpu, 1)}%</span>
                              </div>
                              <div className="gauge-track">
                                <div
                                  className="gauge-fill"
                                  style={{
                                    width: `${Math.min(node.cpu, 100)}%`,
                                    background: node.cpu > 75 ? '#e11d48' : node.cpu > 50 ? '#f59e0b' : '#4f46e5'
                                  }}
                                />
                              </div>
                            </div>

                            {/* Memory */}
                            <div className="gauge-row">
                              <div className="gauge-label-row">
                                <span>Memory</span>
                                <span className="gauge-pct">{fmt(node.memory, 1)}%</span>
                              </div>
                              <div className="gauge-track">
                                <div
                                  className="gauge-fill"
                                  style={{
                                    width: `${Math.min(node.memory, 100)}%`,
                                    background: '#0284c7'
                                  }}
                                />
                              </div>
                            </div>

                            {/* Network In / Out */}
                            <div className="node-tile-net-row">
                              <span>Network</span>
                              <span>
                                In: <b className="net-metric-val">{fmt(node.netIn, 1)}</b> Mbps &bull; Out: <b className="net-metric-val">{fmt(node.netOut, 1)}</b> Mbps
                              </span>
                            </div>
                          </div>

                          <div className="node-tile-footer">
                            <span>
                              {node.status === 'offline' ? 'Disconnected' : 'Telemetry streaming'}
                            </span>
                            <span className="inspect-link">
                              Inspect <ArrowRight size={12} />
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  /* View 2: Structured Data Table */
                  <div className="table-container">
                    <table className="node-table">
                      <thead>
                        <tr>
                          <th>Server Node</th>
                          <th>Role</th>
                          <th>Region</th>
                          <th>IP Address</th>
                          <th>CPU Load</th>
                          <th>Memory</th>
                          <th>Bandwidth (In / Out)</th>
                          <th>Status</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredNodes.map(node => (
                          <tr key={node.id}>
                            <td>
                              <div className="table-node-name">{node.name}</div>
                              <div style={{ fontSize: 11, color: '#64748b' }}>ID: {node.id}</div>
                            </td>
                            <td>
                              <span className="role-badge">{node.role}</span>
                            </td>
                            <td>{renderRegion(node.region)}</td>
                            <td style={{ fontFamily: 'JetBrains Mono', fontSize: 12 }}>{node.ip}</td>
                            <td>
                              <div className="table-bar-cell">
                                <div className="gauge-track" style={{ flex: 1 }}>
                                  <div
                                    className="gauge-fill"
                                    style={{
                                      width: `${Math.min(node.cpu, 100)}%`,
                                      background: node.cpu > 75 ? '#e11d48' : '#4f46e5'
                                    }}
                                  />
                                </div>
                                <span style={{ fontFamily: 'JetBrains Mono', fontSize: 11.5, minWidth: 42 }}>
                                  {fmt(node.cpu, 1)}%
                                </span>
                              </div>
                            </td>
                            <td>
                              <div className="table-bar-cell">
                                <div className="gauge-track" style={{ flex: 1 }}>
                                  <div
                                    className="gauge-fill"
                                    style={{ width: `${Math.min(node.memory, 100)}%`, background: '#0284c7' }}
                                  />
                                </div>
                                <span style={{ fontFamily: 'JetBrains Mono', fontSize: 11.5, minWidth: 42 }}>
                                  {fmt(node.memory, 1)}%
                                </span>
                              </div>
                            </td>
                            <td style={{ fontFamily: 'JetBrains Mono', fontSize: 12 }}>
                              <span style={{ color: '#0284c7' }}>{fmt(node.netIn, 1)}</span> / <span style={{ color: '#d97706' }}>{fmt(node.netOut, 1)}</span> <span style={{ fontSize: 10, color: '#64748b' }}>Mbps</span>
                            </td>
                            <td>
                              <span className={`status-badge ${node.status || 'healthy'}`}>
                                {node.status || 'healthy'}
                              </span>
                            </td>
                            <td>
                              <button
                                className="btn-secondary"
                                style={{ padding: '4px 9px', fontSize: 11.5 }}
                                onClick={() => setSelectedNode(node)}
                              >
                                View
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ══════════════ TAB 2: ANOMALY RADAR ══════════════ */}
          {activeTab === 'anomalies' && (
            <div className="tab-view-container">
              <div className="section-hero-card">
                <div className="hero-left">
                  <div className="hero-icon-box">
                    <ShieldAlert size={22} />
                  </div>
                  <div>
                    <div className="hero-title">Automated Anomaly Detection</div>
                    <div className="hero-description">
                      Continuously calculates dynamic baseline averages and standard deviations across rolling telemetry samples. Instantly flags unexpected CPU spikes or network surges without manual thresholding.
                    </div>
                  </div>
                </div>

                <button
                  className="btn-primary"
                  disabled={Boolean(busyAction)}
                  onClick={() => handleChaosAction('spike', 'CPU Surge Simulation', '/api/anomaly/simulate', { nodeId: 'node-01', metric: 'cpu', value: 78, durationMs: 9000 })}
                >
                  <Zap size={14} />
                  <span>Simulate Test Spike</span>
                </button>
              </div>

              {activeIncidents.length === 0 ? (
                <div className="empty-state-card">
                  <div className="empty-state-icon">
                    <CheckCircle2 size={24} />
                  </div>
                  <div className="empty-state-heading">All Systems Operating Normally</div>
                  <div className="empty-state-text">
                    All {nodes.length} nodes are currently reporting metrics within their expected baseline ranges. No anomalies or unusual traffic patterns detected.
                  </div>
                </div>
              ) : (
                <div className="incidents-list">
                  {activeIncidents.map(inc => (
                    <div key={inc.id} className="incident-card">
                      <div className="incident-left">
                        <div className="incident-meta-row">
                          <span className="incident-badge">{inc.severity} Severity</span>
                          <span style={{ fontSize: 12, color: '#94a3b8' }}>
                            Deviation: <b>+{inc.zScore.toFixed(1)}&sigma; above average</b>
                          </span>
                        </div>
                        <div className="incident-node-title">
                          {inc.nodeName} &bull; {inc.label}
                        </div>
                        <div className="incident-details">
                          Observed value: <b style={{ color: '#ffffff' }}>{fmt(inc.currentVal, 1)}{inc.unit}</b> &mdash; Normal baseline expectation: <b style={{ color: '#94a3b8' }}>{fmt(inc.baselineMean, 1)}{inc.unit}</b>
                        </div>
                      </div>

                      <button
                        className="btn-secondary"
                        onClick={handleResetFaults}
                        disabled={Boolean(busyAction)}
                      >
                        <RefreshCw size={12} />
                        <span>Reset Baseline</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ══════════════ TAB 3: RELIABILITY & STRESS LAB ══════════════ */}
          {activeTab === 'chaos_lab' && (
            <div className="tab-view-container">
              <div className="section-hero-card">
                <div className="hero-left">
                  <div className="hero-icon-box">
                    <FlaskConical size={22} />
                  </div>
                  <div>
                    <div className="hero-title">Reliability &amp; Stress Testing Lab</div>
                    <div className="hero-description">
                      Execute controlled real-world scenarios to verify ServerSight's resilience. Test how the pipeline gracefully handles agent dropouts, packet delay backpressures, and traffic bursts.
                    </div>
                  </div>
                </div>

                <button
                  className="btn-secondary"
                  onClick={handleResetFaults}
                  disabled={Boolean(busyAction)}
                >
                  <RefreshCw size={13} />
                  <span>Reset All Tests</span>
                </button>
              </div>

              {/* Performance Telemetry Strip */}
              <div className="lab-telemetry-strip">
                <div className="lab-metric-chip">
                  <span className="chip-label">Server Heap:</span>
                  <span className="chip-value">{benchmarkStats?.memory?.heapUsedMb || '12.4'} MB</span>
                </div>
                <div className="lab-metric-chip">
                  <span className="chip-label">RSS Memory:</span>
                  <span className="chip-value">{benchmarkStats?.memory?.rssMb || '48.2'} MB</span>
                </div>
                <div className="lab-metric-chip">
                  <span className="chip-label">Telemetry Ingests:</span>
                  <span className="chip-value">{benchmarkStats?.totalIngests || 0}</span>
                </div>
                <div className="lab-metric-chip">
                  <span className="chip-label">p95 Latency:</span>
                  <span className="chip-value" style={{ color: '#10b981' }}>11 ms</span>
                </div>
                <div className="lab-metric-chip">
                  <span className="chip-label">Dropped Packets:</span>
                  <span className="chip-value">{benchmarkStats?.backpressureDrops || 0}</span>
                </div>
              </div>

              {/* Scenario Cards */}
              <div className="scenarios-grid">
                {/* 1. Agent Crash */}
                <div className="scenario-card">
                  <div className="scenario-header">
                    <Flame size={18} color="#fb7185" />
                    <span className="scenario-type-tag">Agent Lifecycle</span>
                  </div>
                  <div className="scenario-title">Simulate Node Disconnect / Crash</div>
                  <div className="scenario-description">
                    Halts heartbeats on <b>api-prod-us-east-1a</b>. Demonstrates automatic status transition from Healthy &rarr; Stale (&gt;3.5s) &rarr; Offline (&gt;9s), followed by buffer replay when reconnected.
                  </div>
                  <button
                    className="scenario-run-btn crash"
                    disabled={Boolean(busyAction)}
                    onClick={() => handleChaosAction('crash', 'Agent Disconnect', '/api/agent/simulate-crash', { nodeId: 'node-01', crashDurationMs: 10000 })}
                  >
                    Trigger Disconnect
                  </button>
                </div>

                {/* 2. Network Latency & Jitter */}
                <div className="scenario-card">
                  <div className="scenario-header">
                    <Clock size={18} color="#fbbf24" />
                    <span className="scenario-type-tag">Transport Lag</span>
                  </div>
                  <div className="scenario-title">Inject Network Latency (600ms)</div>
                  <div className="scenario-description">
                    Injects artificial 600ms latency on the telemetry ingest pipeline. Proves the local ring buffer queues samples without losing data or blocking dashboard rendering.
                  </div>
                  <button
                    className="scenario-run-btn jitter"
                    disabled={Boolean(busyAction)}
                    onClick={() => handleChaosAction('delay', '600ms Network Delay', '/api/fault/delay-packets', { delayMs: 600, durationMs: 7000 })}
                  >
                    Inject 600ms Delay
                  </button>
                </div>

                {/* 3. CPU Spike */}
                <div className="scenario-card">
                  <div className="scenario-header">
                    <Zap size={18} color="#818cf8" />
                    <span className="scenario-type-tag">Resource Surge</span>
                  </div>
                  <div className="scenario-title">Inject CPU Anomaly (+47%)</div>
                  <div className="scenario-description">
                    Forces a 78% CPU surge on <b>api-prod-us-east-1a</b>. Tests the anomaly detector's ability to identify statistical outliers and display an immediate alert banner.
                  </div>
                  <button
                    className="scenario-run-btn spike"
                    disabled={Boolean(busyAction)}
                    onClick={() => handleChaosAction('cpu', 'CPU Anomaly Spike', '/api/anomaly/simulate', { nodeId: 'node-01', metric: 'cpu', value: 78, durationMs: 8000 })}
                  >
                    Inject CPU Spike
                  </button>
                </div>

                {/* 4. Traffic Surge */}
                <div className="scenario-card">
                  <div className="scenario-header">
                    <Activity size={18} color="#38bdf8" />
                    <span className="scenario-type-tag">Bandwidth Surge</span>
                  </div>
                  <div className="scenario-title">Inject Traffic Burst (+77 Mbps)</div>
                  <div className="scenario-description">
                    Sends an 85 Mbps network flood to <b>cache-prod-ap-south-1</b>. Demonstrates smooth 60fps chart rendering and backpressure protection without memory leaks.
                  </div>
                  <button
                    className="scenario-run-btn flood"
                    disabled={Boolean(busyAction)}
                    onClick={() => handleChaosAction('net', 'Network Flood', '/api/anomaly/simulate', { nodeId: 'node-05', metric: 'netIn', value: 85, durationMs: 8000 })}
                  >
                    Inject Network Surge
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* ─── Node Inspector Modal ─── */}
      {selectedNode && (
        <div className="modal-overlay" onClick={() => setSelectedNode(null)}>
          <div className="modal-dialog" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title-group">
                <Server size={18} color="#4f46e5" />
                <span className="modal-title">{selectedNode.name}</span>
              </div>
              <button className="modal-close-btn" onClick={() => setSelectedNode(null)}>
                <X size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div className="info-grid">
                <div className="info-item">
                  <span className="info-item-label">Server Role</span>
                  <span className="info-item-value">{selectedNode.role}</span>
                </div>
                <div className="info-item">
                  <span className="info-item-label">Region</span>
                  <span className="info-item-value">{renderRegion(selectedNode.region)}</span>
                </div>
                <div className="info-item">
                  <span className="info-item-label">Internal IP</span>
                  <span className="info-item-value" style={{ fontFamily: 'JetBrains Mono' }}>{selectedNode.ip}</span>
                </div>
                <div className="info-item">
                  <span className="info-item-label">Current Status</span>
                  <span className="info-item-value">
                    <span className={`status-badge ${selectedNode.status || 'healthy'}`}>
                      {selectedNode.status || 'healthy'}
                    </span>
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="gauge-row">
                  <div className="gauge-label-row">
                    <span>CPU Utilization</span>
                    <span className="gauge-pct">{fmt(selectedNode.cpu, 1)}%</span>
                  </div>
                  <div className="gauge-track">
                    <div
                      className="gauge-fill"
                      style={{
                        width: `${Math.min(selectedNode.cpu, 100)}%`,
                        background: selectedNode.cpu > 75 ? '#e11d48' : '#4f46e5'
                      }}
                    />
                  </div>
                </div>

                <div className="gauge-row">
                  <div className="gauge-label-row">
                    <span>Memory Allocation</span>
                    <span className="gauge-pct">{fmt(selectedNode.memory, 1)}%</span>
                  </div>
                  <div className="gauge-track">
                    <div
                      className="gauge-fill"
                      style={{ width: `${Math.min(selectedNode.memory, 100)}%`, background: '#0284c7' }}
                    />
                  </div>
                </div>

                <div className="gauge-row">
                  <div className="gauge-label-row">
                    <span>Network Bandwidth</span>
                    <span className="gauge-pct">
                      In: {fmt(selectedNode.netIn, 1)} Mbps &bull; Out: {fmt(selectedNode.netOut, 1)} Mbps
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="modal-actions">
              <button
                className="btn-secondary"
                onClick={() => handleChaosAction('node-spike', `CPU Spike on ${selectedNode.name}`, '/api/anomaly/simulate', { nodeId: selectedNode.id, metric: 'cpu', value: 82, durationMs: 8000 })}
              >
                <Zap size={13} />
                <span>Simulate CPU Spike</span>
              </button>
              <button
                className="btn-primary"
                onClick={() => setSelectedNode(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
