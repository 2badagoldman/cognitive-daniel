// Accounts: Sign in (or sign up — the first sign-in creates the account) with GitHub or Google.
//   GET  /api/auth?action=login&provider=github|google  -> redirects to the provider
//   GET  /api/auth?action=callback&provider=…           -> provider redirects back; sets the session cookie
//   GET  /api/auth?action=me                            -> { user, github } or 401
//   POST /api/auth?action=logout
// GitHub: GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET, callback https://<domain>/api/auth?action=callback&provider=github
//         (GitHub also accepts https://<domain>/api/auth as the registered callback base.)
// Google: GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET, redirect URI https://<domain>/api/auth?action=callback&provider=google
// Both need SESSION_SECRET (32+ random characters).
// A Google user can link GitHub afterwards (same login URL with provider=github); the GitHub token is added to
// their session so their repositories load automatically.
import crypto from 'node:crypto';
import { authEnabled, githubLoginEnabled, googleLoginEnabled, loginProviders, getSession, setSession, clearSession, cookie, appendCookie, parseCookies, seal, unseal } from './_auth.js';
import { rateLimit } from './_lib.js';

export const config = { maxDuration: 20 };
const STATE_COOKIE = 'cog_oauth_state';
const origin = req => `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
const callbackUrl = (req, p) => `${origin(req)}/api/auth?action=callback&provider=${p}`;

const PROVIDERS = {
  github: { enabled: githubLoginEnabled, authorize: 'https://github.com/login/oauth/authorize', scope: () => process.env.GITHUB_OAUTH_SCOPES || 'read:user user:email repo', extra: {} },
  google: { enabled: googleLoginEnabled, authorize: 'https://accounts.google.com/o/oauth2/v2/auth', scope: () => 'openid email profile', extra: { prompt: 'select_account' } }
};

export function allowedUser({ login, email }) {
  const list = String(process.env.ALLOWED_USERS || process.env.ALLOWED_GITHUB_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  const ids = [login, email].filter(Boolean).map(x => String(x).toLowerCase());
  return ids.some(id => list.includes(id) || list.some(e => e.startsWith('@') && id.endsWith(e)));
}

export default async function handler(req, res) {
  const q = new URL(req.url, 'http://x').searchParams;
  const action = req.query?.action || q.get('action');
  const provider = req.query?.provider || q.get('provider') || 'github';
  if (!rateLimit(req, res, { route: 'auth', limit: 30 })) return;

  if (action === 'me') {
    const s = getSession(req);
    const body = { enabled: authEnabled(), providers: loginProviders() };
    return s ? res.status(200).json({ ...body, user: s.user, github: !!s.githubToken }) : res.status(401).json({ ...body, user: null, github: false });
  }
  if (action === 'logout') { clearSession(res); return res.status(200).json({ ok: true }); }
  const P = PROVIDERS[provider];
  if (!P) return res.status(400).json({ error: 'Unknown sign-in provider.' });
  if (!P.enabled()) return res.status(400).json({ error: `Sign-in with ${provider === 'google' ? 'Google' : 'GitHub'} is not configured on this deployment.` });

  if (action === 'login') {
    const nonce = crypto.randomBytes(16).toString('hex');
    appendCookie(res, cookie(STATE_COOKIE, seal({ nonce, provider, t: Date.now() }, 'oauth'), { maxAge: 600 }));
    const u = new URL(P.authorize);
    u.searchParams.set('client_id', provider === 'google' ? process.env.GOOGLE_CLIENT_ID : process.env.GITHUB_CLIENT_ID);
    u.searchParams.set('redirect_uri', callbackUrl(req, provider));
    u.searchParams.set('scope', P.scope());
    u.searchParams.set('state', nonce);
    if (provider === 'google') u.searchParams.set('response_type', 'code');
    for (const [k, v] of Object.entries(P.extra)) u.searchParams.set(k, v);
    res.statusCode = 302; res.setHeader('location', u.toString()); return res.end();
  }

  if (action === 'callback') {
    const st = unseal(parseCookies(req)[STATE_COOKIE], 'oauth');
    appendCookie(res, cookie(STATE_COOKIE, '', { maxAge: 0 }));
    if (!st || st.provider !== provider || st.nonce !== q.get('state') || Date.now() - st.t > 600000) return fail(res, 'Sign-in expired or was tampered with. Please try again.');
    if (q.get('error')) return fail(res, q.get('error_description') || 'Sign-in was cancelled.');
    const existing = getSession(req);

    if (provider === 'github') {
      const tr = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code: q.get('code'), redirect_uri: callbackUrl(req, 'github') })
      }).then(r => r.json()).catch(() => ({}));
      if (!tr.access_token) return fail(res, tr.error_description || 'GitHub did not return a token.');
      const H = { authorization: `Bearer ${tr.access_token}`, 'user-agent': 'cognitive-ai', accept: 'application/vnd.github+json' };
      const u = await fetch('https://api.github.com/user', { headers: H }).then(r => r.json()).catch(() => ({}));
      if (!u.login) return fail(res, 'Could not read your GitHub profile.');
      let email = u.email || '';
      if (!email) { const em = await fetch('https://api.github.com/user/emails', { headers: H }).then(r => r.json()).catch(() => []); email = (Array.isArray(em) && (em.find(e => e.primary && e.verified) || em.find(e => e.verified))?.email) || ''; }
      // Linking GitHub to an existing Google account keeps the Google identity.
      const user = existing?.user && existing.user.provider !== 'github' ? { ...existing.user, githubLogin: u.login } : { provider: 'github', login: u.login, name: u.name || u.login, email, avatar: u.avatar_url, id: `gh:${u.id}`, githubLogin: u.login };
      if (!allowedUser(user)) return fail(res, `${user.email || '@' + u.login} is not on this workspace's access list.`);
      setSession(res, { user, githubToken: tr.access_token });
      return done(res, existing ? 'linked' : 'github');
    }

    // Google
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: q.get('code') || '', redirect_uri: callbackUrl(req, 'google'), client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET })
    }).then(r => r.json()).catch(() => ({}));
    if (!tr.access_token) return fail(res, tr.error_description || 'Google did not return a token.');
    const g = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tr.access_token}` } }).then(r => r.json()).catch(() => ({}));
    if (!g.email || g.email_verified === false) return fail(res, 'Your Google account email is not verified.');
    const user = { provider: 'google', login: g.email, name: g.name || g.email, email: g.email, avatar: g.picture, id: `google:${g.sub}`, githubLogin: existing?.user?.githubLogin };
    if (!allowedUser(user)) return fail(res, `${g.email} is not on this workspace's access list.`);
    setSession(res, { user, githubToken: existing?.githubToken });
    return done(res, 'google');
  }
  return res.status(400).json({ error: 'Unknown action.' });
}

function done(res, how) { res.statusCode = 302; res.setHeader('location', `/?signedin=${how}`); return res.end(); }
function fail(res, msg) { res.statusCode = 302; res.setHeader('location', `/?signin_error=${encodeURIComponent(msg)}`); return res.end(); }
