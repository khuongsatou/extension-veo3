// ─── WebSocket to Agent ─────────────────────────────────────

async function agentSocketPortOpenFor(urlValue, timeoutMs = 900) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const probe = new URL(urlValue || DEFAULT_AGENT_WS_URL);
    probe.protocol = probe.protocol === 'wss:' ? 'https:' : 'http:';
    probe.pathname = '/';
    probe.search = '';
    probe.hash = '';
    await fetch(probe.toString(), {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    return true;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function agentSocketPortOpen(timeoutMs = 900) {
  return agentSocketPortOpenFor(agentWsUrl || DEFAULT_AGENT_WS_URL, timeoutMs);
}

function sendToOpenAgentSockets(message) {
  const payload = JSON.stringify(message);
  if (ws?.readyState === WebSocket.OPEN) ws.send(payload);
  if (serverWs?.readyState === WebSocket.OPEN) serverWs.send(payload);
}

function anyAgentConnected() {
  return ws?.readyState === WebSocket.OPEN || serverWs?.readyState === WebSocket.OPEN;
}

function stateForConnectionClose() {
  setState(anyAgentConnected() ? 'idle' : 'off');
}

function rememberRequestRoute(msg, route) {
  if (!msg?.id) return;
  requestRouteById.set(String(msg.id), route);
  setTimeout(() => requestRouteById.delete(String(msg.id)), 30 * 60 * 1000);
}

async function handleAgentMessage(msg, route) {
  rememberRequestRoute(msg, route);
  if (msg.method === 'refresh_flow_session' || msg.method === 'refresh_session') {
    const result = await clearFlowSessionAndReload(msg.params?.reason || 'agent requested refresh');
    sendToAgent({ id: msg.id, result });
  } else if (msg.method === 'get_flow_context') {
    try {
      sendToAgent({ id: msg.id, result: await getFlowProjectContext() });
    } catch (error) {
      sendToAgent({ id: msg.id, error: error?.message || 'FLOW_CONTEXT_FAILED' });
    }
  } else if (msg.method === 'api_request') {
    await handleApiRequest(msg);
  } else if (msg.method === 'upload_video') {
    await handleUploadVideo(msg);
  } else if (msg.method === 'trpc_request') {
    await handleTrpcRequest(msg);
  } else if (msg.method === 'get_credit_status') {
    await handleCreditStatus(msg);
  } else if (msg.method === 'solve_captcha') {
    await handleSolveCaptcha(msg);
  } else if (msg.method === 'get_status') {
    const identity = await extensionIdentity();
    sendToAgent({
      id: msg.id,
      result: {
        ...identity,
        state,
        flowKeyPresent: !!flowKey,
        manualDisconnect,
        tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
        agentMode: agentConnectionMode,
        agentWsUrl,
        callbackUrl,
        serverAgentWsUrl: SERVER_AGENT_WS_URL,
        serverCallbackUrl,
        localConnected: ws?.readyState === WebSocket.OPEN,
        serverConnected: serverWs?.readyState === WebSocket.OPEN,
        metrics,
      },
    });
  } else if (msg.type === 'callback_secret') {
    if (route === 'server-local') {
      serverCallbackSecret = msg.secret;
      serverCallbackUrl = msg.callbackUrl || serverCallbackUrl || SERVER_CALLBACK_URL;
      chrome.storage.local.set({ serverCallbackSecret: msg.secret, serverCallbackUrl });
      console.log('[FlowAgent] Received server callback secret');
    } else {
      callbackSecret = msg.secret;
      callbackUrl = msg.callbackUrl || callbackUrl || DEFAULT_CALLBACK_URL;
      chrome.storage.local.set({ callbackSecret: msg.secret, callbackUrl });
      console.log('[FlowAgent] Received callback secret');
    }
  }
}

async function connectToAgent() {
  if (!localAgentEnabled() || manualDisconnect) return;
  if (ws?.readyState === WebSocket.CONNECTING || ws?.readyState === WebSocket.OPEN || connectInFlight) return;

  connectInFlight = true;
  const portOpen = await agentSocketPortOpen();
  connectInFlight = false;
  if (!portOpen) {
    ws = null;
    if (!anyAgentConnected()) chrome.alarms.clear('token-refresh');
    metrics.lastError = null;
    chrome.storage.local.set({ metrics });
    stateForConnectionClose();
    scheduleReconnect();
    return;
  }

  try {
    ws = new WebSocket(agentWsUrl || DEFAULT_AGENT_WS_URL);
  } catch (e) {
    metrics.lastError = null;
    chrome.storage.local.set({ metrics });
    broadcastStatus();
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[FlowAgent] Connected to agent');
    lastLocalSocketActivityAt = Date.now();
    metrics.lastError = null;
    chrome.storage.local.set({ metrics });
    chrome.alarms.clear('reconnect');
    setState('idle');
    chrome.alarms.create('token-refresh', { periodInMinutes: 45 });
    extensionIdentity().then((identity) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({
      type: 'extension_ready',
      ...identity,
      state,
      flowKeyPresent: !!flowKey,
      sessionPresent: !!flowKey,
      tokenAge: flowKey && metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
      metrics,
    })));
    if (flowKey) ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
  };

  ws.onmessage = async ({ data }) => {
    lastLocalSocketActivityAt = Date.now();
    try {
      await handleAgentMessage(JSON.parse(data), 'local-local');
    } catch (e) {
      console.error('[FlowAgent] Message error:', e);
    }
  };

  ws.onclose = () => {
    stateForConnectionClose();
    if (!anyAgentConnected()) chrome.alarms.clear('token-refresh');
    if (suppressNextClose) {
      suppressNextClose = false;
      return;
    }
    if (!manualDisconnect) {
      metrics.lastError = null;
      chrome.storage.local.set({ metrics });
      broadcastStatus();
      scheduleReconnect();
    }
  };

  ws.onerror = () => {
    metrics.lastError = null;
    chrome.storage.local.set({ metrics });
    broadcastStatus();
    try { ws?.close(); } catch (_) {}
  };
}

async function connectServerAgent() {
  if (!serverAgentEnabled() || manualDisconnect) return;
  if (serverWs?.readyState === WebSocket.CONNECTING || serverWs?.readyState === WebSocket.OPEN || serverConnectInFlight) return;

  serverConnectInFlight = true;
  const portOpen = await agentSocketPortOpenFor(SERVER_AGENT_WS_URL, 1200);
  serverConnectInFlight = false;
  if (!portOpen) {
    serverWs = null;
    metrics.lastError = null;
    chrome.storage.local.set({ metrics });
    stateForConnectionClose();
    scheduleServerReconnect();
    return;
  }

  try {
    serverWs = new WebSocket(SERVER_AGENT_WS_URL);
  } catch (e) {
    metrics.lastError = null;
    chrome.storage.local.set({ metrics });
    broadcastStatus();
    scheduleServerReconnect();
    return;
  }

  serverWs.onopen = () => {
    console.log('[FlowAgent] Connected to server agent');
    lastServerSocketActivityAt = Date.now();
    metrics.lastError = null;
    chrome.storage.local.set({ metrics });
    chrome.alarms.clear('reconnect-server');
    setState('idle');
    chrome.alarms.create('token-refresh', { periodInMinutes: 45 });
    extensionIdentity().then((identity) => serverWs?.readyState === WebSocket.OPEN && serverWs.send(JSON.stringify({
      type: 'extension_ready',
      ...identity,
      state,
      flowKeyPresent: !!flowKey,
      sessionPresent: !!flowKey,
      tokenAge: flowKey && metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
      metrics,
    })));
    if (flowKey) serverWs.send(JSON.stringify({ type: 'token_captured', flowKey }));
  };

  serverWs.onmessage = async ({ data }) => {
    lastServerSocketActivityAt = Date.now();
    try {
      await handleAgentMessage(JSON.parse(data), 'server-local');
    } catch (e) {
      console.error('[FlowAgent] Server message error:', e);
    }
  };

  serverWs.onclose = () => {
    stateForConnectionClose();
    if (!anyAgentConnected()) chrome.alarms.clear('token-refresh');
    if (serverSuppressNextClose) {
      serverSuppressNextClose = false;
      return;
    }
    if (!manualDisconnect) {
      metrics.lastError = null;
      chrome.storage.local.set({ metrics });
      broadcastStatus();
      scheduleServerReconnect();
    }
  };

  serverWs.onerror = () => {
    metrics.lastError = null;
    chrome.storage.local.set({ metrics });
    broadcastStatus();
    try { serverWs?.close(); } catch (_) {}
  };
}
