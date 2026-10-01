// Swarm orchestrator: turns a task into staged pipeline of specialist agents (same stage = runs in parallel).
import { AGENT_IDS, PLANNER_PROMPT, checkAccess, requireKey, callAnthropic, knowledgeBlock, cors } from './_lib.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkAccess(req, res)) return;
  const key = requireKey(res); if (!key) return;
  const task = String(req.body?.task || '').trim().slice(0, 8000);
  if (!task) return res.status(400).json({ error: 'Describe the task first.' });
  const repoNote = req.body?.repoName ? `\n\nThe user has connected the repository ${String(req.body.repoName).slice(0, 100)}.` : '';
  let r;
  try { r = await callAnthropic(key, { max_tokens: 1500, system: PLANNER_PROMPT + knowledgeBlock(req.body?.knowledge), messages: [{ role: 'user', content: task + repoNote }] }); }
  catch { return res.status(502).json({ error: 'Could not reach the model.' }); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || 'Upstream error.' });
  const text = data.content?.[0]?.text || '';
  let plan; try { plan = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { plan = null; }
  let steps = (plan?.steps || []).filter(s => AGENT_IDS.includes(s?.agent) && s.instruction).slice(0, 6)
    .map((s, i) => ({ agent: s.agent, instruction: String(s.instruction).slice(0, 1500), stage: Number.isInteger(s.stage) && s.stage > 0 ? s.stage : i + 1 }));
  if (!steps.length) return res.status(502).json({ error: 'The orchestrator could not build a plan. Try rephrasing the task.' });
  // Normalise stages to 1..n in order.
  const order = [...new Set(steps.map(s => s.stage))].sort((a, b) => a - b);
  steps = steps.map(s => ({ ...s, stage: order.indexOf(s.stage) + 1 })).sort((a, b) => a.stage - b.stage);
  return res.status(200).json({ summary: String(plan.summary || '').slice(0, 400), steps });
}
