function flowProjectContextFromUrl(url) {
  const value = String(url || '').trim();
  const match = value.match(/^https:\/\/flow\.google\.com\/(?:[^/?#]+\/)?project\/([^/?#]+)/i);
  if (!match?.[1]) return null;
  try {
    return {
      ok: true,
      projectId: decodeURIComponent(match[1]),
      flowUrl: value,
      source: 'flow_project_url',
    };
  } catch (_) {
    return null;
  }
}

async function getFlowProjectContext() {
  const tabs = await chrome.tabs.query({
    url: [
      'https://flow.google.com/project/*',
      'https://flow.google.com/*/project/*',
    ],
  });
  const candidates = tabs
    .filter((tab) => tab?.id && flowProjectContextFromUrl(tab.url))
    .sort((left, right) => {
      if (!!right.active !== !!left.active) return Number(!!right.active) - Number(!!left.active);
      return (right.lastAccessed || 0) - (left.lastAccessed || 0);
    });
  return flowProjectContextFromUrl(candidates[0]?.url)
    || { ok: false, error: 'NO_FLOW_PROJECT' };
}

async function requestCaptchaFromContentScript(tabId, requestId, pageAction, siteKey = '') {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
      siteKey: String(siteKey || '').trim(),
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('CAPTCHA content bridge timeout')), 22000)),
  ]);
}

async function requestCaptchaDirectly(tabId, pageAction, siteKey = '') {
  const result = await Promise.race([
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (requestedSiteKey, action) => {
        const fallbackSiteKey = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
        const findSiteKey = () => {
          if (requestedSiteKey) return requestedSiteKey;
          try {
            const stack = Object.values(window.___grecaptcha_cfg?.clients || {});
            const seen = new Set();
            while (stack.length) {
              const value = stack.pop();
              if (!value || typeof value !== 'object' || seen.has(value)) continue;
              seen.add(value);
              if (typeof value.sitekey === 'string' && value.sitekey.trim()) return value.sitekey.trim();
              for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child);
            }
          } catch (_) {}
          for (const script of document.querySelectorAll('script[src*="recaptcha"]')) {
            try {
              const value = new URL(script.src, location.href).searchParams.get('render');
              if (value && value !== 'explicit') return value;
            } catch (_) {}
          }
          return fallbackSiteKey;
        };
        if (!window.grecaptcha?.enterprise?.execute) return { token: null, error: 'grecaptcha not available' };
        const key = findSiteKey();
        try {
          await new Promise((resolve) => window.grecaptcha.enterprise.ready(resolve));
          const token = await Promise.race([
            window.grecaptcha.enterprise.execute(key, { action }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('grecaptcha execute timeout')), 15000)),
          ]);
          return { token, siteKeySource: requestedSiteKey ? 'request' : 'page' };
        } catch (error) {
          return { token: null, error: error?.message || String(error) };
        }
      },
      args: [String(siteKey || '').trim(), pageAction],
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('CAPTCHA executeScript timeout')), 20000)),
  ]);
  return result?.[0]?.result || { token: null, error: 'No CAPTCHA result' };
}

async function requestCaptchaFromTab(tabId, requestId, pageAction, siteKey = '') {
  let bridgeResult = null;
  try {
    bridgeResult = await requestCaptchaFromContentScript(tabId, requestId, pageAction, siteKey);
    if (bridgeResult?.token) return bridgeResult;
  } catch (error) {
    bridgeResult = { token: null, error: error?.message || String(error) };
  }

  try {
    const directResult = await requestCaptchaDirectly(tabId, pageAction, siteKey);
    return directResult?.token ? directResult : (directResult || bridgeResult);
  } catch (error) {
    return bridgeResult || { token: null, error: error?.message || String(error) };
  }
}
