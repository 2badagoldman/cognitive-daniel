// Slack app: @mention the bot or use /cognitive. Prefix with an agent name to route, e.g. "qa: test plan for checkout".
// Setup: SLACK_BOT_TOKEN (xoxb-…), SLACK_SIGNING_SECRET. Event Subscriptions + Slash Command URL: https://<your-app>/api/slack
import { askAgent, routeAgent, PROMPTS } from './_lib.js';
import { readRaw, verifySlack, later, slackPost } from './_integrations.js';

export const config = { maxDuration: 300 };
const toSlack = md => md.replace(/\*\*([^*]+)\*\*/g, '*$1*').replace(/^#{1,6}\s+(.+)$/gm, '*$1*').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<$2|$1>');
const nameOf = id => (PROMPTS[id].match(/You are (Cognitive [\w ]+?),/) || [])[1] || id;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const raw = await readRaw(req);
  if (!process.env.SLACK_SIGNING_SECRET || !verifySlack(req, raw)) return res.status(401).json({ error: 'Bad signature' });
  const ctype = String(req.headers['content-type'] || '');

  if (ctype.includes('application/x-www-form-urlencoded')) {
    const f = Object.fromEntries(new URLSearchParams(raw));
    const { agentId, text } = routeAgent(f.text);
    if (!text) return res.status(200).json({ response_type: 'ephemeral', text: 'Usage: `/cognitive [agent:] your request` — agents: ' + Object.keys(PROMPTS).join(', ') });
    later((async () => {
      let reply; try { reply = toSlack(await askAgent(agentId, text)); } catch (e) { reply = `:warning: ${e.message}`; }
      await fetch(f.response_url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response_type: 'in_channel', replace_original: true, text: `*${nameOf(agentId)}* — ${text.slice(0, 150)}\n\n${reply}` }) });
    })());
    return res.status(200).json({ response_type: 'in_channel', text: `:hourglass_flowing_sand: ${nameOf(agentId)} is working on it…` });
  }

  const body = JSON.parse(raw || '{}');
  if (body.type === 'url_verification') return res.status(200).json({ challenge: body.challenge });
  if (req.headers['x-slack-retry-num']) return res.status(200).end(); // already handling the original delivery
  const ev = body.event || {};
  if (body.type === 'event_callback' && (ev.type === 'app_mention' || (ev.type === 'message' && ev.channel_type === 'im')) && !ev.bot_id && !ev.subtype) {
    const { agentId, text } = routeAgent(String(ev.text || '').replace(/<@[^>]+>/g, '').trim());
    later((async () => {
      let reply; try { reply = toSlack(await askAgent(agentId, text || 'Introduce yourself briefly.')); } catch (e) { reply = `:warning: ${e.message}`; }
      await slackPost(ev.channel, `*${nameOf(agentId)}*\n${reply}`, ev.thread_ts || ev.ts).catch(e => console.error(e));
    })());
  }
  return res.status(200).end();
}
