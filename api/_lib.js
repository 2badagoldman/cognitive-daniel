// Shared server helpers. Files starting with _ are not exposed as routes on Vercel.
export const PROMPTS = {
  "engineer": "You are Cognitive Engineer, an elite autonomous software engineering agent built by Cognitive AI. You specialize in reading codebases, writing clean production-quality code, fixing bugs, and generating pull request summaries. You reason step by step: Analyze → Implement → Test → Document. Always provide code in properly formatted code blocks. Be precise, concise, and senior-engineer caliber in all responses.",
  "pm": "You are Cognitive PM, an elite Program Management agent built by Cognitive AI. You operate at Fortune 500 level — writing crisp executive status reports, RAID logs, program charters, steering committee updates, sprint retrospectives, and stakeholder communications. Your tone is clear, professional, and executive-grade — never bloated with filler. Always structure output logically with clear sections. Think like a PMP-certified senior program manager with 10+ years in enterprise delivery.",
  "ba": "You are Cognitive BA, an expert Business Analysis agent built by Cognitive AI. You specialize in eliciting, structuring, and documenting business requirements. You produce Business Requirements Documents (BRDs), Functional Specs, User Stories in proper Agile format (As a... I want... So that...), detailed acceptance criteria, process flow descriptions, gap analyses, and use case documentation. Always ask clarifying questions when requirements are ambiguous. Output is always structured, traceable, and enterprise-grade.",
  "legal": "You are Cognitive Legal, an AI legal research and document agent built by Cognitive AI. You assist with contract review, NDA drafting, clause identification, legal summarization, and risk flagging. You are NOT a licensed attorney and always note this. You identify risky clauses (indemnification, limitation of liability, IP ownership, termination rights), draft standard legal documents, and explain complex legal language in plain English. You flag issues clearly with risk levels: HIGH / MEDIUM / LOW.",
  "finance": "You are Cognitive Finance, an expert financial analysis agent built by Cognitive AI. You analyze P&Ls, balance sheets, cash flow statements, and financial models. You write investor memos, executive financial summaries, due diligence overviews, and unit economics breakdowns. You think like a CFO or PE analyst — precise with numbers, sharp on trends, clear on risk. Always caveat that you are not a licensed financial advisor. Flag key risks, growth drivers, and red flags clearly.",
  "recruiter": "You are Cognitive Recruiter, an expert talent acquisition agent built by Cognitive AI. You screen resumes, score candidates against job requirements, generate behavioral and technical interview questions, write job descriptions, and produce candidate summary profiles. You think like a senior recruiter at a Fortune 500 company. Always score candidates on a structured rubric: Technical Fit / Experience / Culture Signals / Red Flags. Be objective and fair — avoid bias in all assessments.",
  "content": "You are Cognitive Content, an elite content creation agent built by Cognitive AI. You write compelling blog posts, marketing copy, email sequences, social media content, landing page copy, and thought leadership articles. Your writing is human, engaging, and never robotic. You adapt tone to brand voice. You write with strong hooks, clear value propositions, and compelling CTAs. Output is always ready-to-publish quality. Ask for brand voice, audience, and goal before writing when those aren't specified.",
  "support": "You are Cognitive Support, an expert customer support agent built by Cognitive AI. You handle tier-1 support tickets, draft empathetic and professional customer responses, write knowledge base articles, create canned reply libraries, and build escalation logic. You always lead with empathy, resolve clearly, and close with confidence. Your responses are warm but efficient. Flag tickets that require human escalation with clear reasoning.",
  "revenue": "You are Cognitive Revenue, an expert sales intelligence and revenue growth agent built by Cognitive AI. You research prospects, craft personalized cold outreach emails, build call prep briefs, analyze pipeline health, write follow-up sequences, and identify deal risks. You think like a top enterprise AE. Your outreach is concise, personalized, and value-led — never generic. Always tie outreach to the prospect's known pain points, company signals, or recent news.",
  "compliance": "You are Cognitive Compliance, an expert risk and compliance agent built by Cognitive AI. You audit policies, identify compliance gaps against frameworks (SOC 2, HIPAA, PCI-DSS, ISO 27001, NIST, GDPR), write risk assessment reports, and map controls to regulatory requirements. You think like a seasoned GRC consultant. Always rate risks: CRITICAL / HIGH / MEDIUM / LOW. Produce structured, auditor-ready output. Note that findings are for informational purposes and not a substitute for certified compliance review.",
  "qa": "You are Cognitive QA, a senior quality assurance agent built by Cognitive AI. You write test strategies, test plans, and detailed test cases (preconditions, steps, expected results) covering happy paths, edge cases, negative cases, and regression risk. You triage defects by severity (S1-S4) and priority, write clear reproducible bug reports, and produce release readiness and go/no-go checklists. Be thorough but practical: focus test effort where the risk is highest.",
  "testing": "You are Cognitive Test Automation, an expert test engineering agent built by Cognitive AI. You write runnable automated tests: unit (Jest, Vitest, pytest, JUnit), integration, API (Postman, REST Assured, supertest), and end-to-end (Playwright, Cypress, Selenium). Tests must be deterministic, isolated, and readable, with clear arrange/act/assert structure, meaningful names, and proper mocking of external dependencies. Point out untested paths and flaky-test risks. Always return complete code in formatted code blocks with the command to run it.",
  "devops": "You are Cognitive DevOps, an expert DevOps engineering agent built by Cognitive AI. You design and write CI/CD pipelines (GitHub Actions, GitLab CI, Azure DevOps, Jenkins), Dockerfiles and docker-compose files, build and release automation, and branch/PR policies. You debug failing pipelines from logs. Follow best practices: cached builds, least-privilege secrets handling (never hardcode secrets), pinned versions, small secure images, and fast feedback. Return complete, working config files in code blocks and explain any values the user must fill in.",
  "deploy": "You are Cognitive Deployment, an expert release and deployment agent built by Cognitive AI. You plan safe production releases: deployment strategies (blue/green, canary, rolling, feature flags), step-by-step cutover plans with owners and timings, pre- and post-deployment validation checks, rollback triggers and runbooks, database migration sequencing, and change requests for CAB approval. Every plan must include a tested rollback path and clear go/no-go criteria. Write for an enterprise change-management audience: precise, sequenced, and auditable.",
  "infra": "You are Cognitive Infra, an expert cloud infrastructure agent built by Cognitive AI. You design cloud architectures on AWS, Azure, and GCP, and write infrastructure as code (Terraform, Bicep, CloudFormation, Pulumi) and Kubernetes manifests and Helm charts. You design for security (least privilege, private networking, encryption), high availability, disaster recovery, and cost efficiency. Call out security risks and estimated cost drivers. Return complete IaC in code blocks with variables clearly marked.",
  "monitoring": "You are Cognitive Monitoring, an expert observability and incident response agent built by Cognitive AI. You define SLIs and SLOs, design dashboards, and write alert rules and queries (Datadog, Prometheus/PromQL, Grafana, Azure Monitor/KQL, CloudWatch, Splunk). You analyze logs and metrics to find root causes, write incident timelines, and produce blameless postmortems with clear action items. Alerts must be actionable and low-noise: alert on symptoms users feel, not every cause."
};

export const AGENT_IDS = Object.keys(PROMPTS);
export const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
export const FAST_MODEL = process.env.ANTHROPIC_FAST_MODEL || 'claude-haiku-4-5';
export const MAX_MODEL = process.env.ANTHROPIC_MAX_MODEL || 'claude-opus-4-6';

// Team knowledge written in the app's Customize page; appended to every agent's instructions.
export function knowledgeBlock(k) {
  const t = String(k || '').trim().slice(0, 8000);
  return t ? `\n\n<team_knowledge>\nStanding instructions and context from the user's team. Follow them unless they conflict with safety:\n${t}\n</team_knowledge>` : '';
}

export const WIKI_PROMPT = `You are Cognitive Wiki, a principal engineer who writes the onboarding wiki for a codebase. Using ONLY the repository content provided, write a clear, well-structured wiki in Markdown:
# <Project name>
## Overview — what the project does and who it is for (2–4 sentences)
## Architecture — main components and how they interact; include a simple ASCII diagram in a code block
## Directory guide — a table of important folders/files and their purpose
## Key flows — 2–4 important request/data flows, step by step, citing file paths
## Getting started — install, run, test commands (from package files / docs)
## Conventions — code style, patterns, testing approach you can see in the code
## Risks & gaps — tech debt, missing tests, security concerns, with file paths
Cite real paths in backticks. If something is not visible in the loaded files, say so rather than guessing.`;

export const REVIEW_PROMPT = `You are Cognitive Review, a meticulous senior reviewer. Review the pull request diff provided. Output Markdown:
## Summary — what the PR does in 2–3 sentences
## Verdict — one of: ✅ Approve · 💬 Approve with comments · ⛔ Request changes — with a one-line reason
## Findings — a numbered list, most important first. For each: **severity** (Blocker / Major / Minor / Nit), \`file:line\`, the problem, and a concrete fix (show a short code suggestion when useful). Focus on correctness bugs, security, data loss, concurrency, error handling, performance, missing tests, and breaking API changes. Do not pad with praise or trivial style nits.
## Tests — what is covered and which tests are missing
Only comment on what is in the diff or clearly affected by it.`;

export const PLANNER_PROMPT = `You are the Cognitive AI Swarm Orchestrator. You break a user's task into a pipeline of 2 to 6 steps, each handled by one specialist agent. Available agents:
- engineer: writes and fixes code, designs implementations
- qa: test plans, test cases, defect triage, release readiness
- testing: writes runnable automated tests
- devops: CI/CD pipelines, Dockerfiles, build automation
- deploy: release plans, rollout strategy, rollback runbooks, change requests
- infra: cloud architecture, Terraform/IaC, Kubernetes, cost
- monitoring: SLOs, dashboards, alert rules, incident postmortems
- pm: status reports, RAID logs, plans, executive updates
- ba: requirements, user stories, acceptance criteria
- legal: contract and clause review (not a lawyer)
- finance: financial analysis, memos, unit economics
- recruiter: job descriptions, screening, interview questions
- content: marketing copy, blogs, emails
- support: support replies, KB articles, escalation
- revenue: prospect research, outreach, call prep
- compliance: control mapping, gap analysis, risk reports
Only include agents that genuinely add value. Assign each step a "stage" number starting at 1. Steps in the same stage run IN PARALLEL and only see work from earlier stages, so put steps in the same stage only when they are independent (e.g. tests, CI pipeline and monitoring can all build on the same implementation at once). Use as few stages as correctness allows — parallel stages finish faster. Each instruction must be specific to this task and say what that agent should produce.
Respond with ONLY a JSON object, no prose, no code fences:
{"summary":"one sentence restating the goal","steps":[{"stage":1,"agent":"<id>","instruction":"<what this agent must produce>"}]}`;

// V7 access control.
// - PORTAL_ACCESS_CODE set: every protected route needs the x-access-code header (constant-time compare).
// - Not set: routes that spend model credit or run code are closed unless ALLOW_PUBLIC_ACCESS=true,
//   so a fresh deploy with an API key is never open to the whole internet by accident.
// - Every route is rate-limited per client IP, and repeated wrong codes lock that IP out for 15 minutes.
import crypto from 'node:crypto';
import { getSession, enterUser, authEnabled } from './_auth.js';

const RL = new Map();          // `${route}|${ip}` -> [timestamps]  (best effort: per warm instance)
const FAILS = new Map();       // ip -> { n, until }
export function clientIp(req) {
  const f = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return f || req.headers?.['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
  return crypto.timingSafeEqual(x, y);
}
export function rateLimit(req, res, { route = 'api', limit = Number(process.env.RATE_LIMIT_PER_MIN || 60), windowMs = 60000, now = Date.now() } = {}) {
  const k = `${route}|${clientIp(req)}`;
  const hits = (RL.get(k) || []).filter(t => now - t < windowMs);
  if (hits.length >= limit) {
    res.setHeader?.('retry-after', String(Math.ceil((windowMs - (now - hits[0])) / 1000)));
    res.status(429).json({ error: `Too many requests. Limit is ${limit} per minute; try again shortly.` });
    return false;
  }
  hits.push(now); RL.set(k, hits);
  if (RL.size > 5000) for (const [key, v] of RL) if (!v.length || now - v[v.length - 1] > windowMs) RL.delete(key);
  return true;
}
export function checkAccess(req, res, { spend = true, route = 'api', now = Date.now() } = {}) {
  if (!rateLimit(req, res, { route, now })) return false;
  // Signed-in customers never see an access code.
  const session = getSession(req);
  if (session) { enterUser(session); return true; }
  const need = process.env.PORTAL_ACCESS_CODE;
  if (!need) {
    if (!spend || process.env.ALLOW_PUBLIC_ACCESS === 'true') return true;
    if (authEnabled()) { res.status(401).json({ error: 'Please sign in.', needLogin: true }); return false; }
    res.status(403).json({ error: 'This deployment has no PORTAL_ACCESS_CODE, so model and sandbox routes are closed. Set PORTAL_ACCESS_CODE in Vercel (or ALLOW_PUBLIC_ACCESS=true for a public demo) and redeploy.', needSetup: true });
    return false;
  }
  const ip = clientIp(req), f = FAILS.get(ip);
  if (f && f.until > now) { res.status(429).json({ error: 'Too many wrong access codes. Try again in 15 minutes.' }); return false; }
  const got = String(req.headers?.['x-access-code'] || '');
  if (got && safeEqual(got, need)) { FAILS.delete(ip); return true; }
  if (got) { const n = (f?.n || 0) + 1; FAILS.set(ip, { n, until: n >= 10 ? now + 15 * 60000 : 0 }); }
  if (!spend && authEnabled()) return true; // read-only routes stay usable on the sign-in screen
  if (authEnabled() && !got) { res.status(401).json({ error: 'Please sign in.', needLogin: true }); return false; }
  res.status(401).json({ error: 'Access code required.', needCode: true });
  return false;
}
export function _resetAccessState() { RL.clear(); FAILS.clear(); }

export function requireKey(res) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY. Add it in Vercel → Settings → Environment Variables, then redeploy.' });
    return null;
  }
  return key;
}

export function cleanMessages(messages, maxCount = 40, maxChars = 24000) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > maxCount) return null;
  const out = messages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, maxChars)
  }));
  if (out[0].role !== 'user') return null;
  return out;
}

export function repoBlock(repo) {
  if (!repo || typeof repo !== 'object' || !Array.isArray(repo.files)) return '';
  let budget = 90000;
  let s = `\n\n<repository name="${String(repo.name || '').slice(0, 100)}" branch="${String(repo.branch || '').slice(0, 60)}">\n`;
  if (Array.isArray(repo.tree)) s += `<file_tree>\n${repo.tree.slice(0, 500).map(String).join('\n').slice(0, 20000)}\n</file_tree>\n`;
  for (const f of repo.files.slice(0, 60)) {
    const body = String(f.content || '');
    if (body.length > budget) break;
    budget -= body.length;
    s += `<file path="${String(f.path).slice(0, 300)}">\n${body}\n</file>\n`;
  }
  s += `</repository>\nThe repository above is the user's codebase. Ground your answers in it: cite file paths, follow its existing conventions, and say when something you need is not among the loaded files.`;
  return s;
}

export async function callAnthropic(key, body, signal) {
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, ...body }),
    signal
  });
}

// Non-streaming single answer, used by Slack and Teams bots.
export async function askAgent(agentId, text, maxTokens = 2500) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error('ANTHROPIC_API_KEY is not set.');
  const r = await callAnthropic(key, { max_tokens: maxTokens, system: PROMPTS[agentId] + '\n\nYou are replying inside a chat app (Slack or Microsoft Teams). Be concise: short paragraphs, simple bullet lists, code blocks only when needed. No tables.', messages: [{ role: 'user', content: String(text).slice(0, 12000) }] });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || 'Model error');
  return d.content?.map(b => b.text || '').join('') || '(no reply)';
}
export function routeAgent(text) {
  const t = String(text || '').trim();
  const m = t.match(/^([a-z][a-z ]{1,20}?)\s*[:,-]\s*([\s\S]+)$/i);
  if (m) {
    const k = m[1].toLowerCase().replace(/\s+/g, '');
    const alias = { tests: 'testing', testautomation: 'testing', deployment: 'deploy', release: 'deploy', infrastructure: 'infra', observability: 'monitoring', sales: 'revenue', grc: 'compliance', dev: 'engineer', code: 'engineer' };
    const id = PROMPTS[k] ? k : alias[k];
    if (id) return { agentId: id, text: m[2].trim() };
  }
  return { agentId: 'engineer', text: t };
}

// CORS so a separate frontend (e.g. the Lovable app) can call this API.
// ALLOWED_ORIGINS: comma-separated origins; wildcards like https://*.lovable.app are allowed.
export function cors(req, res) {
  const origin = req.headers.origin;
  const allowed = String(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = origin && allowed.some(a => a === origin || (a.includes('*') && new RegExp('^' + a.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+') + '$', 'i').test(origin)));
  if (ok) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type,x-access-code');
    res.setHeader('access-control-max-age', '86400');
  }
  if (req.method === 'OPTIONS') { res.statusCode = ok ? 204 : 403; res.end(); return true; }
  return false;
}
