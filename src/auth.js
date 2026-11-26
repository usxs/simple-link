import { randomToken, sha256Hex, timingSafeEqual } from './util.js';

export const ADMIN_COOKIE = 'sl_admin';
export const OWNER_COOKIE = 'sl_owner';
export const PK_COOKIE = 'sl_pk';
export const ADMIN_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;
export const OWNER_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
export const SESSION_TTL_MS = ADMIN_COOKIE_MAX_AGE * 1000;

const encoder = new TextEncoder();

export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return '';
    }
  }
  return '';
}

export function cookieSecure(request) {
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return true;
  }
}

export function getBlogOrigin(env) {
  const raw = String(env.BLOG_ORIGIN || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

export function ssoEnabled(env) {
  const flag = String(env.BLOG_SSO_ENABLED || '').trim().toLowerCase();
  return (
    (flag === '1' || flag === 'true' || flag === 'yes') &&
    Boolean(getBlogOrigin(env)) &&
    Boolean(String(env.BLOG_SSO_SECRET || '').trim())
  );
}

export function sessionSecret(env) {
  return String(
    env.SESSION_SECRET ||
      env.ADMIN_TOKEN ||
      env.ADMIN_PASSWORD ||
      ''
  ).trim();
}

export async function hmacSign(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(String(value)));
  return base64url(new Uint8Array(signature));
}

export async function hmacVerify(secret, value, signature) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  try {
    return await crypto.subtle.verify(
      'HMAC',
      key,
      fromBase64url(signature),
      encoder.encode(String(value))
    );
  } catch {
    return false;
  }
}

export function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function fromBase64url(value) {
  const raw = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function adminCookieHeader(request, token) {
  const secure = cookieSecure(request) ? '; Secure' : '';
  return (
    ADMIN_COOKIE +
    '=' +
    encodeURIComponent(token) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' +
    ADMIN_COOKIE_MAX_AGE +
    secure
  );
}

export function clearAdminCookieHeader(request) {
  const secure = cookieSecure(request) ? '; Secure' : '';
  return ADMIN_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + secure;
}

export function ownerCookieHeader(request, key) {
  const secure = cookieSecure(request) ? '; Secure' : '';
  return (
    OWNER_COOKIE +
    '=' +
    encodeURIComponent(key) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' +
    OWNER_COOKIE_MAX_AGE +
    secure
  );
}

export function clearOwnerCookieHeader(request) {
  const secure = cookieSecure(request) ? '; Secure' : '';
  return OWNER_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + secure;
}

export function pkCookieHeader(request, value) {
  const secure = cookieSecure(request) ? '; Secure' : '';
  return (
    PK_COOKIE +
    '=' +
    encodeURIComponent(value) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=300' +
    secure
  );
}

export function clearPkCookieHeader(request) {
  const secure = cookieSecure(request) ? '; Secure' : '';
  return PK_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + secure;
}

export function adminPasswordConfigured(env) {
  return Boolean(String(env.ADMIN_PASSWORD || '').trim());
}

export function adminTokenConfigured(env) {
  return Boolean(String(env.ADMIN_TOKEN || '').trim());
}

export async function getAuthConfig(env) {
  let passkeys = 0;
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_passkeys').first();
    passkeys = Number(row?.n || 0);
  } catch {
    passkeys = 0;
  }
  const password = adminPasswordConfigured(env);
  const token = adminTokenConfigured(env);
  const sso = ssoEnabled(env);
  const passkey = passkeys > 0;
  return {
    enabled: password || token || sso || passkey,
    password,
    token,
    passkey,
    passkeyCount: passkeys,
    sso,
    username: String(env.ADMIN_USERNAME || 'admin')
  };
}

async function issueSession(env, request, method, username) {
  const secret = sessionSecret(env);
  if (!secret) throw new Error('missing session secret');
  const now = Date.now();
  const sid = randomToken(18);
  const exp = now + SESSION_TTL_MS;
  await env.DB.prepare(
    'INSERT INTO admin_sessions (id, method, username, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)'
  )
    .bind(sid, method, String(username || ''), now, exp)
    .run();
  const payload = base64url(
    encoder.encode(JSON.stringify({ sid, method, username: String(username || ''), exp }))
  );
  const signature = await hmacSign(secret, payload);
  const token = payload + '.' + signature;
  return {
    token,
    session: { mode: method, username: String(username || '') },
    cookie: adminCookieHeader(request, token)
  };
}

async function verifySession(request, env) {
  const secret = sessionSecret(env);
  if (!secret) return null;
  const token = readCookie(request, ADMIN_COOKIE);
  if (!token || token.length > 2048) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const payloadPart = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!(await hmacVerify(secret, payloadPart, signature))) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64url(payloadPart)));
  } catch {
    return null;
  }
  if (!payload || typeof payload.sid !== 'string' || !Number.isFinite(payload.exp)) return null;
  if (payload.exp < Date.now()) return null;
  const row = await env.DB.prepare(
    'SELECT id, method, username, expires_at FROM admin_sessions WHERE id = ?1'
  )
    .bind(payload.sid)
    .first();
  if (!row || row.expires_at < Date.now()) return null;
  return { mode: row.method || 'session', username: row.username || '' };
}

export async function authenticateAdmin(request, env) {
  const expected = String(env.ADMIN_TOKEN || '').trim();
  const header = request.headers.get('Authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (expected && bearer && timingSafeEqual(bearer, expected)) {
    return { mode: 'token', username: '管理令牌' };
  }
  return verifySession(request, env);
}

export async function loginWithPassword(request, env, username, password) {
  if (!adminPasswordConfigured(env)) return null;
  const expectedUser = String(env.ADMIN_USERNAME || 'admin').trim() || 'admin';
  const expectedPassword = String(env.ADMIN_PASSWORD || '').trim();
  const userOk = timingSafeEqual(
    await sha256Hex(String(username || '').trim()),
    await sha256Hex(expectedUser)
  );
  const passOk = timingSafeEqual(
    await sha256Hex(String(password || '')),
    await sha256Hex(expectedPassword)
  );
  if (!userOk || !passOk) return null;
  return issueSession(env, request, 'password', expectedUser);
}

export async function loginWithPasskey(request, env, username) {
  return issueSession(env, request, 'passkey', username || String(env.ADMIN_USERNAME || 'admin'));
}

export async function loginWithBlog(request, env, username) {
  return issueSession(env, request, 'blog', username || '简单博客');
}

export async function destroyAdminSession(request, env) {
  const token = readCookie(request, ADMIN_COOKIE);
  if (token && token.length <= 2048) {
    const dot = token.lastIndexOf('.');
    if (dot > 0) {
      try {
        const payload = JSON.parse(
          new TextDecoder().decode(fromBase64url(token.slice(0, dot)))
        );
        if (payload?.sid) {
          await env.DB.prepare('DELETE FROM admin_sessions WHERE id = ?1')
            .bind(payload.sid)
            .run();
        }
      } catch {
        /* ignore malformed cookie */
      }
    }
  }
  return clearAdminCookieHeader(request);
}

export async function makeChallengeCookie(request, env) {
  const secret = sessionSecret(env);
  if (!secret) return null;
  const challenge = randomToken(32);
  const exp = Date.now() + 5 * 60 * 1000;
  const value = challenge + '.' + exp;
  const signature = await hmacSign(secret, value);
  return {
    challenge,
    cookie: pkCookieHeader(request, value + '.' + signature)
  };
}

export async function readChallengeCookie(request, env) {
  const secret = sessionSecret(env);
  if (!secret) return null;
  const raw = readCookie(request, PK_COOKIE);
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [challenge, expRaw, signature] = parts;
  if (!(await hmacVerify(secret, challenge + '.' + expRaw, signature))) return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  return challenge;
}

export async function ownerHashFromKey(key) {
  return sha256Hex('owner|' + String(key || ''));
}

export async function getOwnerKey(request) {
  const header = request.headers.get('X-Owner-Key') || '';
  const key = header || readCookie(request, OWNER_COOKIE);
  if (!key || key.length < 24 || key.length > 128) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return '';
  return key;
}

export async function ownerContext(request) {
  const key = await getOwnerKey(request);
  return key ? { key, hash: await ownerHashFromKey(key) } : null;
}
