// GET  /api/integrations                 -> which integrations are configured
// POST /api/integrations?action=ticket   -> import a Jira / Linear / GitHub / GitLab issue as a task
// POST /api/integrations?action=notify   -> post a result to Slack / Teams / webhook
import { checkAccess, cors } from './_lib.js';
import { integrationStatus, fetchTicket, notify, fetchPR, commentOnPR, parsePR } from './_integrations.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!checkAccess(req, res)) return;
  if (req.method === 'GET') return res.status(200).json(integrationStatus());
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const action = req.query?.action || new URL(req.url, 'http://x').searchParams.get('action');
  try {
    if (action === 'ticket') return res.status(200).json(await fetchTicket(req.body?.ref));
    if (action === 'pr') return res.status(200).json(await fetchPR(req.body?.ref));
    if (action === 'pr-comment') {
      const pr = parsePR(req.body?.url); if (!pr) return res.status(400).json({ error: 'Bad pull request URL.' });
      const text = String(req.body?.text || '').trim().slice(0, 60000); if (!text) return res.status(400).json({ error: 'Nothing to post.' });
      return res.status(200).json({ url: await commentOnPR(pr, text) });
    }
    if (action === 'notify') {
      const { title, text, url } = req.body || {};
      if (!title) return res.status(400).json({ error: 'Missing title.' });
      const sent = await notify({ title: String(title).slice(0, 200), text: String(text || '').slice(0, 3000), url: url && /^https?:\/\//.test(url) ? url : undefined });
      return res.status(200).json({ sent });
    }
    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) { return res.status(e.status && e.status < 600 ? e.status : 502).json({ error: String(e.message || e).slice(0, 400) }); }
}
