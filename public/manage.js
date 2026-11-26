const OWNER_KEY_STORAGE = 'simple-link:owner-key';
const CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

const state = {
  key: '',
  links: [],
  query: '',
  loading: false
};

const $ = (selector) => document.querySelector(selector);

function init() {
  const year = $('#footer-year');
  if (year) year.textContent = String(new Date().getFullYear());

  state.key = readStoredKey();
  bindEvents();
  bootstrap();
}

function readStoredKey() {
  try {
    return localStorage.getItem(OWNER_KEY_STORAGE) || '';
  } catch (error) {
    return '';
  }
}

function storeKey(key) {
  try {
    localStorage.setItem(OWNER_KEY_STORAGE, key);
  } catch (error) {
    /* 忽略存储失败 */
  }
}

function clearStoredKey() {
  try {
    localStorage.removeItem(OWNER_KEY_STORAGE);
  } catch (error) {
    /* 忽略 */
  }
}

async function bootstrap() {
  try {
    await loadLinks();
  } catch (error) {
    if (error.status !== 401) {
      showLogin();
      showLoginError('读取管理信息失败，请稍后再试。');
    }
  }
}

function bindEvents() {
  $('#manage-login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    hideLoginError();
    const key = $('#owner-key-input').value.trim();
    if (!key) {
      showLoginError('请输入管理密钥。');
      return;
    }
    const button = $('#manage-login-btn');
    button.disabled = true;
    button.textContent = '验证中…';
    try {
      await api('/api/manage/session', {
        method: 'POST',
        body: JSON.stringify({ key })
      });
      state.key = key;
      storeKey(key);
      $('#owner-key-input').value = '';
      await loadLinks();
    } catch (error) {
      showLoginError(
        error.status === 401 ? '没有找到这个管理密钥对应的短链。' : error.message || '登录失败，请稍后再试。'
      );
    } finally {
      button.disabled = false;
      button.textContent = '进入我的短链';
    }
  });

  $('#manage-refresh').addEventListener('click', () => loadLinks());
  $('#manage-logout').addEventListener('click', logout);
  $('#manage-search').addEventListener('input', () => {
    state.query = $('#manage-search').value.trim().toLowerCase();
    renderRows();
  });
  $('#manage-key-copy').addEventListener('click', copyKey);
}

async function loadLinks() {
  const data = await api('/api/manage/links');
  state.links = Array.isArray(data.links) ? data.links : [];
  renderDashboard(data);
  show('dashboard');
}

function renderDashboard(data) {
  $('#manage-total').textContent = number(data.stats?.total);
  $('#manage-active').textContent = number(data.stats?.active);
  $('#manage-clicks').textContent = number(data.stats?.clicks);

  const keyBox = $('#manage-key-display');
  if (state.key) {
    keyBox.hidden = false;
    $('#manage-key-value').textContent = state.key;
    $('#manage-key-hint').textContent =
      '这条密钥可以管理当前浏览器创建的所有短链。请把它保存到密码管理器；关闭页面后不会再次显示。';
  } else {
    keyBox.hidden = true;
    $('#manage-key-hint').textContent =
      '当前通过浏览器 Cookie 登录。若要换设备管理，请在创建短链时保存好管理密钥。';
  }

  $('#manage-meta').textContent =
    '共 ' + number(data.stats?.total) + ' 条 · 更新于 ' + formatDate(Date.now(), true) +
    (data.origin ? ' · ' + data.origin : '');
  renderRows();
}

function renderRows() {
  const tbody = $('#manage-rows');
  tbody.replaceChildren();
  const query = state.query;
  const filtered = state.links.filter((link) => {
    if (!query) return true;
    return String(link.code).toLowerCase().includes(query) || String(link.url).toLowerCase().includes(query);
  });

  $('#manage-empty').hidden = filtered.length > 0;
  $('#manage-empty').textContent = state.links.length
    ? '没有匹配的短链。'
    : '还没有用这个密钥创建过短链。';

  for (const link of filtered) tbody.append(renderRow(link));
}

function renderRow(link) {
  const tr = document.createElement('tr');

  const codeCell = document.createElement('td');
  codeCell.className = 'code-cell';
  const codeLink = document.createElement('a');
  codeLink.href = '/' + link.code + '+';
  codeLink.target = '_blank';
  codeLink.rel = 'noopener';
  codeLink.textContent = '/' + link.code;
  codeLink.style.color = 'inherit';
  codeLink.style.textDecoration = 'none';
  codeCell.append(codeLink);

  const urlCell = document.createElement('td');
  urlCell.className = 'url-cell';
  const urlLink = document.createElement('a');
  urlLink.href = link.url;
  urlLink.target = '_blank';
  urlLink.rel = 'noopener noreferrer nofollow';
  urlLink.textContent = link.url;
  urlLink.title = link.url;
  urlLink.style.color = 'inherit';
  urlLink.style.textDecoration = 'none';
  urlCell.append(urlLink);

  const statusCell = document.createElement('td');
  statusCell.append(statusBadge(link));

  const clicksCell = document.createElement('td');
  clicksCell.className = 'num';
  clicksCell.textContent = number(link.clicks);

  const createdCell = document.createElement('td');
  createdCell.className = 'num';
  createdCell.textContent = formatDate(link.created_at, false);

  const actionsCell = document.createElement('td');
  const actions = document.createElement('div');
  actions.className = 'row-actions';

  const stats = document.createElement('a');
  stats.href = '/' + link.code + '+';
  stats.target = '_blank';
  stats.rel = 'noopener';
  stats.textContent = '统计';
  stats.style.color = 'inherit';
  stats.style.textDecoration = 'none';
  actions.append(stats);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = link.blocked ? '取消屏蔽' : '屏蔽';
  toggle.addEventListener('click', () => {
    act(link.code, link.blocked ? 'unblock' : 'block');
  });
  actions.append(toggle);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger';
  remove.textContent = '删除';
  remove.addEventListener('click', () => act(link.code, 'delete'));
  actions.append(remove);

  actionsCell.append(actions);
  tr.append(codeCell, urlCell, statusCell, clicksCell, createdCell, actionsCell);
  return tr;
}

async function act(code, action) {
  if (!CODE_RE.test(code)) return;
  if (action === 'delete' && !window.confirm('删除 /' + code + ' 后无法恢复，确定继续？')) return;
  if (action === 'block' && !window.confirm('屏蔽后 /' + code + ' 会立即停止跳转，确定继续？')) return;

  hideError();
  try {
    await api('/api/manage/links/' + encodeURIComponent(code), {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    await loadLinks();
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      showLoginError('登录状态已失效，请重新输入管理密钥。');
      return;
    }
    showError(error.message || '操作失败，请稍后再试。');
  }
}

async function copyKey() {
  if (!state.key) return;
  try {
    await navigator.clipboard.writeText(state.key);
    const button = $('#manage-key-copy');
    button.textContent = '已复制';
    window.setTimeout(() => {
      button.textContent = '复制密钥';
    }, 1600);
  } catch (error) {
    showError('复制失败，请手动选中密钥复制。');
  }
}

async function logout() {
  if (!window.confirm('退出后会清除这个浏览器记住的管理密钥，需要时请重新粘贴。确定退出？')) return;
  try {
    await api('/api/manage/logout', { method: 'POST' });
  } catch (error) {
    /* 即使接口失败也清除本地状态 */
  }
  state.key = '';
  state.links = [];
  clearStoredKey();
  $('#manage-rows').replaceChildren();
  show('login');
  $('#owner-key-input').focus();
}

function show(view) {
  $('#manage-login').hidden = view !== 'login';
  $('#manage-dashboard').hidden = view !== 'dashboard';
}

function showLogin() {
  show('login');
  $('#manage-login-error').hidden = true;
}

function showLoginError(message) {
  const box = $('#manage-login-error');
  box.textContent = message;
  box.hidden = false;
}

function hideLoginError() {
  $('#manage-login-error').hidden = true;
}

function showError(message) {
  const box = $('#manage-error');
  box.textContent = message;
  box.hidden = false;
}

function hideError() {
  $('#manage-error').hidden = true;
}

async function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (state.key) headers['X-Owner-Key'] = state.key;

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
    const failure = new Error(data?.error || '请求失败（' + response.status + '）');
    failure.status = response.status;
    throw failure;
  }
  return data;
}

function statusBadge(link) {
  const now = Date.now();
  const span = document.createElement('span');
  span.className = 'badge';
  if (link.blocked) {
    span.classList.add('badge-danger');
    span.textContent = '已拦截';
  } else if (link.expires_at <= now) {
    span.textContent = '已过期';
  } else {
    span.classList.add('badge-ok');
    span.textContent = '有效';
  }
  return span;
}

function number(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function formatDate(ms, withTime) {
  if (!ms) return '—';
  try {
    const options = withTime
      ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
      : { year: 'numeric', month: '2-digit', day: '2-digit' };
    return new Intl.DateTimeFormat('zh-CN', options).format(new Date(ms)).replace(/\//g, '-');
  } catch (error) {
    return new Date(ms).toISOString().slice(0, withTime ? 16 : 10).replace('T', ' ');
  }
}

init();
