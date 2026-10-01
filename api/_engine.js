// Daniel — Cognitive AI's autonomous engineering engine.
// One engine, three hosts: Vercel (the browser drives `advanceMission` one unit at a time),
// the local runner (a server loop drives it and persists state to disk), and the desktop app.
import { MODEL, FAST_MODEL, MAX_MODEL, callAnthropic, knowledgeBlock } from './_lib.js';
import { safePath, shq } from './_sandbox.js';

/* ---------------- pricing (USD per million tokens; estimates, override with env) ---------------- */
const PRICE = {
  fast: [Number(process.env.PRICE_FAST_IN || 1), Number(process.env.PRICE_FAST_OUT || 5)],
  main: [Number(process.env.PRICE_MAIN_IN || 3), Number(process.env.PRICE_MAIN_OUT || 15)],
  max: [Number(process.env.PRICE_MAX_IN || 5), Number(process.env.PRICE_MAX_OUT || 25)]
};
export function costOf(tier, u = {}) {
  const [pin, pout] = PRICE[tier] || PRICE.main;
  const input = (u.input_tokens || 0) + 1.25 * (u.cache_creation_input_tokens || 0) + 0.1 * (u.cache_read_input_tokens || 0);
  return (input * pin + (u.output_tokens || 0) * pout) / 1e6;
}
function addUsage(total, tier, u) {
  total.input += (u?.input_tokens || 0) + (u?.cache_creation_input_tokens || 0) + (u?.cache_read_input_tokens || 0);
  total.output += u?.output_tokens || 0;
  total.cost = +(total.cost + costOf(tier, u)).toFixed(4);
  total.calls = (total.calls || 0) + 1;
  total.byTier = total.byTier || {}; total.byTier[tier] = (total.byTier[tier] || 0) + 1;
}

/* ---------------- tools ---------------- */
export const TOOLS = [
  { name: 'bash', description: 'Run a shell command in the repository root inside the sandbox (bash). Use for installing dependencies, running tests/builds/linters, git inspection and file discovery. Output is truncated to ~12k chars. Default timeout 120s, max 240s.',
    input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout_sec: { type: 'integer', minimum: 5, maximum: 240 } }, required: ['command'] } },
  { name: 'read_file', description: 'Read a text file (path relative to repo root). Optionally a 1-based inclusive line range. Returns numbered lines.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] } },
  { name: 'write_file', description: 'Create or overwrite a file with the full content given. Prefer edit_file for small changes.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', description: 'Replace one exact occurrence of old_str with new_str. old_str must match exactly once (include surrounding lines).',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['path', 'old_str', 'new_str'] } },
  { name: 'search', description: 'Search file contents with a regular expression (grep -rnE), skipping node_modules/.git. Up to 200 matches.',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  { name: 'finish', description: 'Call when the current task is complete. test_command is re-run by the platform and MUST exit 0 or you will be told to keep working. If the change truly cannot be tested, leave test_command empty and explain in no_tests_reason.',
    input_schema: { type: 'object', properties: { summary: { type: 'string' }, test_command: { type: 'string' }, no_tests_reason: { type: 'string' } }, required: ['summary'] } }
];

export function danielSystem({ repo, goal, ticket, envInfo, playbook, knowledge, name = 'Daniel' }) {
  return `You are ${name}, Cognitive AI's autonomous senior software engineer. You work inside an isolated sandbox where the repository ${repo.name} (branch ${repo.branch}) is checked out at the working directory, with full shell access through tools.

How you work:
1. Explore just enough to understand the relevant code and how tests run (package scripts, pytest, Makefile, CI config).
2. Plan briefly, then make the smallest correct change that follows the repository's conventions.
3. Add or update tests that prove the change.
4. Install dependencies if needed, run the tests, read failures carefully, fix, and re-run until they pass. Run the broader suite when it is reasonably fast.
5. Call finish with a clear summary and the exact test_command that proves the work. The platform re-runs it; the task only completes when it exits 0.

Never give up early and never stop halfway: if something fails, diagnose it and try another approach. If you are blocked by something outside the repo (missing credentials, network), say exactly what is needed in your finish summary and use no_tests_reason.
Rules: do not commit, push, or change git config — the platform commits each finished task and opens the pull request. Never print or exfiltrate secrets. Do not modify unrelated files. Batch related shell commands with && to move fast. Keep narration to one or two short sentences before tool calls.

Environment:
${envInfo || '(unknown)'}
${ticket ? `\nLinked ticket (${ticket.source} ${ticket.id}): ${ticket.title}\n${String(ticket.body || '').slice(0, 6000)}\n` : ''}${playbook ? `\nFollow this playbook (${String(playbook.name || '').slice(0, 80)}):\n${String(playbook.instructions || '').slice(0, 6000)}\n` : ''}
Overall goal:
${goal}` + knowledgeBlock(knowledge);
}

export async function runTool(box, name, input, env, bashCapSec = 240) {
  const fmt = r => [r.stdout, r.stderr && `[stderr]\n${r.stderr}`].filter(Boolean).join('\n').trim() + `\n[exit code ${r.exitCode}]`;
  switch (name) {
    case 'bash': {
      const t = Math.min(Math.max(+input.timeout_sec || 120, 5), bashCapSec) * 1000;
      const r = await box.exec(String(input.command || ''), t, env);
      return { ok: r.exitCode === 0, exitCode: r.exitCode, output: fmt(r) };
    }
    case 'read_file': {
      const p = safePath(input.path); const buf = await box.readFile(p);
      if (!buf) return { ok: false, output: `File not found: ${p}` };
      const lines = buf.toString('utf8').split('\n');
      const s = Math.max(1, +input.start_line || 1), e = Math.min(lines.length, +input.end_line || Math.min(lines.length, s + 399));
      let out = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}  ${l}`).join('\n');
      if (e < lines.length) out += `\n… (${lines.length} lines total; request a range to see more)`;
      return { ok: true, output: out.slice(0, 40000) };
    }
    case 'write_file': {
      const p = safePath(input.path); await box.writeFile(p, String(input.content ?? ''));
      return { ok: true, output: `Wrote ${p} (${String(input.content ?? '').split('\n').length} lines).` };
    }
    case 'edit_file': {
      const p = safePath(input.path); const buf = await box.readFile(p);
      if (!buf) return { ok: false, output: `File not found: ${p}` };
      const src = buf.toString('utf8'), oldS = String(input.old_str ?? '');
      const count = oldS ? src.split(oldS).length - 1 : 0;
      if (count !== 1) return { ok: false, output: `old_str matched ${count} times in ${p}; it must match exactly once. Read the file and include more context.` };
      await box.writeFile(p, src.replace(oldS, () => String(input.new_str ?? '')));
      return { ok: true, output: `Edited ${p}.` };
    }
    case 'search': {
      const p = safePath(input.path || '.');
      const r = await box.exec(`grep -rnIE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build -- ${shq(input.pattern)} ${shq(p)} | head -200`, 60000);
      return { ok: true, output: r.stdout.trim() || 'No matches.' };
    }
    default: return { ok: false, output: `Unknown tool ${name}` };
  }
}

/* ---------------- model routing ---------------- */
// Fast model for exploration; main model once code changes or something fails; max model on retries or when stuck.
export function chooseModel({ speed = 'fast', messages = [], attempt = 1, stuck = false }) {
  if (speed === 'max' || stuck || attempt >= 3) return { model: MAX_MODEL, tier: 'max' };
  if (speed === 'normal' || attempt >= 2) return { model: MODEL, tier: 'main' };
  let edited = false;
  for (const m of messages) if (m.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_use' && ['edit_file', 'write_file', 'finish'].includes(b.name)) edited = true;
  const last = messages[messages.length - 1];
  const failed = last && Array.isArray(last.content) && last.content.some(b => b.type === 'tool_result' && b.is_error);
  return edited || failed ? { model: MODEL, tier: 'main' } : { model: FAST_MODEL, tier: 'fast' };
}
// Backwards-compatible name used by v4 tests.
export const pickModel = (speed, messages) => chooseModel({ speed, messages });

export function withCache(messages) {
  const out = messages.map(m => ({ ...m }));
  const last = out[out.length - 1];
  if (last) {
    const content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.map(b => ({ ...b }));
    content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: 'ephemeral' } };
    last.content = content;
  }
  return out;
}

/* ---------------- V7: verification integrity ---------------- */
// Test files: the most common way an agent fakes a green run is by editing or deleting the tests.
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)\/|(^|\/)test_[^/]+\.py$|_test\.(py|go|rb)$|\.(test|spec)\.[cm]?[jt]sx?$|(Test|Tests|IT)\.(java|kt|scala)$|_spec\.rb$/;
export const isTestPath = p => TEST_PATH.test(String(p || ''));
// Changes to EXISTING tests are flagged; new test files are encouraged.
export function testIntegrityViolations(changes = [], { allow = false } = {}) {
  if (allow) return [];
  return changes.filter(c => isTestPath(c.path) && (c.status === 'modified' || c.status === 'deleted')).map(c => `${c.status} ${c.path}`);
}
// A goal or task that explicitly asks to change tests lifts the guard.
export const goalAllowsTestEdits = text => /\b(update|rewrite|change|edit|refactor|modify|delete|remove|migrate)\b[^.\n]{0,40}\btests?\b|\btests?\b[^.\n]{0,20}\b(are|is) (wrong|outdated|broken|incorrect)/i.test(String(text || ''));
// Commands that exit 0 without proving anything.
export function isTrivialCommand(cmd) {
  const c = String(cmd || '').trim();
  if (!c) return false;
  if (/^(true|:|exit 0|pwd)$/i.test(c) || /^(echo|printf|ls|cat)\b[^&;|]*$/i.test(c)) return true;
  if (/\|\|\s*(true|:|exit 0)\s*$/i.test(c)) return true;          // "npm test || true"
  if (/;\s*(true|exit 0)\s*$/i.test(c)) return true;                 // "npm test; true"
  if (/(--passWithNoTests|-k\s+["']?nonexistent|--testNamePattern\s+["']?\$)/i.test(c)) return true;
  return false;
}
// Detect the toolchains a repo needs from its file list and return a bootstrap script for the sandbox.
export function detectStacks(listing) {
  const f = String(listing || '').split('\n').map(x => x.trim()).filter(Boolean);
  const has = re => f.some(x => re.test(x));
  return {
    node: has(/(^|\/)package\.json$/), python: has(/(^|\/)(requirements[^/]*\.txt|pyproject\.toml|setup\.py|Pipfile)$|\.py$/),
    go: has(/(^|\/)go\.mod$/), java: has(/(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/), maven: has(/(^|\/)pom\.xml$/),
    gradle: has(/(^|\/)build\.gradle(\.kts)?$/), rust: has(/(^|\/)Cargo\.toml$/), ruby: has(/(^|\/)Gemfile$/)
  };
}
export function toolchainScript(st) {
  const pk = [];
  if (st.python) pk.push('python3 python3-pip');
  if (st.go) pk.push('golang');
  if (st.java) pk.push('java-17-amazon-corretto-devel');
  if (st.maven) pk.push('maven');
  if (st.ruby) pk.push('ruby ruby-devel');
  const lines = ['set +e', 'SUDO=$(command -v sudo >/dev/null && echo sudo)', 'PM=$(command -v dnf || command -v yum || command -v apt-get)'];
  const need = { python: 'python3', go: 'go', java: 'java', maven: 'mvn', ruby: 'ruby' };
  const miss = Object.entries(need).filter(([k]) => st[k]).map(([, bin]) => bin);
  if (pk.length) lines.push(`MISSING=""; for b in ${miss.join(' ')}; do command -v $b >/dev/null || MISSING="$MISSING $b"; done`, `if [ -n "$MISSING" ]; then echo "Installing toolchains:$MISSING"; case "$PM" in *apt-get) $SUDO $PM update -qq >/dev/null 2>&1; $SUDO $PM install -y -qq ${pk.join(' ').replace('java-17-amazon-corretto-devel', 'openjdk-17-jdk').replace('ruby-devel', 'ruby-dev')} >/dev/null 2>&1;; *) $SUDO $PM install -y -q ${pk.join(' ')} >/dev/null 2>&1;; esac; fi`);
  if (st.rust) lines.push('command -v cargo >/dev/null || { curl -sSf https://sh.rustup.rs | sh -s -- -y -q --profile minimal >/dev/null 2>&1; }', '[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"');
  lines.push('echo "Toolchains: $(for t in node python3 go java mvn gradle cargo ruby; do command -v $t >/dev/null && printf "%s " $t; done)"');
  return lines.join('\n');
}

const sig = s => { let h = 0; for (const c of String(s).replace(/\d+(\.\d+)?m?s\b/g, '').slice(0, 4000)) h = (h * 31 + c.charCodeAt(0)) | 0; return h; };

/* ---------------- one agent turn ---------------- */
export async function agentStep({ key, box, system, messages, speed, attempt, stuck, env, extraVerify, guardTests = false, bashCapSec = 240, maxTokens = 8000 }) {
  const route = chooseModel({ speed, messages, attempt, stuck });
  const tools = TOOLS.map((t, i) => (i === TOOLS.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t));
  const r = await callAnthropic(key, { model: route.model, max_tokens: maxTokens, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], tools, messages: withCache(messages) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data?.error?.message || `Model error (${r.status}).`); e.status = r.status; e.retryable = r.status === 429 || r.status >= 500; throw e; }

  const assistant = { role: 'assistant', content: data.content };
  const events = [], results = [];
  let done = false, summary = '', testCommand = '', testsVerified = false, verifyFailSig = null, noTestsReason = '';
  const fmt = t => [t.stdout, t.stderr && `[stderr]\n${t.stderr}`].filter(Boolean).join('\n').trim() + `\n[exit code ${t.exitCode}]`;
  for (const block of data.content || []) {
    if (block.type === 'text' && block.text.trim()) events.push({ type: 'text', text: block.text });
    if (block.type !== 'tool_use') continue;
    if (block.name === 'finish') {
      const cmd = String(block.input?.test_command || '').trim();
      if (isTrivialCommand(cmd)) {
        results.push({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: `Rejected: \`${cmd}\` exits 0 without proving the change. Give the real test command for this project (for example \`npm test\`, \`pytest\`, \`go test ./...\`).` });
        events.push({ type: 'verify', command: cmd, ok: false, output: 'Rejected: trivial test command.' });
        continue;
      }
      if (guardTests) {
        const changes = await changedFiles(box, 'HEAD');
        const bad = testIntegrityViolations(changes);
        if (bad.length) {
          results.push({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: `Rejected: the goal does not ask you to change existing tests, but these test files were changed:\n${bad.join('\n')}\nRestore them (git checkout -- <file>) and fix the code under test instead. Adding NEW test files is fine.` });
          events.push({ type: 'verify', command: '(test integrity)', ok: false, output: `Rejected: existing tests changed — ${bad.join(', ')}` });
          continue;
        }
      }
      const checks = [cmd, extraVerify].filter(Boolean);
      let failed = null;
      for (const c of checks) {
        const t = await box.exec(c, Math.min(bashCapSec, 240) * 1000, env);
        const out = fmt(t);
        events.push({ type: 'verify', command: c, ok: t.exitCode === 0, exitCode: t.exitCode, output: out });
        if (t.exitCode !== 0) { failed = { c, out, code: t.exitCode }; verifyFailSig = sig(out); break; }
      }
      if (failed) { results.push({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: `Verification failed — the platform re-ran \`${failed.c}\` and it exited ${failed.code}. Keep working until it passes.\n\n${failed.out}` }); continue; }
      if (!cmd && !String(block.input?.no_tests_reason || '').trim()) {
        results.push({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: 'finish requires a test_command that proves the change (or a no_tests_reason if it genuinely cannot be tested). Run the tests, then call finish again.' });
        events.push({ type: 'verify', command: '(none given)', ok: false, output: 'Rejected: no test command.' });
        continue;
      }
      testsVerified = !!cmd; done = true; summary = String(block.input?.summary || ''); testCommand = cmd; noTestsReason = String(block.input?.no_tests_reason || '');
      results.push({ type: 'tool_result', tool_use_id: block.id, content: 'Accepted. Task complete.' });
      events.push({ type: 'finish', summary, testCommand, testsVerified, noTestsReason });
      continue;
    }
    let out;
    try { out = await runTool(box, block.name, block.input || {}, env, bashCapSec); } catch (e) { out = { ok: false, output: String(e.message || e) }; }
    events.push({ type: 'tool', name: block.name, input: block.input, ok: out.ok, exitCode: out.exitCode, output: out.output });
    results.push({ type: 'tool_result', tool_use_id: block.id, content: out.output || '(no output)', ...(out.ok ? {} : { is_error: true }) });
  }
  let toolMessage = results.length ? { role: 'user', content: results } : null;
  if (!results.length && !done) toolMessage = { role: 'user', content: 'Continue working. When the task is complete and tests pass, call the finish tool.' };
  return { assistant, toolMessage, events, done, summary, testCommand, testsVerified, noTestsReason, verifyFailSig, model: route.model, tier: route.tier, usage: data.usage || {}, cost: costOf(route.tier, data.usage), stopReason: data.stop_reason };
}

/* ---------------- context compaction ---------------- */
export const needsCompaction = messages => messages.length > 44 || JSON.stringify(messages).length > 280000;
export async function compact({ key, task, messages }) {
  const flat = messages.map(m => {
    if (typeof m.content === 'string') return `${m.role.toUpperCase()}: ${m.content}`;
    return m.content.map(b => b.type === 'text' ? `${m.role.toUpperCase()}: ${b.text}` : b.type === 'tool_use' ? `TOOL ${b.name}: ${JSON.stringify(b.input).slice(0, 600)}` : b.type === 'tool_result' ? `RESULT${b.is_error ? ' (error)' : ''}: ${String(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 1200)}` : '').join('\n');
  }).join('\n').slice(-120000);
  const r = await callAnthropic(key, { model: FAST_MODEL, max_tokens: 1500, system: 'You summarise an engineering agent\'s work so it can continue with a fresh context. Be specific and terse.', messages: [{ role: 'user', content: `Task: ${task}\n\nTranscript (oldest first):\n${flat}\n\nWrite: 1) files changed and why, 2) what was tried and what failed (exact error lines), 3) current state of tests, 4) the next 3 concrete steps.` }] });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d?.error?.message || 'Compaction failed'), { retryable: true });
  return { note: d.content?.map(b => b.text || '').join('') || '(no summary)', usage: d.usage };
}

/* ---------------- planning ---------------- */
export async function planMission({ key, goal, repoName, listing, readme, knowledge, maxTasks }) {
  const system = `You are Daniel's planner. Break an engineering goal into an ordered list of 1 to ${maxTasks} concrete, independently verifiable tasks for an autonomous engineer working in the repository. Small goals should be ONE task. Each task must be completable in one focused session and end with passing tests. Order tasks so each builds on the previous ones.
Respond with ONLY JSON: {"summary":"one sentence","tasks":[{"title":"imperative, <70 chars","detail":"what to change and where","acceptance":"how we know it is done, including the test that proves it"}]}` + knowledgeBlock(knowledge);
  const r = await callAnthropic(key, { model: MODEL, max_tokens: 3000, system, messages: [{ role: 'user', content: `Repository: ${repoName}\n\nFiles:\n${String(listing).slice(0, 12000)}\n\nREADME:\n${String(readme || '').slice(0, 6000)}\n\nGoal:\n${goal}` }] });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d?.error?.message || 'Planning failed'), { retryable: r.status === 429 || r.status >= 500 });
  const text = d.content?.map(b => b.text || '').join('') || '';
  let plan; try { plan = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { plan = null; }
  const tasks = (plan?.tasks || []).filter(t => t?.title).slice(0, maxTasks).map(t => ({ title: String(t.title).slice(0, 120), detail: String(t.detail || '').slice(0, 3000), acceptance: String(t.acceptance || '').slice(0, 1500) }));
  if (!tasks.length) tasks.push({ title: String(goal).split('\n')[0].slice(0, 110), detail: goal, acceptance: 'Tests covering the change pass.' });
  return { summary: String(plan?.summary || '').slice(0, 300), tasks, usage: d.usage };
}

/* ---------------- git helpers ---------------- */
export async function changedFiles(box, base = 'HEAD') {
  await box.exec('git add -A', 60000);
  const r = await box.exec(`git diff --cached --raw -z --no-renames ${shq(base)}`, 60000);
  const parts = r.stdout.split('\0').filter(Boolean); const changes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i].trim().split(/\s+/); const path = parts[i + 1];
    changes.push({ path, status: meta[4] === 'A' ? 'added' : meta[4] === 'D' ? 'deleted' : 'modified', executable: meta[1] === '100755' });
  }
  await box.exec('git reset -q', 60000);
  for (const c of changes) if (c.status !== 'deleted') { c.content = await box.readFile(c.path); if (!c.content) c.status = 'deleted'; }
  return changes;
}

/* ---------------- missions: plan → work every task to verified → PR ---------------- */
export const DEFAULT_SETTINGS = { speed: 'fast', maxStepsPerTask: 25, maxAttempts: 3, maxTasks: 12, budgetUsd: 25, maxMinutes: 240, autoPR: true, setupScript: '', verifyCommand: '', guardTests: true, autoToolchains: true, agentName: 'Daniel' };

export function newMission({ goal, repo, ticket, playbook, knowledge, settings = {}, env = {} }) {
  return {
    id: 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), version: 7,
    goal: String(goal), repo, ticket: ticket || null, playbook: playbook || null, knowledge: knowledge || '',
    settings: { ...DEFAULT_SETTINGS, ...settings }, env: env || {},
    phase: 'setup', tasks: [], cur: null, steps: 0, errors: 0,
    usage: { input: 0, output: 0, cost: 0, calls: 0, byTier: {} },
    startedAt: Date.now(), updatedAt: Date.now()
  };
}

function taskPrompt(s, t) {
  const i = s.tasks.indexOf(t);
  const done = s.tasks.filter(x => x.status === 'done').map(x => `- ${x.title}`).join('\n');
  return `Your current task (${i + 1} of ${s.tasks.length}): ${t.title}\n\n${t.detail}\n\nAcceptance criteria: ${t.acceptance}\n\n${done ? `Already completed and committed in this mission:\n${done}\n\n` : ''}Work only on this task, then call finish.`;
}

/**
 * Advance a mission by one unit of work. Pure state machine: the caller persists `state`.
 * deps: { key, sandboxes, cloneInfo, openPullRequest, notify, commentOnTicket, exportLocal? }
 */
export async function advanceMission(state, deps) {
  const s = state, ev = [];
  const log = e => ev.push({ t: Date.now(), task: s.cur, ...e });
  s.updatedAt = Date.now();
  if (['done', 'stopped', 'paused', 'failed'].includes(s.phase)) return { state: s, events: ev };

  // Hard limits keep a "never stop" loop safe: the mission pauses (resumable) instead of running away.
  const minutes = (Date.now() - s.startedAt) / 60000;
  if (s.usage.cost >= s.settings.budgetUsd) return pause(s, log, `Budget cap reached ($${s.usage.cost.toFixed(2)} of $${s.settings.budgetUsd}). Raise the cap to continue.`, ev);
  if (minutes >= s.settings.maxMinutes) return pause(s, log, `Time cap reached (${Math.round(minutes)} min). Raise the cap to continue.`, ev);

  try {
    const S = deps.sandboxes();
    if (s.phase === 'setup') {
      if (!s.taskId) {
        log({ type: 'info', text: s.repo.provider === 'local' ? `Copying ${s.repo.name} into an isolated workspace…` : 'Starting an isolated sandbox and cloning the repository…' });
        const ci = s.repo.provider === 'local' ? { localPath: s.repo.path } : deps.cloneInfo(s.repo);
        s.taskId = await S.create({ ...ci, branch: s.repo.provider === 'local' ? null : s.repo.branch });
        const box = await S.open(s.taskId);
        if (ci.publicUrl) await box.exec(`git remote set-url origin ${shq(ci.publicUrl)}`, 30000);
        await box.exec('git config user.email daniel@cognitive.ai && git config user.name "Daniel (Cognitive AI)"', 30000);
        s.baseSha = (await box.exec('git rev-parse HEAD', 30000)).stdout.trim();
        const probe = await box.exec(`echo "OS: $(uname -sr)"; echo "Tools: $(for t in node npm pnpm yarn python3 pip go cargo java mvn gradle ruby make; do command -v $t >/dev/null && printf "%s " $t; done)"; echo "Node: $(node -v 2>/dev/null)"; echo "Python: $(python3 -V 2>&1)"; echo "Top-level: $(ls -A | head -40 | tr '\\n' ' ')"; echo "Commit: $(git log -1 --format='%h %s' 2>/dev/null)"`, 30000);
        s.envInfo = probe.stdout.trim();
        log({ type: 'info', text: `Workspace ready. ${s.envInfo.split('\n').find(l => l.startsWith('Commit')) || ''}` });
        return { state: s, events: ev };
      }
      if (s.settings.autoToolchains !== false && !s.toolchainsDone) {
        const box = await S.open(s.taskId);
        const st = detectStacks((await box.exec('git ls-files | head -2000', 30000)).stdout);
        if (st.python || st.go || st.java || st.rust || st.ruby) {
          log({ type: 'info', text: 'Preparing toolchains for this repository…' });
          const r = await box.exec(toolchainScript(st), 240000, s.env);
          const line = (r.stdout.match(/Toolchains: .*/) || [''])[0];
          if (line) s.envInfo = `${s.envInfo}\n${line}`;
          log({ type: 'tool', name: 'bash', input: { command: '(toolchain bootstrap)' }, ok: r.exitCode === 0, exitCode: r.exitCode, output: `[toolchains]\n${r.stdout}\n${r.stderr}`.slice(0, 6000) });
        }
        s.toolchainsDone = true;
        return { state: s, events: ev };
      }
      if (s.settings.setupScript && !s.setupDone) {
        const box = await S.open(s.taskId);
        const r = await box.exec(s.settings.setupScript, 240000, s.env);
        log({ type: 'tool', name: 'bash', input: { command: s.settings.setupScript }, ok: r.exitCode === 0, exitCode: r.exitCode, output: `[environment setup]\n${r.stdout}\n${r.stderr}`.slice(0, 12000) });
      }
      s.setupDone = true; s.phase = 'planning';
      return { state: s, events: ev };
    }

    const box = await S.open(s.taskId);

    if (s.phase === 'planning') {
      log({ type: 'info', text: 'Planning the work…' });
      const listing = (await box.exec('git ls-files | head -400', 30000)).stdout;
      const readme = (await box.readFile('README.md'))?.toString('utf8') || '';
      const plan = await planMission({ key: deps.key, goal: s.goal, repoName: s.repo.name, listing, readme, knowledge: s.knowledge, maxTasks: s.settings.maxTasks });
      addUsage(s.usage, 'main', plan.usage);
      s.summary = plan.summary;
      s.tasks = plan.tasks.map((t, i) => ({ id: i + 1, ...t, status: 'pending', attempts: 0, steps: 0, messages: [], failSigs: [] }));
      s.phase = 'working';
      log({ type: 'plan', summary: plan.summary, tasks: s.tasks.map(t => t.title) });
      return { state: s, events: ev };
    }

    if (s.phase === 'working') {
      let t = s.tasks.find(x => x.status === 'running') || s.tasks.find(x => x.status === 'pending');
      if (!t) {
        const b = s.tasks.find(x => x.status === 'blocked' && !x.revisited);
        if (b) {
          b.revisited = true; b.status = 'running'; b.attempts = Math.max(1, s.settings.maxAttempts - 1); b.steps = 0; b.messages = []; b.failSigs = [];
          t = b; log({ type: 'info', text: `Revisiting blocked task "${b.title}" with the strongest model now that other tasks are done.` });
        } else { s.phase = 'finalizing'; return { state: s, events: ev }; }
      }
      s.cur = s.tasks.indexOf(t);
      if (t.status === 'pending') { t.status = 'running'; t.attempts = 1; t.startedAt = Date.now(); log({ type: 'task', status: 'started', title: t.title, index: s.cur }); }
      if (!t.messages.length) t.messages = [{ role: 'user', content: taskPrompt(s, t) + (t.carryNote || '') }];

      if (needsCompaction(t.messages)) {
        const c = await compact({ key: deps.key, task: t.title, messages: t.messages });
        addUsage(s.usage, 'fast', c.usage);
        t.messages = [{ role: 'user', content: `${taskPrompt(s, t)}\n\nYour earlier context was compacted. Progress so far:\n${c.note}\n\nContinue from here.` }];
        log({ type: 'info', text: 'Context compacted so the work can continue without losing track.' });
        return { state: s, events: ev };
      }

      const system = danielSystem({ repo: s.repo, goal: s.goal, ticket: s.ticket, envInfo: s.envInfo, playbook: s.playbook, knowledge: s.knowledge, name: s.settings.agentName });
      const r = await agentStep({ key: deps.key, box, system, messages: t.messages, speed: s.settings.speed, attempt: t.attempts, stuck: !!t.stuck, env: s.env, extraVerify: s.settings.verifyCommand, guardTests: s.settings.guardTests !== false && !goalAllowsTestEdits(`${s.goal}\n${t.title}\n${t.detail}`), bashCapSec: deps.bashCapSec || 240 });
      addUsage(s.usage, r.tier, r.usage);
      t.steps++; s.steps++; s.errors = 0;
      t.messages.push(r.assistant); if (r.toolMessage) t.messages.push(r.toolMessage);
      r.events.forEach(e => log({ ...e, tier: r.tier }));

      // Stuck detection: the same verification failure three times → escalate to the strongest model with recovery guidance.
      if (r.verifyFailSig != null) {
        t.failSigs.push(r.verifyFailSig);
        const last3 = t.failSigs.slice(-3);
        if (last3.length === 3 && last3.every(x => x === last3[0]) && !t.stuck) {
          t.stuck = true;
          const tm = t.messages[t.messages.length - 1];
          if (tm?.role === 'user' && Array.isArray(tm.content)) tm.content.push({ type: 'text', text: 'You have hit the same failure three times. Stop repeating the same fix. Re-read the full error, re-check your assumptions about the code, consider reverting your last change, and try a genuinely different approach.' });
          log({ type: 'info', text: 'Same failure three times — switching to the strongest model with recovery guidance.' });
        }
      }

      if (r.done) {
        const c = await box.exec(`git add -A && git commit -q --no-verify -m ${shq(`${t.title}\n\n${r.summary}`.slice(0, 4000))} && git rev-parse --short HEAD`, 60000);
        t.commit = c.exitCode === 0 ? c.stdout.trim().split('\n').pop() : null;
        Object.assign(t, { status: 'done', summary: r.summary, testCommand: r.testCommand, verified: r.testsVerified, noTestsReason: r.noTestsReason, finishedAt: Date.now(), messages: [], stuck: false });
        log({ type: 'task', status: 'done', title: t.title, index: s.cur, commit: t.commit, verified: t.verified });
        return { state: s, events: ev };
      }

      if (t.steps >= s.settings.maxStepsPerTask * t.attempts) {
        if (t.attempts < s.settings.maxAttempts) {
          const c = await compact({ key: deps.key, task: t.title, messages: t.messages });
          addUsage(s.usage, 'fast', c.usage);
          const stat = (await box.exec('git diff --stat HEAD', 30000)).stdout.trim();
          t.attempts++; t.stuck = false; t.failSigs = [];
          t.messages = [{ role: 'user', content: `${taskPrompt(s, t)}\n\nAttempt ${t.attempts} of ${s.settings.maxAttempts}. The previous attempt ran out of steps. What happened:\n${c.note}\n\nUncommitted changes right now:\n${stat || '(none)'}\n\nTake a different approach. Keep what is useful, revert what is not.` }];
          log({ type: 'task', status: 'retry', title: t.title, index: s.cur, attempt: t.attempts });
        } else {
          t.partialDiff = (await box.exec('git diff HEAD', 30000)).stdout.slice(0, 20000);
          await box.exec('git reset -q --hard && git clean -fdq', 60000);
          Object.assign(t, { status: 'blocked', messages: [], blockedAt: Date.now() });
          log({ type: 'task', status: 'blocked', title: t.title, index: s.cur });
        }
      }
      return { state: s, events: ev };
    }

    if (s.phase === 'finalizing') {
      const done = s.tasks.filter(t => t.status === 'done'), blocked = s.tasks.filter(t => t.status === 'blocked');
      s.outcome = { done: done.length, blocked: blocked.length, total: s.tasks.length };
      if (!done.length) { s.phase = 'done'; s.finishedAt = Date.now(); log({ type: 'mission', status: 'done', text: 'No task could be completed. See the blocked tasks for what went wrong.' }); return { state: s, events: ev }; }
      const title = (s.ticket ? `${s.ticket.id}: ` : '') + (s.summary || s.goal.split('\n')[0]).slice(0, 110);
      const body = `${s.summary || s.goal}\n\n### Completed by ${s.settings.agentName}\n${done.map(t => `- [x] **${t.title}**${t.verified ? ` — verified with \`${t.testCommand}\`` : ''}${t.commit ? ` (${t.commit})` : ''}`).join('\n')}${blocked.length ? `\n\n### Still open\n${blocked.map(t => `- [ ] ${t.title}`).join('\n')}` : ''}\n\n---\n_Opened by ${s.settings.agentName}, Cognitive AI. Every task above was verified in an isolated sandbox before commit${s.settings.guardTests !== false ? ', and no existing test was edited to get there' : ''}. Review before merging._`;
      if (s.settings.autoPR && s.repo.provider === 'local' && deps.exportLocal) {
        s.pr = await deps.exportLocal(s, box);
        log({ type: 'pr', ...s.pr });
      } else if (s.settings.autoPR && ['github', 'gitlab'].includes(s.repo.provider)) {
        const changes = await changedFiles(box, s.baseSha);
        if (changes.length) {
          const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'mission';
          s.pr = { ...(await deps.openPullRequest(s.repo, { branch: `daniel/${slug}-${Date.now().toString(36)}`, title, body, changes })), files: changes.length };
          log({ type: 'pr', ...s.pr });
          if (s.ticket && deps.commentOnTicket) await deps.commentOnTicket(s.ticket, `${s.settings.agentName} opened a ${s.pr.kind} for this: ${s.pr.url}`).catch(() => {});
        }
      }
      if (deps.notify) await deps.notify({ title: `${s.settings.agentName} finished: ${title}`, text: `${done.length}/${s.tasks.length} tasks done${blocked.length ? `, ${blocked.length} blocked` : ''} · est. $${s.usage.cost.toFixed(2)}`, url: s.pr?.url }).catch(() => {});
      s.phase = 'done'; s.finishedAt = Date.now();
      log({ type: 'mission', status: 'done', text: `${done.length} of ${s.tasks.length} tasks completed and verified.` });
      return { state: s, events: ev };
    }
  } catch (e) {
    s.errors = (s.errors || 0) + 1;
    const msg = String(e.message || e).replace(/https:\/\/[^@\s]+@/g, 'https://***@').slice(0, 500);
    log({ type: 'error', text: msg, retrying: s.errors < 6 });
    if (/not found|expired/i.test(msg) && s.phase !== 'setup') { s.phase = 'failed'; s.failReason = 'The workspace expired. Start the mission again; completed tasks are listed above.'; }
    else if (s.errors >= 6) return pause(s, log, `Paused after repeated errors: ${msg}`, ev);
  }
  return { state: s, events: ev };
}

function pause(s, log, reason, ev) {
  s.resumePhase = s.phase; s.phase = 'paused'; s.pauseReason = reason;
  log({ type: 'mission', status: 'paused', text: reason });
  return { state: s, events: ev };
}
export function resumeMission(s, newSettings = {}) {
  Object.assign(s.settings, newSettings);
  if (s.phase === 'paused') { s.phase = s.resumePhase || 'working'; s.pauseReason = null; s.errors = 0; }
  return s;
}
