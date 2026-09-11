/**
 * Auto-connect helper for the Veo3 dashboard /ext/connect page.
 * Runs only on explicit connector URLs and saves the dashboard socket locally.
 */
(async () => {
  const socketMeta = document.querySelector('meta[name="veo3-kit-agent-ws-url"]');
  const callbackMeta = document.querySelector('meta[name="veo3-kit-callback-url"]');
  const status = document.getElementById('status');
  const agentWsUrl = String(socketMeta?.content || '').trim();
  const callbackUrl = String(callbackMeta?.content || '').trim();

  const writeStatus = (text, tone = 'neutral') => {
    if (!status) return;
    status.textContent = text;
    status.dataset.tone = tone;
    status.style.background = tone === 'ok' ? 'rgba(34,197,94,.16)' : tone === 'bad' ? 'rgba(239,68,68,.18)' : 'rgba(59,130,246,.15)';
    status.style.color = tone === 'ok' ? '#bbf7d0' : tone === 'bad' ? '#fecaca' : '#bfdbfe';
  };

  if (!agentWsUrl || !callbackUrl) {
    writeStatus('Missing Veo3 Kit socket config on this page.', 'bad');
    return;
  }

  writeStatus('Saving socket config to Veo3 Kit Extension...');
  try {
    const saved = await chrome.runtime.sendMessage({
      type: 'SAVE_AGENT_CONFIG',
      agentWsUrl,
      callbackUrl,
    });
    if (saved?.error) throw new Error(saved.error);
    await chrome.runtime.sendMessage({ type: 'RECONNECT' }).catch(() => {});
    writeStatus('Connected config saved. Open the Veo3 Kit side panel to confirm the green dot.', 'ok');
  } catch (error) {
    writeStatus(`Could not save config: ${error?.message || error}`, 'bad');
  }
})();
