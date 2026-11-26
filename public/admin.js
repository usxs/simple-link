const TOKEN_KEY = 'simple-link:admin-token';
const SSO_TRY_KEY = 'simple-link:sso-tried';
const CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

const state = {
  token: '',
  mode: '',
  username: '',
  config: null,
  loginMethod: 'blog',
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
    state.config = await api('/api/config');
    state.timezone = state.config.timezone || 'Asia/Shanghai';
  } catch (error) {
    show('login');
    showLoginError('配置加载失败，请刷新页面重试。');
    return;
  }

  if (!state.config.adminEnabled) {
    show('disabled');
    return;
  }

  if (!state.config.adminAuth?.blog) state.loginMethod = 'token';
  configureLogin();

  try {
    const session = await getSession();
    if (session) {
      state.mode = session.mode || '';
      state.username = session.username || '';
      await loadOverview();
      return;
    }
  } catch (error) {
    if (error.status !== 401 && error.status !== 404) {
      showLoginError(error.message || '登录状态检查失败，请稍后再试。');
    }
  }

  if (state.token) {
    try {
      state.mode = 'token';
      await loadOverview();
      return;
    } catch (error) {
      clearStoredToken();
      showLoginError(error.status === 401 ? '管理令牌不正确。' : error.message || '登录失败。');
    }
  }

  if (shouldAutoSso()) {
    goSso();
    return;
  }

  showLogin();
  if (new URLSearchParams(location.search).get('error') === 'sso') {
    showLoginError('博客登录已过期，请重新登录。');
  }
}

function ssoAvailable() {
  return Boolean(state.config?.adminAuth?.sso && state.config.adminAuth.ssoUrl);
}

function shouldAutoSso() {
  const params = new URLSearchParams(location.search);
  if (params.get('local') === '1' || params.get('error') === 'sso') return false;
  if (!ssoAvailable()) return false;
  try {
    const last = Number(sessionStorage.getItem(SSO_TRY_KEY) || 0);
    return !last || Date.now() - last > 5 * 60 * 1000;
  } catch (error) {
    return false;
  }
}

function goSso() {
  if (!ssoAvailable()) return;
  try {
    sessionStorage.setItem(SSO_TRY_KEY, String(Date.now()));
  } catch (error) {
    /* 忽略 */
  }
  location.replace(state.config.adminAuth.ssoUrl);
}

async function getSession() {
  try {
    return await api('/api/admin/session');
  } catch (error) {
    if (error.status === 401 || error.status === 404) return null;
    throw error;
  }
}

function bindEvents() {
  $('#blog-login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    hideLoginError();
    const username = $('#blog-username').value.trim();
    const password = $('#blog-password').value;
    const totpCode = $('#totp-code').value.trim();
    if (!username) {
      showLoginError('请输入简单博客用户名。');
      $('#blog-username').focus();
      return;
    }
    if (!password) {
      showLoginError('请输入简单博客密码。');
      $('#blog-password').focus();
      return;
    }

    const button = $('#blog-login-btn');
    button.disabled = true;
    button.textContent = '验证中…';
    try {
      const data = await api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ username, password, totpCode })
      });
      state.mode = data.mode || 'blog';
      state.username = data.username || username;
      clearStoredToken();
      state.token = '';
      $('#blog-password').value = '';
      $('#totp-code').value = '';
      await loadOverview();
    } catch (error) {
      if (error.needTotp) {
        $('#totp-field').hidden = false;
        $('#totp-code').focus();
        showLoginError('请输入两步验证码后继续。');
      } else if (error.status === 401) {
        showLoginError(error.message || '用户名或密码不正确。');
      } else if (error.status === 429) {
        showLoginError(error.message || '尝试次数过多，请稍后再试。');
      } else {
        showLoginError(error.message || '登录失败，请稍后再试。');
      }
    } finally {
      button.disabled = false;
      button.textContent = $('#totp-field').hidden ? '用博客密码登录' : '继续登录';
    }
  });

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    hideLoginError();
    const token = $('#token-input').value.trim();
    if (!token) {
      showLoginError('请输入管理令牌。');
      return;
    }

    const button = $('#login-btn');
    button.disabled = true;
    button.textContent = '验证中…';
    state.token = token;
    try {
      state.mode = 'token';
      state.username = '管理令牌';
      await loadOverview();
      try {
        sessionStorage.setItem(TOKEN_KEY, token);
      } catch (error) {
        /* 忽略 */
      }
    } catch (error) {
      state.token = '';
      state.mode = '';
      showLoginError(error.status === 401 ? '管理令牌不正确。' : error.message || '登录失败。');
    } finally {
      button.disabled = false;
      button.textContent = '进入后台';
    }
  });

  $('#token-toggle').addEventListener('click', () => {
    state.loginMethod = state.loginMethod === 'blog' ? 'token' : 'blog';
    hideLoginError();
    configureLogin();
    focusLoginField();
  });

  $('#sso-btn').addEventListener('click', goSso);

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

function configureLogin() {
  const blog = Boolean(state.config?.adminAuth?.blog);
  const token = Boolean(state.config?.adminAuth?.token);
  if (!blog) state.loginMethod = 'token';

  const blogMode = blog && state.loginMethod === 'blog';
  $('#blog-login-form').hidden = !blogMode;
  $('#login-form').hidden = blogMode || !token;
  $('#login-switch').hidden = !(blog && token);
  $('#token-toggle').textContent = blogMode ? '使用管理令牌' : '返回简单博客登录';
  $('#sso-btn').hidden = !ssoAvailable();

  if (blog) {
    $('#login-lead').textContent = '使用「简单博客」账号登录，登录状态会和博客共用。';
    $('#login-hint').textContent = blogMode
      ? '不需要单独注册。已经登录简单博客的话，打开本页会自动进入。'
      : '管理令牌只保存在当前标签页，关闭标签页即失效。';
  } else {
    $('#login-lead').textContent = '输入部署时设置的管理令牌，查看全站短链、屏蔽或删除。';
    $('#login-hint').textContent = '令牌只保存在当前标签页的 sessionStorage，关闭标签页即失效。';
  }
}

function runSearch() {
  state.query = $('#search-input').value.trim();
  loadOverview();
}

async function logout() {
  const button = $('#logout-btn');
  button.disabled = true;
  try {
    await api('/api/admin/logout', { method: 'POST' });
  } catch (error) {
    /* 服务端不可用时也要清掉本地状态 */
  } finally {
    button.disabled = false;
  }

  state.token = '';
  state.mode = '';
  state.username = '';
  state.links = [];
  clearStoredToken();
  $('#token-input').value = '';
  $('#blog-password').value = '';
  $('#totp-code').value = '';
  $('#totp-field').hidden = true;
  $('#admin-rows').replaceChildren();
  showLogin();
}

function clearStoredToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch (error) {
    /* 忽略 */
  }
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
    failure.needTotp = Boolean(data?.needTotp);
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
      state.mode = '';
      state.username = '';
      clearStoredToken();
      showLogin();
      showLoginError('登录状态已失效，请重新登录。');
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

  const who = state.mode === 'blog' && state.username
    ? '已登录：' + state.username + ' · '
    : '';
  $('#admin-meta').textContent =
    who + '更新于 ' + formatDate(Date.now(), true) + ' · 时区 ' + data.timezone +
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
    if (error.status === 401) return;
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

function showLogin() {
  configureLogin();
  show('login');
  focusLoginField();
}

function focusLoginField() {
  window.setTimeout(() => {
    const blogMode = state.config?.adminAuth?.blog && state.loginMethod === 'blog';
    const field = blogMode ? $('#blog-username') : $('#token-input');
    if (field && !field.closest('[hidden]')) field.focus();
  }, 0);
}

function show(view) {
  $('#login-view').hidden = view !== 'login';
  $('#dashboard').hidden = view !== 'dashboard';
  $('#disabled-view').hidden = view !== 'disabled';
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