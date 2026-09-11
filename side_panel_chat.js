// ── Chat ─────────────────────────────────────────────────────

const API_BASE = 'http://127.0.0.1:8120';
const CHAT_SETTINGS_KEY = 'fk_chat_settings';
const DEFAULT_CHAT_SETTINGS = {
  source: 'flowkit',
  routerBaseUrl: 'http://127.0.0.1:20128/v1',
  routerApiKey: '',
  routerModel: 'cx/gpt-5.5',
  configCollapsed: false,
};
let chatMessages = [];
let chatStreaming = false;
let availableSkills = [];
let chatSettings = { ...DEFAULT_CHAT_SETTINGS };

// Hardcoded fallback — covers all commands when API server isn't running
const FALLBACK_SKILLS = [
  "fk-add-material","fk-brand-logo","fk-camera-guide","fk-change-model",
  "fk-concat","fk-concat-fit-narrator","fk-create-project","fk-creative-mix",
  "fk-dashboard","fk-doctor","fk-fix-uuids","fk-gen-chain-videos",
  "fk-gen-images","fk-gen-music","fk-gen-narrator","fk-gen-refs",
  "fk-gen-text-overlays","fk-gen-tts-template","fk-gen-videos",
  "fk-import-voice","fk-insert-scene","fk-monitor","fk-pipeline",
  "fk-refresh-urls","fk-research","fk-review-board","fk-review-video",
  "fk-status","fk-switch-project","fk-thumbnail","fk-thumbnail-guide",
  "fk-upload-image","fk-youtube-seo","fk-youtube-upload",
].map(name => ({ name, usage: `/${name}`, file: "" }));

function normalizeRouterBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_CHAT_SETTINGS.routerBaseUrl).trim().replace(/\/+$/, '');
}

function routerHeaders(includeJson = false) {
  const headers = includeJson ? { 'Content-Type': 'application/json' } : {};
  const key = String(chatSettings.routerApiKey || '').trim();
  if (key) {
    headers.Authorization = `Bearer ${key}`;
    headers['x-api-key'] = key;
  }
  return headers;
}

async function loadChatSettings() {
  try {
    const data = await chrome.storage.local.get([CHAT_SETTINGS_KEY]);
    chatSettings = {
      ...DEFAULT_CHAT_SETTINGS,
      ...(data[CHAT_SETTINGS_KEY] || {}),
    };
  } catch {
    chatSettings = { ...DEFAULT_CHAT_SETTINGS };
  }
  updateChatSettingsUi();
}

async function saveChatSettings(partial = {}) {
  chatSettings = {
    ...chatSettings,
    ...partial,
  };
  await chrome.storage.local.set({ [CHAT_SETTINGS_KEY]: chatSettings });
  updateChatSettingsUi();
}

function updateChatSettingsUi() {
  const panel = document.getElementById('chat-config');
  const toggle = document.getElementById('chat-config-toggle');
  const caret = document.getElementById('chat-config-caret');
  const summary = document.getElementById('chat-config-summary');
  const source = document.getElementById('chat-source');
  const base = document.getElementById('chat-router-base');
  const key = document.getElementById('chat-router-key');
  const routerFields = document.getElementById('chat-router-fields');
  if (!source || !base || !key || !routerFields) return;

  source.value = chatSettings.source || DEFAULT_CHAT_SETTINGS.source;
  base.value = chatSettings.routerBaseUrl || DEFAULT_CHAT_SETTINGS.routerBaseUrl;
  key.value = chatSettings.routerApiKey || '';

  const direct = source.value === '9router';
  base.classList.toggle('is-hidden', !direct);
  routerFields.classList.toggle('is-hidden', !direct);
  if (summary) {
    summary.textContent = direct
      ? `9Router · ${chatSettings.routerModel || DEFAULT_CHAT_SETTINGS.routerModel}`
      : 'Veo3 Kit backend';
  }
  if (panel) panel.classList.toggle('collapsed', Boolean(chatSettings.configCollapsed));
  if (toggle) toggle.setAttribute('aria-expanded', String(!chatSettings.configCollapsed));
  if (caret) caret.textContent = chatSettings.configCollapsed ? '▾' : '▴';
}

function appendModelOption(select, value, label) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label || value;
  select.appendChild(opt);
}

async function loadChatModels() {
  const select = document.getElementById('chat-model');
  if (!select) return;
  if (chatSettings.source === '9router') {
    await loadRouterChatModels(select);
    return;
  }

  try {
    const resp = await fetch(`${API_BASE}/api/models/chat`);
    if (!resp.ok) return;
    const data = await resp.json();
    const models = data.models || [];
    select.innerHTML = '';
    if (models.length === 0) {
      appendModelOption(select, '', 'Backend default');
      return;
    }
    models.forEach((m) => {
      appendModelOption(select, `${m.provider}/${m.alias}`, `[${m.provider}] ${m.alias}`);
    });
  } catch {
    select.innerHTML = `
      <option value="">Backend default</option>
    `;
  }
}

async function loadRouterChatModels(select) {
  select.innerHTML = '<option value="">Loading 9Router...</option>';
  const selectedModel = chatSettings.routerModel || DEFAULT_CHAT_SETTINGS.routerModel;
  try {
    const resp = await fetch(`${normalizeRouterBaseUrl(chatSettings.routerBaseUrl)}/models`, {
      headers: routerHeaders(),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const models = Array.isArray(data.data)
      ? data.data.map(model => model.id).filter(Boolean)
      : Array.isArray(data.models)
        ? data.models.map(model => model.id || model.fullModel || model.name).filter(Boolean)
        : [];

    select.innerHTML = '';
    if (!models.includes(selectedModel)) appendModelOption(select, selectedModel, `[9Router] ${selectedModel}`);
    models.forEach(model => appendModelOption(select, model, `[9Router] ${model}`));
    select.value = selectedModel;
  } catch {
    select.innerHTML = '';
    appendModelOption(select, selectedModel, `[9Router] ${selectedModel}`);
  }
}

function setRouterStatus(message, tone = '') {
  const el = document.getElementById('chat-router-status');
  if (!el) return;
  el.textContent = message || '';
  el.className = `chat-router-status${tone ? ` ${tone}` : ''}`;
}

async function testRouterConnection() {
  const btn = document.getElementById('chat-router-test');
  const baseInput = document.getElementById('chat-router-base');
  const keyInput = document.getElementById('chat-router-key');
  const modelSelect = document.getElementById('chat-model');
  if (!btn || !baseInput || !keyInput || !modelSelect) return;

  await saveChatSettings({
    source: '9router',
    routerBaseUrl: baseInput.value || DEFAULT_CHAT_SETTINGS.routerBaseUrl,
    routerApiKey: keyInput.value,
    routerModel: modelSelect.value || chatSettings.routerModel || DEFAULT_CHAT_SETTINGS.routerModel,
  });

  btn.disabled = true;
  btn.textContent = 'Testing...';
  setRouterStatus('Testing 9Router /models...', '');
  try {
    const resp = await fetch(`${normalizeRouterBaseUrl(chatSettings.routerBaseUrl)}/models`, {
      headers: routerHeaders(),
    });
    const text = await resp.text();
    const data = JSON.parse(text || '{}');
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    const models = Array.isArray(data.data)
      ? data.data.map(model => model.id).filter(Boolean)
      : Array.isArray(data.models)
        ? data.models.map(model => model.id || model.fullModel || model.name).filter(Boolean)
        : [];
    setRouterStatus(`Connected to 9Router. ${models.length} model(s) available.`, 'ok');
    await loadChatModels();
  } catch (e) {
    setRouterStatus(`9Router test failed: ${e.message}`, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test';
  }
}

async function loadSkills() {
  try {
    const resp = await fetch(`${API_BASE}/api/skills`);
    if (!resp.ok) throw new Error('not ok');
    const data = await resp.json();
    availableSkills = Array.isArray(data) && data.length > 0 ? data : FALLBACK_SKILLS;
  } catch {
    availableSkills = FALLBACK_SKILLS;
  }
}

function scrollChatToBottom() {
  const el = document.getElementById('chat-messages');
  el.scrollTop = el.scrollHeight;
}

function formatMarkdownLite(text) {
  let s = escHtml(text);
  // Bold: **text**
  s = s.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // Inline code: `text`
  s = s.replace(/`([^`]+)`/g, '<code style="background:rgba(59,130,246,0.15);padding:1px 4px;border-radius:3px;font-size:9px">$1</code>');
  // Bullet points: lines starting with • or -
  s = s.replace(/^(\s*[•\-]\s+)/gm, '<span style="color:var(--accent)">$1</span>');
  return s;
}

function renderChat() {
  const container = document.getElementById('chat-messages');
  if (chatMessages.length === 0) {
    container.innerHTML = '<div class="chat-empty">Type <span style="color:var(--accent)">/</span> for commands, or ask anything...</div>';
    return;
  }
  container.innerHTML = chatMessages.map((msg) => {
    const isCommand = msg.role === 'user' && /^\/fk[- ]/.test((msg.content || '').trim());
    const roleClass = msg.role === 'user' ? 'user' : msg.error ? 'error' : 'assistant';
    const roleLabel = msg.role === 'user' ? (isCommand ? '⚡ Command' : 'You') : msg.error ? 'Error' : 'Assistant';
    const bubble = msg.role === 'assistant'
      ? formatMarkdownLite(msg.content || (msg.error ? msg.error : ''))
      : escHtml(msg.content || (msg.error ? msg.error : ''));
    return `<div class="chat-msg ${roleClass}${isCommand ? ' command' : ''}">
      <div class="chat-role">${escHtml(roleLabel)}</div>
      <div class="chat-bubble">${bubble}</div>
    </div>`;
  }).join('');
  scrollChatToBottom();
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  const text = input.value.trim();
  if (!text || chatStreaming) return;
  const isCommand = /^\/fk[- ]/.test(text.trim()) || text.trim() === '/fk' || text.trim() === '/fk-list';

  // Track skill usage on send
  const skillMatch = text.trim().match(/^\/([\w-]+)/);
  if (skillMatch) saveSkillUsage(skillMatch[1]);

  // Add user message
  chatMessages.push({ role: 'user', content: text });
  renderChat();
  input.value = '';
  hideSkillDropdown();

  // Build outgoing messages BEFORE adding assistant placeholder
  const outMessages = chatMessages
    .filter(m => !m.error && m.role && m.content)
    .map(m => ({ role: m.role, content: m.content }));

  // Add placeholder for assistant (after building outMessages)
  const placeholderIdx = chatMessages.length;
  chatMessages.push({ role: 'assistant', content: '' });
  chatStreaming = true;
  sendBtn.disabled = true;

  const container = document.getElementById('chat-messages');
  const placeholder = document.createElement('div');
  placeholder.className = 'chat-typing';
  placeholder.id = 'chat-typing';
  placeholder.textContent = isCommand ? '⚡ executing skill...' : 'typing...';
  container.appendChild(placeholder);
  scrollChatToBottom();

  try {
    const model = document.getElementById('chat-model').value;
    const resp = chatSettings.source === '9router'
      ? await fetch(`${normalizeRouterBaseUrl(chatSettings.routerBaseUrl)}/chat/completions`, {
        method: 'POST',
        headers: routerHeaders(true),
        body: JSON.stringify({
          model,
          messages: outMessages,
          stream: true,
        }),
      })
      : await fetch(`${API_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: outMessages,
        model,
      }),
    });

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      chatMessages[placeholderIdx] = { role: 'assistant', error: errData.error || `HTTP ${resp.status}` };
    } else {
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await resp.json();
        const content = data.content || data.choices?.[0]?.message?.content || '';
        chatMessages[placeholderIdx] = { role: 'assistant', content };
      } else {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        let buffer = '';
        placeholder.textContent = isCommand ? '⚡ skill active — LLM responding...' : 'typing...';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const dataStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
            if (dataStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(dataStr);
              const content = parsed.choices?.[0]?.delta?.content
                || parsed.choices?.[0]?.message?.content
                || parsed.content
                || '';
              if (content) {
                fullContent += content;
                chatMessages[placeholderIdx] = { role: 'assistant', content: fullContent };
                placeholder.textContent = fullContent;
                scrollChatToBottom();
              }
            } catch { /* skip malformed chunks */ }
          }
        }
        if (!fullContent) {
          chatMessages[placeholderIdx] = { role: 'assistant', error: 'No response received' };
        }
      }
    }
  } catch (e) {
    chatMessages[placeholderIdx] = { role: 'assistant', error: `Connection error: ${e.message}` };
  }

  chatStreaming = false;
  sendBtn.disabled = false;
  const typingEl = document.getElementById('chat-typing');
  if (typingEl) typingEl.remove();
  renderChat();
}

document.getElementById('chat-source').addEventListener('change', async (e) => {
  await saveChatSettings({ source: e.target.value });
  setRouterStatus('', '');
  await loadChatModels();
});

document.getElementById('chat-settings-save').addEventListener('click', async () => {
  const model = document.getElementById('chat-model').value || DEFAULT_CHAT_SETTINGS.routerModel;
  await saveChatSettings({
    source: document.getElementById('chat-source').value,
    routerBaseUrl: document.getElementById('chat-router-base').value || DEFAULT_CHAT_SETTINGS.routerBaseUrl,
    routerApiKey: document.getElementById('chat-router-key').value,
    routerModel: model,
  });
  setRouterStatus('Chat settings saved.', 'ok');
  await loadChatModels();
});

document.getElementById('chat-router-test').addEventListener('click', testRouterConnection);

document.getElementById('chat-config-toggle').addEventListener('click', async () => {
  await saveChatSettings({ configCollapsed: !chatSettings.configCollapsed });
});

document.getElementById('chat-model').addEventListener('change', async (e) => {
  if (chatSettings.source === '9router') {
    await saveChatSettings({ routerModel: e.target.value });
  }
});

document.getElementById('chat-send').addEventListener('click', sendChat);

document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

// Auto-resize textarea
document.getElementById('chat-input').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 80) + 'px';
  handleSkillAutocomplete(this.value);
});
