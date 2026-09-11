async function getReadyFlowTab() {
  let tabs = await chrome.tabs.query({ url: FLOW_URL_PATTERNS });

  if (!tabs.length) {
    const created = await chrome.tabs.create({
      url: FLOW_URL,
      active: true,
    });
    await sleep(3000);
    tabs = [created];
  }

  const tab = tabs
    .filter((candidate) => candidate?.id)
    .sort((a, b) => {
      if (!!b.active !== !!a.active) return Number(!!b.active) - Number(!!a.active);
      return (b.lastAccessed || 0) - (a.lastAccessed || 0);
    })[0];

  if (!tab?.id) return null;

  try {
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(750);
  } catch (e) {
    console.warn('[FlowAgent] Could not focus Flow tab before captcha:', e?.message || e);
  }

  return tab;
}

async function solveCaptcha(requestId, captchaAction, options = {}) {
  try {
    const tab = await getReadyFlowTab({ focus: options.focus === true });
    if (!tab?.id) return { error: 'NO_FLOW_TAB' };
    const request = () => Promise.race([
      requestCaptchaFromTab(tab.id, requestId, captchaAction, options.siteKey || ''),
      new Promise((_, rej) => setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), 30000)),
    ]);
    let resp = await request();
    if (!resp?.token && /not available|not ready|ready timeout|sitekey|executeScript/i.test(String(resp?.error || ''))) {
      try {
        await chrome.tabs.reload(tab.id);
        await sleep(3000);
      } catch (_) {}
      resp = await request();
    }
    return resp;
  } catch (e) {
    return { error: e.message };
  }
}

async function handleSolveCaptcha(msg) {
  const { id, params } = msg;
  const result = await solveCaptcha(id, params?.captchaAction || 'VIDEO_GENERATION', {
    focus: params?.focus === true,
    siteKey: params?.siteKey || params?.site_key || '',
  });

  // Standalone captcha solve counts as captcha-consuming
  metrics.requestCount++;
  if (result?.token) {
    metrics.successCount++;
  } else {
    metrics.failedCount++;
    metrics.lastError = result?.error || 'NO_TOKEN';
  }
  chrome.storage.local.set({ metrics });

  sendToAgent({ id, result });
}

// Read the account entitlement from the browser-owned extension session. The
// desktop app must not guess a tier (or reuse another profile's tier) before
// dispatching a provider generation request.
async function handleCreditStatus(msg) {
  const { id } = msg;
  setState('running');
  try {
    if (typeof ensureFreshFlowKey === 'function') {
      await ensureFreshFlowKey('tier preflight');
    }
    if (!flowKey) {
      sendToAgent({ id, status: 503, error: 'NO_FLOW_KEY' });
      return;
    }
    const url = `https://aisandbox-pa.googleapis.com/v1/credits?key=${encodeURIComponent(API_KEY)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: headersWithSingleAuthorization({
        Accept: '*/*',
        // The browser UI moved to flow.google.com, but this legacy REST API
        // key is still restricted to the Labs origin. Flow's new UI reads
        // credits through an internal VideoFxService RPC instead.
        Origin: 'https://labs.google',
        Referer: 'https://labs.google/',
      }, flowKey),
      credentials: 'include',
    });
    const responseText = await response.text();
    let data;
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch (_) {
      data = { message: responseText.slice(0, 300) };
    }
    sendToAgent({ id, status: response.status, data });
  } catch (error) {
    sendToAgent({ id, status: 500, error: error?.message || 'CREDIT_STATUS_FAILED' });
  } finally {
    setState('idle');
  }
}

// ─── API Request Proxy ──────────────────────────────────────

async function handleTrpcRequest(msg) {
  const { id, params } = msg;
  const { url, method = 'POST', headers = {}, body, responseType = 'json' } = params;

  if (!url || (!url.startsWith('https://labs.google/') && !url.startsWith('https://flow.google.com/'))) {
    sendToAgent({ id, error: 'INVALID_TRPC_URL' });
    return;
  }

  setState('running');
  // TRPC calls don't consume captcha — don't count in metrics

  const logId = id;
  const logType = url.includes('createProject') ? 'CREATE_PROJECT' : 'TRPC';
  // TRPC calls are silent — don't show in request log

  const fetchHeaders = headersWithSingleAuthorization(
    { 'Content-Type': 'application/json', ...headers },
    flowKey,
  );

  try {
    const resp = await fetch(url, {
      method,
      headers: fetchHeaders,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    let data;
    if (responseType === 'url') {
      data = { url: resp.url, ok: resp.ok };
    } else {
      data = await resp.json();
    }
    chrome.storage.local.set({ metrics });
    updateRequestLog(logId, { status: 'success' });
    sendToAgent({ id, status: resp.status, data });
  } catch (e) {
    console.error('[FlowAgent] tRPC request failed:', e);
    chrome.storage.local.set({ metrics });
    updateRequestLog(logId, { status: 'failed', error: e.message || 'TRPC_FETCH_FAILED' });
    sendToAgent({ id, error: e.message || 'TRPC_FETCH_FAILED' });
  } finally {
    setState('idle');
  }
}

async function handleApiRequest(msg) {
  const { id, params } = msg;
  const { url, method, headers, body, captchaAction } = params;
  const captchaSiteKey = params.siteKey || params.site_key || '';

  if (!url) {
    sendToAgent({ id, error: 'MISSING_URL' });
    return;
  }

  if (!url.startsWith('https://aisandbox-pa.googleapis.com/')) {
    sendToAgent({ id, error: 'INVALID_URL' });
    return;
  }

  setState('running');
  const hasCaptcha = !!captchaAction;
  if (hasCaptcha) metrics.requestCount++;

  const logId = id;
  const logType = _classifyApiUrl(url);
  if (_VISIBLE_TYPES.has(logType)) {
    const payloadSummary = body ? JSON.stringify(body).slice(0, 200) : null;
    addRequestLog({ id: logId, type: logType, time: new Date().toISOString(), status: 'processing', error: null, outputUrl: null, url, payloadSummary });
  }

  try {
    // Step 1: Solve captcha if needed
    let captchaToken = null;
    if (captchaAction) {
      const captchaResult = await solveCaptcha(id, captchaAction, {
        focus: params?.focus === true,
        siteKey: captchaSiteKey,
      });
      captchaToken = captchaResult?.token || null;
      if (!captchaToken) {
        // Cannot proceed without captcha — API will 403
        const err = captchaResult?.error || 'CAPTCHA_FAILED';
        const recovery = await refreshSessionAfterCaptchaBlock(`captcha solve failed: ${err}`);
        console.error(`[FlowAgent] Captcha failed for ${captchaAction}: ${err}`);
        sendToAgent({
          id,
          status: 403,
          error: `CAPTCHA_FAILED: ${err}`,
          errorKind: 'captcha',
          retrySafe: true,
          data: {
            errorKind: 'captcha',
            retrySafe: true,
            recovery,
            error: {
              status: 'PERMISSION_DENIED',
              message: `CAPTCHA_FAILED: ${err}`,
              details: [{ reason: 'RECAPTCHA_SESSION_REFRESH_REQUIRED' }],
            },
          },
        });
        if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `CAPTCHA_FAILED: ${err}`; }
        chrome.storage.local.set({ metrics });
        updateRequestLog(logId, { status: 'failed', error: `CAPTCHA_FAILED: ${err}` });
        setState('idle');
        return;
      }
    }

    // Step 2: Inject captcha token into body
    let finalBody = body;
    if (captchaToken && finalBody) {
      finalBody = JSON.parse(JSON.stringify(finalBody)); // deep clone
      finalBody.clientContext = finalBody.clientContext || {};
      finalBody.clientContext.recaptchaContext = {
        ...(finalBody.clientContext.recaptchaContext || {}),
        token: captchaToken,
        applicationType: finalBody.clientContext.recaptchaContext?.applicationType || 'RECAPTCHA_APPLICATION_TYPE_WEB',
      };
      if (finalBody.requests && Array.isArray(finalBody.requests)) {
        for (const req of finalBody.requests) {
          if (req.clientContext?.recaptchaContext) {
            req.clientContext.recaptchaContext.token = captchaToken;
            req.clientContext.recaptchaContext.applicationType = req.clientContext.recaptchaContext.applicationType || 'RECAPTCHA_APPLICATION_TYPE_WEB';
          }
        }
      }
    }

    // Step 3: Keep bearer token fresh per extension profile. Each extension
    // owns its own local flowKey; never borrow another profile's token.
    if (typeof ensureFreshFlowKey === 'function') {
      try {
        await ensureFreshFlowKey(!flowKey ? 'missing flow key' : 'api request');
      } catch (error) {
        console.warn('[FlowAgent] Could not refresh token before API request:', error?.message || error);
      }
    }

    const activeFlowKey = flowKey;
    if (!activeFlowKey) {
      sendToAgent({ id, status: 503, error: 'NO_FLOW_KEY' });
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = 'NO_FLOW_KEY'; }
      chrome.storage.local.set({ metrics });
      updateRequestLog(logId, { status: 'failed', error: 'NO_FLOW_KEY' });
      setState('idle');
      return;
    }

    let fetchHeaders = headersWithSingleAuthorization(headers || {}, activeFlowKey);
    if (url.includes('batchAsyncGenerateVideo')) {
      const debugHeaders = { ...fetchHeaders, authorization: 'Bearer <FLOW_KEY>' };
      const debugBody = finalBody ? JSON.parse(JSON.stringify(finalBody)) : finalBody;
      if (debugBody?.clientContext?.recaptchaContext?.token) {
        debugBody.clientContext.recaptchaContext.token = '<RECAPTCHA_TOKEN>';
      }
      if (Array.isArray(debugBody?.requests)) {
        for (const req of debugBody.requests) {
          if (req.clientContext?.recaptchaContext?.token) req.clientContext.recaptchaContext.token = '<RECAPTCHA_TOKEN>';
        }
      }
      const curlFull = buildCurl(method || 'POST', url, debugHeaders, debugBody);
      console.log('[FlowAgent][GEN_VIDEO_CURL]\n' + curlFull);
      updateRequestLog(logId, { curlFull, requestBodyFull: JSON.stringify(debugBody, null, 2) });
      sendToAgent({ type: 'debug_log', label: 'GEN_VIDEO_CURL', message: curlFull });
    }

    // Step 4: Make the API call from browser context
    const requestBody = method === 'GET' ? undefined : JSON.stringify(finalBody);
    let response = await fetch(url, {
      method: method || 'POST',
      headers: fetchHeaders,
      credentials: 'include',
      body: requestBody,
    });

    if (response.status === 401) {
      try {
        metrics.lastError = 'AUTH_401';
        await chrome.storage.local.set({ metrics });
        if (typeof ensureFreshFlowKey === 'function') await ensureFreshFlowKey('api 401 retry');
        const retryFlowKey = flowKey;
        if (retryFlowKey && retryFlowKey !== activeFlowKey) {
          fetchHeaders = headersWithSingleAuthorization(fetchHeaders, retryFlowKey);
          response = await fetch(url, {
            method: method || 'POST',
            headers: fetchHeaders,
            credentials: 'include',
            body: requestBody,
          });
        }
      } catch (error) {
        console.warn('[FlowAgent] Token refresh/retry after 401 failed:', error?.message || error);
      }
    }

    let responseData;
    const responseText = await response.text();
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }
    const errorKind = classifyExtensionApiError(response.status, responseData);
    let recovery = null;
    if (errorKind === 'captcha' || errorKind === 'session') {
      recovery = await refreshSessionAfterCaptchaBlock(`api ${response.status} ${errorKind}`);
    }
    if (url.includes('batchAsyncGenerateVideo')) {
      const responseFull = JSON.stringify({ status: response.status, ok: response.ok, body: responseData }, null, 2);
      console.log('[FlowAgent][GEN_VIDEO_RESPONSE]', {
        status: response.status,
        ok: response.ok,
        body: responseData,
      });
      updateRequestLog(logId, { responseFull });
      sendToAgent({
        type: 'debug_log',
        label: 'GEN_VIDEO_RESPONSE',
        message: responseFull,
      });
    }

    sendToAgent({
      id,
      status: response.status,
      ...(errorKind ? { errorKind, retrySafe: true } : {}),
      data: errorKind
        ? withRecoveryErrorMetadata(responseData, { errorKind, recovery, status: response.status })
        : responseData,
    });

    const responseSummary = responseText ? responseText.slice(0, 300) : null;
    if (response.ok) {
      if (hasCaptcha) { metrics.successCount++; metrics.lastError = null; }
      updateRequestLog(logId, { status: 'success', httpStatus: response.status, responseSummary });
    } else {
      const safeError = errorKind ? `API_${response.status}_${errorKind.toUpperCase()}` : `API_${response.status}`;
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = safeError; }
      updateRequestLog(logId, { status: 'failed', error: safeError, httpStatus: response.status, responseSummary });
    }
  } catch (e) {
    sendToAgent({
      id,
      status: 500,
      error: e.message || 'API_REQUEST_FAILED',
    });
    if (hasCaptcha) { metrics.failedCount++; metrics.lastError = e.message; }
    updateRequestLog(logId, { status: 'failed', error: e.message || 'API_REQUEST_FAILED' });
  }

  chrome.storage.local.set({ metrics });
  setState('idle');
}

function safeJsonText(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value || {});
  } catch (_) {
    return String(value || '');
  }
}

function classifyExtensionApiError(status, data) {
  const code = Number(status || 0);
  const text = safeJsonText(data).toLowerCase();
  const reason = String(data?.error?.details?.[0]?.reason || data?.error?.status || '').toUpperCase();
  if (code === 401 || reason.includes('UNAUTHENTICATED') || text.includes('invalid authentication credentials')) {
    return 'session';
  }
  if (code === 403 && (
    reason.includes('UNUSUAL_ACTIVITY') ||
    reason.includes('RECAPTCHA') ||
    text.includes('unusual activity') ||
    text.includes('captcha') ||
    text.includes('recaptcha')
  )) {
    return 'captcha';
  }
  return '';
}

async function refreshSessionAfterCaptchaBlock(reason) {
  if (typeof clearFlowSessionAndReload !== 'function') {
    return { ok: false, source: 'unavailable', reason };
  }
  try {
    const result = await clearFlowSessionAndReload(reason);
    return {
      ok: Boolean(result?.ok),
      source: String(result?.source || ''),
      reason,
      tokenChanged: Boolean(result?.tokenChanged),
    };
  } catch (error) {
    return {
      ok: false,
      source: 'refresh_session',
      reason,
      error: error?.message || String(error),
    };
  }
}

function withRecoveryErrorMetadata(data, { errorKind, recovery, status }) {
  const source = data && typeof data === 'object'
    ? JSON.parse(JSON.stringify(data))
    : { message: String(data || `HTTP ${status}`) };
  const error = source.error && typeof source.error === 'object' ? source.error : {};
  return {
    ...source,
    errorKind,
    retrySafe: true,
    recovery,
    error: {
      ...error,
      message: error.message || source.message || `HTTP ${status}`,
      status: error.status || (errorKind === 'captcha' ? 'PERMISSION_DENIED' : 'UNAUTHENTICATED'),
      details: Array.isArray(error.details) && error.details.length
        ? error.details
        : [{ reason: errorKind === 'captcha' ? 'RECAPTCHA_SESSION_REFRESH_REQUIRED' : 'AUTH_SESSION_REFRESH_REQUIRED' }],
    },
  };
}

function redactBearer(value) {
  const text = String(value || '');
  return text.replace(/Bearer\s+[^'"\s]+/gi, 'Bearer <FLOW_KEY>');
}

function removeAuthorizationHeaders(headers) {
  const clean = { ...(headers || {}) };
  for (const key of Object.keys(clean)) {
    if (key.toLowerCase() === 'authorization') delete clean[key];
  }
  return clean;
}

function headersWithSingleAuthorization(headers, bearerToken) {
  const clean = removeAuthorizationHeaders(headers);
  if (bearerToken) clean.authorization = 'Bearer ' + bearerToken;
  return clean;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildCurl(method, url, headers, body) {
  const parts = [`curl ${shellQuote(url)}`];
  if ((method || 'POST').toUpperCase() !== 'GET') parts.push(`-X ${shellQuote(method || 'POST')}`);
  for (const [key, value] of Object.entries(headers || {})) {
    parts.push(`-H ${shellQuote(`${key}: ${redactBearer(value)}`)}`);
  }
  if (body !== undefined && body !== null && (method || 'POST').toUpperCase() !== 'GET') {
    parts.push(`--data-raw ${shellQuote(JSON.stringify(body))}`);
  }
  return parts.join(' \\\n  ');
}

// ─── State & Popup ──────────────────────────────────────────
