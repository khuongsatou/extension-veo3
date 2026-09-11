/**
 * Veo3 Kit — Side Panel
 * Displays live connection status, metrics, and request log.
 */

// ── Type label map ───────────────────────────────────────────

const TYPE_LABELS = {
  // Worker request types
  GENERATE_IMAGE:           'GEN IMAGE',
  REGENERATE_IMAGE:         'REGEN IMAGE',
  EDIT_IMAGE:               'EDIT IMAGE',
  GENERATE_CHARACTER_IMAGE: 'GEN REF',
  REGENERATE_CHARACTER_IMAGE: 'REGEN REF',
  EDIT_CHARACTER_IMAGE:     'EDIT REF',
  GENERATE_VIDEO:           'GEN VIDEO',
  GENERATE_VIDEO_REFS:      'GEN VIDEO FROM REFS',
  UPSCALE_VIDEO:            'UPSCALE VIDEO',
  // Captcha action types
  IMAGE_GENERATION:         'GEN IMAGE',
  VIDEO_GENERATION:         'GEN VIDEO',
  // Extension-classified API types
  GEN_IMG:                  'GEN IMAGE',
  GEN_VID:                  'GEN VIDEO',
  GEN_VID_REF:              'GEN VIDEO FROM REFS',
  UPSCALE:                  'UPSCALE VIDEO',
  UPS_IMG:                  'UPSCALE IMAGE',
  POLL:                     'CHECK GEN VIDEO',
  CREDITS:                  'CHECK CREDIT',
  CREATE_PROJECT:           'CREATE PROJECT',
  UPLOAD:                   'UPLOAD IMAGE',
  MEDIA:                    'READ MEDIA',
  TRACKING:                 'GOOGLE FLOW TRACK',
  URL_REFRESH:              'URL REFRESH',
  TRPC:                     'TRPC',
  API:                      'API',
};

const DEFAULT_AGENT_WS_URL = 'ws://127.0.0.1:9422';
const DEFAULT_CALLBACK_URL = 'http://127.0.0.1:8120/api/ext/callback';
const SERVER_AGENT_WS_URL = 'wss://veo3.1nutnhan.com/api/ext/socket';
const SERVER_CALLBACK_URL = 'https://veo3.1nutnhan.com/api/ext/callback';
const AGENT_CONFIG_COLLAPSED_STORAGE_KEY = 'veo3KitAgentSocketCollapsed';

const AGENT_ROUTE_PRESETS = {
  automatic: { agentMode: 'automatic', agentWsUrl: DEFAULT_AGENT_WS_URL, callbackUrl: DEFAULT_CALLBACK_URL },
  'local-local': { agentMode: 'local-local', agentWsUrl: DEFAULT_AGENT_WS_URL, callbackUrl: DEFAULT_CALLBACK_URL },
  'server-local': { agentMode: 'server-local', agentWsUrl: SERVER_AGENT_WS_URL, callbackUrl: SERVER_CALLBACK_URL },
};

function formatType(type) {
  if (!type) return '—';
  return TYPE_LABELS[type] || type.slice(0, 5).toUpperCase();
}

function normalizeUiUrl(value, fallback) {
  try {
    const url = new URL(String(value || fallback).trim());
    if (url.pathname === '/' && !url.search && !url.hash) {
      url.pathname = '';
    }
    return url.toString();
  } catch {
    return fallback;
  }
}

function agentRouteFromConfig(config = {}) {
  const mode = String(config.agentMode || '').trim().toLowerCase();
  if (mode === 'automatic' || mode === 'local-local' || mode === 'server-local') return mode;
  const ws = normalizeUiUrl(config.agentWsUrl || '', DEFAULT_AGENT_WS_URL);
  const callback = normalizeUiUrl(config.callbackUrl || '', DEFAULT_CALLBACK_URL);
  if (ws === normalizeUiUrl(SERVER_AGENT_WS_URL, SERVER_AGENT_WS_URL) && callback === normalizeUiUrl(SERVER_CALLBACK_URL, SERVER_CALLBACK_URL)) {
    return 'server-local';
  }
  if (ws === normalizeUiUrl(DEFAULT_AGENT_WS_URL, DEFAULT_AGENT_WS_URL) && callback === normalizeUiUrl(DEFAULT_CALLBACK_URL, DEFAULT_CALLBACK_URL)) {
    return 'local-local';
  }
  return 'custom';
}

function fillAgentRoute(config = {}) {
  const routeSelect = document.getElementById('agent-route-mode');
  const socketInput = document.getElementById('agent-ws-url');
  const callbackInput = document.getElementById('agent-callback-url');
  const route = agentRouteFromConfig(config);
  if (routeSelect) routeSelect.value = route;
  if (socketInput && document.activeElement !== socketInput) socketInput.value = config.agentWsUrl || DEFAULT_AGENT_WS_URL;
  if (callbackInput && document.activeElement !== callbackInput) callbackInput.value = config.callbackUrl || DEFAULT_CALLBACK_URL;
  return route;
}

function routeStatusLabel(route) {
  if (route === 'automatic') return 'auto both';
  if (route === 'server-local') return 'server -> local';
  if (route === 'local-local') return 'local -> local';
  return 'custom';
}

// ── Time formatting ──────────────────────────────────────────

function formatTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch {
    return '—';
  }
}

// ── Status update ────────────────────────────────────────────

function updateStatus(data) {
  if (!data) return;

  // Connection dot
  const dot = document.getElementById('conn-dot');
  const connected = data.agentConnected;
  dot.className = connected ? 'on' : '';

  // Toggle state
  const toggle = document.getElementById('main-toggle');
  const toggleLabel = document.getElementById('toggle-label');
  const isOn = data.state !== 'off';
  toggle.checked = isOn;
  toggleLabel.textContent = isOn ? 'ON' : 'OFF';

  // State badge
  const stateBadge = document.getElementById('state-badge');
  const st = data.state || 'off';
  stateBadge.textContent = st;
  stateBadge.className = st; // idle | running | off

  // Token status
  const tokenEl = document.getElementById('token-status');
  if (data.flowKeyPresent) {
    const ageMs = data.tokenAge || 0;
    const ageMin = Math.round(ageMs / 60000);
    if (ageMs > 3600000) {
      tokenEl.textContent = `token expired — open Flow to refresh`;
      tokenEl.className = 'warn';
    } else {
      tokenEl.textContent = `token synced ${ageMin}m`;
      tokenEl.className = 'ok';
    }
    // Auto-refresh when token age > 55 min and connected
    if (ageMs > 3300000 && data.agentConnected) {
      chrome.runtime.sendMessage({ type: 'REFRESH_TOKEN' });
    }
  } else {
    tokenEl.textContent = 'no token';
    tokenEl.className = 'bad';
  }

  // Metrics
  const m = data.metrics || {};
  document.getElementById('m-total').textContent   = m.requestCount || 0;
  document.getElementById('m-success').textContent = m.successCount || 0;
  document.getElementById('m-failed').textContent  = m.failedCount  || 0;

  const route = fillAgentRoute({
    agentMode: data.agentMode,
    agentWsUrl: data.agentWsUrl || DEFAULT_AGENT_WS_URL,
    callbackUrl: data.callbackUrl || DEFAULT_CALLBACK_URL,
  });
  setAgentConfigStatus(routeStatusLabel(route), route === 'custom' ? '' : 'ok');
}

// ── Request log ──────────────────────────────────────────────

function updateRequestLog(entries) {
  const tbody = document.getElementById('log-body');
  const countEl = document.getElementById('log-count');
  const clearBtn = document.getElementById('log-clear');

  if (!entries || entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="log-empty">No requests yet</td></tr>';
    countEl.textContent = '0';
    _logEntries = [];
    if (clearBtn) clearBtn.disabled = true;
    return;
  }

  countEl.textContent = entries.length;
  _logEntries = entries;
  if (clearBtn) clearBtn.disabled = false;

  // Render newest first (entries already sorted DESC by background.js)
  const rows = entries.map((entry) => {
    const shortId = entry.id ? String(entry.id).slice(0, 8) : '—';
    const type   = formatType(entry.type || entry.method);
    const time   = formatTime(entry.time || entry.timestamp || entry.createdAt);
    const status = entry.status || entry.state || 'pending';
    const error  = entry.error || '';

    let badgeHtml;
    if (status === 'COMPLETED' || status === 'success') {
      badgeHtml = '<span class="badge badge-ok">&#10003; done</span>';
    } else if (status === 'FAILED' || status === 'failed' || (typeof status === 'number' && status >= 400)) {
      badgeHtml = '<span class="badge badge-fail">&#10007; fail</span>';
    } else if (status === 'PROCESSING') {
      badgeHtml = '<span class="badge badge-proc">&#9203; gen...</span>';
    } else if (status === 200 || status === 'processing') {
      badgeHtml = '<span class="badge badge-proc">&#9203; sent</span>';
    } else {
      badgeHtml = '<span class="badge badge-proc">&#9203; sent</span>';
    }

    const canInspect = Boolean(error || entry.curlFull || entry.responseFull || entry.responseSummary || entry.payloadSummary);
    const rowClass = canInspect ? 'inspectable' : '';
    const errorDisplay = error
      ? `<td class="td-error" title="${escHtml(error)}">${escHtml(truncate(error, 28))}</td>`
      : `<td class="td-error empty">—</td>`;

    return `<tr class="${rowClass}" data-request-id="${escHtml(entry.id || '')}" title="${canInspect ? 'Click to inspect curl / response' : ''}">
      <td class="td-id" data-request-id="${escHtml(entry.id || '')}">${escHtml(shortId)}</td>
      <td class="td-type">${escHtml(type)}</td>
      <td class="td-time">${escHtml(time)}</td>
      <td>${badgeHtml}</td>
      ${errorDisplay}
    </tr>`;
  });

  tbody.innerHTML = rows.join('');

  // Attach click handlers to inspectable rows
  tbody.querySelectorAll('tr.inspectable[data-request-id]').forEach(row => {
    row.addEventListener('click', () => {
      const reqId = row.getAttribute('data-request-id');
      if (reqId) showRequestDetail(reqId);
    });
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str, len) {
  if (!str || str.length <= len) return str;
  return str.slice(0, len) + '…';
}

// ── Request detail modal ────────────────────────────────────

let _logEntries = [];

function showRequestDetail(reqId) {
  const entry = _logEntries.find(e => e.id === reqId);
  if (!entry) return;

  const overlay = document.getElementById('detail-overlay');
  const title = document.getElementById('detail-title');
  const body = document.getElementById('detail-body');

  title.textContent = `Request ${String(reqId).slice(0, 12)}`;

  const fields = [
    ['ID', entry.id],
    ['Type', formatType(entry.type || entry.method)],
    ['Time', formatTime(entry.time || entry.timestamp || entry.createdAt)],
    ['Status', entry.status || entry.state || 'pending'],
    ['HTTP', entry.httpStatus || '—'],
    ['URL', entry.url || '—'],
    ['Error', entry.error || '—'],
  ];

  const fieldHtml = fields.map(([label, value]) => {
    let cls = 'detail-value';
    if (label === 'Error' && value && value !== '—') cls += ' error';
    if (label === 'Status' && (value === 'COMPLETED' || value === 'success')) cls += ' ok';
    return `<div class="detail-row">
      <div class="detail-label">${escHtml(label)}</div>
      <div class="${cls}">${escHtml(String(value || '—'))}</div>
    </div>`;
  }).join('');

  const blocks = [
    ['Curl', entry.curlFull || '—'],
    ['Request Body', entry.requestBodyFull || entry.payloadSummary || '—'],
    ['Response', entry.responseFull || entry.responseSummary || '—'],
  ];

  const blockHtml = blocks.map(([label, value], index) => {
    const safeValue = String(value || '—');
    const copyId = `copy-${index}`;
    return `<div class="detail-block">
      <div class="detail-block-head">
        <span>${escHtml(label)}</span>
        <button class="detail-copy" type="button" data-copy-target="${copyId}">Copy</button>
      </div>
      <pre class="detail-code" id="${copyId}">${escHtml(safeValue)}</pre>
    </div>`;
  }).join('');

  body.innerHTML = fieldHtml + blockHtml;
  body.querySelectorAll('[data-copy-target]').forEach(btn => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const target = document.getElementById(btn.getAttribute('data-copy-target'));
      await navigator.clipboard.writeText(target?.textContent || '');
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 900);
    });
  });

  overlay.classList.add('open');
}

document.getElementById('detail-close').addEventListener('click', () => {
  document.getElementById('detail-overlay').classList.remove('open');
});

document.getElementById('detail-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.classList.remove('open');
  }
});

// ── Initial data fetch ───────────────────────────────────────

function fetchStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS' }, (data) => {
    if (chrome.runtime.lastError) return;
    updateStatus(data);
  });
}

function fetchLog() {
  chrome.runtime.sendMessage({ type: 'REQUEST_LOG' }, (data) => {
    if (chrome.runtime.lastError) return;
    if (data && data.log) updateRequestLog(data.log);
  });
}

// ── Message listener (push updates) ─────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_PUSH') {
    fetchStatus();
  }
  if (msg.type === 'REQUEST_LOG_UPDATE') {
    if (msg.log) updateRequestLog(msg.log);
  }
});

// ── Toggle (connect / disconnect) ───────────────────────────

document.getElementById('main-toggle').addEventListener('change', (e) => {
  const msgType = e.target.checked ? 'RECONNECT' : 'DISCONNECT';
  chrome.runtime.sendMessage({ type: msgType }, () => {
    if (chrome.runtime.lastError) return;
    setTimeout(fetchStatus, 400);
  });
});

// ── Agent socket config ─────────────────────────────────────

function setAgentConfigStatus(text, tone = '') {
  const status = document.getElementById('agent-config-status');
  if (!status) return;
  status.textContent = text;
  status.className = tone;
}

function readAgentConfigCollapsed() {
  try { return localStorage.getItem(AGENT_CONFIG_COLLAPSED_STORAGE_KEY) !== '0'; }
  catch (_) { return true; }
}

function setAgentConfigCollapsed(collapsed, persist = true) {
  const panel = document.getElementById('agent-config');
  const toggle = document.getElementById('agent-config-toggle');
  const body = document.getElementById('agent-config-body');
  const caret = document.getElementById('agent-config-caret');
  if (panel) panel.classList.toggle('is-collapsed', collapsed);
  if (toggle) toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  if (body) body.hidden = collapsed;
  if (caret) caret.textContent = collapsed ? '▸' : '▾';
  if (!persist) return;
  try {
    localStorage.setItem(AGENT_CONFIG_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch (_) {}
}

function loadAgentConfig() {
  chrome.runtime.sendMessage({ type: 'GET_AGENT_CONFIG' }, (data) => {
    if (chrome.runtime.lastError || !data) return;
    const route = fillAgentRoute({
      agentMode: data.agentMode,
      agentWsUrl: data.agentWsUrl || DEFAULT_AGENT_WS_URL,
      callbackUrl: data.callbackUrl || DEFAULT_CALLBACK_URL,
    });
    setAgentConfigStatus(routeStatusLabel(route), route === 'custom' ? '' : 'ok');
  });
}

function saveAgentConfig(agentMode, agentWsUrl, callbackUrl) {
  setAgentConfigStatus('saving...', '');
  chrome.runtime.sendMessage({ type: 'SAVE_AGENT_CONFIG', agentMode, agentWsUrl, callbackUrl }, (data) => {
    if (chrome.runtime.lastError || data?.error) {
      setAgentConfigStatus('save failed', 'bad');
      return;
    }
    const route = fillAgentRoute({
      agentMode: data.agentMode,
      agentWsUrl: data.agentWsUrl || agentWsUrl,
      callbackUrl: data.callbackUrl || callbackUrl,
    });
    setAgentConfigStatus('saved', 'ok');
    setTimeout(() => setAgentConfigStatus(routeStatusLabel(route), route === 'custom' ? '' : 'ok'), 900);
    setTimeout(fetchStatus, 500);
  });
}

document.getElementById('agent-config-save').addEventListener('click', () => {
  const agentWsUrl = document.getElementById('agent-ws-url').value;
  const callbackUrl = document.getElementById('agent-callback-url').value;
  const agentMode = agentRouteFromConfig({ agentWsUrl, callbackUrl });
  saveAgentConfig(agentMode, agentWsUrl, callbackUrl);
});

document.getElementById('agent-config-toggle').addEventListener('click', () => {
  const body = document.getElementById('agent-config-body');
  setAgentConfigCollapsed(!(body?.hidden));
});

document.getElementById('agent-route-mode').addEventListener('change', (event) => {
  const selected = event.target.value;
  const preset = AGENT_ROUTE_PRESETS[selected];
  if (!preset) {
    setAgentConfigStatus('custom', '');
    return;
  }
  fillAgentRoute(preset);
  saveAgentConfig(preset.agentMode, preset.agentWsUrl, preset.callbackUrl);
});

document.getElementById('agent-config-reset').addEventListener('click', () => {
  setAgentConfigStatus('resetting...', '');
  chrome.runtime.sendMessage({ type: 'RESET_AGENT_CONFIG' }, (data) => {
    if (chrome.runtime.lastError || data?.error) {
      setAgentConfigStatus('reset failed', 'bad');
      return;
    }
    fillAgentRoute({
      agentMode: data.agentMode || 'automatic',
      agentWsUrl: data.agentWsUrl || DEFAULT_AGENT_WS_URL,
      callbackUrl: data.callbackUrl || DEFAULT_CALLBACK_URL,
    });
    setAgentConfigStatus('auto both', 'ok');
    setTimeout(fetchStatus, 500);
  });
});

document.getElementById('btn-flow').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_FLOW_TAB' }, () => {
    if (chrome.runtime.lastError) return;
  });
});

function runSessionButton(btn, messageType, busyText, doneText) {
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = busyText;
  btn.disabled = true;
  chrome.runtime.sendMessage({ type: messageType }, (result) => {
    const failed = chrome.runtime.lastError || result?.error;
    btn.textContent = failed ? 'Session Failed' : doneText;
    fetchStatus();
    setTimeout(() => { btn.textContent = btn.dataset.label || doneText; btn.disabled = false; }, failed ? 1400 : 900);
  });
}

document.getElementById('btn-cookie').addEventListener('click', () => {
  runSessionButton(document.getElementById('btn-cookie'), 'GET_COOKIE', 'Getting...', 'Cookie Synced');
});

document.getElementById('btn-token').addEventListener('click', () => {
  runSessionButton(document.getElementById('btn-token'), 'REFRESH_TOKEN', 'Refreshing...', 'Token Synced');
});

document.getElementById('log-clear').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_REQUEST_LOG' }, (data) => {
    if (chrome.runtime.lastError) return;
    updateRequestLog(data?.log || []);
  });
});

setAgentConfigCollapsed(readAgentConfigCollapsed(), false);
fetchStatus();
loadAgentConfig();
fetchLog();
