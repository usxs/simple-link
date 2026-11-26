import { escapeHtml } from './util.js';

const FONT_URL =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Noto+Sans+SC:wght@400;500;600&display=swap';
const DAY_MS = 86400000;

const ICONS = {
  auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 20h8M12 17v3"/></svg>',
  light:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></svg>'
};

function themeToggle() {
  return `<div class="theme-options" role="group" aria-label="外观模式">
    <button type="button" class="theme-option" data-theme-mode="auto" aria-label="跟随系统" title="跟随系统">${ICONS.auto}</button>
    <button type="button" class="theme-option" data-theme-mode="light" aria-label="浅色" title="浅色">${ICONS.light}</button>
    <button type="button" class="theme-option" data-theme-mode="dark" aria-label="深色" title="深色">${ICONS.dark}</button>
  </div>`;
}

function header() {
  return `<header class="site-header">
  <div class="header-inner">
    <a class="brand" href="/" aria-label="简链首页">
      <span class="brand-mark" aria-hidden="true"><img src="/favicon.svg" alt="" width="32" height="32"></span>
      <span class="brand-name">简链</span>
    </a>
    <div class="header-actions">
      ${themeToggle()}
      <a class="header-link" href="/">生成短链</a>
    </div>
  </div>
</header>`;
}

function footer() {
  const year = new Date().getFullYear();
  return `<footer class="site-footer">
  <div class="footer-inner">
    <p>© ${year} 简链 · 公益、克制的短链服务</p>
    <p class="footer-muted">与「简单博客」共用一套黑白主题</p>
  </div>
</footer>`;
}

function shell({ title, description, body, noindex = false }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="color-scheme" content="light dark">
${noindex ? '<meta name="robots" content="noindex, nofollow">' : ''}
<meta name="theme-color" content="#F7F7F8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#101012" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script src="/theme.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONT_URL}" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
</head>
<body class="narrow">
${header()}
${body}
${footer()}
</body>
</html>`;
}

function formatDate(ms, timeZone) {
  if (!ms) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
      .format(new Date(ms))
      .replace(/\//g, '-');
  } catch {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
  }
}

const STATUS_META = {
  active: { className: 'status-ok', text: '有效' },
  expired: { className: 'status-muted', text: '已过期' },
  blocked: { className: 'status-danger', text: '已拦截' }
};

export function renderStatsPage({ link, daily, timezone, now = Date.now() }) {
  const status = STATUS_META[link.status] || STATUS_META.expired;
  const total = daily.reduce((sum, item) => sum + item.count, 0);
  const max = Math.max(1, ...daily.map((item) => item.count));
  const daysLeft = Math.max(0, Math.ceil((link.expires_at - now) / DAY_MS));
  const bars = daily
    .map((item, index) => {
      const height = item.count ? Math.max(6, Math.round((item.count / max) * 100)) : 2;
      const tick = index % 2 === 1 ? escapeHtml(item.day.slice(5)) : '';
      return `<div class="chart-col${item.count ? '' : ' is-empty'}" title="${escapeHtml(item.day)} · ${item.count} 次">
        <span class="chart-bar" style="height:${height}%"></span>
        <span class="chart-tick">${tick}</span>
      </div>`;
    })
    .join('');

  let statusNote = '';
  if (link.status === 'active') statusNote = `${daysLeft} 天后自动到期`;
  else if (link.status === 'expired') statusNote = '已停止跳转，等待清理';
  else statusNote = '因违规或滥用被停止跳转';

  const body = `<main class="shell stats-shell">
  <div class="stats-head">
    <p class="eyebrow">LINK STATS / 短链统计</p>
    <h1 class="stats-title mono">/${escapeHtml(link.code)}</h1>
    <div class="status-line">
      <span class="status ${status.className}"><span class="status-dot"></span>${status.text}</span>
      <span class="status-note">${statusNote}</span>
    </div>
  </div>

  <section class="stats-card" aria-label="点击数据">
    <div class="stats-total">
      <p class="stat-label">累计点击</p>
      <p class="stat-number">${link.clicks.toLocaleString('en-US')}</p>
      <p class="stat-sub">最近 14 天 ${total.toLocaleString('en-US')} 次</p>
    </div>
    <div class="chart" role="img" aria-label="最近 14 天每日点击次数">
      <div class="chart-bars">${bars}</div>
      <p class="chart-caption">最近 14 天 · 按 ${escapeHtml(timezone)} 时区切分</p>
    </div>
  </section>

  <dl class="meta-list">
    <div class="meta-row">
      <dt>目标地址</dt>
      <dd><a class="mono meta-url" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(link.url)}</a></dd>
    </div>
    <div class="meta-row">
      <dt>创建时间</dt>
      <dd>${escapeHtml(formatDate(link.created_at, timezone))}</dd>
    </div>
    <div class="meta-row">
      <dt>到期时间</dt>
      <dd>${escapeHtml(formatDate(link.expires_at, timezone))}</dd>
    </div>
    <div class="meta-row">
      <dt>最近点击</dt>
      <dd>${link.last_click_at ? escapeHtml(formatDate(link.last_click_at, timezone)) : '还没有人点击'}</dd>
    </div>
  </dl>

  <div class="stats-actions">
    <a class="btn btn-primary" href="/">再生成一条</a>
    ${link.status === 'active' ? `<a class="btn btn-ghost" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer nofollow">访问目标 ↗</a>` : ''}
  </div>
</main>`;

  return shell({
    title: `/${link.code} 的统计 · 简链`,
    description: '简链公开统计页：查看这条短链的累计点击与最近 14 天趋势。',
    body,
    noindex: true
  });
}

const ERROR_COPY = {
  404: {
    title: '这条短链不存在。',
    message: '可能从未生成过，也可能早已过期被清理。检查一下地址，或者回到首页生成一条新的。'
  },
  410: {
    title: '这条短链已经过期。',
    message: '短链到期后会自动停止跳转，并被定时清理。如果它是你创建的，可以回到首页重新生成。'
  },
  451: {
    title: '这条短链已被拦截。',
    message: '目标地址违反了本站的使用约定，已停止跳转。如果你认为这是误判，请联系站点管理员。'
  },
  500: {
    title: '服务暂时不可用。',
    message: '刚才那次请求没有完成。可以刷新重试，或者稍后再来。'
  }
};

export function renderErrorPage(status = 404) {
  const copy = ERROR_COPY[status] || ERROR_COPY[404];
  const body = `<main class="shell error-shell">
  <p class="eyebrow">SHORT LINK / 简链</p>
  <div class="error-card">
    <p class="error-code mono">${status}</p>
    <h1>${copy.title}</h1>
    <p class="error-copy">${copy.message}</p>
    <div class="error-actions">
      <a class="btn btn-primary" href="/">回到首页</a>
    </div>
  </div>
</main>`;
  return shell({
    title: `${status} · 简链`,
    description: copy.title,
    body,
    noindex: true
  });
}
