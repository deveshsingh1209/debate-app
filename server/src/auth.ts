import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CFG } from './config.ts';

/**
 * Single-user local mode.
 *
 * The server binds 127.0.0.1 by default and holds no accounts. Four guards
 * run on every request, in this order:
 *
 *  1. Host check (DNS rebinding). A page on attacker.example that re-points
 *     its own hostname at 127.0.0.1 reaches this server with
 *     `Host: attacker.example`. Only localhost, 127.0.0.1, [::1], HOST itself
 *     and ALLOWED_HOSTS are served.
 *  2. Origin check. A browser request that carries an Origin (every
 *     cross-site POST, and cross-origin EventSource) must be this server's
 *     own origin: scheme, host and port (sameOrigin below). This is what
 *     protects the SSE stream, which a GET cannot otherwise authenticate
 *     against CSRF.
 *  3. Session gate, only when ACCESS_PASSWORD is set: every /api route but
 *     /api/health, /api/me and /api/auth/* needs a session cookie.
 *  4. CSRF token on every state-changing /api request (POST/PUT/PATCH/
 *     DELETE): the `x-csrf-token` header must match the token GET /api/me
 *     handed this browser. Another origin cannot read that response, so it
 *     cannot forge the header; and a custom header forces a CORS preflight,
 *     which this server never grants.
 *
 * Sessions live in memory: a restart signs you out, and nothing about them
 * touches disk.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export const isLoopback = (host: string) => LOOPBACK.has(host.toLowerCase());

/** The password gate is on whenever a password is configured. */
export const authRequired = () => CFG.accessPassword.length > 0;

const SESSION_COOKIE = 'debate_session';
/** Per process. Binds CSRF tokens to this server run. */
const PROCESS_SECRET = crypto.randomBytes(32);

const sessions = new Map<string, number>(); // session id -> expiry (ms)

function allowedHostnames(): Set<string> {
  const set = new Set(LOOPBACK);
  const h = CFG.host.toLowerCase();
  if (h && h !== '0.0.0.0' && h !== '::') set.add(h);
  for (const a of CFG.allowedHosts) set.add(a);
  return set;
}

/** Hostname out of a Host header or an Origin URL, without the port. */
export function hostnameOf(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  try {
    return new URL(v.includes('://') ? v : `http://${v}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Is this Origin the server's own origin, as the browser reached it?
 *
 * Scheme, host AND port, compared against the request's own Host header (the
 * hostname is already allowlisted by then). Hostname alone was not enough:
 * every other app on localhost (another dev server, a local tool) shares the
 * hostname, so it passed as "same origin". Comparing with Host rather than
 * CFG.port keeps Docker's port mapping and the Vite dev proxy working (their
 * browser-facing port is not the one this process listens on). The scheme is
 * https when the request arrived over TLS, through a proxy that says so
 * (X-Forwarded-Proto; a browser cannot set it cross-origin without a preflight
 * this server never grants). PUBLIC_URL's origin, when set, is accepted as
 * written, for a TLS proxy that sends no X-Forwarded-Proto.
 */
export function sameOrigin(origin: string, hostHeader: string, https: boolean): boolean {
  let o: URL;
  let h: URL;
  try {
    o = new URL(origin.trim());
    h = new URL(`http://${hostHeader.trim()}`);
  } catch {
    return false;
  }
  if (o.protocol !== 'http:' && o.protocol !== 'https:') return false;
  if (o.protocol !== (https ? 'https:' : 'http:')) return false;
  const port = (u: URL, scheme: string) => u.port || (scheme === 'https:' ? '443' : '80');
  return o.hostname.toLowerCase() === h.hostname.toLowerCase() && port(o, o.protocol) === port(h, o.protocol);
}

/** PUBLIC_URL's origin, when set: the address a reverse proxy serves this app at. */
function publicOrigin(): string | null {
  try {
    return CFG.publicUrl ? new URL(CFG.publicUrl).origin : null;
  } catch {
    return null;
  }
}

function originAllowed(req: FastifyRequest, origin: string): boolean {
  if (origin === 'null') return false;
  const pub = publicOrigin();
  if (pub && origin.trim().toLowerCase() === pub.toLowerCase()) return true;
  const fwd = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  const https = req.protocol === 'https' || fwd === 'https';
  return sameOrigin(origin, String(req.headers.host ?? ''), https);
}

/**
 * Normalise a URL path before any decision is made on it. Strips query and
 * fragment, decodes repeatedly (so double-encoding cannot hide a segment),
 * folds backslashes and duplicate slashes, and resolves `.` and `..`.
 */
export function normalizePath(rawUrl: string): string {
  let p = rawUrl.split(/[?#]/)[0] ?? '';
  for (let i = 0; i < 3; i++) {
    try {
      const d = decodeURIComponent(p);
      if (d === p) break;
      p = d;
    } catch {
      break;
    }
  }
  p = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

const PUBLIC_API = new Set(['/api/health', '/api/me', '/api/auth/login', '/api/auth/logout']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function cookieValue(req: FastifyRequest, name: string): string | undefined {
  return (req as any).cookies?.[name];
}

function sessionId(req: FastifyRequest): string | null {
  const sid = cookieValue(req, SESSION_COOKIE);
  if (!sid) return null;
  const exp = sessions.get(sid);
  if (!exp) return null;
  if (exp < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  return sid;
}

export function isSignedIn(req: FastifyRequest): boolean {
  return !authRequired() || sessionId(req) !== null;
}

/**
 * CSRF token for this browser: bound to its session when the password gate
 * is on, else to this server process. Only ever handed out by GET /api/me.
 */
export function csrfToken(req: FastifyRequest): string {
  const binding = authRequired() ? (sessionId(req) ?? 'anonymous') : 'local';
  return crypto.createHmac('sha256', PROCESS_SECRET).update(`csrf:${binding}`).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** onRequest hook: host, origin, session, CSRF. */
export async function guard(req: FastifyRequest, reply: FastifyReply) {
  const allowed = allowedHostnames();

  const host = hostnameOf(String(req.headers.host ?? ''));
  if (!host || !allowed.has(host)) {
    return reply.code(421).type('text/plain').send('Unrecognised Host header. Add it to ALLOWED_HOSTS if you meant to reach this server by that name.');
  }

  const origin = req.headers.origin;
  if (origin !== undefined && !originAllowed(req, String(origin))) {
    return reply.code(403).send({ error: 'cross-origin request refused' });
  }

  const p = normalizePath(req.url);
  if (!p.startsWith('/api/') && p !== '/api') return; // the static app shell holds no data

  if (authRequired() && !PUBLIC_API.has(p) && !sessionId(req)) {
    return reply.code(401).send({ error: 'sign in first' });
  }

  if (!SAFE_METHODS.has(req.method) && p !== '/api/auth/login') {
    const sent = String(req.headers['x-csrf-token'] ?? '');
    if (!sent || !safeEqual(sent, csrfToken(req))) {
      return reply.code(403).send({ error: 'missing or invalid CSRF token; reload the page' });
    }
  }
}

// ---- login rate limit: per client address, in memory ----

const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

function throttled(ip: string): number {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.resetAt < now) return 0;
  return a.count >= MAX_ATTEMPTS ? Math.ceil((a.resetAt - now) / 1000) : 0;
}

function recordFailure(ip: string) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.resetAt < now) attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  else a.count++;
}

export function registerAuthRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    if (!authRequired()) return { ok: true };
    const wait = throttled(req.ip);
    if (wait) return reply.code(429).send({ error: `Too many attempts. Try again in ${wait}s.`, retryAfter: wait });
    const password = String((req.body as any)?.password ?? '');
    if (!password || !safeEqual(password, CFG.accessPassword)) {
      recordFailure(req.ip);
      return reply.code(401).send({ error: 'Wrong password.' });
    }
    attempts.delete(req.ip);
    const old = cookieValue(req, SESSION_COOKIE);
    if (old) sessions.delete(old);
    for (const [id, exp] of sessions) if (exp < Date.now()) sessions.delete(id);
    const sid = crypto.randomBytes(32).toString('base64url');
    sessions.set(sid, Date.now() + CFG.sessionTtlMs);
    reply.setCookie(SESSION_COOKIE, sid, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: req.protocol === 'https',
      maxAge: Math.floor(CFG.sessionTtlMs / 1000),
    });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const sid = cookieValue(req, SESSION_COOKIE);
    if (sid) sessions.delete(sid);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
