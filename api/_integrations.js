// Integrations: status, ticket import + comment-back (Jira, Linear, GitHub, GitLab), notifications (Slack, Teams, webhook).
import crypto from 'node:crypto';
import { authEnabled } from './_auth.js';
import { gh, gl } from './_git.js';

const env = k => process.env[k] || '';
export const VERSION = '7.0.0';
export function integrationStatus() {
  return {
    version: VERSION,
    ready: !!env('ANTHROPIC_API_KEY') && (authEnabled() || !!env('PORTAL_ACCESS_CODE') || env('ALLOW_PUBLIC_ACCESS') === 'true'),
    publicAccess: env('ALLOW_PUBLIC_ACCESS') === 'true',
    auth: authEnabled() ? 'github' : null,
    anthropic: !!env('ANTHROPIC_API_KEY'),
    accessCode: !!env('PORTAL_ACCESS_CODE'),
    sandbox: env('SANDBOX_DRIVER') === 'local' ? 'local' : 'vercel',
    github: !!env('GITHUB_TOKEN'),
    gitlab: !!env('GITLAB_TOKEN'),
    slackNotify: !!(env('SLACK_BOT_TOKEN') && env('SLACK_CHANNEL')) || !!env('SLACK_WEBHOOK_URL'),
    slackBot: !!(env('SLACK_BOT_TOKEN') && env('SLACK_SIGNING_SECRET')),
    teamsNotify: !!env('TEAMS_WEBHOOK_URL'),
    teamsBot: !!(env('TEAMS_OUTGOING_SECRET') && env('TEAMS_WEBHOOK_URL')),
    jira: !!(env('JIRA_BASE_URL') && env('JIRA_EMAIL') && env('JIRA_API_TOKEN')),
    linear: !!env('LINEAR_API_KEY'),
    webhook: !!env('WEBHOOK_URL'),
    stripe: !!(env('STRIPE_SECRET_KEY') && env('STRIPE_PRICE_STARTER') && env('STRIPE_PRICE_PRO') && env('STRIPE_PRICE_TEAM'))
  };
}

/* ---------- helpers ---------- */
export async function readRaw(req) {
  if (typeof req.rawBody === 'string') return req.rawBody;
  const chunks = []; for await (const c of req) chunks.push(Buffer.from(c)); return Buffer.concat(chunks).toString('utf8');
}
export async function later(promise) {
  try { const { waitUntil } = await import('@vercel/functions'); waitUntil(promise); }
  catch { promise.catch(e => console.error('background task failed', e)); }
}
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  const inner = (node.content || []).map(adfToText).join(node.type === 'bulletList' || node.type === 'orderedList' ? '' : '');
  if (['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(node.type)) return (node.type === 'listItem' ? '- ' : '') + inner + '\n';
  return inner;
}
const jiraAuth = () => 'Basic ' + Buffer.from(`${env('JIRA_EMAIL')}:${env('JIRA_API_TOKEN')}`).toString('base64');
const jiraBase = () => env('JIRA_BASE_URL').replace(/\/+$/, '');
async function linearQL(query, variables) {
  const r = await fetch('https://api.linear.app/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: env('LINEAR_API_KEY') }, body: JSON.stringify({ query, variables }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.errors) throw new Error('Linear: ' + (d.errors?.[0]?.message || r.status));
  return d.data;
}

/* ---------- tickets ---------- */
export function parseTicket(ref) {
  const s = String(ref || '').trim();
  let m;
  if ((m = s.match(/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/i))) return { source: 'github', repo: m[1], number: +m[2] };
  if ((m = s.match(/^(?:https?:\/\/)?[^/]*gitlab[^/]*\/(.+?)\/-\/issues\/(\d+)/i))) return { source: 'gitlab', project: m[1], number: +m[2] };
  if ((m = s.match(/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]+-\d+)/i)) || (m = s.match(/^linear:\s*([A-Z][A-Z0-9]+-\d+)$/i))) return { source: 'linear', key: m[1].toUpperCase() };
  if ((m = s.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/i)) || (m = s.match(/^jira:\s*([A-Z][A-Z0-9]+-\d+)$/i))) return { source: 'jira', key: m[1].toUpperCase() };
  if ((m = s.match(/^([A-Z][A-Z0-9]+-\d+)$/i))) {
    const st = integrationStatus();
    if (st.jira) return { source: 'jira', key: m[1].toUpperCase() };
    if (st.linear) return { source: 'linear', key: m[1].toUpperCase() };
    return { source: 'unknown', key: m[1] };
  }
  return null;
}
export async function fetchTicket(ref) {
  const t = parseTicket(ref);
  if (!t) throw Object.assign(new Error('Paste a GitHub/GitLab issue URL, a Jira key like ABC-123, or a Linear issue URL.'), { status: 400 });
  if (t.source === 'unknown') throw Object.assign(new Error('Connect Jira or Linear (see Integrations) to import ticket keys.'), { status: 400 });
  if (t.source === 'github') {
    const i = await gh(`/repos/${t.repo}/issues/${t.number}`);
    return { ...t, id: `${t.repo}#${t.number}`, title: i.title, body: i.body || '', url: i.html_url };
  }
  if (t.source === 'gitlab') {
    const i = await gl(`/projects/${encodeURIComponent(t.project)}/issues/${t.number}`);
    return { ...t, id: `${t.project}#${t.number}`, title: i.title, body: i.description || '', url: i.web_url };
  }
  if (t.source === 'jira') {
    if (!integrationStatus().jira) throw Object.assign(new Error('Jira is not connected. Add JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN.'), { status: 400 });
    const r = await fetch(`${jiraBase()}/rest/api/3/issue/${t.key}?fields=summary,description`, { headers: { authorization: jiraAuth(), accept: 'application/json' } });
    if (!r.ok) throw Object.assign(new Error(`Jira: could not read ${t.key} (${r.status}).`), { status: r.status });
    const d = await r.json();
    return { ...t, id: t.key, title: d.fields.summary, body: adfToText(d.fields.description).trim(), url: `${jiraBase()}/browse/${t.key}` };
  }
  if (!integrationStatus().linear) throw Object.assign(new Error('Linear is not connected. Add LINEAR_API_KEY.'), { status: 400 });
  const d = await linearQL('query($id:String!){ issue(id:$id){ id identifier title description url } }', { id: t.key });
  if (!d.issue) throw Object.assign(new Error(`Linear issue ${t.key} not found.`), { status: 404 });
  return { ...t, id: d.issue.identifier, linearId: d.issue.id, title: d.issue.title, body: d.issue.description || '', url: d.issue.url };
}
export async function commentOnTicket(ticket, text) {
  if (!ticket?.source) return false;
  if (ticket.source === 'github') { await gh(`/repos/${ticket.repo}/issues/${ticket.number}/comments`, { method: 'POST', body: JSON.stringify({ body: text }) }); return true; }
  if (ticket.source === 'gitlab') { await gl(`/projects/${encodeURIComponent(ticket.project)}/issues/${ticket.number}/notes`, { method: 'POST', body: JSON.stringify({ body: text }) }); return true; }
  if (ticket.source === 'jira' && integrationStatus().jira) {
    const r = await fetch(`${jiraBase()}/rest/api/3/issue/${ticket.key}/comment`, { method: 'POST', headers: { authorization: jiraAuth(), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } }) });
    return r.ok;
  }
  if (ticket.source === 'linear' && integrationStatus().linear) {
    const d = await linearQL('mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success } }', { input: { issueId: ticket.linearId || ticket.key, body: text } });
    return !!d.commentCreate?.success;
  }
  return false;
}

/* ---------- notifications ---------- */
export async function notify({ title, text, url }) {
  const jobs = [], sent = [];
  const plain = `*${title}*\n${text}${url ? `\n${url}` : ''}`;
  if (env('SLACK_BOT_TOKEN') && env('SLACK_CHANNEL')) {
    jobs.push(slackPost(env('SLACK_CHANNEL'), plain).then(() => sent.push('slack')));
  } else if (env('SLACK_WEBHOOK_URL')) {
    jobs.push(fetch(env('SLACK_WEBHOOK_URL'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: plain }) }).then(r => r.ok && sent.push('slack')));
  }
  if (env('TEAMS_WEBHOOK_URL')) jobs.push(teamsPost(title, text, url).then(ok => ok && sent.push('teams')));
  if (env('WEBHOOK_URL')) jobs.push(fetch(env('WEBHOOK_URL'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'cognitive-ai', title, text, url, at: new Date().toISOString() }) }).then(r => r.ok && sent.push('webhook')));
  await Promise.allSettled(jobs);
  return sent;
}
export async function slackPost(channel, text, thread_ts) {
  const r = await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${env('SLACK_BOT_TOKEN')}` }, body: JSON.stringify({ channel, text, ...(thread_ts ? { thread_ts } : {}), unfurl_links: false }) });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error('Slack: ' + (d.error || r.status));
  return d;
}
export async function teamsPost(title, text, url) {
  const card = { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', body: [
    { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
    { type: 'TextBlock', text: text.slice(0, 20000), wrap: true } ], ...(url ? { actions: [{ type: 'Action.OpenUrl', title: 'Open', url }] } : {}) };
  const r = await fetch(env('TEAMS_WEBHOOK_URL'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] }) });
  return r.ok;
}

/* ---------- inbound verification ---------- */
export function verifySlack(req, raw) {
  const ts = req.headers['x-slack-request-timestamp'], sig = req.headers['x-slack-signature'];
  if (!ts || !sig || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const mine = 'v0=' + crypto.createHmac('sha256', env('SLACK_SIGNING_SECRET')).update(`v0:${ts}:${raw}`).digest('hex');
  return mine.length === sig.length && crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(sig));
}
export function verifyTeams(req, raw) {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('HMAC ') || !env('TEAMS_OUTGOING_SECRET')) return false;
  const mine = crypto.createHmac('sha256', Buffer.from(env('TEAMS_OUTGOING_SECRET'), 'base64')).update(Buffer.from(raw, 'utf8')).digest('base64');
  const theirs = auth.slice(5);
  return mine.length === theirs.length && crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(theirs));
}

/* ---------- pull request review ---------- */
export function parsePR(ref) {
  const s = String(ref || '').trim(); let m;
  if ((m = s.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i))) return { provider: 'github', repo: m[1], number: +m[2] };
  if ((m = s.match(/^(?:https?:\/\/)?[^/]*gitlab[^/]*\/(.+?)\/-\/merge_requests\/(\d+)/i))) return { provider: 'gitlab', project: m[1], number: +m[2] };
  return null;
}
export async function fetchPR(ref) {
  const p = parsePR(ref);
  if (!p) throw Object.assign(new Error('Paste a GitHub pull request URL or a GitLab merge request URL.'), { status: 400 });
  if (p.provider === 'github') {
    const meta = await gh(`/repos/${p.repo}/pulls/${p.number}`);
    const r = await fetch(`https://api.github.com/repos/${p.repo}/pulls/${p.number}`, { headers: { ...(await import('./_git.js')).ghHeaders(), accept: 'application/vnd.github.v3.diff' } });
    if (!r.ok) throw Object.assign(new Error(`GitHub: could not load the diff (${r.status}).`), { status: r.status });
    const diff = await r.text();
    return { ...p, id: `${p.repo}#${p.number}`, title: meta.title, body: meta.body || '', url: meta.html_url, author: meta.user?.login, base: meta.base?.ref, head: meta.head?.ref, additions: meta.additions, deletions: meta.deletions, files: meta.changed_files, diff: diff.slice(0, 200000), truncated: diff.length > 200000 };
  }
  const id = encodeURIComponent(p.project);
  const meta = await gl(`/projects/${id}/merge_requests/${p.number}`);
  const ch = await gl(`/projects/${id}/merge_requests/${p.number}/changes`);
  const diff = (ch.changes || []).map(c => `diff --git a/${c.old_path} b/${c.new_path}\n--- a/${c.old_path}\n+++ b/${c.new_path}\n${c.diff}`).join('\n');
  return { ...p, id: `${p.project}!${p.number}`, title: meta.title, body: meta.description || '', url: meta.web_url, author: meta.author?.username, base: meta.target_branch, head: meta.source_branch, files: (ch.changes || []).length, diff: diff.slice(0, 200000), truncated: diff.length > 200000 };
}
export async function commentOnPR(pr, text) {
  const body = `${text}\n\n---\n_Review by Cognitive AI. Automated feedback — verify before acting._`;
  if (pr.provider === 'github') { if (!env('GITHUB_TOKEN')) throw Object.assign(new Error('Add a GITHUB_TOKEN to post reviews.'), { status: 400 }); const d = await gh(`/repos/${pr.repo}/issues/${pr.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) }); return d.html_url; }
  if (!env('GITLAB_TOKEN')) throw Object.assign(new Error('Add a GITLAB_TOKEN to post reviews.'), { status: 400 });
  await gl(`/projects/${encodeURIComponent(pr.project)}/merge_requests/${pr.number}/notes`, { method: 'POST', body: JSON.stringify({ body }) });
  return pr.url;
}
