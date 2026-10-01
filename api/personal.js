// Cognitive Personal: the life agent, its memory, and its account connections.
//   GET  /api/personal?action=status
//   GET  /api/personal?action=connect&provider=google|microsoft|x   -> OAuth redirect
//   GET  /api/personal?action=oauth&provider=…                      -> OAuth callback
//   POST /api/personal?action=connect-home {url, token}             -> Home Assistant
//   POST /api/personal?action=disconnect {provider}
//   POST /api/personal?action=chat {messages, memory, profile}      -> {text, memoryOps, proposals}
//   POST /api/personal?action=execute {token}                       -> runs an action the user confirmed
// OAuth redirect URI for every provider: https://<your-domain>/api/personal?action=oauth&provider=<name>
import crypto from 'node:crypto';
import { checkAccess, requireKey, cleanMessages, callAnthropic, cors } from './_lib.js';
import { seal, unseal, parseCookies, cookie, appendCookie } from './_auth.js';
import { PROVIDERS, status, readConnections, saveConnection, dropConnection, personalChat, executeProposal } from './_personal.js';

export const config = { maxDuration: 120 };
const STATE = 'cog_conn_state';
const origin = req => `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
const redirectUri = (req, p) => `${origin(req)}/api/personal?action=oauth&provider=${p}`;
const back = (res, q) => { res.statusCode = 302; res.setHeader('location', `/?personal=${encodeURIComponent(q)}`); return res.end(); };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const url = new URL(req.url, 'http://x'), q = url.searchParams;
  const action = req.query?.action || q.get('action');
  const p = req.query?.provider || q.get('provider');
  const spend = action === 'chat' || action === 'execute';
  if (action !== 'oauth' && !checkAccess(req, res, { route: 'personal', spend })) return;
  try {
    if (action === 'status') return res.status(200).json(status(req));

    if (action === 'connect') {
      const P = PROVIDERS[p];
      if (!P || P.kind !== 'oauth') return res.status(400).json({ error: 'Unknown provider.' });
      if (!P.configured()) return res.status(400).json({ error: `${P.label} is not set up on this deployment yet.` });
      const nonce = crypto.randomBytes(16).toString('hex'), verifier = crypto.randomBytes(32).toString('base64url');
      appendCookie(res, cookie(STATE, seal({ nonce, verifier, p, t: Date.now() }, 'connstate'), { maxAge: 600 }));
      const u = new URL(P.authorize);
      u.searchParams.set('client_id', P.id()); u.searchParams.set('redirect_uri', redirectUri(req, p));
      u.searchParams.set('response_type', 'code'); u.searchParams.set('scope', P.scopes); u.searchParams.set('state', nonce);
      for (const [k, v] of Object.entries(P.extra || {})) u.searchParams.set(k, v);
      if (P.pkce) { u.searchParams.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url')); u.searchParams.set('code_challenge_method', 'S256'); }
      res.statusCode = 302; res.setHeader('location', u.toString()); return res.end();
    }

    if (action === 'oauth') {
      const P = PROVIDERS[p]; const st = unseal(parseCookies(req)[STATE], 'connstate');
      appendCookie(res, cookie(STATE, '', { maxAge: 0 }));
      if (!P || !st || st.p !== p || st.nonce !== q.get('state') || Date.now() - st.t > 600000) return back(res, 'error:Connection expired. Try again.');
      if (q.get('error')) return back(res, `error:${q.get('error_description') || q.get('error')}`);
      const body = new URLSearchParams({ grant_type: 'authorization_code', code: q.get('code') || '', redirect_uri: redirectUri(req, p), client_id: P.id() });
      const headers = { 'content-type': 'application/x-www-form-urlencoded' };
      if (P.pkce) { body.set('code_verifier', st.verifier); headers.authorization = 'Basic ' + Buffer.from(`${P.id()}:${P.secret()}`).toString('base64'); } else body.set('client_secret', P.secret());
      const t = await fetch(P.token, { method: 'POST', headers, body }).then(r => r.json()).catch(() => ({}));
      if (!t.access_token) return back(res, `error:${t.error_description || 'The provider did not return a token.'}`);
      let account = '';
      try {
        if (p === 'google') account = (await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${t.access_token}` } })).json()).email || '';
        if (p === 'microsoft') { const m = await (await fetch('https://graph.microsoft.com/v1.0/me', { headers: { authorization: `Bearer ${t.access_token}` } })).json(); account = m.mail || m.userPrincipalName || ''; }
        if (p === 'x') account = '@' + ((await (await fetch('https://api.twitter.com/2/users/me', { headers: { authorization: `Bearer ${t.access_token}` } })).json()).data?.username || '');
      } catch {}
      saveConnection(res, p, { access: t.access_token, refresh: t.refresh_token || '', expires: Date.now() + (t.expires_in || 3600) * 1000, account });
      return back(res, `connected:${p}`);
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const b = req.body || {};

    if (action === 'connect-home') {
      const u = String(b.url || '').trim().replace(/\/+$/, ''), token = String(b.token || '').trim();
      if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(u)) return res.status(400).json({ error: 'Use your Home Assistant https:// address (for example your Nabu Casa URL).' });
      if (!token) return res.status(400).json({ error: 'Paste a Home Assistant long-lived access token.' });
      const r = await fetch(`${u}/api/`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
      if (!r || !r.ok) return res.status(400).json({ error: 'Could not reach Home Assistant with that address and token.' });
      saveConnection(res, 'home', { url: u, token, account: new URL(u).host });
      return res.status(200).json({ connected: true });
    }
    if (action === 'disconnect') {
      if (!PROVIDERS[b.provider]) return res.status(400).json({ error: 'Unknown provider.' });
      dropConnection(res, b.provider); return res.status(200).json({ disconnected: true });
    }
    if (action === 'chat') {
      const key = requireKey(res); if (!key) return;
      const messages = cleanMessages(b.messages); if (!messages) return res.status(400).json({ error: 'Conversation is too long or malformed. Start a new chat.' });
      const memory = (Array.isArray(b.memory) ? b.memory : []).filter(m => m && m.id && m.text).slice(-300);
      const out = await personalChat({ key, callModel: callAnthropic, messages, memory, profile: b.profile, conns: readConnections(req), res });
      return res.status(200).json(out);
    }
    if (action === 'execute') return res.status(200).json(await executeProposal(String(b.token || ''), { conns: readConnections(req), res }));
    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    return res.status(e.status && e.status < 600 ? e.status : 502).json({ error: String(e.message || e).slice(0, 500) });
  }
}
