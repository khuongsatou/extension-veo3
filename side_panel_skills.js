// ── Skill autocomplete dropdown ─────────────────────────────

const SKILL_USAGE_KEY = 'fk_skill_usage';

function getSkillUsageCounts() {
  try {
    return JSON.parse(localStorage.getItem(SKILL_USAGE_KEY) || '{}');
  } catch { return {}; }
}

function saveSkillUsage(skillName) {
  try {
    const counts = getSkillUsageCounts();
    counts[skillName] = (counts[skillName] || 0) + 1;
    localStorage.setItem(SKILL_USAGE_KEY, JSON.stringify(counts));
  } catch { /* ignore */ }
}

function buildSkillItems(skills) {
  const counts = getSkillUsageCounts();
  const sorted = skills.slice().sort((a, b) => (counts[b.name] || 0) - (counts[a.name] || 0));
  const pinned = sorted.slice(0, 3).filter(s => (counts[s.name] || 0) > 0);
  const rest = sorted.slice(pinned.length);

  return { pinned, rest, sorted };
}

function renderSkillDropdown(matches, inputText) {
  const dropdown = document.getElementById('skill-dropdown');
  if (!dropdown) return;

  const { pinned, rest } = buildSkillItems(matches);
  const showPinned = pinned.length > 0 && (inputText.trim() === '/' || inputText.trim() === '' || inputText.trim().startsWith('/'));
  const items = showPinned ? [...pinned, ...rest] : rest;

  if (items.length === 0) {
    dropdown.classList.remove('open');
    return;
  }

  const parts = [];

  if (showPinned) {
    parts.push('<div class="skill-section-label">Frequent</div>');
    pinned.forEach((s, i) => {
      parts.push(`<div class="skill-item" data-cmd="/${s.name}" data-skill="${escHtml(s.name)}">
        <span class="skill-rank">${i + 1}</span>
        <span class="skill-cmd">/${escHtml(s.name)}</span>
      </div>`);
    });
    parts.push('<div class="skill-separator"></div>');
    parts.push('<div class="skill-section-label">All commands</div>');
  }

  rest.forEach((s, i) => {
    parts.push(`<div class="skill-item" data-cmd="/${s.name}" data-skill="${escHtml(s.name)}">
      <span class="skill-cmd">/${escHtml(s.name)}</span>
    </div>`);
  });

  dropdown.innerHTML = parts.join('');

  dropdown.querySelectorAll('.skill-item').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const cmd = el.getAttribute('data-cmd');
      const skill = el.getAttribute('data-skill');
      const input = document.getElementById('chat-input');
      input.value = cmd + ' ';
      saveSkillUsage(skill);
      input.focus();
      dropdown.classList.remove('open');
    });
  });

  dropdown.classList.add('open');
}

function handleSkillAutocomplete(text) {
  const dropdown = document.getElementById('skill-dropdown');
  if (!dropdown) return;
  const trimmed = text.trim();

  if (!trimmed.startsWith('/') || availableSkills.length === 0) {
    dropdown.classList.remove('open');
    return;
  }

  const query = trimmed.toLowerCase();
  let matches;

  if (query === '/') {
    matches = availableSkills.slice();
  } else {
    const q = query.startsWith('/') ? query.slice(1) : query;
    const q2 = q.startsWith('fk-') ? q : (q.startsWith('fk') ? 'fk-' + q.slice(2) : q);
    matches = availableSkills.filter(s => {
      const cmd = s.name.toLowerCase();
      return cmd.startsWith(q) || cmd.startsWith(q2) || cmd.includes(q) || cmd.includes(q2);
    }).slice(0, 12);
  }

  renderSkillDropdown(matches, text);
}

function hideSkillDropdown() {
  const dropdown = document.getElementById('skill-dropdown');
  if (dropdown) dropdown.classList.remove('open');
}

document.addEventListener('DOMContentLoaded', () => {
  fetchStatus();
  fetchLog();
  loadChatSettings().then(loadChatModels);
  loadSkills();
});
