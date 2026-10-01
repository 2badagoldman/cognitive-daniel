// Cognitive Personal — the life agent in the Cognitive AI suite.
// It remembers what you tell it (memory lives on your device and is sent with each request),
// and works across the accounts you connect: Gmail + Google Calendar, Outlook + Microsoft 365
// calendar, SMS (Twilio), X, and your smart home (Home Assistant).
// Anything that leaves your account (sending, posting, controlling devices) is returned as a
// proposal the user must confirm in the app; the agent can never send on its own.
import { seal, unseal, parseCookies, cookie, appendCookie } from './_auth.js';

export const PERSONAL_PROMPT = `You are Cognitive Personal, a capable, warm and discreet personal assistant built by Cognitive AI. You help with anything in the user's life: planning, email, calendar, messages, relationships, career, money questions, health habits, home and errands.

How you work:
- Use the tools to look things up in the user's connected accounts before answering questions about them. Never invent emails, events or facts about the user.
- Memory: when the user shares a durable fact or preference (people in their life, goals, routines, likes and dislikes, important dates), call remember with one short sentence. When they ask you to forget something, call forget. Do not store passwords, card numbers or government ID numbers.
- Actions that leave the user's account (sending an email or text, posting, creating events, controlling home devices) are proposals: call the matching tool and the app will ask the user to confirm. Tell the user what you prepared and that it is waiting for their OK.
- If an account is not connected, say which one and that they can connect it under Personal → Connections.
- On health, legal and money topics, give practical, accurate information and suggest a professional when it matters. You are not a doctor, lawyer or financial advisor.
- Be concise and specific. Use the user's name and remembered context naturally, without reciting it.`;

/* ---------------- connector registry ---------------- */
const env = k => process.env[k] || '';
export const PROVIDERS = {
  google: { label: 'Gmail + Google Calendar', kind: 'oauth', configured: () => !!(env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET')),
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    scopes: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar.events',
    extra: { access_type: 'offline', prompt: 'consent' }, id: () => env('GOOGLE_CLIENT_ID'), secret: () => env('GOOGLE_CLIENT_SECRET') },
  microsoft: { label: 'Outlook + Microsoft 365 calendar', kind: 'oauth', configured: () => !!(env('MICROSOFT_CLIENT_ID') && env('MICROSOFT_CLIENT_SECRET')),
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: 'offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite', extra: {}, id: () => env('MICROSOFT_CLIENT_ID'), secret: () => env('MICROSOFT_CLIENT_SECRET') },
  x: { label: 'X (Twitter)', kind: 'oauth', pkce: true, configured: () => !!(env('X_CLIENT_ID') && env('X_CLIENT_SECRET')),
    authorize: 'https://twitter.com/i/oauth2/authorize', token: 'https://api.twitter.com/2/oauth2/token',
    scopes: 'tweet.read tweet.write users.read offline.access', extra: {}, id: () => env('X_CLIENT_ID'), secret: () => env('X_CLIENT_SECRET') },
  sms: { label: 'Text messages (Twilio)', kind: 'server', configured: () => !!(env('TWILIO_ACCOUNT_SID') && env('TWILIO_AUTH_TOKEN') && env('TWILIO_FROM')) },
  home: { label: 'Smart home (Home Assistant)', kind: 'token', configured: () => true }
};
// Not offered, and why (shown in the app so expectations are honest).
export const UNAVAILABLE = [
  ['Apple Health / Health Connect', 'No web API; needs the Cognitive mobile app (planned).'],
  ['iMessage / your phone\'s own texts', 'Phones do not expose personal SMS to web apps; texts go out from your Twilio number.'],
  ['Instagram, Facebook, LinkedIn', 'Posting requires Meta / LinkedIn app review for this app first.']
];

const connCookie = p => `cog_conn_${p}`;
export function readConnections(req) {
  const c = parseCookies(req), out = {};
  for (const p of Object.keys(PROVIDERS)) { const v = unseal(c[connCookie(p)], `conn:${p}`); if (v) out[p] = v; }
  if (PROVIDERS.sms.configured()) out.sms = { server: true };
  return out;
}
export function saveConnection(res, p, data) { appendCookie(res, cookie(connCookie(p), seal(data, `conn:${p}`), { maxAge: 60 * 60 * 24 * 180 })); }
export function dropConnection(res, p) { appendCookie(res, cookie(connCookie(p), '', { maxAge: 0 })); }
export function status(req) {
  const conns = readConnections(req);
  return { providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { label: v.label, configured: v.configured(), connected: !!conns[k], account: conns[k]?.account || null }])), unavailable: UNAVAILABLE };
}

/* ---------------- token refresh ---------------- */
export async function accessToken(res, p, conn, fetchImpl = fetch) {
  if (!conn) return null;
  if (!conn.expires || conn.expires - 60000 > Date.now() || !conn.refresh) return conn.access;
  const P = PROVIDERS[p];
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: conn.refresh, client_id: P.id() });
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (P.pkce) headers.authorization = 'Basic ' + Buffer.from(`${P.id()}:${P.secret()}`).toString('base64'); else body.set('client_secret', P.secret());
  const t = await fetchImpl(P.token, { method: 'POST', headers, body }).then(r => r.json()).catch(() => ({}));
  if (!t.access_token) return null;
  Object.assign(conn, { access: t.access_token, refresh: t.refresh_token || conn.refresh, expires: Date.now() + (t.expires_in || 3600) * 1000 });
  saveConnection(res, p, conn);
  return conn.access;
}

/* ---------------- tools ---------------- */
export const PERSONAL_TOOLS = [
  { name: 'remember', description: 'Save one durable fact or preference about the user (one short sentence).', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'forget', description: 'Delete a saved memory by its id (ids are shown in <memory>).', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'email_search', description: 'Search the user\'s connected mailbox (Gmail or Outlook). Returns sender, subject, date, snippet and id.', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Gmail-style search, e.g. "from:alex newer_than:7d"' }, max: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'] } },
  { name: 'email_read', description: 'Read one email by id.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'email_send', description: 'Prepare an email for the user to confirm and send.', input_schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] } },
  { name: 'calendar_list', description: 'List upcoming calendar events.', input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 60 } } } },
  { name: 'calendar_create', description: 'Prepare a calendar event for the user to confirm. Times are ISO 8601 with offset.', input_schema: { type: 'object', properties: { title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' } }, location: { type: 'string' } }, required: ['title', 'start', 'end'] } },
  { name: 'text_send', description: 'Prepare a text message (SMS) for the user to confirm.', input_schema: { type: 'object', properties: { to: { type: 'string', description: 'E.164 phone number, e.g. +14695550123' }, body: { type: 'string' } }, required: ['to', 'body'] } },
  { name: 'social_post', description: 'Prepare a post on X for the user to confirm.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'home_status', description: 'Read smart-home device states from Home Assistant, optionally filtered by domain (light, climate, lock, sensor, …).', input_schema: { type: 'object', properties: { domain: { type: 'string' } } } },
  { name: 'home_control', description: 'Prepare a Home Assistant service call for the user to confirm, e.g. domain "light", service "turn_off", entity_id "light.kitchen".', input_schema: { type: 'object', properties: { domain: { type: 'string' }, service: { type: 'string' }, entity_id: { type: 'string' }, data: { type: 'object' } }, required: ['domain', 'service', 'entity_id'] } }
];
const PROPOSE = { email_send: 'Send email', calendar_create: 'Create event', text_send: 'Send text', social_post: 'Post on X', home_control: 'Control device' };

const j = async (r, label) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${label}: ${d.error?.message || d.message || d.error || r.status}`); return d; };
const mailProvider = c => (c.google ? 'google' : c.microsoft ? 'microsoft' : null);
const need = what => ({ ok: false, output: `${what} is not connected. Ask the user to connect it under Personal → Connections.` });

export async function runPersonalTool(name, input, ctx) {
  const { conns, res, fetchImpl = fetch, memory = [] } = ctx;
  if (name === 'remember') { const text = String(input.text || '').trim().slice(0, 300); if (!text) return { ok: false, output: 'Empty memory.' }; if (/\b\d{12,19}\b|\bssn\b|\bpassword\b/i.test(text)) return { ok: false, output: 'Not saved: never store passwords, card or ID numbers.' }; return { ok: true, output: 'Saved.', memoryOp: { op: 'save', text } }; }
  if (name === 'forget') { const m = memory.find(x => x.id === input.id); return m ? { ok: true, output: 'Forgotten.', memoryOp: { op: 'forget', id: m.id } } : { ok: false, output: 'No memory with that id.' }; }
  if (PROPOSE[name]) {
    const mp = mailProvider(conns);
    const ready = { email_send: !!mp, calendar_create: !!mp, text_send: !!conns.sms, social_post: !!conns.x, home_control: !!conns.home }[name];
    if (!ready) return need({ email_send: 'Email', calendar_create: 'A calendar', text_send: 'Text messaging', social_post: 'X', home_control: 'Home Assistant' }[name]);
    const params = { ...input, provider: name === 'email_send' || name === 'calendar_create' ? mp : undefined };
    const summary = name === 'email_send' ? `Email to ${input.to}: "${input.subject}"` : name === 'calendar_create' ? `Event "${input.title}" ${input.start} → ${input.end}` : name === 'text_send' ? `Text to ${input.to}: "${String(input.body).slice(0, 80)}"` : name === 'social_post' ? `Post on X: "${String(input.text).slice(0, 80)}"` : `${input.domain}.${input.service} on ${input.entity_id}`;
    const proposal = { id: 'p_' + Math.random().toString(36).slice(2, 10), kind: name, label: PROPOSE[name], summary, params };
    proposal.token = seal({ ...proposal, exp: Date.now() + 30 * 60000 }, 'proposal');
    return { ok: true, output: `Prepared and waiting for the user to confirm: ${summary}`, proposal };
  }
  if (name === 'email_search' || name === 'email_read') {
    const mp = mailProvider(conns); if (!mp) return need('Email');
    const tok = await accessToken(res, mp, conns[mp], fetchImpl); if (!tok) return need('Email (session expired)');
    const H = { authorization: `Bearer ${tok}` };
    if (mp === 'google') {
      if (name === 'email_read') { const m = await j(await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(input.id)}?format=full`, { headers: H }), 'Gmail'); return { ok: true, output: gmailText(m) }; }
      const list = await j(await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${Math.min(20, input.max || 10)}&q=${encodeURIComponent(input.query || '')}`, { headers: H }), 'Gmail');
      const items = await Promise.all((list.messages || []).map(async x => { const m = await j(await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${x.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: H }), 'Gmail'); const h = n => (m.payload?.headers || []).find(y => y.name === n)?.value || ''; return `- id ${m.id} · ${h('Date')} · ${h('From')} · ${h('Subject')} — ${m.snippet || ''}`; }));
      return { ok: true, output: items.join('\n') || 'No matching emails.' };
    }
    if (name === 'email_read') { const m = await j(await fetchImpl(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(input.id)}?$select=subject,from,receivedDateTime,body`, { headers: { ...H, prefer: 'outlook.body-content-type="text"' } }), 'Outlook'); return { ok: true, output: `From: ${m.from?.emailAddress?.address}\nDate: ${m.receivedDateTime}\nSubject: ${m.subject}\n\n${String(m.body?.content || '').slice(0, 8000)}` }; }
    const l = await j(await fetchImpl(`https://graph.microsoft.com/v1.0/me/messages?$top=${Math.min(20, input.max || 10)}&$search=${encodeURIComponent(`"${String(input.query || '').replace(/"/g, '')}"`)}&$select=id,subject,from,receivedDateTime,bodyPreview`, { headers: { ...H, consistencylevel: 'eventual' } }), 'Outlook');
    return { ok: true, output: (l.value || []).map(m => `- id ${m.id} · ${m.receivedDateTime} · ${m.from?.emailAddress?.address} · ${m.subject} — ${m.bodyPreview}`).join('\n') || 'No matching emails.' };
  }
  if (name === 'calendar_list') {
    const mp = mailProvider(conns); if (!mp) return need('A calendar');
    const tok = await accessToken(res, mp, conns[mp], fetchImpl); if (!tok) return need('Calendar (session expired)');
    const from = new Date(), to = new Date(Date.now() + (input.days || 7) * 86400000);
    if (mp === 'google') {
      const d = await j(await fetchImpl(`https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=50&timeMin=${from.toISOString()}&timeMax=${to.toISOString()}`, { headers: { authorization: `Bearer ${tok}` } }), 'Google Calendar');
      return { ok: true, output: (d.items || []).map(e => `- ${e.start?.dateTime || e.start?.date} → ${e.end?.dateTime || e.end?.date} · ${e.summary || '(no title)'}${e.location ? ' @ ' + e.location : ''}`).join('\n') || 'Nothing scheduled.' };
    }
    const d = await j(await fetchImpl(`https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${from.toISOString()}&endDateTime=${to.toISOString()}&$top=50&$orderby=start/dateTime`, { headers: { authorization: `Bearer ${tok}` } }), 'Outlook calendar');
    return { ok: true, output: (d.value || []).map(e => `- ${e.start?.dateTime} → ${e.end?.dateTime} (${e.start?.timeZone}) · ${e.subject}${e.location?.displayName ? ' @ ' + e.location.displayName : ''}`).join('\n') || 'Nothing scheduled.' };
  }
  if (name === 'home_status') {
    if (!conns.home) return need('Home Assistant');
    const st = await j(await fetchImpl(`${conns.home.url}/api/states`, { headers: { authorization: `Bearer ${conns.home.token}` } }), 'Home Assistant');
    const rows = st.filter(s => !input.domain || s.entity_id.startsWith(input.domain + '.')).slice(0, 80);
    return { ok: true, output: rows.map(s => `- ${s.entity_id} (${s.attributes?.friendly_name || ''}): ${s.state}`).join('\n') || 'No devices found.' };
  }
  return { ok: false, output: `Unknown tool ${name}.` };
}

function gmailText(m) {
  const h = n => (m.payload?.headers || []).find(y => y.name === n)?.value || '';
  const parts = []; const walk = p => { if (!p) return; if (p.mimeType === 'text/plain' && p.body?.data) parts.push(Buffer.from(p.body.data, 'base64url').toString('utf8')); (p.parts || []).forEach(walk); };
  walk(m.payload);
  return `From: ${h('From')}\nTo: ${h('To')}\nDate: ${h('Date')}\nSubject: ${h('Subject')}\n\n${(parts.join('\n') || m.snippet || '').slice(0, 8000)}`;
}

/* ---------------- confirmed actions ---------------- */
export async function executeProposal(token, { conns, res, fetchImpl = fetch }) {
  const p = unseal(token, 'proposal');
  if (!p || p.exp < Date.now()) throw Object.assign(new Error('This action expired. Ask again.'), { status: 400 });
  const x = p.params;
  if (p.kind === 'email_send') {
    const tok = await accessToken(res, x.provider, conns[x.provider], fetchImpl); if (!tok) throw new Error('Email is not connected.');
    if (x.provider === 'google') {
      const raw = Buffer.from(`To: ${x.to}\r\nSubject: ${x.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${x.body}`).toString('base64url');
      await j(await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ raw }) }), 'Gmail');
    } else {
      await j(await fetchImpl('https://graph.microsoft.com/v1.0/me/sendMail', { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ message: { subject: x.subject, body: { contentType: 'Text', content: x.body }, toRecipients: String(x.to).split(',').map(a => ({ emailAddress: { address: a.trim() } })) } }) }), 'Outlook');
    }
    return { done: true, text: `Email sent to ${x.to}.` };
  }
  if (p.kind === 'calendar_create') {
    const tok = await accessToken(res, x.provider, conns[x.provider], fetchImpl); if (!tok) throw new Error('Calendar is not connected.');
    if (x.provider === 'google') {
      const e = await j(await fetchImpl('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all', { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ summary: x.title, location: x.location, start: { dateTime: x.start }, end: { dateTime: x.end }, attendees: (x.attendees || []).map(email => ({ email })) }) }), 'Google Calendar');
      return { done: true, text: `Event created: ${e.htmlLink || x.title}` };
    }
    await j(await fetchImpl('https://graph.microsoft.com/v1.0/me/events', { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ subject: x.title, start: { dateTime: x.start, timeZone: 'UTC' }, end: { dateTime: x.end, timeZone: 'UTC' }, location: { displayName: x.location || '' }, attendees: (x.attendees || []).map(a => ({ emailAddress: { address: a }, type: 'required' })) }) }), 'Outlook calendar');
    return { done: true, text: `Event created: ${x.title}` };
  }
  if (p.kind === 'text_send') {
    if (!/^\+[1-9]\d{7,14}$/.test(x.to)) throw Object.assign(new Error('Phone number must be in +15551234567 format.'), { status: 400 });
    const sid = env('TWILIO_ACCOUNT_SID');
    await j(await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(`${sid}:${env('TWILIO_AUTH_TOKEN')}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ To: x.to, From: env('TWILIO_FROM'), Body: String(x.body).slice(0, 1600) }) }), 'Twilio');
    return { done: true, text: `Text sent to ${x.to}.` };
  }
  if (p.kind === 'social_post') {
    const tok = await accessToken(res, 'x', conns.x, fetchImpl); if (!tok) throw new Error('X is not connected.');
    const d = await j(await fetchImpl('https://api.twitter.com/2/tweets', { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: String(x.text).slice(0, 280) }) }), 'X');
    return { done: true, text: `Posted on X (id ${d.data?.id}).` };
  }
  if (p.kind === 'home_control') {
    if (!conns.home) throw new Error('Home Assistant is not connected.');
    if (!/^[a-z_]+$/.test(x.domain) || !/^[a-z_]+$/.test(x.service)) throw Object.assign(new Error('Invalid service.'), { status: 400 });
    await j(await fetchImpl(`${conns.home.url}/api/services/${x.domain}/${x.service}`, { method: 'POST', headers: { authorization: `Bearer ${conns.home.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ entity_id: x.entity_id, ...(x.data || {}) }) }), 'Home Assistant');
    return { done: true, text: `Done: ${x.domain}.${x.service} on ${x.entity_id}.` };
  }
  throw Object.assign(new Error('Unknown action.'), { status: 400 });
}

/* ---------------- the agent loop ---------------- */
export function memoryBlock(memory = []) {
  const m = (Array.isArray(memory) ? memory : []).slice(-300).map(x => `- [${String(x.id).slice(0, 24)}] ${String(x.text).slice(0, 300)}`).join('\n');
  return m ? `\n\n<memory>\nWhat you remember about the user (ids in brackets):\n${m}\n</memory>` : '\n\n<memory>\n(nothing saved yet)\n</memory>';
}
export async function personalChat({ key, callModel, messages, memory, profile, conns, res, fetchImpl = fetch, maxTurns = 6 }) {
  const connected = Object.keys(conns).map(k => PROVIDERS[k]?.label).filter(Boolean);
  const system = PERSONAL_PROMPT + `\n\nToday is ${new Date().toISOString().slice(0, 10)}.${profile?.name ? ` The user's name is ${String(profile.name).slice(0, 60)}.` : ''}\nConnected accounts: ${connected.join(', ') || 'none yet'}.` + memoryBlock(memory);
  const convo = messages.slice(-30);
  const memoryOps = [], proposals = [], events = [];
  let text = '', usage = { input: 0, output: 0 };
  for (let turn = 0; turn < maxTurns; turn++) {
    const r = await callModel(key, { max_tokens: 3000, system, tools: PERSONAL_TOOLS, messages: convo });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data?.error?.message || `Model error (${r.status}).`), { status: r.status });
    usage.input += data.usage?.input_tokens || 0; usage.output += data.usage?.output_tokens || 0;
    const calls = (data.content || []).filter(b => b.type === 'tool_use');
    text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || text;
    if (!calls.length) break;
    convo.push({ role: 'assistant', content: data.content });
    const results = [];
    for (const c of calls) {
      let out;
      try { out = await runPersonalTool(c.name, c.input || {}, { conns, res, fetchImpl, memory }); } catch (e) { out = { ok: false, output: String(e.message || e).slice(0, 500) }; }
      if (out.memoryOp) memoryOps.push(out.memoryOp);
      if (out.proposal) proposals.push(out.proposal);
      events.push({ tool: c.name, ok: out.ok });
      results.push({ type: 'tool_result', tool_use_id: c.id, content: out.output, ...(out.ok ? {} : { is_error: true }) });
    }
    convo.push({ role: 'user', content: results });
  }
  return { text, memoryOps, proposals: proposals.map(({ params, ...p }) => p), events, usage };
}
