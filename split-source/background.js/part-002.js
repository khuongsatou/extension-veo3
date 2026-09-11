
function restartAgentSocket(reason = 'manual restart') {
  manualDisconnect = false;
  chrome.alarms.clear('reconnect');

  metrics.lastError = `Restarting agent WebSocket (${reason})...`;
  chrome.storage.local.set({ metrics });

  const oldSocket = ws;
  ws = null;
  if (oldSocket && oldSocket.readyState !== WebSocket.CLOSED) {
    suppressNextClose = true;
    try { oldSocket.close(); } catch (_) {}
  }

  setTimeout(() => {
    suppressNextClose = false;
    connectToAgent();
  }, 250);
}

function restartServerAgentSocket(reason = 'manual restart') {
  manualDisconnect = false;
  chrome.alarms.clear('reconnect-server');

  metrics.lastError = `Restarting server agent WebSocket (${reason})...`;
  chrome.storage.local.set({ metrics });

  const oldSocket = serverWs;
  serverWs = null;
  if (oldSocket && oldSocket.readyState !== WebSocket.CLOSED) {
    serverSuppressNextClose = true;
    try { oldSocket.close(); } catch (_) {}
  }

  setTimeout(() => {
    serverSuppressNextClose = false;
    connectServerAgent();
  }, 250);
}

function reconnectConfiguredAgents(reason = 'configured reconnect') {
  chrome.alarms.clear('reconnect');
  chrome.alarms.clear('reconnect-server');
  if (!localAgentEnabled()) {
    const oldSocket = ws;
    ws = null;
    if (oldSocket && oldSocket.readyState !== WebSocket.CLOSED) {
      suppressNextClose = true;
      try { oldSocket.close(); } catch (_) {}
      setTimeout(() => { suppressNextClose = false; }, 250);
    }
  }
  if (!serverAgentEnabled()) {
    const oldSocket = serverWs;
    serverWs = null;
    if (oldSocket && oldSocket.readyState !== WebSocket.CLOSED) {
      serverSuppressNextClose = true;
      try { oldSocket.close(); } catch (_) {}
      setTimeout(() => { serverSuppressNextClose = false; }, 250);
    }
  }
  if (localAgentEnabled()) restartAgentSocket(reason);
  if (serverAgentEnabled()) restartServerAgentSocket(reason);
  if (!localAgentEnabled() && !serverAgentEnabled()) setState('off');
}

function scheduleReconnect() {
  if (!localAgentEnabled()) return;
  chrome.alarms.create('reconnect', { delayInMinutes: SOCKET_WATCHDOG_PERIOD_MINUTES });
}

function scheduleServerReconnect() {
  if (!serverAgentEnabled()) return;
  chrome.alarms.create('reconnect-server', { delayInMinutes: SOCKET_WATCHDOG_PERIOD_MINUTES });
}

function socketActivityStale(socket, lastActivityAt, now = Date.now()) {
  return socket?.readyState === WebSocket.OPEN
    && (!lastActivityAt || now - lastActivityAt >= SOCKET_STALE_AFTER_MS);
}

function keepAlive() {
  const now = Date.now();
  if (socketActivityStale(ws, lastLocalSocketActivityAt, now)) {
    restartAgentSocket('watchdog stale connection');
  } else if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  } else {
    connectToAgent();
  }
  if (socketActivityStale(serverWs, lastServerSocketActivityAt, now)) {
    restartServerAgentSocket('watchdog stale connection');
  } else if (serverWs?.readyState === WebSocket.OPEN) {
    serverWs.send(JSON.stringify({ type: 'ping' }));
  } else {
    connectServerAgent();
  }
}

function sendToAgent(msg) {
  const route = msg.id ? requestRouteById.get(String(msg.id)) : '';
  const target = route === 'server-local'
    ? {
      ws: serverWs,
      callbackUrl: serverCallbackUrl || SERVER_CALLBACK_URL,
      callbackSecret: serverCallbackSecret,
    }
    : {
      ws,
      callbackUrl: callbackUrl || DEFAULT_CALLBACK_URL,
      callbackSecret,
    };
  // API responses (with msg.id) go via HTTP — immune to WS disconnect
  if (msg.id) {
    fetch(target.callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(target.callbackSecret ? { 'X-Extension-Callback-Secret': target.callbackSecret } : {}),
      },
      body: JSON.stringify(msg),
    }).then((response) => {
      if (!response.ok) throw new Error(`Callback HTTP ${response.status}`);
    }).catch(() => {
      // HTTP failed — fallback to WS
      if (target.ws?.readyState === WebSocket.OPEN) target.ws.send(JSON.stringify(msg));
    });
    requestRouteById.delete(String(msg.id));
    return;
  }
  // Non-response messages (ping, status) or no secret yet — use WS
  sendToOpenAgentSockets(msg);
}

// ─── reCAPTCHA Solving ──────────────────────────────────────

function setState(newState) {
  state = newState;
  const badges = { idle: '●', running: '▶', off: '○' };
  const colors = { idle: '#22c55e', running: '#f59e0b', off: '#6b7280' };
  chrome.action.setBadgeText({ text: badges[state] || '' });
  chrome.action.setBadgeBackgroundColor({ color: colors[state] || '#000' });
  broadcastStatus();
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS_PUSH' }).catch(() => {});
}

function agentModeFromUrls(nextAgentWsUrl, nextCallbackUrl, explicitMode = '') {
  const mode = String(explicitMode || '').trim().toLowerCase();
  if (mode === 'automatic' || mode === 'local-local' || mode === 'server-local') return mode;
  const wsUrl = normalizeAgentWsUrl(nextAgentWsUrl);
  const callback = normalizeCallbackUrl(nextCallbackUrl);
  if (wsUrl === normalizeAgentWsUrl('wss://veo3.1nutnhan.com/api/ext/socket') && callback === normalizeCallbackUrl('https://veo3.1nutnhan.com/api/ext/callback')) {
    return 'server-local';
  }
  if (wsUrl === normalizeAgentWsUrl(DEFAULT_AGENT_WS_URL) && callback === normalizeCallbackUrl(DEFAULT_CALLBACK_URL)) return 'local-local';
  return 'custom';
}

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type === 'STATUS') {
    extensionIdentity().then((identity) => reply({
      ...identity,
      connected: ws?.readyState === WebSocket.OPEN,
      agentConnected: anyAgentConnected(),
      agentMode: agentConnectionMode,
      agentWsUrl,
      callbackUrl,
      serverAgentWsUrl: SERVER_AGENT_WS_URL,
      serverCallbackUrl,
      localConnected: ws?.readyState === WebSocket.OPEN,
      serverConnected: serverWs?.readyState === WebSocket.OPEN,
      flowKeyPresent: !!flowKey,
      sessionPresent: !!flowKey,
      manualDisconnect,
      tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
      metrics: {
        requestCount: metrics.requestCount,
        successCount: metrics.successCount,
        failedCount: metrics.failedCount,
        lastError: metrics.lastError,
      },
      state,
    }));
    return true;
  }

  if (msg.type === 'GET_AGENT_CONFIG') {
    reply({
      agentMode: agentConnectionMode,
      agentWsUrl,
      callbackUrl,
      serverAgentWsUrl: SERVER_AGENT_WS_URL,
      serverCallbackUrl,
    });
    return true;
  }

  if (msg.type === 'SAVE_AGENT_CONFIG') {
    const nextAgentWsUrl = normalizeAgentWsUrl(msg.agentWsUrl);
    const nextCallbackUrl = normalizeCallbackUrl(msg.callbackUrl);
    const nextAgentConnectionMode = agentModeFromUrls(nextAgentWsUrl, nextCallbackUrl, msg.agentMode);
    const changed = (
      nextAgentWsUrl !== agentWsUrl
      || nextCallbackUrl !== callbackUrl
      || nextAgentConnectionMode !== agentConnectionMode
    );
    agentWsUrl = nextAgentWsUrl;
    callbackUrl = nextCallbackUrl;
    agentConnectionMode = nextAgentConnectionMode;
    chrome.storage.local.set({ agentWsUrl, callbackUrl, agentConnectionMode, serverCallbackUrl }, () => {
      if (changed) reconnectConfiguredAgents('agent socket config changed');
      reply({ ok: true, agentMode: agentConnectionMode, agentWsUrl, callbackUrl, serverAgentWsUrl: SERVER_AGENT_WS_URL, serverCallbackUrl });
    });
    return true;
  }

  if (msg.type === 'RESET_AGENT_CONFIG') {
    agentWsUrl = DEFAULT_AGENT_WS_URL;
    callbackUrl = DEFAULT_CALLBACK_URL;
    agentConnectionMode = 'automatic';
    chrome.storage.local.set({ agentWsUrl, callbackUrl, agentConnectionMode }, () => {
      reconnectConfiguredAgents('agent socket config reset');
      reply({ ok: true, agentMode: 'automatic', agentWsUrl, callbackUrl });
    });
    return true;
  }

  if (msg.type === 'DISCONNECT') {
    manualDisconnect = true;
    if (ws) ws.close();
    if (serverWs) serverWs.close();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'RECONNECT') {
    reconnectConfiguredAgents('user requested reconnect');
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'RESTART_SOCKET') {
    reconnectConfiguredAgents('user requested restart');
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'REQUEST_LOG') {
    reply({ log: requestLog });
    return true;
  }

  if (msg.type === 'CLEAR_REQUEST_LOG') {
    clearRequestLog();
    reply({ ok: true, log: requestLog });
    return true;
  }

  if (msg.type === 'OPEN_FLOW_TAB') {
    chrome.tabs.query({
      url: FLOW_URL_PATTERNS,
    }).then((tabs) => {
      if (tabs.length) {
        chrome.tabs.update(tabs[0].id, { active: true });
        reply({ ok: true, tabId: tabs[0].id });
      } else {
        chrome.tabs.create({ url: FLOW_URL })
          .then((tab) => reply({ ok: true, tabId: tab.id }))
          .catch((e) => reply({ error: e.message }));
      }
    }).catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'REFRESH_TOKEN') {
    refreshFlowSessionFromAuthApi({ focus: msg.focus === true })
      .then(async (result) => {
        if (result?.ok) return result;
        return captureTokenFromFlowTab({ forceReload: true, waitMs: msg.waitMs || 30000, focus: msg.focus === true });
      })
      .then((result) => reply(result))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'REFRESH_FLOW_SESSION') {
    refreshFlowSessionFromAuthApi({ focus: msg.focus === true })
      .then(async (result) => {
        if (result?.ok || msg.fallbackReload === false) return result;
        return clearFlowSessionAndReload('manual refresh fallback');
      })
      .then((result) => reply(result))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'GET_COOKIE') {
    refreshFlowSessionFromAuthApi({ focus: msg.focus === true })
      .then((result) => reply(result))
      .catch((e) => reply({ ok: false, error: e.message || String(e) }));
    return true;
  }

  if (msg.type === 'TEST_CAPTCHA') {
    solveCaptcha(`test-${Date.now()}`, msg.pageAction || 'IMAGE_GENERATION')
      .then((r) => reply(r))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'TRPC_MEDIA_URLS') {
    handleTrpcMediaUrls(msg.trpcUrl, msg.body, (entries) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'media_urls_refresh', urls: entries }));
      }
      if (serverWs?.readyState === WebSocket.OPEN) {
        serverWs.send(JSON.stringify({ type: 'media_urls_refresh', urls: entries }));
      }
    });
    reply({ ok: true });
    return true;
  }

  return true;
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Human-like Telemetry ──────────────────────────────────
// Periodically send tracking events to Google's analytics endpoints
// to mimic normal browser behavior.
