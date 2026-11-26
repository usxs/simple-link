const TOKEN_KEY = 'simple-link:admin-token';
const CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

const state = {
  token: '',
  mode: '',
  username: '',
  config: null,
  methods: [],
  method: '',
  links: [],
  query: '',
  loading: false
};

const METHODS = {
  password: { label: '账密', panel: 'password-form' },
  passkey: { label: '通行密钥', panel: 'passkey-panel' },
  token: { label: '管理令牌', panel: 'token-form' },
  blog: { label: '简单博客', panel: 'sso-panel' }
};

const MODE_LABELS = {
  password: '管理员账密',
  passkey: '通行密钥',
  token: '管理令牌',
  blog: '简单博客 SSO'
};

const $ = (selector) => document.querySelector(selector);

function init() {
  const year = $('#footer-year');
  if (year) year.textContent = String(new Date().getFullYear());
  bindEvents();
  bootstrap();
}

function bindEvents() {
  $('#password-form').addEventListener('submit', loginWithPassword);
  $('#token-form').addEventListener('submit', loginWithToken);
  $('#passkey-login-btn').addEventListener('click', loginWithPasskey);
  $('#sso-login-btn').addEventListener('click', () => {
    if (!state.config?.adminAuth?.ssoUrl) {
      showLoginError('简单博客单点登录还没有配置完成。');
      return;
    }
    window.location.href = state.config.adminAuth.ssoUrl;
  });

  $('#refresh-btn').addEventListener('click', () => loadOverview());
  $('#logout-btn').addEventListener('click', logout);
  $('#search-btn').addEventListener('click', () => {
    state.query = $('#search-input').value.trim();
    loadOverview();
  });
  $('#search-input').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    state.query = $('#search-input').value.trim();
    loadOverview();
  });

  $('#passkey-form').addEventListener('submit', registerPasskey);
}

async function bootstrap() {
  let config;
  try {
    config = await api('/api/config');
  } catch (error) {
    showLogin();
    showLoginError('无法读取站点配置，请稍后再试。');
    return;
  }

  state.config = config;
  if (!config.adminEnabled) {
    show('disabled');
    return;
  }

  const auth = config.adminAuth || {};
  state.methods = Array.isArray(auth.methods) ? auth.methods.filter((method) => METHODS[method]) : [];
  state.method = auth.defaultMethod && state.methods.includes(auth.defaultMethod)
    ? auth.defaultMethod
    : state.methods[0] || 'password';

  const stored = readToken();
  if (stored) state.token = stored;

  if (state.token) {
    try {
      const session = await api('/api/admin/session');
      enterDashboard(session);
      return;
    } catch (error) {
      if (error.status !== 401) {
        showLogin();
        showLoginError(error.message || '读取登录状态失败。');
        return;
      }
      state.token = '';
      clearToken();
    }
  }

  try {
    const session = await api('/api/admin/session');
    enterDashboard(session);
    return;
  } catch (error) {
    if (error.status !== 401) {
      showLogin();
      showLoginError(error.message || '读取登录状态失败。');
      return;
    }
  }

  showLogin();
  const params = new URLSearchParams(window.location.search);
  if (params.get('error') === 'sso') {
    showLoginError('简单博客单点登录没有完成，请重试，或使用其他方式登录。');
    history.replaceState(null, '', window.location.pathname);
  }
}

async function loginWithPassword(event) {
  event.preventDefault();
  hideLoginError();
  const username = $('#admin-username').value.trim();
  const password = $('#admin-password').value;
  if (!username || !password) {
    showLoginError('请输入管理员用户名和密码。');
    return;
  }
  const button = $('#password-login-btn');
  setBusy(button, true, '登录中…');
  try {
    await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    state.token = '';
    clearToken();
    const session = await api('/api/admin/session');
    $('#admin-password').value = '';
    enterDashboard(session);
  } catch (error) {
    showLoginError(error.message || '登录失败，请稍后再试。');
  } finally {
    setBusy(button, false, '登录');
  }
}

async function loginWithToken(event) {
  event.preventDefault();
  hideLoginError();
  const token = $('#token-input').value.trim();
  if (!token) {
    showLoginError('请输入管理令牌。');
    return;
  }
  const button = $('#token-login-btn');
  setBusy(button, true, '验证中…');
  state.token = token;
  try {
    const session = await api('/api/admin/session');
    writeToken(token);
    enterDashboard(session);
  } catch (error) {
    state.token = '';
    clearToken();
    showLoginError(error.status === 401 ? '管理令牌不正确。' : error.message || '登录失败。');
  } finally {
    setBusy(button, false, '进入后台');
  }
}

async function loginWithPasskey() {
  hideLoginError();
  if (!window.PublicKeyCredential || !navigator.credentials) {
    showLoginError('当前浏览器不支持通行密钥，请使用其他方式登录。');
    return;
  }
  const button = $('#passkey-login-btn');
  setBusy(button, true, '等待设备确认…');
  try {
    const data = await api('/api/admin/passkeys/login/options', { method: 'POST' });
    if (!data.options) throw new Error('通行密钥登录没有正确初始化。');
    const options = data.options;
    const publicKey = {
      ...options,
      challenge: b64urlToBuffer(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((item) => ({
        ...item,
        id: b64urlToBuffer(item.id)
      }))
    };
    const credential = await navigator.credentials.get({ publicKey });
    const response = credential.response;
    await api('/api/admin/passkeys/login', {
      method: 'POST',
      body: JSON.stringify({
        id: bufferToB64url(credential.rawId),
        authenticatorData: bufferToB64url(response.authenticatorData),
        clientDataJSON: bufferToB64url(response.clientDataJSON),
        signature: bufferToB64url(response.signature)
      })
    });
    const session = await api('/api/admin/session');
    enterDashboard(session);
  } catch (error) {
    if (error.name === 'NotAllowedError' || error.name === 'AbortError') {
      showLoginError('已取消通行密钥登录，或等待超时。');
    } else if (error.status === 404) {
      showLoginError('还没有添加通行密钥，请先用其他方式登录后添加。');
    } else {
      showLoginError(error.message || '通行密钥登录失败。');
    }
  } finally {
    setBusy(button, false, '使用通行密钥登录');
  }
}

function enterDashboard(session) {
  state.mode = session.mode || '';
  state.username = session.username || '';
  show('dashboard');
  renderPasskeysHint();
  loadOverview();
  loadPasskeys();
}

function showLogin() {
  show('login');
  renderTabs();
  $('#login-error').hidden = true;
}

function show(view) {
  $('#disabled-view').hidden = view !== 'disabled';
  $('#login-view').hidden = view !== 'login';
  $('#dashboard').hidden = view !== 'dashboard';
}

function renderTabs() {
  const tabs = $('#auth-tabs');
  tabs.replaceChildren();
  if (state.methods.length <= 1) {
    tabs.hidden = true;
    selectMethod(state.method || state.methods[0] || 'password');
    return;
  }
  tabs.hidden = false;
  for (const method of state.methods) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'auth-tab';
    button.dataset.method = method;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', METHODS[method].panel);
    button.setAttribute('aria-selected', state.method === method ? 'true' : 'false');
    button.textContent = METHODS[method].label;
    button.addEventListener('click', () => selectMethod(method));
    tabs.append(button);
  }
  selectMethod(state.method);
}

function selectMethod(method) {
  if (!METHODS[method]) method = state.methods[0] || 'password';
  state.method = method;
  for (const [key, item] of Object.entries(METHODS)) {
    const panel = document.getElementById(item.panel);
    if (panel) panel.hidden = key !== method;
  }
  for (const tab of document.querySelectorAll('.auth-tab')) {
    tab.setAttribute('aria-selected', tab.dataset.method === method ? 'true' : 'false');
  }
  const lead = $('#login-lead');
  if (method === 'password') lead.textContent = '使用部署时设置的管理员用户名和密码登录。';
  if (method === 'passkey') lead.textContent = '使用这台设备上已经添加的通行密钥，免密码登录。';
  if (method === 'token') lead.textContent = '使用部署时设置的管理令牌登录。';
  if (method === 'blog') lead.textContent = '使用「简单博客」账号登录，需要管理员显式开启单点登录。';
  if (method !== 'password') {
    const username = $('#admin-username');
    if (username) username.value = 'admin';
  }
}

function renderPasskeysHint() {
  const box = $('#passkey-box');
  if (!box) return;
  const auth = state.config?.adminAuth || {};
  const supported = Boolean(window.PublicKeyCredential && navigator.credentials);
  const add = $('#add-passkey');
  if (!supported) {
    add.disabled = true;
    add.textContent = '当前浏览器不支持通行密钥';
  } else {
    add.disabled = false;
    add.textContent = '添加通行密钥';
  }
  const meta = $('#admin-meta');
  if (meta) {
    meta.textContent = '以 ' + (MODE_LABELS[state.mode] || '管理员') + ' 登录' +
      (state.username ? '（' + state.username + '）' : '') +
      (auth.passkeyCount ? ' · 已添加 ' + auth.passkeyCount + ' 个通行密钥' : '');
  }
}

async function loadOverview() {
  if (state.loading) return;
  state.loading = true;
  hideAdminError();
  try {
    const query = state.query ? '?q=' + encodeURIComponent(state.query) : '';
    const data = await api('/api/admin/overview' + query);
    renderStats(data);
    state.links = data.links || [];
    renderRows();
  } catch (error) {
    if (error.status === 401) {
      expireLogin();
      return;
    }
    showAdminError(error.message || '读取短链列表失败。');
  } finally {
    state.loading = false;
  }
}

function renderStats(data) {
  const stats = data.stats || {};
  $('#stat-total').textContent = number(stats.totalLinks);
  $('#stat-active').textContent = number(stats.activeLinks);
  $('#stat-clicks').textContent = number(stats.totalClicks);
  $('#stat-today').textContent = number(stats.todayClicks);
  const parts = [
    '全站 ' + number(stats.totalLinks) + ' 条',
    '今日新增 ' + number(stats.todayLinks) + ' 条',
    '时区 ' + (data.timezone || 'Asia/Shanghai'),
    '以 ' + (MODE_LABELS[state.mode] || '管理员') + ' 登录'
  ];
  $('#admin-meta').textContent = parts.join(' · ');
}

function renderRows() {
  const tbody = $('#admin-rows');
  tbody.replaceChildren();
  $('#admin-empty').hidden = state.links.length > 0;
  $('#admin-empty').textContent = state.query ? '没有匹配的短链。' : '还没有短链。';
  for (const link of state.links) tbody.append(renderRow(link));
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
  if (link.owner) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.marginLeft = '6px';
    badge.title = '由管理密钥用户创建';
    badge.textContent = '用户';
    codeCell.append(badge);
  }

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
  toggle.addEventListener('click', () => act(link.code, link.blocked ? 'unblock' : 'block'));
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
  hideAdminError();
  try {
    await api('/api/admin/links/' + encodeURIComponent(code), {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    await loadOverview();
  } catch (error) {
    if (error.status === 401) {
      expireLogin();
      return;
    }
    showAdminError(error.message || '操作失败，请稍后再试。');
  }
}

async function loadPasskeys() {
  const list = $('#passkey-list');
  if (!list) return;
  list.replaceChildren();
  try {
    const data = await api('/api/admin/passkeys');
    const passkeys = Array.isArray(data.passkeys) ? data.passkeys : [];
    if (passkeys.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'passkey-empty';
      empty.textContent = '还没有添加通行密钥。添加后可以免密码登录。';
      list.append(empty);
      return;
    }
    for (const passkey of passkeys) list.append(renderPasskey(passkey));
  } catch (error) {
    if (error.status === 401) return;
    const empty = document.createElement('p');
    empty.className = 'passkey-empty';
    empty.textContent = error.message || '读取通行密钥失败。';
    list.append(empty);
  }
}

function renderPasskey(passkey) {
  const item = document.createElement('div');
  item.className = 'passkey-item';

  const info = document.createElement('div');
  const name = document.createElement('strong');
  name.textContent = passkey.name || '通行密钥';
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = '添加于 ' + formatDate(passkey.created_at, false) +
    (passkey.last_used_at ? ' · 最近使用 ' + formatDate(passkey.last_used_at, false) : ' · 尚未使用');
  info.append(name, meta);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger';
  remove.textContent = '删除';
  remove.addEventListener('click', async () => {
    if (!window.confirm('删除这把通行密钥后，就不能再用它登录了。确定继续？')) return;
    try {
      await api('/api/admin/passkeys/' + encodeURIComponent(passkey.id), { method: 'DELETE' });
      await loadPasskeys();
    } catch (error) {
      showPasskeyError(error.message || '删除失败。');
    }
  });

  item.append(info, remove);
  return item;
}

async function registerPasskey(event) {
  event.preventDefault();
  hidePasskeyError();
  if (!window.PublicKeyCredential || !navigator.credentials) {
    showPasskeyError('当前浏览器或环境不支持通行密钥，请换用支持 WebAuthn 的浏览器。');
    return;
  }
  const button = $('#add-passkey');
  setBusy(button, true, '等待设备确认…');
  try {
    const data = await api('/api/admin/passkeys/register/options', { method: 'POST' });
    if (!data.options) throw new Error('通行密钥注册没有正确初始化。');
    const options = data.options;
    const publicKey = {
      ...options,
      challenge: b64urlToBuffer(options.challenge),
      user: {
        ...options.user,
        id: b64urlToBuffer(options.user.id)
      },
      excludeCredentials: (options.excludeCredentials || []).map((item) => ({
        ...item,
        id: b64urlToBuffer(item.id)
      }))
    };
    const credential = await navigator.credentials.create({ publicKey });
    const response = credential.response;
    const transports = typeof response.getTransports === 'function' ? response.getTransports() : [];
    const name = $('#passkey-name').value.trim() || '通行密钥';
    await api('/api/admin/passkeys/register', {
      method: 'POST',
      body: JSON.stringify({
        name,
        attestationObject: bufferToB64url(response.attestationObject),
        clientDataJSON: bufferToB64url(response.clientDataJSON),
        transports: transports.join(',')
      })
    });
    $('#passkey-name').value = '';
    await loadPasskeys();
    const hint = document.createElement('p');
    hint.className = 'form-hint';
    hint.textContent = '通行密钥已添加。下次可以在登录页选择通行密钥登录。';
    const box = $('#passkey-box');
    box.append(hint);
    window.setTimeout(() => hint.remove(), 5000);
  } catch (error) {
    if (error.name === 'NotAllowedError' || error.name === 'AbortError') {
      showPasskeyError('已取消添加，或等待超时。');
    } else {
      showPasskeyError(error.message || '添加通行密钥失败。');
    }
  } finally {
    setBusy(button, false, '添加通行密钥');
  }
}

async function logout() {
  try {
    await api('/api/admin/logout', { method: 'POST' });
  } catch (error) {
    /* 即使接口失败也清除本地登录状态 */
  }
  state.token = '';
  state.mode = '';
  state.username = '';
  state.links = [];
  clearToken();
  showLogin();
  $('#password-form').reset();
  $('#token-form').reset();
}

function expireLogin() {
  state.token = '';
  clearToken();
  showLogin();
  showLoginError('登录状态已失效，请重新登录。');
}

function showLoginError(message) {
  const box = $('#login-error');
  box.textContent = message;
  box.hidden = false;
}

function hideLoginError() {
  $('#login-error').hidden = true;
}

function showAdminError(message) {
  const box = $('#admin-error');
  box.textContent = message;
  box.hidden = false;
}

function hideAdminError() {
  $('#admin-error').hidden = true;
}

function showPasskeyError(message) {
  const box = $('#passkey-error');
  box.textContent = message;
  box.hidden = false;
}

function hidePasskeyError() {
  $('#passkey-error').hidden = true;
}

function setBusy(button, busy, busyText) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
  } else {
    button.disabled = false;
    button.textContent = button.dataset.originalText || busyText;
  }
}

function readToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  } catch (error) {
    return '';
  }
}

function writeToken(token) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch (error) {
    /* 忽略存储失败 */
  }
}

function clearToken() {
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
    throw failure;
  }
  return data;
}

function b64urlToBuffer(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToB64url(value) {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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