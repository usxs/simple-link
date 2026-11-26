const TOKEN_KEY = 'simple-link:admin-token';
const CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

const state = {
  token: '',
  timezone: 'Asia/Shanghai',
  query: '',
  links: []
};

const $ = (selector) => document.querySelector(selector);

function init() {
  const year = $('#footer-year');
  if (year) year.textContent = String(new Date().getFullYear());

  try {
    state.token = sessionStorage.getItem(TOKEN_KEY) || '';
  } catch (error) {
    state.token = '';
  }

  bindEvents();
  bootstrap();
}

async function bootstrap() {
  try {
    const config = await api('/api/config');
    state.timezone = config.timezone || 'Asia/Shanghai';
    if (!config.adminEnabled) {
      show('disabled');
      return;
    }
  } catch (error) {
    show('login');
    showLoginError('配置加载失败，请刷新页面重试。');
    return;
  }

  if (state.token) {
    await loadOverview();
  } else {
    show('login');
  }
}

function bindEvents() {
  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    hideLoginError();
    const token = $('#token-input').value.trim();
    if (!token) {
      showLoginError('请输入管理令牌。');
      return;
    }
    state.token = token;
    const button = $('#login-btn');
    button.disabled = true;
    button.textContent = '验证中…';
    try {
      await loadOverview();
      try {
        sessionStorage.setItem(TOKEN_KEY, token);
      } catch (error) {
        /* 忽略 */
      }
    } catch (error) {
      state.token = '';
      showLoginError(error.status === 401 ? '管理令牌不正确。' : error.message || '登录失败。');
    } finally {
      button.disabled = false;
      button.textContent = '进入后台';
    }
  });

  $('#refresh-btn').addEventListener('click', () => loadOverview());
  $('#logout-btn').addEventListener('click', logout);
  $('#search-btn').addEventListener('click', runSearch);
  $('#search-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runSearch();
    }
  });
}

function runSearch() {
  state.query = $('#search-input').value.trim();
  loadOverview();
}

function logout() {
  state.token = '';
  state.links = [];
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch (error) {
    /* 忽略 */
  }
  $('#token-input').value = '';
  $('#admin-rows').replaceChildren();
  show('login');
}

async function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = 'Bearer ' + state.token;

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

async function loadOverview() {
  hideAdminError();
  const query = state.query ? '?q=' + encodeURIComponent(state.query) : '';
  try {
    const data = await api('/api/admin/overview' + query);
    state.timezone = data.timezone || state.timezone;
    state.links = data.links || [];
    renderOverview(data);
    show('dashboard');
  } catch (error) {
    if (error.status === 401) {
      state.token = '';
      try {
        sessionStorage.removeItem(TOKEN_KEY);
      } catch (storageError) {
        /* 忽略 */
      }
      show('login');
      showLoginError('管理令牌已失效，请重新输入。');
      return;
    }
    throw error;
  }
}

function renderOverview(data) {
  const { stats } = data;
  $('#stat-total').textContent = number(stats.totalLinks);
  $('#stat-active').textContent = number(stats.activeLinks);
  $('#stat-clicks').textContent = number(stats.totalClicks);
  $('#stat-today').textContent = number(stats.todayClicks);
  $('#admin-meta').textContent =
    '更新于 ' + formatDate(Date.now(), true) + ' · 时区 ' + data.timezone +
    (state.query ? ' · 搜索“' + state.query + '”' : '');
  $('#admin-hint').textContent = state.query
    ? '搜索结果最多 40 条。删除不可恢复；屏蔽会立即停止跳转。'
    : '最多显示最近 40 条。删除不可恢复；屏蔽会立即停止跳转。';

  const tbody = $('#admin-rows');
  tbody.replaceChildren();
  const empty = $('#admin-empty');
  empty.hidden = state.links.length > 0;

  for (const link of state.links) {
    tbody.append(renderRow(link));
  }
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
    act(link.code, link.blocked ? 'unblock' : 'block', link.blocked ? '取消屏蔽' : '屏蔽');
  });
  actions.append(toggle);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger';
  remove.textContent = '删除';
  remove.addEventListener('click', () => act(link.code, 'delete', '删除'));
  actions.append(remove);

  actionsCell.append(actions);

  tr.append(codeCell, urlCell, statusCell, clicksCell, createdCell, actionsCell);
  return tr;
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

async function act(code, action, label) {
  if (!CODE_RE.test(code)) return;
  if (action === 'delete' && !window.confirm('删除 /' + code + ' 后无法恢复，确定继续？')) return;
  if (action !== 'delete' && !window.confirm('确定要' + label + ' /' + code + ' 吗？')) return;

  hideAdminError();
  try {
    await api('/api/admin/links/' + encodeURIComponent(code), {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    await loadOverview();
  } catch (error) {
    showAdminError(error.message || '操作失败，请稍后再试。');
  }
}

function showAdminError(message) {
  const box = $('#admin-error');
  box.textContent = message;
  box.hidden = false;
}

function hideAdminError() {
  const box = $('#admin-error');
  box.hidden = true;
  box.textContent = '';
}

function showLoginError(message) {
  const box = $('#login-error');
  box.textContent = message;
  box.hidden = false;
}

function hideLoginError() {
  const box = $('#login-error');
  box.hidden = true;
  box.textContent = '';
}

function show(view) {
  $('#login-view').hidden = view !== 'login';
  $('#dashboard').hidden = view !== 'dashboard';
  $('#disabled-view').hidden = view !== 'disabled';
  if (view === 'login') {
    window.setTimeout(() => $('#token-input').focus(), 0);
  }
}

function number(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function formatDate(ms, withTime) {
  if (!ms) return '—';
  try {
    const options = withTime
      ? { timeZone: state.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
      : { timeZone: state.timezone, year: 'numeric', month: '2-digit', day: '2-digit' };
    return new Intl.DateTimeFormat('zh-CN', options).format(new Date(ms)).replace(/\//g, '-');
  } catch (error) {
    return new Date(ms).toISOString().slice(0, withTime ? 16 : 10).replace('T', ' ');
  }
}

init();
