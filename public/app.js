const RECENT_KEY = 'simple-link:recent';
const OWNER_KEY_STORAGE = 'simple-link:owner-key';
const MAX_RECENT = 6;
const SLUG_RE = /^[A-Za-z0-9_-]{3,32}$/;

const state = {
  config: null,
  latest: null,
  ownerKey: readOwnerKey(),
  turnstileWidget: null,
  turnstileToken: '',
  turnstileWaiters: []
};

const $ = (selector) => document.querySelector(selector);

function init() {
  const year = $('#footer-year');
  if (year) year.textContent = String(new Date().getFullYear());

  bindForm();
  bindCopy('#copy-url', () => state.latest?.link?.shortUrl || '');
  bindCopy('#copy-key', () => state.latest?.manageKey || '');
  bindCopy('#copy-owner-key', () => state.latest?.ownerKey || state.ownerKey || '');
  bindRecentActions();

  $('#new-link').addEventListener('click', resetForm);
  $('#delete-link').addEventListener('click', deleteLatest);

  $('#url-input').addEventListener('input', clearError);
  $('#slug-input').addEventListener('input', clearError);

  refreshAll();
}

async function refreshAll() {
  await loadConfig();
  await refreshQuota();
  await loadRecentStatuses();
}

async function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin'
  });

  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }

  if (!response.ok) {
    const message = data?.error || '请求失败（' + response.status + '）';
    const failure = new Error(message);
    failure.status = response.status;
    throw failure;
  }
  return data;
}

async function loadConfig() {
  try {
    const data = await api('/api/config');
    state.config = data;
    paintTtlOptions(data);
    paintFooterLinks(data);
    if (data.turnstileSiteKey) setupTurnstile(data.turnstileSiteKey);
  } catch (error) {
    setError('配置加载失败，生成功能可能不可用。');
  }
}

function paintFooterLinks(config) {
  const target = $('#footer-links');
  if (!target) return;
  const items = [
    ['随机邮箱', config.links?.sibling],
    ['简单博客', config.links?.blog],
    ['源码', config.links?.repo]
  ].filter(([, href]) => href);
  if (!items.length) return;

  target.replaceChildren();
  items.forEach(([label, href], index) => {
    if (index) target.append(document.createTextNode(' · '));
    const link = document.createElement('a');
    link.href = href;
    link.textContent = label;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    target.append(link);
  });
}

function paintTtlOptions(config) {
  const select = $('#ttl-select');
  const labels = { 1: '1 天', 7: '7 天', 30: '30 天', 90: '90 天', 180: '180 天', 365: '365 天', 3650: '10 年' };
  const values = Array.isArray(config.ttlOptions) && config.ttlOptions.length ? config.ttlOptions : [1, 7, 30, 365];
  select.replaceChildren();
  for (const days of values) {
    const option = document.createElement('option');
    option.value = String(days);
    option.textContent = labels[days] || days + ' 天';
    select.append(option);
  }
  const wanted = String(config.limits?.defaultTtlDays || values[values.length - 1]);
  select.value = values.map(String).includes(wanted) ? wanted : String(values[0]);
}

async function refreshQuota() {
  const summary = $('#quota-summary');
  try {
    const data = await api('/api/quota');
    renderQuota(data.quota);
  } catch (error) {
    summary.textContent = '额度暂时无法读取';
  }
}

function renderQuota(quota) {
  const summary = $('#quota-summary');
  if (!quota) return;
  if (!quota.daily.limit) {
    summary.textContent = '今日额度已关闭';
    return;
  }
  summary.textContent =
    '今日剩余 ' + quota.daily.remaining + ' / ' + quota.daily.limit + ' 条 · 同时保留 ' +
    quota.active.used + ' / ' + quota.active.limit + ' 条';
}

function bindForm() {
  $('#shorten-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();
    hideStatus();

    const url = $('#url-input').value.trim();
    const slug = $('#slug-input').value.trim();
    const ttlDays = Number($('#ttl-select').value);

    if (!url) {
      setError('请填写要缩短的链接。');
      $('#url-input').focus();
      return;
    }
    if (url.length > 4096) {
      setError('链接太长了，请控制在 4096 个字符以内。');
      return;
    }
    if (slug && !SLUG_RE.test(slug)) {
      setError('自定义短码需为 3–32 位字母、数字、- 或 _。');
      $('#slug-input').focus();
      return;
    }

    setLoading(true);
    try {
      const token = await waitForTurnstileToken();
      const ownerKey = readOwnerKey();
      const data = await api('/api/links', {
        method: 'POST',
        headers: ownerKey ? { 'X-Owner-Key': ownerKey } : {},
        body: JSON.stringify({
          url,
          slug: slug || undefined,
          ttlDays,
          turnstileToken: token || undefined
        })
      });
      if (data.ownerKey) {
        state.ownerKey = data.ownerKey;
        writeOwnerKey(data.ownerKey);
      }
      state.latest = data;
      showResult(data);
      renderQuota(data.quota);
      saveRecent(data.link);
      await loadRecentStatuses();
      resetTurnstile();
    } catch (error) {
      setError(error.message || '生成失败，请稍后再试。');
      resetTurnstile();
    } finally {
      setLoading(false);
    }
  });
}

function setLoading(loading) {
  const button = $('#submit-btn');
  const label = $('#submit-label');
  button.disabled = loading;
  label.textContent = loading ? '生成中…' : '生成短链';
}

function setError(message) {
  const box = $('#form-error');
  box.textContent = message;
  box.hidden = false;
}

function clearError() {
  const box = $('#form-error');
  box.hidden = true;
  box.textContent = '';
}

function showStatus(message) {
  const box = $('#form-status');
  box.textContent = message;
  box.hidden = false;
}

function hideStatus() {
  $('#form-status').hidden = true;
}

function showResult(data) {
  const { link } = data;
  $('#result').hidden = false;
  $('#result-url').textContent = link.shortUrl;
  $('#result-url').href = link.shortUrl;
  $('#result-stats').href = link.statsUrl;
  $('#result-visit').href = link.shortUrl;
  $('#result-expiry').textContent = '到期 ' + formatDate(link.expiresAt);
  $('#manage-key').textContent = data.manageKey;
  $('#delete-link').disabled = false;

  const ownerBox = $('#owner-key-box');
  if (data.ownerKey) {
    $('#owner-key').textContent = data.ownerKey;
    ownerBox.hidden = false;
  } else {
    ownerBox.hidden = true;
  }

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    $('#result').scrollIntoView({ block: 'nearest' });
  } else {
    $('#result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function resetForm() {
  $('#result').hidden = true;
  $('#url-input').value = '';
  $('#slug-input').value = '';
  state.latest = null;
  clearError();
  hideStatus();
  $('#url-input').focus();
}

async function deleteLatest() {
  if (!state.latest) return;
  const code = state.latest.link.code;
  const proceed = window.confirm('删除后这条短链会立即失效，且无法恢复。确定删除？');
  if (!proceed) return;

  const button = $('#delete-link');
  button.disabled = true;
  try {
    await api('/api/links/' + encodeURIComponent(code), {
      method: 'DELETE',
      headers: { 'X-Manage-Key': state.latest.manageKey }
    });
    removeRecent(code);
    $('#result').hidden = true;
    state.latest = null;
    showStatus('已删除 /' + code + '。今日额度不会退回，但这条链接已立即失效。');
    await refreshQuota();
    await loadRecentStatuses();
  } catch (error) {
    setError(error.message || '删除失败，请稍后再试。');
    button.disabled = false;
  }
}

function formatDate(ms) {
  if (!ms) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: state.config?.timezone || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
      .format(new Date(ms))
      .replace(/\//g, '-');
  } catch (error) {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

function bindCopy(selector, getValue) {
  const button = $(selector);
  if (!button) return;
  button.addEventListener('click', async () => {
    const value = getValue();
    if (!value) return;
    try {
      await copyText(value);
      flashCopied(button);
    } catch (error) {
      setError('复制失败，请手动选中复制。');
    }
  });
}

async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('copy failed');
}

function flashCopied(button) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.textContent = '已复制';
  window.clearTimeout(button._copyTimer);
  button._copyTimer = window.setTimeout(() => {
    button.textContent = button.dataset.label;
  }, 1600);
}

/* ---------- 最近记录 ---------- */

function readOwnerKey() {
  try {
    const key = localStorage.getItem(OWNER_KEY_STORAGE) || '';
    return /^[A-Za-z0-9_-]{24,128}$/.test(key) ? key : '';
  } catch (error) {
    return '';
  }
}

function writeOwnerKey(key) {
  try {
    localStorage.setItem(OWNER_KEY_STORAGE, key);
  } catch (error) {
    /* 忽略存储失败 */
  }
}

function readRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item) => item && typeof item.code === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(item.code))
      .slice(0, MAX_RECENT);
  } catch (error) {
    return [];
  }
}

function writeRecent(items) {
  try {
    if (items.length) localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, MAX_RECENT)));
    else localStorage.removeItem(RECENT_KEY);
  } catch (error) {
    /* 忽略存储失败 */
  }
}

function saveRecent(link) {
  const items = readRecent().filter((item) => item.code !== link.code);
  items.unshift({
    code: link.code,
    url: link.url,
    shortUrl: link.shortUrl,
    statsUrl: link.statsUrl,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt
  });
  writeRecent(items);
}

function removeRecent(code) {
  writeRecent(readRecent().filter((item) => item.code !== code));
}

function bindRecentActions() {
  $('#clear-recent').addEventListener('click', () => {
    writeRecent([]);
    $('#recent-section').hidden = true;
    $('#recent-list').replaceChildren();
  });
}

async function loadRecentStatuses() {
  const items = readRecent();
  const section = $('#recent-section');
  if (!items.length) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  let lookup = [];
  try {
    const data = await api('/api/links/lookup', {
      method: 'POST',
      body: JSON.stringify({ codes: items.map((item) => item.code) })
    });
    lookup = data.items || [];
  } catch (error) {
    lookup = [];
  }

  const byCode = new Map(lookup.map((item) => [item.code, item]));
  const list = $('#recent-list');
  list.replaceChildren();

  for (const item of items) {
    const info = byCode.get(item.code);
    const li = document.createElement('li');
    li.className = 'recent-item';

    const main = document.createElement('div');
    main.className = 'recent-main';

    const codeLink = document.createElement('a');
    codeLink.className = 'recent-code';
    codeLink.textContent = '/' + item.code;
    codeLink.href = info?.statsUrl || item.statsUrl || '/';
    codeLink.target = '_blank';
    codeLink.rel = 'noopener';
    codeLink.title = '查看这条短链的统计';

    const dest = document.createElement('span');
    dest.className = 'recent-dest';
    dest.textContent = item.url;
    dest.title = item.url;
    main.append(codeLink, dest);

    const meta = document.createElement('div');
    meta.className = 'recent-meta';
    meta.append(statusPill(info), counter(info), dateLabel(item.createdAt));
    li.append(main, meta);
    list.append(li);
  }
}

function statusPill(info) {
  const span = document.createElement('span');
  span.className = 'status';
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  span.append(dot);
  if (!info || !info.exists) {
    span.classList.add('status-muted');
    span.append('已清理');
  } else if (info.status === 'blocked') {
    span.classList.add('status-danger');
    span.append('已拦截');
  } else if (info.status === 'expired') {
    span.classList.add('status-muted');
    span.append('已过期');
  } else {
    span.classList.add('status-ok');
    span.append('有效');
  }
  return span;
}

function counter(info) {
  const span = document.createElement('span');
  span.textContent = info?.exists ? String(info.clicks) + ' 次点击' : '—';
  return span;
}

function dateLabel(ms) {
  const span = document.createElement('span');
  span.className = 'recent-date';
  span.textContent = formatDate(ms);
  return span;
}

/* ---------- Turnstile ---------- */

function setupTurnstile(siteKey) {
  const slot = $('#turnstile-slot');
  slot.hidden = false;
  loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit')
    .then(() => {
      if (!window.turnstile) throw new Error('turnstile missing');
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      state.turnstileWidget = window.turnstile.render(slot, {
        sitekey: siteKey,
        action: 'shorten',
        theme: dark ? 'dark' : 'light',
        callback: (token) => {
          state.turnstileToken = token;
          const waiters = state.turnstileWaiters.splice(0);
          for (const resolve of waiters) resolve(token);
        },
        'expired-callback': () => {
          state.turnstileToken = '';
        },
        'error-callback': () => {
          state.turnstileToken = '';
        }
      });
    })
    .catch(() => {
      setError('人机验证加载失败，请刷新页面后重试。');
    });
}

function waitForTurnstileToken() {
  if (!state.turnstileWidget) return Promise.resolve('');
  if (state.turnstileToken) return Promise.resolve(state.turnstileToken);
  return new Promise((resolve) => {
    state.turnstileWaiters.push(resolve);
    window.setTimeout(() => {
      const index = state.turnstileWaiters.indexOf(resolve);
      if (index >= 0) {
        state.turnstileWaiters.splice(index, 1);
        resolve('');
      }
    }, 15000);
  });
}

function resetTurnstile() {
  state.turnstileToken = '';
  if (state.turnstileWidget && window.turnstile) {
    try {
      window.turnstile.reset(state.turnstileWidget);
    } catch (error) {
      /* 忽略 */
    }
  }
}

const loadedScripts = new Map();

function loadScript(src) {
  if (loadedScripts.has(src)) return loadedScripts.get(src);
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('script load failed'));
    document.head.append(script);
  });
  loadedScripts.set(src, promise);
  return promise;
}

init();