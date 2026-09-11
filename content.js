/**
 * Content script — bridge between background.js and injected.js
 * Injects injected.js into MAIN world to access window.grecaptcha
 */
(function () {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('injected.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
})();

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type === 'GET_FLOW_SESSION') {
    const urls = Array.isArray(msg.urls) && msg.urls.length
      ? msg.urls
      : ['https://flow.google.com/api/auth/session', 'https://labs.google/fx/api/auth/session'];
    (async () => {
      let last = { ok: false, error: 'FLOW_SESSION_FETCH_FAILED' };
      for (const url of urls) {
        try {
          const response = await fetch(url, {
            method: 'GET',
            headers: { accept: '*/*', 'content-type': 'application/json' },
            credentials: 'include',
            cache: 'no-store',
          });
          const text = await response.text();
          let data = null;
          try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
          last = { ok: response.ok, status: response.status, data, url };
          const hasAccessToken = Boolean(data?.access_token || data?.accessToken || data?.token);
          if (response.ok && hasAccessToken) return last;
        } catch (error) {
          last = { ok: false, error: error?.message || 'FLOW_SESSION_FETCH_FAILED', url };
        }
      }
      return last;
    })().then(reply).catch((error) => reply({ ok: false, error: error?.message || 'FLOW_SESSION_FETCH_FAILED' }));
    return true;
  }

  if (msg.type !== 'GET_CAPTCHA') return;

  const { requestId, pageAction, siteKey } = msg;

  const handler = (e) => {
    if (e.detail?.requestId === requestId) {
      window.removeEventListener('CAPTCHA_RESULT', handler);
      clearTimeout(timer);
      reply({
        token: e.detail.token,
        error: e.detail.error,
        siteKeySource: e.detail.siteKeySource,
        action: e.detail.action,
      });
    }
  };

  const timer = setTimeout(() => {
    window.removeEventListener('CAPTCHA_RESULT', handler);
    reply({ error: 'CONTENT_TIMEOUT' });
  }, 25000);

  window.addEventListener('CAPTCHA_RESULT', handler);

  window.dispatchEvent(new CustomEvent('GET_CAPTCHA', {
    detail: { requestId, pageAction, siteKey },
  }));

  return true; // keep channel open for async reply
});

// ─── TRPC Media URL Monitor ─────────────────────────────────
// Forward intercepted TRPC responses with media URLs to background.js
window.addEventListener('TRPC_MEDIA_URLS', (e) => {
  const { url, body } = e.detail || {};
  if (!body) return;
  chrome.runtime.sendMessage({
    type: 'TRPC_MEDIA_URLS',
    trpcUrl: url,
    body,
  }).catch(() => {});
});
