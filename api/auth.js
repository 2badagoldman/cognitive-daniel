// Sign in with GitHub.
//   GET  /api/auth?action=login     -> redirects to GitHub
//   GET  /api/auth?action=callback  -> GitHub redirects back here; sets the session cookie
//   GET  /api/auth?action=me        -> { user } or 401
//   POST /api/auth?action=logout
// Needs GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and SESSION_SECRET (32+ random characters).
// GitHub OAuth app callback URL: https://<your-domain>/api/auth?action=callback
import crypto from 'node:crypto';
import { authEnabled, getSession, setSession, clearSession, cookie, appendCookie, parseCookies, seal, unseal } from './_auth.js';
import { rateLimit } from './_lib.js';

export const config = { maxDuration: 20 };
const STATE_COOKIE = 'cog_oauth_state';

const origin = req => `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host}`;

export default async function handler(req, res) {
  const action = req.query?.action || new URL(req.url, 'http://x').searchParams.get('action');
  if (!rateLimit(req, res, { route: 'auth', limit: 30 })) return;
  if (action === 'me') {
    const s = getSession(req);
    return s ? res.status(200).json({ user: s.user, enabled: authEnabled() }) : res.status(401).json({ user: null, enabled: authEnabled() });
  }
  if (action === 'logout') { clearSession(res); return res.status(200).json({ ok: true }); }
  if (!authEnabled()) return res.status(400).json({ error: 'Sign-in is not configured. Set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and SESSION_SECRET in Vercel.' });

  if (action === 'login') {
    const nonce = crypto.randomBytes(16).toString('hex');
    appendCookie(res, cookie(STATE_COOKIE, seal({ nonce, t: Date.now() }, 'oauth'), { maxAge: 600 }));
    const u = new URL('https://github.com/login/oauth/authorize');
    u.searchParams.set('client_id', process.env.GITHUB_CLIENT_ID);
    u.searchParams.set('redirect_uri', `${origin(req)}/api/auth?action=callback`);
    u.searchParams.set('scope', process.env.GITHUB_OAUTH_SCOPES || 'read:user user:email repo');
    u.searchParams.set('state', nonce);
    res.statusCode = 302; res.setHeader('location', u.toString()); return res.end();
  }

  if (action === 'callback') {
    const q = new URL(req.url, 'http://x').searchParams;
    const st = unseal(parseCookies(req)[STATE_COOKIE], 'oauth');
    appendCookie(res, cookie(STATE_COOKIE, '', { maxAge: 0 }));
    if (!st || st.nonce !== q.get('state') || Date.now() - st.t > 600000) return fail(res, 'Sign-in expired or was tampered with. Please try again.');
    const tr = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code: q.get('code'), redirect_uri: `${origin(req)}/api/auth?action=callback` })
    }).then(r => r.json()).catch(() => ({}));
    if (!tr.access_token) return fail(res, tr.error_description || 'GitHub did not return a token.');
    const u = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${tr.access_token}`, 'user-agent': 'cognitive-ai', accept: 'application/vnd.github+json' } }).then(r => r.json()).catch(() => ({}));
    if (!u.login) return fail(res, 'Could not read your GitHub profile.');
    const allow = String(process.env.ALLOWED_GITHUB_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (allow.length && !allow.includes(u.login.toLowerCase())) return fail(res, `@${u.login} is not on this workspace's access list.`);
    setSession(res, { user: { login: u.login, name: u.name || u.login, avatar: u.avatar_url, id: u.id }, githubToken: tr.access_token });
    res.statusCode = 302; res.setHeader('location', '/'); return res.end();
  }
  return res.status(400).json({ error: 'Unknown action.' });
}

function fail(res, msg) {
  res.statusCode = 302; res.setHeader('location', `/?signin_error=${encodeURIComponent(msg)}`); return res.end();
}
