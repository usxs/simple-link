const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "script-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "connect-src 'self' https://challenges.cloudflare.com"
].join('; ');

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function json(data, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (value !== undefined && value !== null) headers.set(key, value);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export function htmlResponse(body, status = 200, { noindex = false } = {}) {
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  if (noindex) headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(body, { status, headers });
}

export function redirect(location, status = 302) {
  return new Response(null, {
    status,
    headers: {
      Location: location,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export function protect(response, { noindex = false } = {}) {
  const out = new Response(response.body, response);
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  out.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  const type = out.headers.get('Content-Type') || '';
  if (type.includes('text/html')) {
    out.headers.set('Content-Security-Policy', CSP);
    out.headers.set('X-Frame-Options', 'DENY');
  }
  if (noindex) out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return out;
}
