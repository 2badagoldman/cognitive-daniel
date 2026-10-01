// Streams an agent reply as plain text. Keeps the Anthropic API key on the server.
import { PROMPTS, WIKI_PROMPT, REVIEW_PROMPT, checkAccess, requireKey, cleanMessages, repoBlock, knowledgeBlock, callAnthropic, cors } from './_lib.js';

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkAccess(req, res, { route: 'chat' })) return;
  const key = requireKey(res); if (!key) return;

  const { agentId, messages, repo, context, knowledge, purpose, diff } = req.body || {};
  const base = purpose === 'wiki' ? WIKI_PROMPT : purpose === 'review' ? REVIEW_PROMPT : PROMPTS[agentId];
  if (!base) return res.status(400).json({ error: 'Unknown agent.' });
  const clean = cleanMessages(messages);
  if (!clean) return res.status(400).json({ error: 'Conversation is too long or malformed. Clear the chat and try again.' });

  let system = base;
  if (context) system += `\n\n<swarm_context>\nYou are one step in a multi-agent pipeline. Work produced by earlier agents:\n${String(context).slice(0, 60000)}\n</swarm_context>\nBuild on that work rather than repeating it. Produce only your step's deliverable.`;
  if (purpose === 'review') system += `\n\n<pull_request_diff>\n${String(diff || '').slice(0, 150000)}\n</pull_request_diff>`;
  system += repoBlock(repo) + knowledgeBlock(knowledge);

  let upstream;
  try {
    upstream = await callAnthropic(key, { max_tokens: purpose ? 8000 : 4096, system, messages: clean, stream: true });
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach the model. Please try again.' });
  }
  if (!upstream.ok) {
    const data = await upstream.json().catch(() => ({}));
    return res.status(upstream.status).json({ error: data?.error?.message || 'Upstream error.' });
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-accel-buffering', 'no');

  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') res.write(ev.delta.text);
        else if (ev.type === 'message_delta' && ev.delta?.stop_reason === 'max_tokens') res.write('\n\n_[Reply hit the length limit. Ask me to continue.]_');
        else if (ev.type === 'error') res.write(`\n\n[Error: ${ev.error?.message || 'stream error'}]`);
      }
    }
  } catch (e) {
    res.write('\n\n[Connection interrupted.]');
  }
  res.end();
}
