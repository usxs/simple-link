import { htmlResponse, redirect } from './http.js';

const BLOG_SESSION_COOKIE = 'console_session';
const ADMIN_COOKIE = 'sl_admin';
const ADMIN_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;
const SSO_PATH = '/__simple_link_sso';
const TOKEN_TTL_MS = 2 * 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64url(value) {
  const raw = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function encryptionKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealSsoToken(payload, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(secret);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(JSON.stringify(payload))
  );
  return base64url(iv) + '.' + base64url(new Uint8Array(cipher));
}

export async function openSsoToken(token, secret) {
  try {
    const [ivPart, cipherPart] = String(token || '').split('.');
    if (!ivPart || !cipherPart) return null;
    const key = await encryptionKey(secret);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64url(ivPart) },
      key,
      fromBase64url(cipherPart)
    );
    const payload = JSON.parse(decoder.decode(plain));
    if (!payload || typeof payload !== 'object') return null;
    if (!Number.isFinite(payload.exp) || payload.exp < Date.now()) return null;
    if (!payload.sid || typeof payload.sid !== 'string' || payload.sid.length > 256) return null;
    return {
      sid: payload.sid,
      username: String(payload.username || ''),
      exp: payload.exp
    };
  } catch {
    return null;
  }
}

function blogOrigin(env) {
  const raw = String(env.BLOG_ORIGIN || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

function publicOrigin(env) {
  const raw = String(env.PUBLIC_ORIGIN || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return '';
  }
}

function readCookie(request, name) {
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

function cookieSecure(request) {
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return true;
  }
}

function adminCookieHeader(request, token) {
  const secure = cookieSecure(request) ? '; Secure' : '';
  return ADMIN_COOKIE + '=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + ADMIN_COOKIE_MAX_AGE + secure;
}

async function blogStatus(origin, token) {
  if (!origin || !token || token.length > 256) return null;
  try {
    const response = await fetch(origin + '/api/auth/status', {
      headers: {
        Accept: 'application/json',
        Cookie: BLOG_SESSION_COOKIE + '=' + encodeURIComponent(token)
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data || data.ok !== true || data.authed !== true) return null;
    return { username: String(data.username || '') };
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function signedOutPage(env) {
  const origin = blogOrigin(env);
  const admin = origin + '/admin';
  const retry = origin + SSO_PATH;
  const app = publicOrigin(env);
  const local = app ? app + '/admin?local=1' : '';
  return htmlResponse(`<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>需要先登录简单博客</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #f7f7f8; color: #141416; font-family: -apple-system, BlinkMacSystemFont, "Noto Sans SC", sans-serif; }
  main { width: 100%; max-width: 420px; padding: 28px; background: #fff; border: 1px solid #e4e4e7; border-radius: 12px; }
  p { margin: 0 0 12px; color: #52525b; font-size: 14px; line-height: 1.7; }
  h1 { margin: 0 0 12px; font-size: 22px; letter-spacing: -0.03em; }
  a { display: inline-flex; align-items: center; justify-content: center; height: 42px; padding: 0 16px; border-radius: 8px; background: #18181b; color: #fff; font-size: 13px; font-weight: 500; text-decoration: none; }
  a.secondary { margin-left: 8px; background: #fff; border: 1px solid #e4e4e7; color: #141416; }
  .hint { margin-top: 18px; font-size: 12px; }
  .hint a.text { display: inline; height: auto; padding: 0; background: none; color: #52525b; text-decoration: underline; font-weight: 400; }
  @media (prefers-color-scheme: dark) { body { background: #101012; color: #f4f4f5; } main { background: #161618; border-color: #27272a; } p { color: #a1a1aa; } a { background: #f4f4f5; color: #141416; } a.secondary { background: #161618; border-color: #3f3f46; color: #f4f4f5; } .hint a.text { background: none; color: #a1a1aa; } }
</style>
<main>
  <h1>还差一步</h1>
  <p>这个页面会读取你在「简单博客」的登录状态。现在还没有读到，请先去博客后台登录，再回来继续。</p>
  <p><a href="${escapeHtml(admin)}" target="_top">去登录简单博客</a><a class="secondary" href="${escapeHtml(retry)}" target="_top">已登录，继续</a></p>
  ${local ? '<p class="hint">没有博客账号？<a class="text" href="' + escapeHtml(local) + '" target="_top">使用管理令牌登录</a></p>' : ''}
</main>
</html>`, 401, { noindex: true });
}

export async function handleBlogSso(request, env, url) {
  if (url.pathname !== SSO_PATH) return null;
  const origin = blogOrigin(env);
  const target = publicOrigin(env);
  if (!origin || !target || !String(env.BLOG_SSO_SECRET || '').trim()) {
    return htmlResponse('<!doctype html><meta charset="utf-8"><title>未配置</title><p>单点登录未配置。</p>', 404);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return htmlResponse('<!doctype html><meta charset="utf-8"><title>405</title><p>Method Not Allowed</p>', 405);
  }

  const sid = readCookie(request, BLOG_SESSION_COOKIE);
  if (!sid) return signedOutPage(env);
  const who = await blogStatus(origin, sid);
  if (!who) return signedOutPage(env);

  const token = await sealSsoToken({
    sid,
    username: who.username,
    exp: Date.now() + TOKEN_TTL_MS
  }, String(env.BLOG_SSO_SECRET).trim());

  const destination = new URL('/admin/sso', target);
  destination.searchParams.set('token', token);
  const response = redirect(destination.toString(), 302);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

export async function handleAdminSso(request, env, url) {
  if (url.pathname !== '/admin/sso') return null;
  const secret = String(env.BLOG_SSO_SECRET || '').trim();
  if (!secret) return htmlResponse('<!doctype html><meta charset="utf-8"><title>未配置</title><p>单点登录未配置。</p>', 404);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return htmlResponse('<!doctype html><meta charset="utf-8"><title>405</title><p>Method Not Allowed</p>', 405);
  }

  const payload = await openSsoToken(url.searchParams.get('token'), secret);
  if (!payload) {
    const response = redirect('/admin?error=sso', 302);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }

  const response = redirect('/admin', 302);
  response.headers.append('Set-Cookie', adminCookieHeader(request, payload.sid));
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
