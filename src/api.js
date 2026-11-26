import { ApiError, json } from './http.js';
import {
  dayKey,
  getClientIp,
  intEnv,
  randomCode,
  randomToken,
  safeHttpUrl,
  sha256Hex,
  timingSafeEqual
} from './util.js';
import { normalizeDestination, validateSlug } from './validate.js';

const CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const DAY_MS = 86400000;

export async function handleApi(request, env, url) {
  const segments = url.pathname.split('/').filter(Boolean);
  const method = request.method.toUpperCase();
  const readOnly = method === 'GET' || method === 'HEAD';
  const route = segments[1] || '';

  if (route === 'health' && readOnly) {
    return json({ ok: true, service: 'simple-link', now: Date.now() });
  }

  if (route === 'config' && readOnly) {
    return getConfig(env, url);
  }

  if (route === 'quota' && readOnly) {
    const ipHash = await getIpHash(request, env);
    return getQuota(env, ipHash);
  }

  if (route === 'links') {
    if (segments[2] === 'lookup' && method === 'POST') {
      return lookupLinks(request, env, url);
    }
    if (segments.length === 2 && method === 'POST') {
      const ipHash = await getIpHash(request, env);
      return createLink(request, env, url, ipHash);
    }
    if (segments.length === 3 && method === 'DELETE') {
      return deleteLink(request, env, segments[2]);
    }
    if (segments.length === 4 && segments[3] === 'stats' && readOnly) {
      return getStats(env, segments[2], url);
    }
  }

  if (route === 'admin' && segments[2] === 'overview' && readOnly) {
    requireAdmin(request, env);
    return adminOverview(env, url);
  }

  if (route === 'admin' && segments[2] === 'links' && segments.length === 4 && method === 'POST') {
    requireAdmin(request, env);
    return adminAction(request, env, segments[3]);
  }

  throw new ApiError(404, '接口不存在');
}

function readLimits(env) {
  const daily = intEnv(env.DAILY_LINK_LIMIT, 10, 0, 10000);
  const active = intEnv(env.ACTIVE_LINK_LIMIT, 30, 0, 100000);
  const maxTtlDays = intEnv(env.MAX_TTL_DAYS, 365, 1, 3650);
  const defaultTtlDays = Math.min(intEnv(env.DEFAULT_TTL_DAYS, 365, 1, 3650), maxTtlDays);
  return { daily, active, maxTtlDays, defaultTtlDays };
}

function ttlOptions(limits) {
  const values = new Set([1, 7, 30, 365].filter((days) => days <= limits.maxTtlDays));
  values.add(limits.defaultTtlDays);
  return [...values].filter((days) => days >= 1).sort((a, b) => a - b);
}

function getPublicOrigin(env, url) {
  const configured = safeHttpUrl(env.PUBLIC_ORIGIN);
  if (configured) return new URL(configured).origin;
  return url.origin;
}

function quotaPayload(dailyUsed, activeUsed, limits) {
  return {
    daily: {
      used: dailyUsed,
      limit: limits.daily,
      remaining: Math.max(0, limits.daily - dailyUsed)
    },
    active: {
      used: activeUsed,
      limit: limits.active,
      remaining: Math.max(0, limits.active - activeUsed)
    }
  };
}

async function getIpHash(request, env) {
  const salt = env.IP_SALT || 'simple-link-public-salt';
  return sha256Hex(salt + '|' + getClientIp(request));
}

async function getQuota(env, ipHash) {
  const limits = readLimits(env);
  const tz = env.TIMEZONE || 'Asia/Shanghai';
  const day = dayKey(tz);
  const now = Date.now();
  const [dailyRow, activeRow] = await Promise.all([
    env.DB.prepare('SELECT count FROM link_quota WHERE ip_hash = ?1 AND day = ?2')
      .bind(ipHash, day)
      .first(),
    env.DB.prepare(
      'SELECT COUNT(*) AS n FROM links WHERE ip_hash = ?1 AND blocked = 0 AND expires_at > ?2'
    )
      .bind(ipHash, now)
      .first()
  ]);
  return json({
    ok: true,
    day,
    timezone: tz,
    quota: quotaPayload(dailyRow?.count || 0, activeRow?.n || 0, limits)
  });
}

function getConfig(env, url) {
  const limits = readLimits(env);
  const turnstileSiteKey = String(env.TURNSTILE_SITE_KEY || '').trim();
  const turnstileSecret = String(env.TURNSTILE_SECRET || '').trim();
  return json({
    ok: true,
    brand: '简链',
    origin: getPublicOrigin(env, url),
    host: url.host,
    timezone: env.TIMEZONE || 'Asia/Shanghai',
    limits,
    ttlOptions: ttlOptions(limits),
    turnstileSiteKey: turnstileSiteKey && turnstileSecret ? turnstileSiteKey : null,
    adminEnabled: Boolean(String(env.ADMIN_TOKEN || '').trim()),
    links: {
      sibling: safeHttpUrl(env.SIBLING_URL),
      blog: safeHttpUrl(env.BLOG_URL),
      repo: safeHttpUrl(env.REPO_URL)
    }
  });
}

async function readJson(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiError(415, '请求格式应为 application/json');
  }
  let text;
  try {
    text = await request.text();
  } catch {
    throw new ApiError(400, '读取请求内容失败');
  }
  if (text.length > 16384) throw new ApiError(413, '请求内容过大');
  if (!text.trim()) throw new ApiError(400, '请求内容为空');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(400, '请求内容不是合法 JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, '请求内容格式不正确');
  }
  return body;
}

async function verifyTurnstile(request, env, token) {
  const secret = String(env.TURNSTILE_SECRET || '').trim();
  if (!secret) return;
  if (!token) throw new ApiError(400, '请先完成人机验证');

  const form = new FormData();
  form.append('secret', secret);
  form.append('response', String(token));
  const ip = getClientIp(request);
  if (ip && ip !== '0.0.0.0') form.append('remoteip', ip);

  let response;
  try {
    response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    throw new ApiError(503, '人机验证暂时不可用，请稍后再试');
  }
  if (!response.ok) throw new ApiError(503, '人机验证暂时不可用，请稍后再试');

  const result = await response.json().catch(() => null);
  if (!result || !result.success) throw new ApiError(400, '人机验证未通过，请刷新后重试');
  if (result.action && result.action !== 'shorten') {
    throw new ApiError(400, '人机验证无效，请刷新后重试');
  }
}

function clampTtl(value, limits) {
  const requested = Number(value);
  let days = limits.defaultTtlDays;
  if (Number.isFinite(requested) && requested > 0) days = Math.round(requested);
  return Math.min(limits.maxTtlDays, Math.max(1, days));
}

function isUniqueViolation(error) {
  const message = String(error?.message || error || '');
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(message);
}

async function refundQuota(env, ipHash, day) {
  try {
    await env.DB.prepare(
      'UPDATE link_quota SET count = CASE WHEN count > 0 THEN count - 1 ELSE 0 END WHERE ip_hash = ?1 AND day = ?2'
    )
      .bind(ipHash, day)
      .run();
  } catch (error) {
    console.error('quota refund failed', error);
  }
}

async function createLink(request, env, url, ipHash) {
  const body = await readJson(request);
  await verifyTurnstile(request, env, body.turnstileToken);

  const limits = readLimits(env);
  if (limits.daily === 0) throw new ApiError(429, '本站今日的生成额度已关闭');
  if (limits.active === 0) throw new ApiError(429, '本站暂时不接受新的短链');

  const destination = normalizeDestination(body.url, {
    requestHost: url.host,
    publicOrigin: env.PUBLIC_ORIGIN,
    blockedHosts: env.BLOCKED_HOSTS
  });
  const customSlug = validateSlug(body.slug);
  const ttlDays = clampTtl(body.ttlDays, limits);
  const tz = env.TIMEZONE || 'Asia/Shanghai';
  const now = Date.now();
  const day = dayKey(tz, now);

  if (customSlug) {
    const existing = await env.DB.prepare('SELECT 1 AS hit FROM links WHERE code = ?1')
      .bind(customSlug)
      .first();
    if (existing) throw new ApiError(409, '这个短码已经被占用了，换一个试试');
  }

  const activeRow = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM links WHERE ip_hash = ?1 AND blocked = 0 AND expires_at > ?2'
  )
    .bind(ipHash, now)
    .first();
  const activeUsed = activeRow?.n || 0;
  if (activeUsed >= limits.active) {
    throw new ApiError(429, `你最多同时保留 ${limits.active} 条有效短链，请等旧链接到期后再来`);
  }

  const reserved = await env.DB.prepare(
    `INSERT INTO link_quota (ip_hash, day, count) VALUES (?1, ?2, 1)
     ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1
     WHERE count < ?3
     RETURNING count`
  )
    .bind(ipHash, day, limits.daily)
    .first();

  if (!reserved) {
    throw new ApiError(429, `今天的 ${limits.daily} 条额度已经用完了，明天再来吧`);
  }

  const expiresAt = now + ttlDays * DAY_MS;
  const publicOrigin = getPublicOrigin(env, url);
  const manageKey = randomToken(24);
  const manageHash = await sha256Hex(manageKey);
  let code = customSlug || '';
  let inserted = false;

  try {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (!customSlug) code = randomCode(7);
      try {
        await env.DB.prepare(
          `INSERT INTO links
            (code, url, created_at, created_day, expires_at, clicks, last_click_at, blocked, ip_hash, manage_hash)
           VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, 0, ?6, ?7)`
        )
          .bind(code, destination, now, day, expiresAt, ipHash, manageHash)
          .run();
        inserted = true;
        break;
      } catch (error) {
        if (isUniqueViolation(error)) {
          if (customSlug) {
            await refundQuota(env, ipHash, day);
            throw new ApiError(409, '这个短码已经被占用了，换一个试试');
          }
          continue;
        }
        await refundQuota(env, ipHash, day);
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw error;
  }

  if (!inserted) {
    await refundQuota(env, ipHash, day);
    throw new ApiError(503, '短码生成失败，请稍后再试');
  }

  const dailyUsed = reserved.count || 0;
  return json(
    {
      ok: true,
      link: {
        code,
        url: destination,
        shortUrl: `${publicOrigin}/${code}`,
        statsUrl: `${publicOrigin}/${code}+`,
        createdAt: now,
        expiresAt,
        ttlDays
      },
      manageKey,
      quota: quotaPayload(dailyUsed, activeUsed + 1, limits)
    },
    201
  );
}

async function lookupLinks(request, env, url) {
  const body = await readJson(request);
  const input = Array.isArray(body.codes) ? body.codes : [];
  const codes = [
    ...new Set(
      input.filter((code) => typeof code === 'string' && CODE_RE.test(code)).slice(0, 50)
    )
  ];
  if (codes.length === 0) return json({ ok: true, items: [] });

  const placeholders = codes.map((_, index) => `?${index + 1}`).join(', ');
  const rows = await env.DB.prepare(
    `SELECT code, url, created_at, expires_at, clicks, last_click_at, blocked
     FROM links WHERE code IN (${placeholders})`
  )
    .bind(...codes)
    .all();

  const now = Date.now();
  const publicOrigin = getPublicOrigin(env, url);
  const byCode = new Map((rows.results || []).map((row) => [row.code, row]));
  return json({
    ok: true,
    items: codes.map((code) => {
      const row = byCode.get(code);
      if (!row) return { code, exists: false };
      return {
        code,
        exists: true,
        url: row.url,
        shortUrl: `${publicOrigin}/${code}`,
        statsUrl: `${publicOrigin}/${code}+`,
        clicks: row.clicks,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastClickAt: row.last_click_at,
        blocked: Boolean(row.blocked),
        status: row.blocked ? 'blocked' : row.expires_at <= now ? 'expired' : 'active'
      };
    })
  });
}

async function deleteLink(request, env, code) {
  if (!CODE_RE.test(code)) throw new ApiError(404, '短链不存在');
  const key = request.headers.get('X-Manage-Key') || '';
  if (!key) throw new ApiError(401, '缺少管理密钥');

  const row = await env.DB.prepare('SELECT manage_hash FROM links WHERE code = ?1')
    .bind(code)
    .first();
  if (!row) throw new ApiError(404, '短链不存在');

  const hash = await sha256Hex(key);
  if (!timingSafeEqual(hash, row.manage_hash || '')) {
    throw new ApiError(403, '管理密钥不正确');
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM link_clicks_daily WHERE code = ?1').bind(code),
    env.DB.prepare('DELETE FROM links WHERE code = ?1').bind(code)
  ]);
  return json({ ok: true, code });
}

async function getStats(env, code, url) {
  if (!CODE_RE.test(code)) throw new ApiError(404, '短链不存在');
  const row = await env.DB.prepare(
    'SELECT code, url, created_at, expires_at, clicks, last_click_at, blocked FROM links WHERE code = ?1'
  )
    .bind(code)
    .first();
  if (!row) throw new ApiError(404, '短链不存在');

  const now = Date.now();
  const tz = env.TIMEZONE || 'Asia/Shanghai';
  const days = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    days.push(dayKey(tz, now - offset * DAY_MS));
  }
  const rows = await env.DB.prepare(
    'SELECT day, count FROM link_clicks_daily WHERE code = ?1 AND day >= ?2 ORDER BY day ASC'
  )
    .bind(code, days[0])
    .all();
  const counts = new Map((rows.results || []).map((item) => [item.day, item.count]));

  return json({
    ok: true,
    link: {
      ...row,
      blocked: Boolean(row.blocked),
      status: row.blocked ? 'blocked' : row.expires_at <= now ? 'expired' : 'active',
      shortUrl: `${getPublicOrigin(env, url)}/${row.code}`
    },
    timezone: tz,
    daily: days.map((day) => ({ day, count: counts.get(day) || 0 }))
  });
}

function requireAdmin(request, env) {
  const expected = String(env.ADMIN_TOKEN || '').trim();
  if (!expected) throw new ApiError(404, '管理功能未开启');
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !timingSafeEqual(token, expected)) {
    throw new ApiError(401, '管理令牌不正确');
  }
}

async function adminOverview(env, url) {
  const tz = env.TIMEZONE || 'Asia/Shanghai';
  const day = dayKey(tz);
  const query = String(url.searchParams.get('q') || '').trim().slice(0, 120);
  const listSql = `SELECT code, url, created_at, expires_at, clicks, last_click_at, blocked
    FROM links
    ${query ? 'WHERE code LIKE ?1 OR url LIKE ?1' : ''}
    ORDER BY created_at DESC LIMIT 40`;
  const statement = query
    ? env.DB.prepare(listSql).bind(`%${query}%`)
    : env.DB.prepare(listSql);

  const [rows, totalRow, activeRow, todayLinksRow, todayClicksRow] = await Promise.all([
    statement.all(),
    env.DB.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(clicks), 0) AS clicks FROM links').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM links WHERE blocked = 0 AND expires_at > ?1')
      .bind(Date.now())
      .first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM links WHERE created_day = ?1').bind(day).first(),
    env.DB.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM link_clicks_daily WHERE day = ?1')
      .bind(day)
      .first()
  ]);

  return json({
    ok: true,
    day,
    timezone: tz,
    stats: {
      totalLinks: totalRow?.total || 0,
      totalClicks: totalRow?.clicks || 0,
      activeLinks: activeRow?.n || 0,
      todayLinks: todayLinksRow?.n || 0,
      todayClicks: todayClicksRow?.n || 0
    },
    links: rows.results || []
  });
}

const ADMIN_ACTIONS = new Set(['block', 'unblock', 'delete']);

async function adminAction(request, env, code) {
  if (!CODE_RE.test(code)) throw new ApiError(404, '短链不存在');
  const body = await readJson(request);
  const action = String(body.action || '');
  if (!ADMIN_ACTIONS.has(action)) throw new ApiError(400, '未知操作');

  if (action === 'delete') {
    const result = await env.DB.batch([
      env.DB.prepare('DELETE FROM link_clicks_daily WHERE code = ?1').bind(code),
      env.DB.prepare('DELETE FROM links WHERE code = ?1').bind(code)
    ]);
    if (!result[1]?.meta?.changes) throw new ApiError(404, '短链不存在');
    return json({ ok: true, code, action });
  }

  const result = await env.DB.prepare('UPDATE links SET blocked = ?1 WHERE code = ?2')
    .bind(action === 'block' ? 1 : 0, code)
    .run();
  if (!result.meta?.changes) throw new ApiError(404, '短链不存在');
  return json({ ok: true, code, action });
}
