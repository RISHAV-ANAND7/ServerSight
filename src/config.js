/**
 * ServerSight Dynamic Connection & Security Configuration
 *
 * Fully dynamic endpoint resolution supporting:
 * 1. Separately hosted frontend deployments (Vercel, Netlify, Cloudflare Pages, S3).
 * 2. Environment variable overrides (VITE_API_URL, VITE_WS_URL).
 * 3. Operator runtime settings via UI modal (stored in localStorage/sessionStorage).
 * 4. Zero hardcoded ports, URLs, or administrative secret tokens.
 */

const STORAGE_KEY_API = 'serversight_api_url';
const STORAGE_KEY_WS = 'serversight_ws_url';
const STORAGE_KEY_TOKEN = 'serversight_admin_token';

/**
 * Returns the configured base API URL without trailing slash.
 * E.g., "https://api.serversight.io" or "" for relative proxying.
 */
export function getApiBaseUrl() {
  if (typeof window === 'undefined') return '';
  const userOverride = localStorage.getItem(STORAGE_KEY_API);
  if (userOverride && userOverride.trim()) {
    return userOverride.trim().replace(/\/+$/, '');
  }
  const envUrl = import.meta.env.VITE_API_URL || import.meta.env.VITE_BACKEND_URL;
  if (envUrl && typeof envUrl === 'string' && envUrl.trim()) {
    return envUrl.trim().replace(/\/+$/, '');
  }
  // Default to relative root (works with Vite proxy or reverse proxies)
  return '';
}

/**
 * Returns the resolved WebSocket stream URL.
 * Automatically derives wss:// from https:// or uses explicit environment/storage override.
 */
export function getWsUrl() {
  if (typeof window === 'undefined') return (import.meta.env?.VITE_WS_URL || '');
  const userOverride = localStorage.getItem(STORAGE_KEY_WS);
  if (userOverride && userOverride.trim()) {
    return userOverride.trim();
  }
  const envWs = import.meta.env.VITE_WS_URL;
  if (envWs && typeof envWs === 'string' && envWs.trim()) {
    return envWs.trim();
  }

  const apiBase = getApiBaseUrl();
  if (apiBase && /^https?:\/\//i.test(apiBase)) {
    const wsProto = apiBase.startsWith('https:') ? 'wss:' : 'ws:';
    const hostPart = apiBase.replace(/^https?:\/\//i, '');
    return `${wsProto}//${hostPart}/ws`;
  }

  // Fallback to current browser host (dynamic host & port, e.g. window.location.host)
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

/**
 * Constructs a fully qualified API endpoint URL.
 */
export function buildApiUrl(path) {
  const base = getApiBaseUrl();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${cleanPath}`;
}

/**
 * Retrieves the operator admin token from temporary browser session storage.
 * Never hardcoded in source files or persistent public bundles.
 */
export function getAdminToken() {
  if (typeof window === 'undefined') return null;
  const sessionToken = sessionStorage.getItem(STORAGE_KEY_TOKEN);
  if (sessionToken && sessionToken.trim()) return sessionToken.trim();

  // Optional local environment variable during development only (never in client bundle if unset)
  const envToken = import.meta.env.VITE_ADMIN_TOKEN;
  if (envToken && typeof envToken === 'string' && envToken.trim()) {
    return envToken.trim();
  }
  return null;
}

/**
 * Persists an operator admin token in session storage for the active browser session.
 */
export function setAdminToken(token) {
  if (typeof window === 'undefined') return;
  if (!token || !token.trim()) {
    sessionStorage.removeItem(STORAGE_KEY_TOKEN);
  } else {
    sessionStorage.setItem(STORAGE_KEY_TOKEN, token.trim());
  }
}

/**
 * Clears the operator admin token from session storage.
 */
export function clearAdminToken() {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(STORAGE_KEY_TOKEN);
}

/**
 * Saves custom connection endpoints in localStorage.
 */
export function saveCustomEndpoints(apiUrl, wsUrl) {
  if (typeof window === 'undefined') return;
  if (apiUrl && apiUrl.trim()) {
    localStorage.setItem(STORAGE_KEY_API, apiUrl.trim().replace(/\/+$/, ''));
  } else {
    localStorage.removeItem(STORAGE_KEY_API);
  }

  if (wsUrl && wsUrl.trim()) {
    localStorage.setItem(STORAGE_KEY_WS, wsUrl.trim());
  } else {
    localStorage.removeItem(STORAGE_KEY_WS);
  }
}
