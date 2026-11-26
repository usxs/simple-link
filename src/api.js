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
import {
  authenticateAdmin,
  base64url,
  clearAdminCookieHeader,
  clearOwnerCookieHeader,
  clearPkCookieHeader,
  destroyAdminSession,
  getAuthConfig,
  getBlogOrigin,
  loginWithBlog,
  loginWithPasskey,
  loginWithPassword,
  makeChallengeCookie,
  ownerContext,
  ownerCookieHeader,
  ownerHashFromKey,
  readChallengeCookie,
  ssoEnabled
} from './auth.js';
import {
  originFor,
  rpIdFor,
  verifyAssertion,
  verifyRegistration
} from './passkeys.js';
import { normalizeDestination, validateSlug } from './validate.js';

const CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const DAY_MS = 86400000;
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_MAX_FAILURES = 10;

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

  if (route === 'manage') {
    if (segments[2] === 'session' && method === 'POST') {
      return manageLogin(request, env);
    }
    if (segments[2] === 'logout' && method === 'POST') {
      return manageLogout(request);
    }
    if (segments[2] === 'links' && segments.length === 3 && readOnly) {
      return manageLinks(request, env, url);
    }
    if (segments[2] === 'links' && segments.length === 4 && method === 'POST') {
      return manageAction(request, env, segments[3]);
    }
  }

  if (route === 'admin') {
    if (segments[2] === 'session' && readOnly) {
      return adminSession(request, env);
    }
    if (segments[2] === 'login' && method === 'POST') {
      return adminLogin(request, env);
    }
    if (segments[2] === 'logout' && method === 'POST') {
      return adminLogout(request, env);
    }
    if (segments[2] === 'overview' && readOnly) {
      await requireAdmin(request, env);
      return adminOverview(env, url);
    }
    if (segments[2] === 'links' && segments.length === 4 && method === 'POST') {
      await requireAdmin(request, env);
      return adminAction(request, env, segments[3]);
    }
    if (segments[2] === 'passkeys') {
      return handlePasskeysRoute(request, env, url, segments, method, readOnly);
    }
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

async function getConfig(env, url) {
  const limits = readLimits(env);
  const turnstileSiteKey = String(env.TURNSTILE_SITE_KEY || '').trim();
  const turnstileSecret = String(env.TURNSTILE_SECRET || '').trim();
  const auth = await getAuthConfig(env);
  const ssoOrigin = safeHttpUrl(env.BLOG_SSO_ORIGIN) || getBlogOrigin(env);
  const methods = [];
  if (auth.password) methods.push('password');
  if (auth.token) methods.push('token');
  if (auth.passkey) methods.push('passkey');
  if (auth.sso) methods.push('blog');
  return json({
    ok: true,
    brand: '简链',
    origin: getPublicOrigin(env, url),
    host: url.host,
    timezone: env.TIMEZONE || 'Asia/Shanghai',
    limits,
    ttlOptions: ttlOptions(limits),
    turnstileSiteKey: turnstileSiteKey && turnstileSecret ? turnstileSiteKey : null,
    adminEnabled: auth.enabled,
    adminAuth: {
      password: auth.password,
      token: auth.token,
      passkey: auth.passkey,
      passkeyCount: auth.passkeyCount,
      blog: auth.sso,
      sso: auth.sso,
      auto: false,
      ssoUrl: auth.sso && ssoOrigin ? new URL(ssoOrigin).origin + '/__simple_link_sso' : '',
      methods,
      defaultMethod: methods[0] || ''
    },
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
  if (text.length > 32768) throw new ApiError(413, '请求内容过大');
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
  // Cloudflare 的公开测试密钥不会返回 action；仅测试模式放行，生产密钥不会出现该标记。
  const testToken = Boolean(result.metadata && result.metadata.result_with_testing_key);
  if (!testToken && result.action !== 'shorten') {
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

  const owner = await ownerContext(request);
  const ownerKey = owner?.key || randomToken(24);
  const newlyIssuedOwner = !owner;
  const ownerHash = owner?.hash || (await ownerHashFromKey(ownerKey));

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
    throw new ApiError(429, '你最多同时保留 ' + limits.active + ' 条有效短链，请等旧链接到期后再来');
  }

  const reserved = await env.DB.prepare(
    'INSERT INTO link_quota (ip_hash, day, count) VALUES (?1, ?2, 1) ' +
      'ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1 ' +
      'WHERE count < ?3 RETURNING count'
  )
    .bind(ipHash, day, limits.daily)
    .first();

  if (!reserved) {
    throw new ApiError(429, '今天的 ' + limits.daily + ' 条额度已经用完了，明天再来吧');
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
          'INSERT INTO links ' +
            '(code, url, created_at, created_day, expires_at, clicks, last_click_at, blocked, ip_hash, manage_hash, owner_hash) ' +
            'VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, 0, ?6, ?7, ?8)'
        )
          .bind(code, destination, now, day, expiresAt, ipHash, manageHash, ownerHash)
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
  const result = {
    ok: true,
    link: {
      code,
      url: destination,
      shortUrl: publicOrigin + '/' + code,
      statsUrl: publicOrigin + '/' + code + '+',
      createdAt: now,
      expiresAt,
      ttlDays
    },
    manageKey,
    quota: quotaPayload(dailyUsed, activeUsed + 1, limits)
  };
  if (newlyIssuedOwner) result.ownerKey = ownerKey;

  return json(result, 201, {
    'Set-Cookie': ownerCookieHeader(request, ownerKey)
  });
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

  const placeholders = codes.map((_, index) => '?' + (index + 1)).join(', ');
  const rows = await env.DB.prepare(
    'SELECT code, url, created_at, expires_at, clicks, last_click_at, blocked ' +
      'FROM links WHERE code IN (' + placeholders + ')'
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
        shortUrl: publicOrigin + '/' + code,
        statsUrl: publicOrigin + '/' + code + '+',
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

  await removeLink(env, code);
  return json({ ok: true, code });
}

async function removeLink(env, code) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM link_clicks_daily WHERE code = ?1').bind(code),
    env.DB.prepare('DELETE FROM links WHERE code = ?1').bind(code)
  ]);
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
      shortUrl: getPublicOrigin(env, url) + '/' + row.code
    },
    timezone: tz,
    daily: days.map((day) => ({ day, count: counts.get(day) || 0 }))
  });
}

async function manageLogin(request, env) {
  const body = await readJson(request);
  const key = String(body.key || body.ownerKey || '').trim();
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(key)) {
    throw new ApiError(400, '管理密钥格式不正确');
  }
  const hash = await ownerHashFromKey(key);
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM links WHERE owner_hash = ?1'
  )
    .bind(hash)
    .first();
  if (!row?.n) throw new ApiError(401, '没有找到这个管理密钥对应的短链');

  return json(
    { ok: true, authed: true, count: row.n },
    200,
    { 'Set-Cookie': ownerCookieHeader(request, key) }
  );
}

async function manageLogout(request) {
  return json({ ok: true }, 200, { 'Set-Cookie': clearOwnerCookieHeader(request) });
}

async function manageLinks(request, env, url) {
  const owner = await ownerContext(request);
  if (!owner) throw new ApiError(401, '请先输入管理密钥');
  const rows = await env.DB.prepare(
    'SELECT code, url, created_at, expires_at, clicks, last_click_at, blocked ' +
      'FROM links WHERE owner_hash = ?1 ORDER BY created_at DESC LIMIT 100'
  )
    .bind(owner.hash)
    .all();
  const links = rows.results || [];
  const now = Date.now();
  const totalClicks = links.reduce((sum, row) => sum + Number(row.clicks || 0), 0);
  const active = links.filter((row) => !row.blocked && row.expires_at > now).length;
  return json({
    ok: true,
    origin: getPublicOrigin(env, url),
    stats: {
      total: links.length,
      active,
      clicks: totalClicks
    },
    links
  });
}

async function manageAction(request, env, code) {
  if (!CODE_RE.test(code)) throw new ApiError(404, '短链不存在');
  const owner = await ownerContext(request);
  if (!owner) throw new ApiError(401, '请先输入管理密钥');
  const body = await readJson(request);
  const action = String(body.action || '');
  if (!['delete', 'block', 'unblock'].includes(action)) throw new ApiError(400, '未知操作');

  const row = await env.DB.prepare(
    'SELECT code, owner_hash FROM links WHERE code = ?1'
  )
    .bind(code)
    .first();
  if (!row) throw new ApiError(404, '短链不存在');
  if (!timingSafeEqual(String(row.owner_hash || ''), owner.hash)) {
    throw new ApiError(403, '这条短链不属于当前管理密钥');
  }

  if (action === 'delete') {
    await removeLink(env, code);
    return json({ ok: true, code, action });
  }
  await env.DB.prepare('UPDATE links SET blocked = ?1 WHERE code = ?2')
    .bind(action === 'block' ? 1 : 0, code)
    .run();
  return json({ ok: true, code, action });
}

async function adminRateLimited(request, env) {
  const ipHash = await getIpHash(request, env);
  const since = Date.now() - ADMIN_LOGIN_WINDOW_MS;
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM admin_login_attempts WHERE ip_hash = ?1 AND ts >= ?2'
  )
    .bind(ipHash, since)
    .first();
  return { ipHash, limited: Number(row?.n || 0) >= ADMIN_LOGIN_MAX_FAILURES };
}

async function recordAdminFailure(env, ipHash) {
  await env.DB.prepare('INSERT INTO admin_login_attempts (ip_hash, ts) VALUES (?1, ?2)')
    .bind(ipHash, Date.now())
    .run();
}

async function clearAdminFailures(env, ipHash) {
  await env.DB.prepare('DELETE FROM admin_login_attempts WHERE ip_hash = ?1')
    .bind(ipHash)
    .run();
}

async function adminSession(request, env) {
  const auth = await authenticateAdmin(request, env);
  if (!auth) throw new ApiError(401, '请先登录');
  const config = await getAuthConfig(env);
  return json({
    ok: true,
    authed: true,
    mode: auth.mode,
    username: auth.username,
    passkey: config.passkey,
    password: config.password,
    token: config.token,
    sso: config.sso
  });
}

async function adminLogin(request, env) {
  const config = await getAuthConfig(env);
  if (!config.password) throw new ApiError(404, '没有配置管理员账密');

  const rate = await adminRateLimited(request, env);
  if (rate.limited) throw new ApiError(429, '尝试次数过多，请 15 分钟后再试');

  const body = await readJson(request);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || username.length > 128) throw new ApiError(400, '请输入管理员用户名');
  if (!password || password.length > 256) throw new ApiError(400, '请输入管理员密码');

  const result = await loginWithPassword(request, env, username, password);
  if (!result) {
    await recordAdminFailure(env, rate.ipHash);
    throw new ApiError(401, '用户名或密码不正确');
  }
  await clearAdminFailures(env, rate.ipHash);
  return json(
    { ok: true, authed: true, mode: result.session.mode, username: result.session.username },
    200,
    { 'Set-Cookie': result.cookie }
  );
}

async function adminLogout(request, env) {
  const cookie = await destroyAdminSession(request, env);
  const headers = { 'Set-Cookie': [cookie] };
  if (ssoEnabled(env)) {
    const origin = getBlogOrigin(env);
    if (origin) {
      headers['Set-Cookie'].push(
        'console_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
      );
    }
  }
  return json({ ok: true }, 200, headers);
}

async function requireAdmin(request, env) {
  const auth = await authenticateAdmin(request, env);
  if (!auth) throw new ApiError(401, '请先登录');
  return auth;
}

async function handlePasskeysRoute(request, env, url, segments, method, readOnly) {
  if (segments.length === 3 && readOnly) {
    await requireAdmin(request, env);
    return listPasskeys(env);
  }

  if (segments[3] === 'register' && segments[4] === 'options' && method === 'POST') {
    await requireAdmin(request, env);
    return passkeyRegisterOptions(request, env);
  }

  if (segments[3] === 'register' && segments.length === 4 && method === 'POST') {
    await requireAdmin(request, env);
    return passkeyRegisterFinish(request, env);
  }

  if (segments[3] === 'login' && segments[4] === 'options' && method === 'POST') {
    return passkeyLoginOptions(request, env);
  }

  if (segments[3] === 'login' && segments.length === 4 && method === 'POST') {
    return passkeyLoginFinish(request, env);
  }

  if (segments.length === 4 && method === 'DELETE') {
    await requireAdmin(request, env);
    return deletePasskey(env, segments[3]);
  }

  throw new ApiError(404, '接口不存在');
}

async function listPasskeys(env) {
  const rows = await env.DB.prepare(
    'SELECT id, name, created_at, last_used_at FROM admin_passkeys ORDER BY created_at ASC'
  ).all();
  return json({ ok: true, passkeys: rows.results || [] });
}

async function passkeyRegisterOptions(request, env) {
  const challenge = await makeChallengeCookie(request, env);
  if (!challenge) throw new ApiError(503, '没有配置会话密钥，暂时不能添加通行密钥');
  const rpId = rpIdFor(env, request);
  const existing = await env.DB.prepare('SELECT id FROM admin_passkeys').all();
  const userId = base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('simple-link-admin')))
  ).slice(0, 32);
  return json(
    {
      ok: true,
      options: {
        challenge: challenge.challenge,
        rp: { name: '简链', id: rpId },
        user: { id: userId, name: 'admin', displayName: '简链管理员' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        timeout: 60000,
        attestation: 'none',
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'preferred'
        },
        excludeCredentials: (existing.results || []).map((row) => ({
          type: 'public-key',
          id: row.id
        }))
      }
    },
    200,
    { 'Set-Cookie': challenge.cookie }
  );
}

async function passkeyRegisterFinish(request, env) {
  const challenge = await readChallengeCookie(request, env);
  if (!challenge) throw new ApiError(400, '验证已过期，请重新开始');
  const body = await readJson(request);
  let verified;
  try {
    verified = await verifyRegistration({
      attestationObject: String(body.attestationObject || ''),
      clientDataJSON: String(body.clientDataJSON || ''),
      expectedChallenge: challenge,
      rpId: rpIdFor(env, request),
      origin: originFor(env, request)
    });
  } catch (error) {
    throw new ApiError(400, '通行密钥验证失败：' + error.message);
  }
  const name = String(body.name || '通行密钥').trim().slice(0, 40) || '通行密钥';
  const now = Date.now();
  try {
    await env.DB.prepare(
      'INSERT INTO admin_passkeys (id, username, name, public_key, counter, transports, created_at) ' +
        'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
    )
      .bind(
        verified.credentialId,
        String(env.ADMIN_USERNAME || 'admin'),
        name,
        JSON.stringify(verified.publicKey),
        verified.counter,
        String(body.transports || '').slice(0, 120),
        now
      )
      .run();
  } catch (error) {
    if (isUniqueViolation(error)) throw new ApiError(409, '这个通行密钥已经添加过了');
    throw error;
  }
  return json(
    { ok: true, id: verified.credentialId },
    201,
    { 'Set-Cookie': clearPkCookieHeader(request) }
  );
}

async function passkeyLoginOptions(request, env) {
  const rows = await env.DB.prepare('SELECT id FROM admin_passkeys').all();
  const passkeys = rows.results || [];
  if (passkeys.length === 0) throw new ApiError(404, '还没有添加通行密钥');
  const challenge = await makeChallengeCookie(request, env);
  if (!challenge) throw new ApiError(503, '没有配置会话密钥，暂时不能使用通行密钥');
  return json(
    {
      ok: true,
      options: {
        challenge: challenge.challenge,
        rpId: rpIdFor(env, request),
        timeout: 60000,
        userVerification: 'preferred',
        allowCredentials: passkeys.map((row) => ({ type: 'public-key', id: row.id }))
      }
    },
    200,
    { 'Set-Cookie': challenge.cookie }
  );
}

async function passkeyLoginFinish(request, env) {
  const challenge = await readChallengeCookie(request, env);
  if (!challenge) throw new ApiError(400, '验证已过期，请重新开始');
  const body = await readJson(request);
  const id = String(body.id || '');
  if (!id) throw new ApiError(400, '缺少通行密钥标识');
  const row = await env.DB.prepare(
    'SELECT id, username, public_key, counter FROM admin_passkeys WHERE id = ?1'
  )
    .bind(id)
    .first();
  if (!row) throw new ApiError(401, '通行密钥不存在');
  let publicKey;
  try {
    publicKey = JSON.parse(row.public_key);
  } catch {
    throw new ApiError(401, '通行密钥数据损坏');
  }
  let verified;
  try {
    verified = await verifyAssertion({
      credential: { publicKey, counter: Number(row.counter || 0) },
      authenticatorData: String(body.authenticatorData || ''),
      clientDataJSON: String(body.clientDataJSON || ''),
      signature: String(body.signature || ''),
      expectedChallenge: challenge,
      rpId: rpIdFor(env, request),
      origin: originFor(env, request)
    });
  } catch (error) {
    throw new ApiError(401, '通行密钥验证失败：' + error.message);
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE admin_passkeys SET counter = ?1, last_used_at = ?2 WHERE id = ?3')
      .bind(verified.counter, Date.now(), id),
    env.DB.prepare('DELETE FROM admin_login_attempts WHERE ts < ?1')
      .bind(Date.now() - DAY_MS)
  ]);
  const session = await loginWithPasskey(request, env, row.username);
  return json(
    { ok: true, authed: true, mode: session.session.mode, username: session.session.username },
    200,
    {
      'Set-Cookie': [session.cookie, clearPkCookieHeader(request)]
    }
  );
}

async function deletePasskey(env, id) {
  const result = await env.DB.prepare('DELETE FROM admin_passkeys WHERE id = ?1')
    .bind(id)
    .run();
  if (!result.meta?.changes) throw new ApiError(404, '通行密钥不存在');
  return json({ ok: true });
}

async function adminOverview(env, url) {
  const tz = env.TIMEZONE || 'Asia/Shanghai';
  const day = dayKey(tz);
  const query = String(url.searchParams.get('q') || '').trim().slice(0, 120);
  const listSql =
    'SELECT code, url, created_at, expires_at, clicks, last_click_at, blocked, owner_hash ' +
    'FROM links ' +
    (query ? 'WHERE code LIKE ?1 OR url LIKE ?1 ' : '') +
    'ORDER BY created_at DESC LIMIT 40';
  const statement = query
    ? env.DB.prepare(listSql).bind('%' + query + '%')
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
    links: (rows.results || []).map((row) => ({
      ...row,
      owner: Boolean(row.owner_hash)
    }))
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

export async function cleanupAuth(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at < ?1').bind(now),
    env.DB.prepare('DELETE FROM admin_login_attempts WHERE ts < ?1').bind(now - DAY_MS)
  ]);
}
