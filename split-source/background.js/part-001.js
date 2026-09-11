importScripts('background_flow_context.js', 'background_requests.js', 'background_video_upload.js', 'background_telemetry.js', 'background_media_urls.js');
/**
 * Veo3 Kit — Chrome Extension Background Service Worker
 *
 * Connects to the local desktop app via WebSocket (app runs the WS server).
 * Captures bearer token, solves reCAPTCHA, proxies API calls through browser.
 */

const DEFAULT_AGENT_WS_URL = 'ws://127.0.0.1:9422';
const DEFAULT_CALLBACK_URL = 'http://127.0.0.1:8120/api/ext/callback';
const SERVER_AGENT_WS_URL = 'wss://veo3.1nutnhan.com/api/ext/socket';
const SERVER_CALLBACK_URL = 'https://veo3.1nutnhan.com/api/ext/callback';
const FLOW_AUTH_SESSION_URL = 'https://flow.google.com/api/auth/session';
const LEGACY_AUTH_SESSION_URL = 'https://labs.google/fx/api/auth/session';
const AUTH_SESSION_URLS = [FLOW_AUTH_SESSION_URL, LEGACY_AUTH_SESSION_URL];
const FLOW_URL = 'https://flow.google.com/';
const FLOW_URL_PATTERNS = ['https://flow.google.com/*', 'https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'];
// NOTE: This is a browser-restricted public API key — safe to ship in extension bundles.
const API_KEY = 'AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY';
const FLOW_KEY_REFRESH_MAX_AGE_MS = 45 * 60 * 1000;
const SOCKET_WATCHDOG_PERIOD_MINUTES = 0.5;
const SOCKET_STALE_AFTER_MS = 75 * 1000;
const EXTENSION_BUILD = 'flow-project-context-captcha-v12';
const EXTENSION_CAPABILITIES = Object.freeze([
  'flow_context',
  'video_upload',
  'video_upload_flow_tab_fallback',
  'video_upload_stage_errors',
  'captcha_session_refresh',
  'video_upload_signed_put_omit_credentials',
  'video_upload_page_start_worker_put',
  'video_upload_signed_origin_headers',
  'video_upload_signed_put_header_fallback',
  'video_upload_page_put_fallback',
  'video_upload_cors_response_headers',
]);

let ws = null;
let serverWs = null;
let flowKey = null;
let callbackSecret = null;  // Auth secret for HTTP callback, received from server on WS connect
let serverCallbackSecret = null;
let callbackUrl = DEFAULT_CALLBACK_URL;
let serverCallbackUrl = SERVER_CALLBACK_URL;
let agentWsUrl = DEFAULT_AGENT_WS_URL;
let agentConnectionMode = 'automatic';
let extensionProfileId = null;
let state = 'off'; // off | idle | running
let manualDisconnect = false;
let suppressNextClose = false;
let connectInFlight = false;
let serverSuppressNextClose = false;
let serverConnectInFlight = false;
let lastLocalSocketActivityAt = 0;
let lastServerSocketActivityAt = 0;
let authSessionRefreshPromise = null;
const requestRouteById = new Map();
let metrics = {
  tokenCapturedAt: null,
  requestCount: 0,   // captcha-consuming requests only (gen image/video/upscale)
  successCount: 0,
  failedCount: 0,
  lastError: null,
};

// ─── URL → Log Type Classifier ─────────────────────────────

// Visible log types — only these appear in the request log
const _VISIBLE_TYPES = new Set(['GEN_IMG', 'GEN_VID', 'GEN_VID_REF', 'UPSCALE', 'TRACKING', 'URL_REFRESH']);

function _classifyApiUrl(url) {
  if (url.includes('uploadImage'))                     return 'UPLOAD';
  if (url.includes('batchGenerateImages'))              return 'GEN_IMG';
  if (url.includes('UpsampleVideo'))                   return 'UPSCALE';
  if (url.includes('ReferenceImages'))                 return 'GEN_VID_REF';
  if (url.includes('batchAsyncGenerateVideo'))          return 'GEN_VID';
  if (url.includes('batchCheckAsync'))                  return 'POLL';
  if (url.includes('upsampleImage'))                   return 'UPS_IMG';
  if (url.includes('/media/'))                         return 'MEDIA';
  if (url.includes('/credits'))                        return 'CREDITS';
  return 'API';
}

// ─── Request Log ────────────────────────────────────────────

let requestLog = [];

function addRequestLog(entry) {
  requestLog.unshift(entry);
  if (requestLog.length > 100) requestLog.pop();
  broadcastRequestLog();
}

function updateRequestLog(id, updates) {
  const entry = requestLog.find((e) => e.id === id);
  if (entry) Object.assign(entry, updates);
  broadcastRequestLog();
}

function broadcastRequestLog() {
  chrome.runtime.sendMessage({ type: 'REQUEST_LOG_UPDATE', log: requestLog }).catch(() => {});
}

function clearRequestLog() {
  requestLog = [];
  broadcastRequestLog();
}

// ─── Startup ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
init().catch((error) => console.error('[FlowAgent] init failed:', error));


chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'reconnect') connectToAgent();
  if (alarm.name === 'reconnect-server') connectServerAgent();
  if (alarm.name === 'keepAlive') keepAlive();
  if (alarm.name === 'token-refresh') {
    try {
      await captureTokenFromFlowTab();
    } catch (error) {
      console.warn('[FlowAgent] Scheduled Flow tab token capture failed:', error?.message || error);
    }
  }
});

async function init() {
  const data = await chrome.storage.local.get([
    'flowKey',
    'metrics',
    'callbackSecret',
    'serverCallbackSecret',
    'callbackUrl',
    'serverCallbackUrl',
    'agentWsUrl',
    'agentConnectionMode',
    'extensionProfileId',
    'profileName',
    'profileEmail',
  ]);
  extensionProfileId = data.extensionProfileId || cryptoRandomId();
  if (!data.extensionProfileId) {
    await chrome.storage.local.set({ extensionProfileId });
  }
  if (data.flowKey) flowKey = data.flowKey;
  if (data.metrics) Object.assign(metrics, data.metrics);
  if (data.callbackSecret) callbackSecret = data.callbackSecret;
  if (data.serverCallbackSecret) serverCallbackSecret = data.serverCallbackSecret;
  if (data.callbackUrl) callbackUrl = data.callbackUrl;
  if (data.serverCallbackUrl) serverCallbackUrl = normalizeCallbackUrl(data.serverCallbackUrl);
  if (data.agentWsUrl) agentWsUrl = normalizeAgentWsUrl(data.agentWsUrl);
  agentConnectionMode = normalizeAgentConnectionMode(data.agentConnectionMode || 'automatic');
  reconnectConfiguredAgents();
  chrome.alarms.create('keepAlive', { periodInMinutes: SOCKET_WATCHDOG_PERIOD_MINUTES });
}

function normalizeAgentConnectionMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  if (value === 'automatic' || value === 'local-local' || value === 'server-local') return value;
  return 'custom';
}

function localAgentEnabled() {
  return agentConnectionMode === 'automatic' || agentConnectionMode === 'local-local' || agentConnectionMode === 'custom';
}

function serverAgentEnabled() {
  return agentConnectionMode === 'automatic' || agentConnectionMode === 'server-local';
}

function inferAgentModeFromUrls(nextAgentWsUrl, nextCallbackUrl) {
  const wsUrl = normalizeAgentWsUrl(nextAgentWsUrl);
  const callback = normalizeCallbackUrl(nextCallbackUrl);
  if (wsUrl === normalizeAgentWsUrl(SERVER_AGENT_WS_URL) && callback === normalizeCallbackUrl(SERVER_CALLBACK_URL)) return 'server-local';
  if (wsUrl === normalizeAgentWsUrl(DEFAULT_AGENT_WS_URL) && callback === normalizeCallbackUrl(DEFAULT_CALLBACK_URL)) return 'local-local';
  return 'custom';
}

function normalizeAgentWsUrl(value) {
  const raw = String(value || DEFAULT_AGENT_WS_URL).trim();
  try {
    const url = new URL(raw);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return DEFAULT_AGENT_WS_URL;
    if (!url.pathname || url.pathname === '/') url.pathname = '/';
    return url.toString();
  } catch (_) {
    return DEFAULT_AGENT_WS_URL;
  }
}

function normalizeCallbackUrl(value) {
  const raw = String(value || DEFAULT_CALLBACK_URL).trim();
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_CALLBACK_URL;
    return url.toString();
  } catch (_) {
    return DEFAULT_CALLBACK_URL;
  }
}

function cryptoRandomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `chrome-${Array.from(bytes).map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

async function extensionIdentity() {
  const data = await chrome.storage.local.get(['extensionProfileId', 'profileName', 'profileEmail']);
  if (!extensionProfileId) extensionProfileId = data.extensionProfileId || cryptoRandomId();
  const manifest = chrome.runtime.getManifest();
  const extensionName = manifest.name || manifest.action?.default_title || 'Veo3 Kit Extension';
  return {
    extensionId: chrome.runtime.id,
    extensionName,
    extensionDisplayName: extensionName.includes('Extension') ? extensionName : `${extensionName} Extension`,
    extensionVersion: String(manifest.version || ''),
    extensionBuild: EXTENSION_BUILD,
    extensionCapabilities: [...EXTENSION_CAPABILITIES],
    extensionProfileId,
    profileName: data.profileName || '',
    email: data.profileEmail || '',
  };
}

// Enable opening the side panel on clicking the action icon
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// Fallback just in case setPanelBehavior doesn't catch it
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
});

// ─── Token Capture ──────────────────────────────────────────

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details?.requestHeaders?.length) return;
    const authHeader = details.requestHeaders.find(
      (h) => h.name?.toLowerCase() === 'authorization',
    );
    const value = authHeader?.value || '';
    if (!value.startsWith('Bearer ya29.')) return;

    const token = value.replace(/^Bearer\s+/i, '').trim();
    if (!token) return;

    setFlowKey(token, 'webRequest').catch((error) => {
      console.warn('[FlowAgent] Could not persist captured bearer token:', error?.message || error);
    });
  },
  { urls: ['https://aisandbox-pa.googleapis.com/*', 'https://flow.google.com/*', 'https://labs.google/*'] },
  ['requestHeaders', 'extraHeaders'],
);

let _openingFlowTab = false;

async function setFlowKey(token, source = 'unknown') {
  const clean = String(token || '').trim();
  if (!clean) return false;

  // Always update — even if same token string, refresh the timestamp
  flowKey = clean;
  metrics.tokenCapturedAt = Date.now();
  metrics.lastError = null;
  await chrome.storage.local.set({ flowKey, metrics });
  console.log(`[FlowAgent] Bearer token captured via ${source}`);

  // Notify agent
  sendToOpenAgentSockets({ type: 'token_captured', flowKey });
  broadcastStatus();
  return true;
}

async function requestFlowSessionFromTab(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'GET_FLOW_SESSION', urls: AUTH_SESSION_URLS });
  } catch (error) {
    const msg = error?.message || '';
    const shouldInject = msg.includes('Receiving end does not exist') || msg.includes('Could not establish connection');
    if (!shouldInject) throw error;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await sleep(300);
    return chrome.tabs.sendMessage(tabId, { type: 'GET_FLOW_SESSION', urls: AUTH_SESSION_URLS });
  }
}

async function getReadyFlowTab({ focus = false } = {}) {
  const tabs = await chrome.tabs.query({ url: FLOW_URL_PATTERNS });
  const tab = tabs.find((candidate) => /^https:\/\/flow\.google\.com\//.test(candidate.url || '')) || tabs[0];
  if (tab?.id && focus) await chrome.tabs.update(tab.id, { active: true });
  return tab || null;
}

async function fetchFlowSessionFromTab({ focus = false } = {}) {
  const tab = await getReadyFlowTab({ focus });
  if (!tab?.id) return { ok: false, error: 'NO_FLOW_TAB' };
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
  const response = await requestFlowSessionFromTab(tab.id);
  return { ...(response || {}), source: 'flow_tab', tabId: tab.id };
}

async function fetchFlowSessionFromBackground() {
  let last = { ok: false, error: 'FLOW_SESSION_FETCH_FAILED' };
  for (const url of AUTH_SESSION_URLS) {
    try {
      const response = await fetch(url, {
        method: 'GET', credentials: 'include', cache: 'no-store',
        headers: { accept: '*/*', 'content-type': 'application/json' },
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      last = { ok: response.ok, status: response.status, data, source: 'background_fetch', url };
      const hasAccessToken = Boolean(data?.access_token || data?.accessToken || data?.token);
      if (response.ok && hasAccessToken) return last;
    } catch (error) {
      last = { ok: false, error: error?.message || 'BACKGROUND_SESSION_FAILED', source: 'background_fetch', url };
    }
  }
  return last;
}

async function getFlowCookieSummary() {
  try {
    const cookies = [];
    for (const url of ['https://flow.google/', 'https://labs.google/']) {
      cookies.push(...await chrome.cookies.getAll({ url }));
    }
    const unique = new Map(cookies.map((cookie) => [
      `${cookie.domain}|${cookie.path}|${cookie.name}`, cookie,
    ]));
    const values = [...unique.values()];
    return {
      count: values.length,
      hasSessionCookie: values.some((cookie) => /next-auth\.session-token/i.test(cookie.name || '')),
      hasCsrfCookie: values.some((cookie) => /next-auth\.csrf-token/i.test(cookie.name || '')),
      emailCookiePresent: values.some((cookie) => cookie.name === 'EMAIL'),
    };
  } catch (error) {
    return { count: 0, error: error?.message || 'COOKIE_READ_FAILED' };
  }
}

function publicSessionSummary(session) {
  const user = session?.user || {};
  return {
    user: { name: user.name || '', email: user.email || '', image: user.image || '' },
    expires: session?.expires || session?.expires_at || session?.expiresAt || '',
    accessTokenPresent: Boolean(session?.access_token || session?.accessToken || session?.token),
  };
}

async function refreshFlowSessionFromAuthApi(options = {}) {
  metrics.lastError = 'Refreshing Flow session...';
  await chrome.storage.local.set({ metrics });
  broadcastStatus();
  const cookies = await getFlowCookieSummary();
  let sessionResponse = null;
  let fallbackError = null;
  try { sessionResponse = await fetchFlowSessionFromTab({ focus: options.focus === true }); }
  catch (error) { fallbackError = error?.message || 'FLOW_TAB_SESSION_FAILED'; }
  if (!sessionResponse?.ok) {
    try { sessionResponse = await fetchFlowSessionFromBackground(); }
    catch (error) { fallbackError = fallbackError || error?.message || 'BACKGROUND_SESSION_FAILED'; }
  }
  const session = sessionResponse?.data || null;
  const accessToken = String(session?.access_token || session?.accessToken || session?.token || '').trim();
  if (!sessionResponse?.ok || !accessToken) {
    const error = sessionResponse?.error || fallbackError ||
      (sessionResponse?.status ? `FLOW_SESSION_${sessionResponse.status}` : 'FLOW_SESSION_NO_ACCESS_TOKEN');
    metrics.lastError = error;
    await chrome.storage.local.set({ metrics });
    broadcastStatus();
    return { ok: false, error, status: sessionResponse?.status || null, cookies,
      session: publicSessionSummary(session), source: sessionResponse?.source || '' };
  }
  await setFlowKey(accessToken, 'auth_session_api');
  const user = session?.user || {};
  const userInfo = { name: user.name || '', email: user.email || '', picture: user.image || '' };
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'user_info', extensionProfileId, userInfo }));
  return { ok: true, status: sessionResponse.status || 200, flowKeyPresent: Boolean(flowKey),
    tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
    cookies, session: publicSessionSummary(session), userInfo, source: sessionResponse.source || '' };
}

async function refreshFlowKeyFromAuthSession(reason = 'auth session') {
  if (authSessionRefreshPromise) return authSessionRefreshPromise;

  authSessionRefreshPromise = (async () => {
    console.log('[FlowAgent] Refreshing access_token from Flow auth session:', reason);
    const sessionResponse = await fetchFlowSessionFromBackground();
    const response = { ok: sessionResponse.ok, status: sessionResponse.status || 0 };
    const payload = sessionResponse.data || {};
    const token = String(payload?.access_token || payload?.accessToken || payload?.token || '').trim();
    if (!response.ok || !token) {
      const message = payload?.error || payload?.message || sessionResponse.error || `HTTP ${response.status}`;
      metrics.lastError = `AUTH_SESSION_${response.status}: ${message}`;
      await chrome.storage.local.set({ metrics });
      throw new Error(`Flow auth session did not return access_token (${response.status}): ${message}`);
    }

    const user = payload?.user && typeof payload.user === 'object' ? payload.user : {};
    const profileUpdates = {};
    if (user.name) profileUpdates.profileName = String(user.name).slice(0, 120);
    if (user.email) profileUpdates.profileEmail = String(user.email).slice(0, 180);
    if (Object.keys(profileUpdates).length) {
      await chrome.storage.local.set(profileUpdates);
    }
    await setFlowKey(token, 'auth_session');
    return {
      ok: true,
      source: 'auth_session',
      expires: payload?.expires || payload?.expires_at || payload?.expiresAt || null,
      user: {
        name: profileUpdates.profileName || '',
        email: profileUpdates.profileEmail || '',
      },
      reason,
      source: sessionResponse.source || 'background_fetch',
    };
  })();

  try {
    return await authSessionRefreshPromise;
  } finally {
    authSessionRefreshPromise = null;
  }
}

async function clearFlowSessionAndReload(reason = 'reCAPTCHA failure') {
  try {
    const result = await refreshFlowKeyFromAuthSession(reason);
    broadcastStatus();
    return result;
  } catch (error) {
    console.warn('[FlowAgent] Auth session refresh failed; falling back to Flow tab:', error?.message || error);
    metrics.lastError = `AUTH_SESSION_REFRESH_FAILED: ${error?.message || error}`;
    await chrome.storage.local.set({ metrics });
    await captureTokenFromFlowTab();
  }
  broadcastStatus();
  return { ok: false, reason, message: 'Auth session refresh failed; triggered Flow tab token capture fallback.' };
}

async function ensureFreshFlowKey(reason = 'api request') {
  const tokenAge = metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : Number.POSITIVE_INFINITY;
  if (flowKey && tokenAge < FLOW_KEY_REFRESH_MAX_AGE_MS) {
    return { ok: true, skipped: true, tokenAge };
  }

  const previousFlowKey = flowKey;
  try {
    const result = await refreshFlowKeyFromAuthSession(reason);
    return {
      ...result,
      tokenChanged: Boolean(flowKey && flowKey !== previousFlowKey),
    };
  } catch (error) {
    console.warn('[FlowAgent] Fresh token refresh failed; falling back to Flow tab capture:', error?.message || error);
    metrics.lastError = 'FRESH_TOKEN_REFRESH_FAILED: ' + (error?.message || error);
    await chrome.storage.local.set({ metrics });
    await captureTokenFromFlowTab();
    await sleep(1500);
    return {
      ok: Boolean(flowKey),
      source: 'flow_tab_capture',
      tokenChanged: Boolean(flowKey && flowKey !== previousFlowKey),
      error: error?.message || String(error),
    };
  }
}

async function captureTokenFromFlowTab() {
  const tabs = await chrome.tabs.query({ url: FLOW_URL_PATTERNS });
  if (!tabs.length) {
    if (_openingFlowTab) {
      console.log('[FlowAgent] Flow tab already opening, skipping');
      return;
    }
    _openingFlowTab = true;
    try {
      console.log('[FlowAgent] No Flow tab found — opening one in background');
      await chrome.tabs.create({ url: FLOW_URL, active: false });
      await sleep(3000);
      const retryTabs = await chrome.tabs.query({ url: FLOW_URL_PATTERNS });
      if (!retryTabs.length) {
        console.log('[FlowAgent] Flow tab not ready yet after open');
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId: retryTabs[0].id },
        files: ['content.js'],
      });
      console.log('[FlowAgent] Token refresh triggered on newly opened Flow tab');
    } catch (e) {
      console.error('[FlowAgent] Token refresh failed after opening tab:', e);
    } finally {
      _openingFlowTab = false;
    }
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      files: ['content.js'],
    });
    console.log('[FlowAgent] Token refresh triggered on Flow tab');
  } catch (e) {
    console.error('[FlowAgent] Token refresh failed:', e);
  }
}
