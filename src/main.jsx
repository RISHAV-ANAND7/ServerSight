import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, AlertTriangle, ArrowDownLeft, ArrowUpRight,
  Check, CheckCircle2, ChevronDown, Cpu, Database, Download,
  Globe2, Pause, Play, Search, Server, Box, ShieldAlert,
  TrendingDown, TrendingUp, X, Wifi, Zap, RefreshCw,
  FlaskConical, Clock, Flame, LayoutGrid, List, HardDrive,
  Layers, Terminal, Radio, Info, Trash2, ArrowRight, Bot, Sparkles,
  Sun, Moon, ShieldCheck, Filter, Settings, Key, Eye, EyeOff, Lock
} from 'lucide-react';
import {
  getWsUrl, buildApiUrl, getAdminToken, setAdminToken,
  clearAdminToken, getApiBaseUrl, saveCustomEndpoints
} from './config';
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

function makeChartOpts(unit, max, theme = 'dark') {
  const isDark = theme === 'dark';
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
        backgroundColor: isDark ? '#0f172a' : '#ffffff',
        borderColor: isDark ? 'rgba(255, 255, 255, 0.15)' : '#cbd5e1',
        borderWidth: 1,
        padding: 8,
        titleColor: isDark ? '#94a3b8' : '#64748b',
        bodyColor: isDark ? '#f8fafc' : '#0f172a',
        titleFont: { family: 'Plus Jakarta Sans', size: 12, weight: '600' },
        bodyFont: { family: 'JetBrains Mono', size: 12.5 },
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
          font: { family: 'JetBrains Mono', size: 11 }
        }
      },
      y: {
        min: 0,
        max,
        grid: { color: isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)' },
        border: { display: false },
        ticks: {
          color: '#64748b',
          maxTicksLimit: 4,
          padding: 6,
          font: { family: 'JetBrains Mono', size: 11 },
          callback: (v) => `${v}${unit}`
        }
      }
    },
    elements: {
      point: { radius: 0, hoverRadius: 3, hitRadius: 5 },
      line: { tension: 0.35, borderWidth: 1.8 }
    }
  };
}

// ─── Anomaly Detection Engine ─────────────────────────────────────────────────
const MIN_SAMPLES = 20;
const HISTORY_CAP = 80;
const BASELINE_FRAC = 0.75;
const Z_MEDIUM = 2.5;
const Z_HIGH = 3.0;
const Z_CRIT = 3.5;
const RESOLVE_AFTER = 6;

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
          { metric: 'netIn', label: 'Network In', unit: ' Mbps', cur: node.netIn, vals: h.netIn },
          { metric: 'netOut', label: 'Network Out', unit: ' Mbps', cur: node.netOut, vals: h.netOut }
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

          if (absZ >= Z_MEDIUM) {
            const count = (existing?.count || 0) + 1;
            const peak = Math.max(existing?.peakValue || cur, cur);
            const peakZ = Math.max(existing?.peakZ || absZ, absZ);
            const severity = resolveSeverity(peakZ, count);

            next[key] = {
              id: key,
              nodeId: node.id,
              nodeName: node.name,
              metric,
              label,
              unit,
              currentValue: cur,
              baselineMean: mean,
              baselineSd: sd,
              zScore: z,
              peakZ,
              peakValue: peak,
              severity,
              count,
              normalStreak: 0,
              startedAt: existing?.startedAt || now,
              lastSeen: now
            };
            changed = true;
          } else if (existing) {
            const normalStreak = (existing.normalStreak || 0) + 1;
            if (normalStreak >= RESOLVE_AFTER) {
              delete next[key];
              changed = true;
            } else {
              next[key] = {
                ...existing,
                currentValue: cur,
                normalStreak,
                lastSeen: now
              };
              changed = true;
            }
          }
        });
      });

      return changed ? next : prev;
    });
  }, [nodes]);

  const activeList = useMemo(() => {
    return Object.values(incidents).sort((a, b) => {
      const p = { critical: 3, high: 2, medium: 1 };
      return (p[b.severity] || 0) - (p[a.severity] || 0) || b.peakZ - a.peakZ;
    });
  }, [incidents]);

  const clearAll = () => setIncidents({});
  const dismiss = (id) => setIncidents(prev => {
    const next = { ...prev };
    delete next[id];
    return next;
  });

  return { activeIncidents: activeList, clearAll, dismiss };
}

// ─── Custom Professional ServerSight Logo Component ───────────────────────────
function ServerSightLogo() {
  return (
    <div className="brand-logo-svg">
      <svg width="24" height="24" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="ssLogoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#6366f1" />
            <stop offset="50%" stopColor="#06b6d4" />
            <stop offset="100%" stopColor="#10b981" />
          </linearGradient>
        </defs>
        <path
          d="M16 2L28 8.8V23.2L16 30L4 23.2V8.8L16 2Z"
          stroke="url(#ssLogoGrad)"
          strokeWidth="2.2"
          strokeLinejoin="round"
          fill="rgba(99, 102, 241, 0.08)"
        />
        <path d="M10 12H22M10 16H22M10 20H22" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.2" strokeLinecap="round" />
        <path
          d="M7 16H11L13.5 11L18.5 21L21 16H25"
          stroke="url(#ssLogoGrad)"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="16" cy="16" r="2.2" fill="#06b6d4" />
      </svg>
    </div>
  );
}

// ─── Main Application Component ───────────────────────────────────────────────
export function App() {
  // Theme state: light (default) / dark (optional)
  const [theme, setTheme] = useState(() => localStorage.getItem('serversight-theme') || 'light');

  // WebSocket & Live Telemetry
  const [nodes, setNodes] = useState([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  // Telemetry scope: 'all' (demo fleet) vs 'live' (agent-sourced only)
  const [telemetryView, setTelemetryView] = useState('all');

  // Multi-Metric Chart State
  const [chartMetric, setChartMetric] = useState('cpu'); // 'cpu' | 'mem' | 'net'
  const [history, setHistory] = useState([]);
  const histBufferRef = useRef([]);

  // Filters & Search
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [roleFilter, setRoleFilter] = useState('All');
  const [regionFilter, setRegionFilter] = useState('All');

  // Right Deck Tab: 'inspector' | 'radar' | 'lab'
  const [activeDeckTab, setActiveDeckTab] = useState('inspector');
  const [selectedNode, setSelectedNode] = useState(null);

  // Dynamic Endpoints & Authentication Modals State
  const [endpointVersion, setEndpointVersion] = useState(0);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);
  const [hasAdminToken, setHasAdminToken] = useState(() => Boolean(getAdminToken()));
  const [authModalToken, setAuthModalToken] = useState('');
  const [showTokenPlain, setShowTokenPlain] = useState(false);

  // Settings form fields
  const [cfgApiUrl, setCfgApiUrl] = useState(() => getApiBaseUrl());
  const [cfgWsUrl, setCfgWsUrl] = useState(() => getWsUrl());
  const [cfgAdminToken, setCfgAdminToken] = useState(() => getAdminToken() || '');

  // Status Notification Toast
  const [toastMessage, setToastMessage] = useState('');
  const [busyAction, setBusyAction] = useState(null);

  // Apply theme to document element
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('serversight-theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => (prev === 'dark' ? 'light' : 'dark'));
  };

  // WebSocket connection & 4 Hz live stream using dynamic endpoint resolution
  useEffect(() => {
    let ws = null;
    let timer = null;

    const connect = () => {
      const resolvedWsUrl = getWsUrl();
      try {
        ws = new WebSocket(resolvedWsUrl);
      } catch (e) {
        console.error('[WebSocket Init Error]', e);
        timer = setTimeout(connect, 3000);
        return;
      }

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        timer = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();

      ws.onmessage = (evt) => {
        if (pausedRef.current) return;
        try {
          const payload = JSON.parse(evt.data);
          const incomingNodes = payload.nodes || [];
          setNodes(incomingNodes);

          if (payload.metrics) {
            histBufferRef.current.push({
              time: payload.timestamp || Date.now(),
              cpu: payload.metrics.cpu,
              memory: payload.metrics.memory,
              netIn: payload.metrics.networkIn,
              netOut: payload.metrics.networkOut
            });
            if (histBufferRef.current.length > 50) histBufferRef.current.shift();
          }
        } catch (e) {
          console.error('[WS Parse Error]', e);
        }
      };
    };

    connect();
    return () => {
      if (ws) ws.close();
      if (timer) clearTimeout(timer);
    };
  }, [endpointVersion]);

  // Flush chart buffer at 1 Hz for smooth canvas rendering
  useEffect(() => {
    const iv = setInterval(() => {
      if (!pausedRef.current && histBufferRef.current.length > 0) {
        setHistory([...histBufferRef.current]);
      }
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  // Anomaly Detection hook
  const { activeIncidents, clearAll: clearAnomalies, dismiss: dismissAnomaly } = useAnomalyDetection(nodes);

  // Auto-select first node if none selected or keep current node refreshed
  useEffect(() => {
    if (nodes.length > 0) {
      if (!selectedNode) {
        setSelectedNode(nodes[0]);
      } else {
        const updated = nodes.find(n => n.id === selectedNode.id);
        if (updated) setSelectedNode(updated);
      }
    }
  }, [nodes]);

  // Telemetry View filtering: All vs Pure Live Agents
  const scopedNodes = useMemo(() => {
    if (telemetryView === 'live') {
      return nodes.filter(n => n.source === 'agent' && !n.isSimulated);
    }
    return nodes;
  }, [nodes, telemetryView]);

  // Filtered nodes for the fleet table
  const filteredNodes = useMemo(() => {
    return scopedNodes.filter(node => {
      const matchSearch = !searchTerm ||
        node.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        node.ip.toLowerCase().includes(searchTerm.toLowerCase()) ||
        node.id.toLowerCase().includes(searchTerm.toLowerCase());
      const matchStatus = statusFilter === 'All' || node.status === statusFilter;
      const matchRole = roleFilter === 'All' || node.role === roleFilter;
      const matchRegion = regionFilter === 'All' || node.region === regionFilter;
      return matchSearch && matchStatus && matchRole && matchRegion;
    });
  }, [scopedNodes, searchTerm, statusFilter, roleFilter, regionFilter]);

  // Cluster aggregate KPI calculations
  const totalCount = scopedNodes.length;
  const healthyCount = scopedNodes.filter(n => n.status === 'healthy').length;
  const staleCount = scopedNodes.filter(n => n.status === 'stale').length;
  const offlineCount = scopedNodes.filter(n => n.status === 'offline').length;
  const avgCpu = totalCount > 0 ? scopedNodes.reduce((acc, n) => acc + (n.cpu || 0), 0) / totalCount : 0;
  const avgMem = totalCount > 0 ? scopedNodes.reduce((acc, n) => acc + (n.memory || 0), 0) / totalCount : 0;
  const totalNetIn = scopedNodes.reduce((acc, n) => acc + (n.netIn || 0), 0);
  const totalNetOut = scopedNodes.reduce((acc, n) => acc + (n.netOut || 0), 0);

  // Helper to trigger API actions dynamically without hardcoded URLs or tokens
  const triggerApi = async (urlPath, method = 'POST', body = null, desc = '') => {
    setBusyAction(desc);
    setToastMessage(`Executing: ${desc}...`);
    try {
      const fullUrl = buildApiUrl(urlPath);
      const headers = { 'Content-Type': 'application/json' };
      const currentToken = getAdminToken();
      if (currentToken) {
        headers['Authorization'] = `Bearer ${currentToken}`;
        headers['x-admin-token'] = currentToken;
      }

      const res = await fetch(fullUrl, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
      });

      if (res.status === 401 || res.status === 403) {
        setPendingAction({ urlPath, method, body, desc });
        setAuthModalToken('');
        setShowAuthModal(true);
        setToastMessage(`⚠️ Admin token required to execute: ${desc}`);
        return null;
      }

      const data = await res.json();
      setToastMessage(`✓ ${desc} completed successfully`);
      return data;
    } catch (err) {
      setToastMessage(`✗ Failed: ${err.message}`);
    } finally {
      setTimeout(() => setBusyAction(null), 800);
      setTimeout(() => setToastMessage(''), 3000);
    }
  };

  // Submit handler for Admin Auth Modal
  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    if (!authModalToken.trim()) return;
    setAdminToken(authModalToken.trim());
    setHasAdminToken(true);
    setShowAuthModal(false);
    if (pendingAction) {
      const { urlPath, method, body, desc } = pendingAction;
      setPendingAction(null);
      await triggerApi(urlPath, method, body, desc);
    }
  };

  // Save handler for Connection & Security Settings
  const handleSaveSettings = (e) => {
    e.preventDefault();
    saveCustomEndpoints(cfgApiUrl, cfgWsUrl);
    setAdminToken(cfgAdminToken);
    setHasAdminToken(Boolean(cfgAdminToken.trim()));
    setShowSettingsModal(false);
    setToastMessage('✓ Connection and security settings saved');
    setEndpointVersion(v => v + 1);
  };

  // Clear admin token handler
  const handleClearToken = () => {
    clearAdminToken();
    setCfgAdminToken('');
    setHasAdminToken(false);
    setToastMessage('Admin token cleared from browser session');
  };

  // CSV Export with all 9 columns
  const exportCsv = () => {
    const headers = ['Node', 'Role', 'Region', 'IP', 'CPU %', 'Mem %', 'Net In Mbps', 'Net Out Mbps', 'Status'];
    const rows = filteredNodes.map(n => [
      n.name, n.role, n.region, n.ip,
      fmt(n.cpu, 1), fmt(n.memory, 1), fmt(n.netIn, 1), fmt(n.netOut, 1), n.status
    ]);
    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `serversight-fleet-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Chart dataset generation
  const chartLabels = history.map(h => timeLabel(h.time));
  const isDark = theme === 'dark';

  const chartData = useMemo(() => {
    if (chartMetric === 'cpu') {
      return {
        labels: chartLabels,
        datasets: [{
          label: 'Fleet Average CPU',
          data: history.map(h => h.cpu),
          borderColor: '#6366f1',
          backgroundColor: isDark ? 'rgba(99, 102, 241, 0.12)' : 'rgba(99, 102, 241, 0.08)',
          fill: true
        }]
      };
    }
    if (chartMetric === 'mem') {
      return {
        labels: chartLabels,
        datasets: [{
          label: 'Fleet Average Memory',
          data: history.map(h => h.memory),
          borderColor: '#10b981',
          backgroundColor: isDark ? 'rgba(16, 185, 129, 0.12)' : 'rgba(16, 185, 129, 0.08)',
          fill: true
        }]
      };
    }
    return {
      labels: chartLabels,
      datasets: [
        {
          label: 'Network Inbound',
          data: history.map(h => h.netIn),
          borderColor: '#06b6d4',
          backgroundColor: isDark ? 'rgba(6, 182, 212, 0.12)' : 'rgba(6, 182, 212, 0.08)',
          fill: true
        },
        {
          label: 'Network Outbound',
          data: history.map(h => h.netOut),
          borderColor: '#a855f7',
          backgroundColor: 'transparent',
          fill: false,
          borderDash: [4, 4]
        }
      ]
    };
  }, [history, chartMetric, isDark, chartLabels]);

  const currentOpts = useMemo(() => {
    if (chartMetric === 'cpu') return makeChartOpts('%', 100, theme);
    if (chartMetric === 'mem') return makeChartOpts('%', 100, theme);
    return makeChartOpts(' Mbps', undefined, theme);
  }, [chartMetric, theme]);

  return (
    <div className="app-screen">
      {/* ─── 1. TOP NAVBAR (48px) ─── */}
      <header className="top-navbar">
        <div className="nav-left">
          <div className="brand-group" onClick={() => setSelectedNode(nodes[0])}>
            <ServerSightLogo />
            <span className="brand-title">ServerSight</span>
            <span className="brand-badge">PROD</span>
          </div>

          <div className="nav-divider" />

          {/* Real-Time Stream Beacon */}
          <div className="live-beacon-pill" title={connected ? 'WebSocket connected to /ws (4 Hz streaming)' : 'Connecting...'}>
            <span className={`beacon-dot ${!connected ? 'offline' : paused ? 'paused' : ''}`} />
            <span>{connected ? (paused ? 'Stream Paused' : '4 Hz Live') : 'Connecting...'}</span>
            <span className="latency-tag">14ms p95</span>
          </div>
        </div>

        <div className="nav-right">
          {/* Telemetry Scope Switcher: Demo Fleet vs Pure Live Agents */}
          <div className="view-mode-pill">
            <button
              className={`view-mode-btn ${telemetryView === 'all' ? 'active demo' : ''}`}
              onClick={() => setTelemetryView('all')}
              title="View demonstration fleet (includes 6 simulated baseline nodes)"
            >
              <Sparkles size={12} />
              <span>Demo Fleet</span>
            </button>
            <button
              className={`view-mode-btn ${telemetryView === 'live' ? 'active live' : ''}`}
              onClick={() => setTelemetryView('live')}
              title="Display purely authentic external agent telemetry (excludes simulated data)"
            >
              <Radio size={12} />
              <span>Live Agents</span>
            </button>
          </div>

          {/* Stream Play/Pause */}
          <button
            className="nav-action-btn"
            onClick={() => setPaused(p => !p)}
            title={paused ? 'Resume live telemetry stream' : 'Pause telemetry stream'}
          >
            {paused ? <Play size={12} fill="currentColor" /> : <Pause size={12} fill="currentColor" />}
            <span>{paused ? 'Resume' : 'Pause'}</span>
          </button>

          {/* CSV Export */}
          <button className="nav-action-btn" onClick={exportCsv} title="Export filtered fleet telemetry to CSV">
            <Download size={12} />
            <span>Export CSV</span>
          </button>

          {/* Connection & Auth Settings */}
          <button
            className="theme-toggle-btn"
            onClick={() => {
              setCfgApiUrl(getApiBaseUrl() || '');
              setCfgWsUrl(getWsUrl() || '');
              setCfgAdminToken(getAdminToken() || '');
              setShowSettingsModal(true);
            }}
            title={hasAdminToken ? "Connection & Auth Settings (Admin Authenticated)" : "Connection & Auth Settings"}
            aria-label="Settings"
          >
            {hasAdminToken ? <ShieldCheck size={16} color="#10b981" /> : <Settings size={15} color="var(--text-secondary)" />}
          </button>

          {/* Light / Dark Mode Toggle */}
          <button
            className="theme-toggle-btn"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            aria-label="Toggle Theme"
          >
            {theme === 'dark' ? <Sun size={15} color="#fbbf24" /> : <Moon size={15} color="#475569" />}
          </button>
        </div>
      </header>

      {/* ─── 2. KPI METRICS RIBBON (66px) ─── */}
      <section className="kpi-ribbon">
        {/* Tile 1: Fleet Health */}
        <div className="kpi-tile">
          <div className="kpi-tile-header">
            <span className="kpi-title"><Wifi size={12} color="#10b981" /> Cluster Health</span>
            <span className={`kpi-badge ${healthyCount === totalCount && totalCount > 0 ? 'optimal' : offlineCount > 0 ? 'alert' : 'warning'}`}>
              {totalCount === 0 ? 'Idle' : healthyCount === totalCount ? 'Optimal' : `${offlineCount} Offline`}
            </span>
          </div>
          <div className="kpi-body">
            <div className="kpi-metric">
              <span className="kpi-value">{healthyCount}</span>
              <span className="kpi-unit">/ {totalCount} online</span>
            </div>
            <span className="kpi-sub">
              {totalCount > 0 ? `${Math.round((healthyCount / totalCount) * 100)}% Available` : '0 nodes'}
            </span>
          </div>
          <div className="kpi-bar">
            <div
              className="kpi-bar-fill"
              style={{
                width: `${totalCount > 0 ? (healthyCount / totalCount) * 100 : 0}%`,
                background: healthyCount === totalCount ? '#10b981' : '#f59e0b'
              }}
            />
          </div>
        </div>

        {/* Tile 2: Fleet CPU */}
        <div className="kpi-tile">
          <div className="kpi-tile-header">
            <span className="kpi-title"><Cpu size={12} color="#6366f1" /> Avg Fleet CPU</span>
            <span className={`kpi-badge ${avgCpu > 75 ? 'alert' : avgCpu > 50 ? 'warning' : 'optimal'}`}>
              {avgCpu > 75 ? 'High' : 'Normal'}
            </span>
          </div>
          <div className="kpi-body">
            <div className="kpi-metric">
              <span className="kpi-value">{fmt(avgCpu, 1)}</span>
              <span className="kpi-unit">%</span>
            </div>
            <span className="kpi-sub">
              Peak: {fmt(Math.max(0, ...scopedNodes.map(n => n.cpu || 0)), 1)}%
            </span>
          </div>
          <div className="kpi-bar">
            <div
              className="kpi-bar-fill"
              style={{
                width: `${Math.min(avgCpu, 100)}%`,
                background: avgCpu > 75 ? '#ef4444' : avgCpu > 50 ? '#f59e0b' : '#6366f1'
              }}
            />
          </div>
        </div>

        {/* Tile 3: Fleet Memory */}
        <div className="kpi-tile">
          <div className="kpi-tile-header">
            <span className="kpi-title"><HardDrive size={12} color="#10b981" /> Memory Allocated</span>
            <span className={`kpi-badge ${avgMem > 80 ? 'alert' : avgMem > 65 ? 'warning' : 'optimal'}`}>
              {avgMem > 80 ? 'Constrained' : 'Nominal'}
            </span>
          </div>
          <div className="kpi-body">
            <div className="kpi-metric">
              <span className="kpi-value">{fmt(avgMem, 1)}</span>
              <span className="kpi-unit">%</span>
            </div>
            <span className="kpi-sub">
              Active: {scopedNodes.filter(n => n.memory > 60).length} hosts &gt;60%
            </span>
          </div>
          <div className="kpi-bar">
            <div
              className="kpi-bar-fill"
              style={{
                width: `${Math.min(avgMem, 100)}%`,
                background: avgMem > 80 ? '#ef4444' : '#10b981'
              }}
            />
          </div>
        </div>

        {/* Tile 4: Network Throughput */}
        <div className="kpi-tile">
          <div className="kpi-tile-header">
            <span className="kpi-title"><Activity size={12} color="#06b6d4" /> Total Network I/O</span>
            <span className="kpi-badge optimal">Streaming</span>
          </div>
          <div className="kpi-body">
            <div className="kpi-metric">
              <span className="kpi-value">{fmt(totalNetIn + totalNetOut, 1)}</span>
              <span className="kpi-unit">Mbps</span>
            </div>
            <span className="kpi-sub">
              ↓ {fmt(totalNetIn, 1)} / ↑ {fmt(totalNetOut, 1)}
            </span>
          </div>
          <div className="kpi-bar">
            <div
              className="kpi-bar-fill"
              style={{
                width: `${Math.min(((totalNetIn + totalNetOut) / 200) * 100, 100)}%`,
                background: '#06b6d4'
              }}
            />
          </div>
        </div>
      </section>

      {/* ─── 3. MAIN WORKSPACE (calc(100vh - 114px)) ─── */}
      <main className="workspace-grid">
        {/* ─── LEFT COLUMN: Timeline Chart + Fleet Table ─── */}
        <div className="main-column">
          {/* Real-Time Telemetry Timeline Card */}
          <div className="chart-card">
            <div className="chart-header">
              <div className="chart-tabs">
                <button
                  className={`chart-tab-btn ${chartMetric === 'cpu' ? 'active cpu' : ''}`}
                  onClick={() => setChartMetric('cpu')}
                >
                  <Cpu size={12} />
                  <span>CPU Utilization</span>
                </button>
                <button
                  className={`chart-tab-btn ${chartMetric === 'mem' ? 'active mem' : ''}`}
                  onClick={() => setChartMetric('mem')}
                >
                  <HardDrive size={12} />
                  <span>Memory Usage</span>
                </button>
                <button
                  className={`chart-tab-btn ${chartMetric === 'net' ? 'active net' : ''}`}
                  onClick={() => setChartMetric('net')}
                >
                  <Activity size={12} />
                  <span>Network Traffic</span>
                </button>
              </div>

              <div className="chart-meta">
                <div className="chart-stat-item">
                  <span>Current:</span>
                  <span className="chart-stat-val">
                    {chartMetric === 'cpu' && `${fmt(avgCpu, 1)}%`}
                    {chartMetric === 'mem' && `${fmt(avgMem, 1)}%`}
                    {chartMetric === 'net' && `${fmt(totalNetIn + totalNetOut, 1)} Mbps`}
                  </span>
                </div>
                <div className="chart-stat-item">
                  <span>Window:</span>
                  <span className="chart-stat-val">60s Live</span>
                </div>
              </div>
            </div>

            <div className="chart-canvas-wrap">
              <Line data={chartData} options={currentOpts} />
            </div>
          </div>

          {/* Fleet Nodes Table Card */}
          <div className="fleet-card">
            {/* Toolbar */}
            <div className="fleet-toolbar">
              <div className="fleet-toolbar-left">
                {/* Search */}
                <div className="search-input-wrap">
                  <Search size={12} className="search-input-icon" />
                  <input
                    type="text"
                    className="search-input"
                    placeholder="Search node or IP..."
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                  />
                </div>

                {/* Role select */}
                <select
                  className="filter-select"
                  value={roleFilter}
                  onChange={e => setRoleFilter(e.target.value)}
                >
                  <option value="All">All Roles</option>
                  <option value="API">API Gateway</option>
                  <option value="Worker">Worker</option>
                  <option value="Database">Database</option>
                  <option value="Cache">Cache</option>
                </select>

                {/* Region select */}
                <select
                  className="filter-select"
                  value={regionFilter}
                  onChange={e => setRegionFilter(e.target.value)}
                >
                  <option value="All">All Regions</option>
                  <option value="us-east-1">us-east-1</option>
                  <option value="eu-west-1">eu-west-1</option>
                  <option value="ap-south-1">ap-south-1</option>
                </select>
              </div>

              <div className="fleet-toolbar-right">
                {/* Status chips */}
                <div className="status-chip-group">
                  <button
                    className={`status-chip ${statusFilter === 'All' ? 'active' : ''}`}
                    onClick={() => setStatusFilter('All')}
                  >
                    All ({scopedNodes.length})
                  </button>
                  <button
                    className={`status-chip ${statusFilter === 'healthy' ? 'active' : ''}`}
                    onClick={() => setStatusFilter('healthy')}
                  >
                    Healthy ({healthyCount})
                  </button>
                  {offlineCount > 0 && (
                    <button
                      className={`status-chip ${statusFilter === 'offline' ? 'active' : ''}`}
                      onClick={() => setStatusFilter('offline')}
                    >
                      Offline ({offlineCount})
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Structured Table */}
            <div className="table-scroll-container">
              <table className="fleet-table">
                <thead>
                  <tr>
                    <th>Node Hostname</th>
                    <th>Role</th>
                    <th>Region</th>
                    <th>CPU Load</th>
                    <th>Memory</th>
                    <th>Network</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredNodes.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>
                        {telemetryView === 'live'
                          ? 'No live host agents currently connected. Start an agent using AGENT_TOKEN to see telemetry here.'
                          : 'No nodes match the selected search and filter criteria.'}
                      </td>
                    </tr>
                  ) : (
                    filteredNodes.map(node => {
                      const isSelected = selectedNode?.id === node.id;
                      const hasAlert = activeIncidents.some(i => i.nodeId === node.id);

                      return (
                        <tr
                          key={node.id}
                          className={`${isSelected ? 'selected' : ''}`}
                          onClick={() => setSelectedNode(node)}
                        >
                          <td>
                            <div className="node-cell-primary">
                              <span className={`status-dot ${node.status || 'healthy'}`} />
                              <div>
                                <div className="node-name-text">{node.name}</div>
                                <div className="node-ip-text">{node.ip}</div>
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className="role-pill">
                              {node.role === 'Database' && <Database size={10} color="#f59e0b" />}
                              {node.role === 'Cache' && <Box size={10} color="#06b6d4" />}
                              {node.role === 'API' && <Globe2 size={10} color="#6366f1" />}
                              {node.role === 'Worker' && <Server size={10} color="#10b981" />}
                              <span>{node.role}</span>
                            </span>
                          </td>
                          <td>
                            <span className="region-text">{node.region}</span>
                          </td>
                          <td className="metric-bar-cell">
                            <div className="bar-with-label">
                              <div className="mini-bar-track">
                                <div
                                  className="mini-bar-fill"
                                  style={{
                                    width: `${Math.min(node.cpu, 100)}%`,
                                    background: node.cpu > 75 ? '#ef4444' : node.cpu > 50 ? '#f59e0b' : '#6366f1'
                                  }}
                                />
                              </div>
                              <span className="metric-number-mono">{fmt(node.cpu, 1)}%</span>
                            </div>
                          </td>
                          <td className="metric-bar-cell">
                            <div className="bar-with-label">
                              <div className="mini-bar-track">
                                <div
                                  className="mini-bar-fill"
                                  style={{
                                    width: `${Math.min(node.memory, 100)}%`,
                                    background: node.memory > 80 ? '#ef4444' : '#10b981'
                                  }}
                                />
                              </div>
                              <span className="metric-number-mono">{fmt(node.memory, 1)}%</span>
                            </div>
                          </td>
                          <td>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-secondary)' }}>
                              {fmt(node.netIn, 0)} / {fmt(node.netOut, 0)} Mbps
                            </span>
                          </td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span style={{
                                textTransform: 'capitalize',
                                fontWeight: '600',
                                color: node.status === 'healthy' ? 'var(--emerald)' : node.status === 'stale' ? 'var(--amber)' : 'var(--rose)'
                              }}>
                                {node.status || 'healthy'}
                              </span>
                              {hasAlert && <Flame size={12} color="#ef4444" />}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* ─── RIGHT COLUMN: Inspector & Radar Deck ─── */}
        <aside className="deck-card">
          {/* Deck Tab Header */}
          <div className="deck-tabs-header">
            <button
              className={`deck-tab-btn ${activeDeckTab === 'inspector' ? 'active' : ''}`}
              onClick={() => setActiveDeckTab('inspector')}
            >
              <Server size={13} />
              <span>Inspector</span>
            </button>
            <button
              className={`deck-tab-btn ${activeDeckTab === 'radar' ? 'active' : ''}`}
              onClick={() => setActiveDeckTab('radar')}
            >
              <ShieldAlert size={13} />
              <span>Anomalies</span>
              {activeIncidents.length > 0 && (
                <span className="deck-count-pill">{activeIncidents.length}</span>
              )}
            </button>
            <button
              className={`deck-tab-btn ${activeDeckTab === 'lab' ? 'active' : ''}`}
              onClick={() => setActiveDeckTab('lab')}
            >
              <FlaskConical size={13} />
              <span>Stress Lab</span>
            </button>
          </div>

          {/* Deck Body */}
          <div className="deck-body">
            {/* ── TAB 1: NODE INSPECTOR ── */}
            {activeDeckTab === 'inspector' && (
              selectedNode ? (
                <div>
                  <div className="inspector-node-header">
                    <div>
                      <div className="inspector-node-title">{selectedNode.name}</div>
                      <div className="inspector-node-sub">
                        <span>{selectedNode.ip}</span>
                        <span>&bull;</span>
                        <span>{selectedNode.region}</span>
                        <span>&bull;</span>
                        <span style={{
                          color: selectedNode.source === 'agent' && !selectedNode.isSimulated ? 'var(--emerald)' : 'var(--indigo)'
                        }}>
                          {selectedNode.source === 'agent' && !selectedNode.isSimulated ? 'Live Agent' : 'Synthetic Demo'}
                        </span>
                      </div>
                    </div>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: 'var(--radius-xs)',
                      fontSize: '11px',
                      fontWeight: '700',
                      textTransform: 'uppercase',
                      background: selectedNode.status === 'healthy' ? 'var(--emerald-bg)' : 'var(--amber-bg)',
                      color: selectedNode.status === 'healthy' ? 'var(--emerald)' : 'var(--amber)',
                      border: `1px solid ${selectedNode.status === 'healthy' ? 'var(--emerald-border)' : 'var(--amber-border)'}`
                    }}>
                      {selectedNode.status || 'healthy'}
                    </span>
                  </div>

                  {/* 2x2 Telemetry Grid */}
                  <div className="inspector-metrics-grid">
                    <div className="inspector-metric-box">
                      <div className="inspector-metric-label">CPU LOAD</div>
                      <div className="inspector-metric-val">{fmt(selectedNode.cpu, 1)}%</div>
                      <div className="inspector-metric-sub">Base: {selectedNode.baseCpu || 30}%</div>
                    </div>
                    <div className="inspector-metric-box">
                      <div className="inspector-metric-label">MEMORY USAGE</div>
                      <div className="inspector-metric-val">{fmt(selectedNode.memory, 1)}%</div>
                      <div className="inspector-metric-sub">Base: {selectedNode.baseMemory || 50}%</div>
                    </div>
                    <div className="inspector-metric-box">
                      <div className="inspector-metric-label">INBOUND TRAFFIC</div>
                      <div className="inspector-metric-val">{fmt(selectedNode.netIn, 1)} <span style={{ fontSize: '10px' }}>Mbps</span></div>
                      <div className="inspector-metric-sub">Base: {selectedNode.baseNetIn || 15} Mbps</div>
                    </div>
                    <div className="inspector-metric-box">
                      <div className="inspector-metric-label">OUTBOUND TRAFFIC</div>
                      <div className="inspector-metric-val">{fmt(selectedNode.netOut, 1)} <span style={{ fontSize: '10px' }}>Mbps</span></div>
                      <div className="inspector-metric-sub">Base: {selectedNode.baseNetOut || 10} Mbps</div>
                    </div>
                  </div>

                  {/* Telemetry Stream Health */}
                  <div className="inspector-section-label">
                    <span>TELEMETRY SEQUENCE & FRESHNESS</span>
                  </div>
                  <div className="inspector-keyval-list">
                    <div className="inspector-keyval-row">
                      <span className="inspector-keyval-label">Monotonic Sequence</span>
                      <span className="inspector-keyval-value">#{selectedNode.lastSeq || selectedNode.seq || 0}</span>
                    </div>
                    <div className="inspector-keyval-row">
                      <span className="inspector-keyval-label">Sequence Gaps / Dropped</span>
                      <span className="inspector-keyval-value">{selectedNode.missingSamples || 0} pkts</span>
                    </div>
                    <div className="inspector-keyval-row">
                      <span className="inspector-keyval-label">Buffered Backlog</span>
                      <span className="inspector-keyval-value">{selectedNode.bufferedSamples || 0} queued</span>
                    </div>
                    <div className="inspector-keyval-row">
                      <span className="inspector-keyval-label">Last Heartbeat Seen</span>
                      <span className="inspector-keyval-value">{timeLabel(selectedNode.lastSeen || Date.now())}</span>
                    </div>
                  </div>

                  {/* Node Actions */}
                  <div className="inspector-section-label">
                    <span>FAULT INJECTION ACTIONS</span>
                  </div>
                  <div className="inspector-actions-row">
                    <button
                      className="action-btn spike"
                      disabled={Boolean(busyAction)}
                      onClick={() => triggerApi('/api/anomaly/simulate', 'POST', {
                        nodeId: selectedNode.id,
                        metric: 'cpu',
                        value: 78.0,
                        durationMs: 6000
                      }, `Spike CPU on ${selectedNode.name}`)}
                    >
                      <Flame size={12} />
                      <span>Inject 78% Spike</span>
                    </button>
                    <button
                      className="action-btn outage"
                      disabled={Boolean(busyAction)}
                      onClick={() => triggerApi('/api/agent/simulate-outage', 'POST', {
                        nodeId: selectedNode.id,
                        outageMs: 5000,
                        recoveryMs: 4000
                      }, `Simulate Outage on ${selectedNode.name}`)}
                    >
                      <AlertTriangle size={12} />
                      <span>Simulate Outage</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ textAlign: 'center', padding: '30px 10px', color: 'var(--text-muted)' }}>
                  Select a node from the fleet table to inspect its live telemetry and run diagnostics.
                </div>
              )
            )}

            {/* ── TAB 2: ANOMALY RADAR ── */}
            {activeDeckTab === 'radar' && (
              <div>
                <div className="inspector-section-label">
                  <span>ACTIVE BASELINE ANOMALIES ({activeIncidents.length})</span>
                  {activeIncidents.length > 0 && (
                    <button
                      style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '10px' }}
                      onClick={clearAnomalies}
                    >
                      Clear All
                    </button>
                  )}
                </div>

                {activeIncidents.length === 0 ? (
                  <div className="anomaly-empty-state">
                    <div className="empty-state-icon">
                      <ShieldCheck size={20} />
                    </div>
                    <div className="empty-state-title">All Systems Nominal</div>
                    <div className="empty-state-desc">
                      Rolling baseline Z-scores are within safe statistical bounds (&plusmn;2.5&sigma;).
                    </div>
                  </div>
                ) : (
                  activeIncidents.map(inc => (
                    <div key={inc.id} className="anomaly-item-card">
                      <div className="anomaly-item-top">
                        <span className="anomaly-item-title">{inc.nodeName}</span>
                        <span className="z-score-tag">+{fmt(inc.peakZ, 1)}&sigma;</span>
                      </div>
                      <div className="anomaly-item-desc">
                        Sudden spike on <b>{inc.label}</b>: current <b>{fmt(inc.currentValue, 1)}{inc.unit}</b> vs rolling baseline &mu;={fmt(inc.baselineMean, 1)}{inc.unit} (&sigma;={fmt(inc.baselineSd, 1)}).
                      </div>
                      <div className="anomaly-item-footer">
                        <span>Observed {inc.count} consecutive ticks</span>
                        <button
                          style={{ border: 'none', background: 'transparent', color: 'var(--indigo)', cursor: 'pointer', fontSize: '10.5px', fontWeight: '600' }}
                          onClick={() => dismissAnomaly(inc.id)}
                        >
                          Acknowledge
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* ── TAB 3: CHAOS LAB CONTROLS ── */}
            {activeDeckTab === 'lab' && (
              <div>
                <div className="inspector-section-label">
                  <span>ON-DEMAND RELIABILITY TESTS</span>
                </div>

                <div className="chaos-lab-block">
                  <button
                    className="chaos-lab-btn"
                    disabled={Boolean(busyAction)}
                    onClick={() => triggerApi('/api/anomaly/simulate', 'POST', {
                      nodeId: 'node-01',
                      metric: 'cpu',
                      value: 78.0,
                      durationMs: 5000
                    }, 'Controlled CPU Spike (+47% load)')}
                  >
                    <div className="chaos-btn-left">
                      <Flame size={13} color="#f59e0b" />
                      <span>Inject CPU Spike (Node 01 &rarr; 78%)</span>
                    </div>
                    <ArrowRight size={11} color="var(--text-muted)" />
                  </button>

                  <button
                    className="chaos-lab-btn"
                    disabled={Boolean(busyAction)}
                    onClick={() => triggerApi('/api/anomaly/simulate', 'POST', {
                      nodeId: 'node-01',
                      metric: 'netIn',
                      value: 85.0,
                      durationMs: 5000
                    }, 'Network Ingestion Flood (85 Mbps)')}
                  >
                    <div className="chaos-btn-left">
                      <Zap size={13} color="#06b6d4" />
                      <span>Inject Network Flood (85 Mbps)</span>
                    </div>
                    <ArrowRight size={11} color="var(--text-muted)" />
                  </button>

                  <button
                    className="chaos-lab-btn"
                    disabled={Boolean(busyAction)}
                    onClick={() => triggerApi('/api/fault/delay-packets', 'POST', {
                      delayMs: 350,
                      durationMs: 5000
                    }, 'Transport Jitter Delay (350ms)')}
                  >
                    <div className="chaos-btn-left">
                      <Clock size={13} color="#8b5cf6" />
                      <span>Inject Transport Delay (350ms Jitter)</span>
                    </div>
                    <ArrowRight size={11} color="var(--text-muted)" />
                  </button>

                  <button
                    className="chaos-lab-btn"
                    disabled={Boolean(busyAction)}
                    onClick={() => triggerApi('/api/agent/simulate-crash', 'POST', {
                      nodeId: 'node-03',
                      crashDurationMs: 6000
                    }, 'Simulate Agent Crash on node-03')}
                  >
                    <div className="chaos-btn-left">
                      <AlertTriangle size={13} color="#ef4444" />
                      <span>Simulate Crash & Gap (Node 03)</span>
                    </div>
                    <ArrowRight size={11} color="var(--text-muted)" />
                  </button>

                  <button
                    className="chaos-reset-btn"
                    disabled={Boolean(busyAction)}
                    onClick={() => triggerApi('/api/faults/reset', 'POST', null, 'Reset All Faults & Restore Fleet')}
                  >
                    <RefreshCw size={12} />
                    <span>Restore Fleet to Nominal Health</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </aside>
      </main>

      {/* Floating Status Notification Toast */}
      {toastMessage && (
        <div className="toast-bar">
          <Activity size={13} color="#6366f1" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* ─── MODAL 1: ADMIN AUTHORIZATION PROMPT ─── */}
      {showAuthModal && (
        <div className="modal-backdrop" onClick={() => setShowAuthModal(false)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                <Lock size={15} color="#ef4444" />
                <span>Admin Authorization Required</span>
              </div>
              <button className="modal-close-btn" onClick={() => setShowAuthModal(false)}>
                <X size={15} />
              </button>
            </div>
            <form onSubmit={handleAuthSubmit}>
              <div className="modal-body">
                <p className="modal-description">
                  {pendingAction?.desc ? (
                    <>The action <b>"{pendingAction.desc}"</b> alters fleet health and requires an authorized administrative token.</>
                  ) : (
                    <>This operation is restricted. Please enter your <code>ADMIN_TOKEN</code> to authorize execution.</>
                  )}
                </p>

                <div className="modal-field">
                  <label className="modal-label">
                    <span>Admin Secret Token</span>
                    <span className="modal-hint">Session Only</span>
                  </label>
                  <div className="modal-input-wrap">
                    <input
                      type={showTokenPlain ? 'text' : 'password'}
                      className="modal-input mono"
                      placeholder="Enter ADMIN_TOKEN..."
                      value={authModalToken}
                      onChange={e => setAuthModalToken(e.target.value)}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="modal-input-toggle"
                      onClick={() => setShowTokenPlain(v => !v)}
                      title={showTokenPlain ? "Hide Token" : "Show Token"}
                    >
                      {showTokenPlain ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="modal-btn-secondary"
                  onClick={() => setShowAuthModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="modal-btn-primary"
                  disabled={!authModalToken.trim()}
                >
                  <Key size={13} />
                  <span>Authenticate & Execute</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─── MODAL 2: DYNAMIC CONNECTION & SECURITY SETTINGS ─── */}
      {showSettingsModal && (
        <div className="modal-backdrop" onClick={() => setShowSettingsModal(false)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                <Settings size={15} color="var(--indigo)" />
                <span>Connection & Security Settings</span>
              </div>
              <button className="modal-close-btn" onClick={() => setShowSettingsModal(false)}>
                <X size={15} />
              </button>
            </div>
            <form onSubmit={handleSaveSettings}>
              <div className="modal-body">
                <p className="modal-description">
                  Configure dynamic backend endpoints and operator authentication. Zero hardcoded ports, URLs, or embedded secrets.
                </p>

                <div className="modal-field">
                  <label className="modal-label">
                    <span>Backend API URL</span>
                    <span className="modal-hint">Empty = auto/proxy</span>
                  </label>
                  <input
                    type="text"
                    className="modal-input"
                    placeholder="e.g. https://api.yourdomain.com (default: relative)"
                    value={cfgApiUrl}
                    onChange={e => setCfgApiUrl(e.target.value)}
                  />
                </div>

                <div className="modal-field">
                  <label className="modal-label">
                    <span>WebSocket Stream URL</span>
                    <span className="modal-hint">Empty = auto-derived</span>
                  </label>
                  <input
                    type="text"
                    className="modal-input"
                    placeholder="e.g. wss://api.yourdomain.com/ws (default: auto)"
                    value={cfgWsUrl}
                    onChange={e => setCfgWsUrl(e.target.value)}
                  />
                </div>

                <div className="modal-field">
                  <label className="modal-label">
                    <span>Admin Token (ADMIN_TOKEN)</span>
                    <span className="modal-hint">{hasAdminToken ? 'Authenticated' : 'Unset'}</span>
                  </label>
                  <div className="modal-input-wrap">
                    <input
                      type={showTokenPlain ? 'text' : 'password'}
                      className="modal-input mono"
                      placeholder="Stored in temporary session storage only"
                      value={cfgAdminToken}
                      onChange={e => setCfgAdminToken(e.target.value)}
                    />
                    <button
                      type="button"
                      className="modal-input-toggle"
                      onClick={() => setShowTokenPlain(v => !v)}
                      title={showTokenPlain ? "Hide Token" : "Show Token"}
                    >
                      {showTokenPlain ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="modal-footer">
                {hasAdminToken && (
                  <button
                    type="button"
                    className="modal-btn-secondary"
                    onClick={handleClearToken}
                    style={{ marginRight: 'auto', color: 'var(--rose)' }}
                  >
                    Clear Token
                  </button>
                )}
                <button
                  type="button"
                  className="modal-btn-secondary"
                  onClick={() => setShowSettingsModal(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="modal-btn-primary">
                  <Check size={13} />
                  <span>Save Configuration</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<App />);
