/**
 * Injected into MAIN world on flow.google.com — has access to window.grecaptcha
 * Also intercepts TRPC fetch responses to capture fresh signed media URLs.
 */
if (!window.__FLOW_KIT_INJECTED) {
  window.__FLOW_KIT_INJECTED = true;

  // ─── TRPC Response Monitor ─────────────────────────────────
  // Monkey-patch fetch to intercept TRPC responses containing media URLs.
  // Fresh signed GCS URLs are extracted and forwarded to the agent.

  const _originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await _originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      // Intercept legacy and canonical Flow TRPC calls that return project/media data.
      if (url.includes('/api/trpc/') && response.ok) {
        const clone = response.clone();
        clone.text().then(text => {
          if (text.includes('storage.googleapis.com/ai-sandbox-videofx/')) {
            window.dispatchEvent(new CustomEvent('TRPC_MEDIA_URLS', {
              detail: { url, body: text },
            }));
          }
        }).catch(() => {});
      }
    } catch {}
    return response;
  };


  window.addEventListener('GET_CAPTCHA', async ({ detail }) => {
    const { requestId, pageAction, siteKey: requestedSiteKey } = detail || {};
    try {
      const keyInfo = resolveSiteKey(requestedSiteKey);
      await waitForGrecaptcha(keyInfo.siteKey);
      await waitForEnterpriseReady();
      const token = await Promise.race([
        window.grecaptcha.enterprise.execute(keyInfo.siteKey, { action: pageAction }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('grecaptcha execute timeout')), 15000)),
      ]);
      window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', {
        detail: { requestId, token, siteKeySource: keyInfo.source, action: pageAction },
      }));
    } catch (e) {
      window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', {
        detail: { requestId, error: e.message, action: pageAction },
      }));
    }
  });

  function resolveSiteKey(explicitSiteKey = '') {
    const explicit = String(explicitSiteKey || '').trim();
    if (explicit) return { siteKey: explicit, source: 'request' };

    try {
      const seen = new WeakSet();
      const stack = Object.values(window.___grecaptcha_cfg?.clients || {});
      while (stack.length) {
        const value = stack.pop();
        if (!value || typeof value !== 'object' || seen.has(value)) continue;
        seen.add(value);
        try {
          if (typeof value.sitekey === 'string' && value.sitekey.trim()) {
            return { siteKey: value.sitekey.trim(), source: '___grecaptcha_cfg' };
          }
          for (const child of Object.values(value)) {
            if (child && typeof child === 'object') stack.push(child);
          }
        } catch (_) {}
      }
    } catch (_) {}

    for (const element of document.querySelectorAll('[data-sitekey], [data-site-key], meta[name="recaptcha-site-key"]')) {
      const value = element.getAttribute('data-sitekey')
        || element.getAttribute('data-site-key')
        || element.getAttribute('content');
      if (value && value.trim()) return { siteKey: value.trim(), source: 'dom' };
    }

    for (const script of document.querySelectorAll('script[src*="recaptcha"]')) {
      try {
        const render = new URL(script.src).searchParams.get('render');
        if (render && render !== 'explicit') return { siteKey: render, source: 'recaptcha_script' };
      } catch (_) {}
    }

    return { siteKey: '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV', source: 'flow_compat_default' };
  }

  function waitForEnterpriseReady(timeout = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('grecaptcha enterprise ready timeout')), timeout);
      try {
        window.grecaptcha.enterprise.ready(() => {
          clearTimeout(timer);
          resolve();
        });
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function waitForGrecaptcha(siteKey, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let scriptRequested = false;
      const check = () => {
        if (window.grecaptcha?.enterprise?.execute) return resolve();
        if (!scriptRequested && Date.now() - start >= 1000) {
          scriptRequested = true;
          try {
            const script = document.createElement('script');
            script.src = `https://www.google.com/recaptcha/enterprise.js?trustedtypes=true&render=${encodeURIComponent(siteKey)}`;
            script.async = true;
            script.defer = true;
            (document.head || document.documentElement).appendChild(script);
          } catch (_) {}
        }
        if (Date.now() - start > timeout) return reject(new Error('grecaptcha not available'));
        setTimeout(check, 200);
      };
      check();
    });
  }
}
