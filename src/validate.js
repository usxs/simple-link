import { ApiError } from './http.js';

export const RESERVED_SLUGS = new Set([
  'api',
  'admin',
  'assets',
  'app',
  'static',
  'stats',
  'health',
  'login',
  'logout',
  'signin',
  'signup',
  'dashboard',
  'settings',
  'help',
  'about',
  'terms',
  'privacy',
  'security',
  'abuse',
  'report',
  'index',
  'home',
  'www',
  'mail',
  'url',
  'link',
  'links',
  'favicon',
  'favicon.ico',
  'favicon.svg',
  'robots.txt',
  'sitemap.xml',
  'style.css',
  'theme.js',
  'app.js',
  'admin.js',
  'admin.html',
  'index.html',
  '404',
  '500',
  '_headers',
  '_redirects'
]);

const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan'];

export function normalizeDestination(input, { requestHost, publicOrigin, blockedHosts } = {}) {
  let raw = String(input ?? '').trim();
  if (!raw) throw new ApiError(400, '请填写要缩短的链接');
  if (raw.length > 4096) throw new ApiError(400, '链接太长了，请控制在 4096 个字符以内');

  // 用户常常只粘贴 example.com/path，补一个 https://
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    if (/^[a-zA-Z0-9[\]](?:[a-zA-Z0-9\u00a1-\uffff._~%!$&'()*+,;=:@[\]-]*)\.?/.test(raw)) {
      raw = 'https://' + raw.replace(/^\/\//, '');
    }
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ApiError(400, '链接格式不正确，请检查后重试');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError(400, '只支持 http 或 https 链接');
  }
  if (!parsed.hostname) throw new ApiError(400, '链接缺少域名');
  if (parsed.username || parsed.password) {
    throw new ApiError(400, '链接中不能包含账号或密码');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isPrivateHost(hostname)) {
    throw new ApiError(400, '不能缩短内网或本机地址');
  }

  const selfHosts = new Set();
  if (requestHost) selfHosts.add(requestHost.toLowerCase());
  if (publicOrigin) {
    try {
      selfHosts.add(new URL(publicOrigin).host.toLowerCase());
    } catch {
      /* 忽略无效的 PUBLIC_ORIGIN */
    }
  }
  if (selfHosts.has(parsed.host.toLowerCase())) {
    throw new ApiError(400, '不能把短链指向它自己');
  }

  const blocked = String(blockedHosts || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (blocked.some((item) => hostname === item || hostname.endsWith('.' + item))) {
    throw new ApiError(400, '该域名不允许使用本服务');
  }

  if (parsed.href.length > 4096) {
    throw new ApiError(400, '链接太长了，请控制在 4096 个字符以内');
  }

  return parsed.href;
}

export function validateSlug(input) {
  const slug = String(input ?? '').trim();
  if (!slug) return '';
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(slug)) {
    throw new ApiError(400, '自定义短码需为 3–32 位字母、数字、- 或 _');
  }
  if (RESERVED_SLUGS.has(slug.toLowerCase())) {
    throw new ApiError(409, '这个短码是系统保留字，请换一个');
  }
  return slug;
}

export function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (host === 'metadata.google.internal' || host === 'metadata.goog' || host === 'instance-data') {
    return true;
  }
  if (host.includes(':')) return isPrivateIpv6(host);
  return isPrivateIpv4(host);
}

function isPrivateIpv4(host) {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [a, b, c] = match.slice(1).map(Number);
  if ([a, b, c, Number(match[4])].some((part) => part > 255)) return false;

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(host) {
  const value = host.replace(/^\[|\]$/g, '');
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd')) return true;
  if (value.startsWith('::ffff:')) {
    return isPrivateIpv4(value.slice(7));
  }
  return false;
}
