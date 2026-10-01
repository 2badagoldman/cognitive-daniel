// Daniel on Vercel. One endpoint, several actions (keeps the project under the Hobby function limit):
//   Missions (v6):  POST /api/task?action=advance {state} → {state, events}    — one unit of work per call
//                   POST /api/task?action=resume  {state, settings} → {state}
//   Single task:    start | step | diff | pr | stop                              — v3–v5 clients (Lovable) keep working
//   Benchmarks:     POST /api/task?action=hidden-test {taskId, files:[{path,content}], command}
import { checkAccess, requireKey, cors } from './_lib.js';
import { sandboxes, shq, driverName, safePath } from './_sandbox.js';
import { cloneInfo, openPullRequest } from './_git.js';
import { commentOnTicket, notify } from './_integrations.js';
import { advanceMission, resumeMission, agentStep, danielSystem, changedFiles } from './_engine.js';

export const config = { maxDuration: 300 };
const BASH_CAP = Number(process.env.DANIEL_BASH_CAP_SEC || 150); // keeps each call inside the 300 s function limit

function allowed(res) {
  if (process.env.PORTAL_ACCESS_CODE || process.env.ALLOW_PUBLIC_AUTOPILOT === 'true') return true;
  res.status(403).json({ error: 'Daniel runs code and opens pull requests, so it is locked until you set PORTAL_ACCESS_CODE in Vercel (or ALLOW_PUBLIC_AUTOPILOT=true).' });
  return false;
}
const validRepo = r => r && typeof r === 'object' && ['github', 'gitlab'].includes(r.provider) && /^[\w.\-/]+$/.test(r.name || '') && /^[\w.\-/]+$/.test(r.branch || '');

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkAccess(req, res)) return;
  if (!allowed(res)) return;
  const action = req.query?.action || new URL(req.url, 'http://x').searchParams.get('action');
  const b = req.body || {};
  const S = sandboxes();
  try {
    if (action === 'advance') {
      const key = requireKey(res); if (!key) return;
      const s = b.state;
      if (!s || typeof s !== 'object' || !s.repo || !validRepo(s.repo) || !Array.isArray(s.tasks)) return res.status(400).json({ error: 'Invalid mission state.' });
      if (JSON.stringify(s).length > 4_000_000) return res.status(413).json({ error: 'Mission state too large.' });
      const out = await advanceMission(s, { key, sandboxes, cloneInfo, openPullRequest, notify, commentOnTicket, bashCapSec: BASH_CAP });
      return res.status(200).json(out);
    }
    if (action === 'resume') return res.status(200).json({ state: resumeMission(b.state, b.settings || {}) });

    if (action === 'start') {
      if (!requireKey(res)) return;
      if (!validRepo(b.repo)) return res.status(400).json({ error: 'Connect a GitHub or GitLab repo first.' });
      if (!String(b.task || '').trim()) return res.status(400).json({ error: 'Describe the task.' });
      const ci = cloneInfo(b.repo);
      const id = await S.create({ ...ci, branch: b.repo.branch });
      const box = await S.open(id);
      await box.exec(`git remote set-url origin ${shq(ci.publicUrl)}; git config user.email daniel@cognitive.ai; git config user.name "Daniel (Cognitive AI)"`, 30000);
      const probe = await box.exec(`echo "OS: $(uname -sr)"; echo "Tools: $(for t in node npm pnpm yarn python3 pip go cargo java mvn gradle ruby docker make; do command -v $t >/dev/null && printf "%s " $t; done)"; echo "Node: $(node -v 2>/dev/null)"; echo "Python: $(python3 -V 2>&1)"; echo "Top-level: $(ls -A | head -40 | tr '\\n' ' ')"; echo "Commit: $(git log -1 --format='%h %s' 2>/dev/null)"`, 30000);
      return res.status(200).json({ taskId: id, driver: driverName(), envInfo: probe.stdout.trim() });
    }

    if (!b.taskId || typeof b.taskId !== 'string') return res.status(400).json({ error: 'Missing taskId.' });
    const box = await S.open(b.taskId);

    if (action === 'step') {
      const key = requireKey(res); if (!key) return;
      if (!validRepo(b.repo)) return res.status(400).json({ error: 'Missing repo.' });
      const messages = Array.isArray(b.messages) ? b.messages : [];
      if (!messages.length || messages.length > 240) return res.status(400).json({ error: 'Conversation limit reached. Start a new task.' });
      const system = danielSystem({ repo: b.repo, goal: String(b.task || ''), ticket: b.ticket, envInfo: b.envInfo, playbook: b.playbook, knowledge: b.knowledge });
      const r = await agentStep({ key, box, system, messages, speed: b.speed, attempt: 1, bashCapSec: BASH_CAP });
      return res.status(200).json({ assistant: r.assistant, toolMessage: r.toolMessage, events: r.events, done: r.done, summary: r.summary, testCommand: r.testCommand, testsVerified: r.testsVerified, stopReason: r.stopReason, usage: r.usage, model: r.model, tier: r.tier, cost: r.cost });
    }
    if (action === 'diff') {
      const base = /^[0-9a-f]{7,40}$/.test(b.base || '') ? b.base : 'HEAD';
      await box.exec('git add -A -N .', 30000);
      const stat = await box.exec(`git -c color.ui=never diff --stat ${base}`, 60000);
      const diff = await box.exec(`git -c color.ui=never diff ${base}`, 60000);
      return res.status(200).json({ stat: stat.stdout, diff: diff.stdout });
    }
    if (action === 'pr') {
      if (!validRepo(b.repo)) return res.status(400).json({ error: 'Missing repo.' });
      const base = /^[0-9a-f]{7,40}$/.test(b.base || '') ? b.base : 'HEAD';
      const changes = await changedFiles(box, base);
      if (changes.some(c => c.content && c.content.length > 5 * 1024 * 1024)) return res.status(400).json({ error: 'A changed file is larger than 5 MB; remove it before opening a PR.' });
      const title = String(b.title || 'Changes by Daniel').slice(0, 200);
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'change';
      const body = `${String(b.summary || '').slice(0, 20000)}\n\n---\n` + (b.testCommand ? `**Verified:** \`${b.testCommand}\` passed in an isolated sandbox before this ${b.repo.provider === 'gitlab' ? 'MR' : 'PR'} was opened.\n\n` : '') + (b.ticket?.url ? `**Ticket:** [${b.ticket.id}](${b.ticket.url})\n\n` : '') + `_Opened by Daniel, Cognitive AI. Review before merging._`;
      const pr = await openPullRequest(b.repo, { branch: `daniel/${slug}-${Date.now().toString(36)}`, title, body, changes });
      const f = await Promise.allSettled([b.ticket ? commentOnTicket(b.ticket, `Daniel opened a ${pr.kind} for this: ${pr.url}`) : Promise.resolve(false), notify({ title: `Daniel opened a ${pr.kind} on ${b.repo.name}`, text: `${title}\n${changes.length} file(s) changed${b.testCommand ? ` · tests passing (${b.testCommand})` : ''}`, url: pr.url })]);
      return res.status(200).json({ ...pr, branch: pr.branch || `daniel/${slug}`, files: changes.length, ticketCommented: f[0].value === true, notified: f[1].value || [] });
    }
    if (action === 'hidden-test') {
      for (const f of (Array.isArray(b.files) ? b.files : []).slice(0, 50)) await box.writeFile(safePath(f.path), String(f.content ?? ''));
      const r = await box.exec(String(b.command || 'true'), BASH_CAP * 1000);
      return res.status(200).json({ passed: r.exitCode === 0, exitCode: r.exitCode, output: (r.stdout + '\n' + r.stderr).slice(-8000) });
    }
    if (action === 'stop') { await box.stop(); return res.status(200).json({ stopped: true }); }
    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    return res.status(e.status && e.status < 600 ? e.status : 500).json({ error: String(e.message || e).replace(/https:\/\/[^@\s]+@/g, 'https://***@').slice(0, 600) });
  }
}
