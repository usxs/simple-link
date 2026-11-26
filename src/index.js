import { ApiError, htmlResponse, json, protect, redirect } from './http.js';
import { handleApi } from './api.js';
import { renderErrorPage, renderStatsPage } from './pages.js';
import { dayKey, safeHttpUrl } from './util.js';

const DAY_MS = 86400000;
const CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const ASSET_PATHS = new Set([
  '/style.css',
  '/theme.js',
  '/app.js',
  '/admin.js',
  '/favicon.svg',
  '/robots.txt',
  '/manifest.webmanifest'
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      return await route(request, env, ctx, url);
    } catch (error) {
      return errorResponse(error, request, url);
    }
  },

  async scheduled(controller, env, ctx) {
    const job = cleanupExpired(env).catch((error) => {
      console.error('scheduled cleanup failed', error);
    });
    if (ctx?.waitUntil) ctx.waitUntil(job);
    else await job;
  }
};

async function route(request, env, ctx, url) {
  const method = request.method.toUpperCase();
  const { pathname } = url;

  if (pathname.startsWith('/api/')) {
    return handleApi(request, env, url);
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return htmlResponse(renderErrorPage(404), 404, { noindex: true });
  }

  if (pathname === '/' || pathname === '/index.html') {
    return serveAsset(request, env, '/index.html', { html: true });
  }

  if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin.html') {
    return serveAsset(request, env, '/admin.html', { html: true, noindex: true });
  }

  if (ASSET_PATHS.has(pathname)) {
    return env.ASSETS.fetch(request);
  }

  if (pathname === '/favicon.ico') {
    return redirect('/favicon.svg', 308);
  }

  const statsMatch = pathname.match(/^\/([A-Za-z0-9_-]{1,32})\+$/);
  if (statsMatch) {
    return statsPage(env, statsMatch[1]);
  }

  const codeMatch = pathname.match(/^\/([A-Za-z0-9_-]{1,32})$/);
  if (codeMatch) {
    return redirectForCode(request, env, ctx, codeMatch[1]);
  }

  return htmlResponse(renderErrorPage(404), 404, { noindex: true });
}

async function serveAsset(request, env, path, { html = false, noindex = false } = {}) {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = path;
  assetUrl.search = '';
  const response = await env.ASSETS.fetch(
    new Request(assetUrl.toString(), {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: { Accept: 'text/html' }
    })
  );
  if (!response.ok && response.status !== 304) {
    throw new ApiError(500, '页面资源缺失，请检查部署是否完整');
  }
  const out = protect(response, { noindex });
  if (html) out.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  return out;
}

async function redirectForCode(request, env, ctx, code) {
  const row = await env.DB.prepare(
    'SELECT url, expires_at, blocked FROM links WHERE code = ?1'
  )
    .bind(code)
    .first();

  if (!row) return htmlResponse(renderErrorPage(404), 404, { noindex: true });
  if (row.blocked) return htmlResponse(renderErrorPage(451), 451, { noindex: true });
  if (row.expires_at <= Date.now()) {
    return htmlResponse(renderErrorPage(410), 410, { noindex: true });
  }

  const destination = safeHttpUrl(row.url);
  if (!destination) return htmlResponse(renderErrorPage(410), 410, { noindex: true });

  const now = Date.now();
  const day = dayKey(env.TIMEZONE || 'Asia/Shanghai', now);
  const counting = env.DB.batch([
    env.DB.prepare('UPDATE links SET clicks = clicks + 1, last_click_at = ?1 WHERE code = ?2')
      .bind(now, code),
    env.DB.prepare(
      `INSERT INTO link_clicks_daily (code, day, count) VALUES (?1, ?2, 1)
       ON CONFLICT(code, day) DO UPDATE SET count = count + 1`
    ).bind(code, day)
  ]).catch((error) => {
    console.error('click count failed', code, error);
  });

  if (ctx?.waitUntil) ctx.waitUntil(counting);
  else await counting;

  return redirect(destination, 302);
}

async function statsPage(env, code) {
  const row = await env.DB.prepare(
    'SELECT code, url, created_at, expires_at, clicks, last_click_at, blocked FROM links WHERE code = ?1'
  )
    .bind(code)
    .first();
  if (!row) return htmlResponse(renderErrorPage(404), 404, { noindex: true });

  const now = Date.now();
  const timezone = env.TIMEZONE || 'Asia/Shanghai';
  const days = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    days.push(dayKey(timezone, now - offset * DAY_MS));
  }
  const rows = await env.DB.prepare(
    'SELECT day, count FROM link_clicks_daily WHERE code = ?1 AND day >= ?2 ORDER BY day ASC'
  )
    .bind(code, days[0])
    .all();
  const counts = new Map((rows.results || []).map((item) => [item.day, item.count]));

  const link = {
    ...row,
    blocked: Boolean(row.blocked),
    status: row.blocked ? 'blocked' : row.expires_at <= now ? 'expired' : 'active'
  };
  const html = renderStatsPage({
    link,
    daily: days.map((day) => ({ day, count: counts.get(day) || 0 })),
    timezone,
    now
  });
  return htmlResponse(html, 200, { noindex: true });
}

export async function cleanupExpired(env) {
  const now = Date.now();
  const cutoff = now - 7 * DAY_MS;
  const oldestQuotaDay = dayKey(env.TIMEZONE || 'Asia/Shanghai', now - 60 * DAY_MS);
  await env.DB.batch([
    env.DB.prepare(
      'DELETE FROM link_clicks_daily WHERE code IN (SELECT code FROM links WHERE expires_at < ?1)'
    ).bind(cutoff),
    env.DB.prepare('DELETE FROM links WHERE expires_at < ?1').bind(cutoff),
    env.DB.prepare('DELETE FROM link_quota WHERE day < ?1').bind(oldestQuotaDay)
  ]);
}

function errorResponse(error, request, url) {
  const isApi = url.pathname.startsWith('/api/');
  if (error instanceof ApiError) {
    if (isApi) return json({ ok: false, error: error.message }, error.status);
    const status = error.status === 404 ? 404 : 500;
    return htmlResponse(renderErrorPage(status), status, { noindex: true });
  }

  console.error('unhandled request error', request.method, url.pathname, error);
  if (isApi) {
    return json({ ok: false, error: '服务暂时不可用，请稍后再试' }, 500);
  }
  return htmlResponse(renderErrorPage(500), 500, { noindex: true });
}
