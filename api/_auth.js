// V7 accounts: "Sign in with GitHub" replaces the shared access code for customers.
// Sessions live in an httpOnly cookie: AES-256-GCM encrypted with a key derived from SESSION_SECRET,
// so no database is needed. The user's GitHub token rides inside the session and is used for their
// repos and pull requests, instead of one server-wide GITHUB_TOKEN.
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export const SESSION_COOKIE = 'cog_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const als = new AsyncLocalStorage();

const keyFor = purpose => crypto.createHash('sha256').update(`${process.env.SESSION_SECRET || ''}|${purpose}`).digest();
const secretOk = () => String(process.env.SESSION_SECRET || '').length >= 32;
export const githubLoginEnabled = () => !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET && secretOk());
export const googleLoginEnabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && secretOk());
export const authEnabled = () => githubLoginEnabled() || googleLoginEnabled();
export const loginProviders = () => [githubLoginEnabled() && 'github', googleLoginEnabled() && 'google'].filter(Boolean);

export function seal(obj, purpose = 'session') {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFor(purpose), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64url');
}
export function unseal(token, purpose = 'session') {
  try {
    const b = Buffer.from(String(token || ''), 'base64url');
    if (b.length < 29) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', keyFor(purpose), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
  } catch { return null; }
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers?.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function cookie(name, value, { maxAge = MAX_AGE, path = '/' } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
export function appendCookie(res, c) {
  const prev = res.getHeader?.('set-cookie');
  res.setHeader('set-cookie', prev ? [].concat(prev, c) : c);
}

export function getSession(req) {
  if (!process.env.SESSION_SECRET) return null;
  const s = unseal(parseCookies(req)[SESSION_COOKIE]);
  if (!s || !s.user || (s.exp && s.exp < Date.now())) return null;
  return s;
}
export function setSession(res, data) {
  appendCookie(res, cookie(SESSION_COOKIE, seal({ ...data, exp: Date.now() + MAX_AGE * 1000 })));
}
export function clearSession(res) { appendCookie(res, cookie(SESSION_COOKIE, '', { maxAge: 0 })); }

// Request-scoped user context, read by the git helpers.
export function enterUser(session) { als.enterWith({ session }); }
export function currentSession() { return als.getStore()?.session || null; }
export const githubToken = () => currentSession()?.githubToken || process.env.GITHUB_TOKEN || '';
