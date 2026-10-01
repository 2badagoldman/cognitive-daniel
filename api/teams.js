// Microsoft Teams: an Outgoing Webhook named e.g. "Cognitive" posts here when @mentioned.
// Teams requires a reply within 5 seconds, so we acknowledge immediately and post the full answer to the channel
// through a Teams Workflows incoming webhook. Setup: TEAMS_OUTGOING_SECRET (from the outgoing webhook) + TEAMS_WEBHOOK_URL.
import { askAgent, routeAgent, PROMPTS } from './_lib.js';
import { readRaw, verifyTeams, later, teamsPost } from './_integrations.js';

export const config = { maxDuration: 300 };
const nameOf = id => (PROMPTS[id].match(/You are (Cognitive [\w ]+?),/) || [])[1] || id;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const raw = await readRaw(req);
  if (!verifyTeams(req, raw)) return res.status(401).json({ type: 'message', text: 'Unauthorized.' });
  const activity = JSON.parse(raw || '{}');
  const clean = String(activity.text || '').replace(/<at>[^<]*<\/at>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').trim();
  const { agentId, text } = routeAgent(clean);
  later((async () => {
    let reply; try { reply = await askAgent(agentId, text || 'Introduce yourself briefly.'); } catch (e) { reply = `⚠️ ${e.message}`; }
    await teamsPost(`${nameOf(agentId)} — ${(text || '').slice(0, 120)}`, reply);
  })());
  return res.status(200).json({ type: 'message', text: `⏳ ${nameOf(agentId)} is working on it — the answer will post in this channel shortly.` });
}
