# Daniel by Cognitive AI — v7

**Daniel** is an autonomous engineer. Give it a goal; it plans the work into tasks, completes every task with its tests verified by the platform, commits each one, and opens one pull request (or a local branch). It retries with fresh approaches, compacts its context on long tasks, escalates to stronger models when stuck, parks and later revisits blocked tasks, and pauses (never throws work away) at your budget/time limits.

## What's new in v7
- **Sign in with GitHub.** Customers sign in with GitHub instead of typing a shared access code. Their own GitHub token is used for their repos and pull requests (no server-wide `GITHUB_TOKEN` needed).
- **Cognitive Personal.** A personal life agent in the suite: it remembers what you tell it (Memory tab, deletable) and works across Gmail/Google Calendar, Outlook/Microsoft 365, text messages (Twilio), X and Home Assistant. Anything that sends, posts or controls a device waits for your confirmation.
- **Honest verification.** Daniel can no longer finish a task by editing existing tests or by "proving" it with `true`, `echo` or `npm test || true`. New test files are still encouraged.
- **Any stack, out of the box.** The sandbox detects Go, Java/Maven, Rust, Python and Ruby projects and installs the toolchains before work starts.
- **Safer by default.** Model and sandbox routes are closed until sign-in, an access code, or `ALLOW_PUBLIC_ACCESS=true` is configured. Every route is rate-limited; repeated wrong access codes lock the caller out for 15 minutes; codes are compared in constant time.
- **Clearer errors.** A banner shows when `ANTHROPIC_API_KEY` is missing, missions stop instead of retrying on auth errors, and Wiki failures are shown on the page.

### Setting up sign-in (5 minutes)
1. GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**.
   Homepage URL: `https://<your-domain>` · Callback URL: `https://<your-domain>/api/auth?action=callback`
2. In Vercel add `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `SESSION_SECRET` (any random string of 32+ characters), then redeploy.
3. Optional: `ALLOWED_GITHUB_USERS=alice,bob` limits who can sign in. `PORTAL_ACCESS_CODE` keeps working for scripts and CI.

### Setting up Cognitive Personal connections
Each connection is optional. The OAuth redirect URI for all of them is `https://<your-domain>/api/personal?action=oauth&provider=<google|microsoft|x>`.

| Connection | Env vars | Where to get them |
|---|---|---|
| Gmail + Google Calendar | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud Console → OAuth client (Web). Enable Gmail API and Calendar API. Gmail scopes need Google verification before public launch. |
| Outlook + Microsoft 365 | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Microsoft Entra → App registrations (multitenant + personal accounts). |
| X | `X_CLIENT_ID`, `X_CLIENT_SECRET` | X developer portal, OAuth 2.0 user context. Posting needs a paid API tier. |
| Text messages | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Twilio console. Texts are sent from your Twilio number. |
| Smart home | none | Each user pastes their Home Assistant URL and a long-lived token in the app. |

Not possible from a web app yet: Apple Health / Health Connect and reading your phone's own texts (need a mobile app), and Instagram/Facebook/LinkedIn posting (needs Meta/LinkedIn app review).

**Privacy.** Memory is stored on the user's device and sent with each request. Connection tokens live in encrypted, httpOnly cookies on the user's browser. Nothing is stored on the server.

### Tests
`npm test` runs the v7 unit tests (access control, verification guards, toolchain detection, personal agent).

## Three ways to run it
| | Where it runs | Best for |
|---|---|---|
| **Web (Vercel)** | Your Vercel deployment + Vercel Sandbox | Teams, GitHub/GitLab repos, any device (installable as an app) |
| **Desktop app** | Your computer (Windows / macOS / Linux) | Local folders, background missions, private code |
| **CLI** | Your computer | `daniel run "fix the failing tests" --repo .` |

### Desktop
Install `Daniel-6.0.0-win-x64.exe` (Windows) or run the Linux AppImage. macOS builds come from the GitHub Actions workflow in `.github/workflows/desktop.yml` (push a tag like `v6.0.0`). On first launch, paste your Anthropic API key — it is stored only on your computer. Windows needs Git for Windows installed (Daniel uses its bash).
Builds are unsigned: Windows SmartScreen will ask you to confirm ("More info → Run anyway"); sign them before distributing widely.

### CLI
```
npm install -g .            # from this folder (or publish to npm as cognitive-daniel)
daniel config set ANTHROPIC_API_KEY=sk-ant-…
daniel run "Add rate limiting to the API with tests" --repo /path/to/repo
daniel                      # opens the local app in your browser
```

### Web (Vercel)
Deploy this folder (the `desktop/`, `local/` and `.github/` folders are ignored by Vercel).

## Environment variables
| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Required. Powers every agent. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET` | Sign in with GitHub (v7). Replaces the access code for customers. |
| `PORTAL_ACCESS_CODE` | Shared access code for scripts/CI, or when sign-in is not set up. |
| `ALLOW_PUBLIC_ACCESS` | `true` opens model routes without sign-in (public demo). Off by default. |
| `RATE_LIMIT_PER_MIN` | Requests per minute per visitor per route (default 60). |
| `GITHUB_TOKEN` | Private repos, PRs, issue import + comments. Fine-grained token: Contents, Pull requests, Issues (read/write). |
| `GITLAB_TOKEN`, `GITLAB_URL` | GitLab repos, merge requests, issues (`api` scope). `GITLAB_URL` only for self-hosted. |
| `SLACK_BOT_TOKEN` + `SLACK_CHANNEL` (or `SLACK_WEBHOOK_URL`) | Notifications when PRs open / swarms finish. |
| `SLACK_SIGNING_SECRET` | Slack bot: @mentions and `/cognitive`. Use `slack-manifest.yml`. |
| `TEAMS_WEBHOOK_URL` | Teams notifications (Teams → Workflows → "Post to a channel when a webhook request is received"). |
| `TEAMS_OUTGOING_SECRET` | Teams bot: create an Outgoing Webhook pointing to `https://<app>/api/teams`; paste its security token here. |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Import Jira tickets as tasks; PR links are commented back. |
| `LINEAR_API_KEY` | Import Linear issues; PR links are commented back. |
| `WEBHOOK_URL` | JSON event for every PR and swarm result (Zapier, Make, n8n, …). |
| `ANTHROPIC_MODEL` | Main model (default `claude-sonnet-4-6`). |
| `ANTHROPIC_FAST_MODEL` | Fast model used by smart routing for exploration steps (default `claude-haiku-4-5`). |
| `ANTHROPIC_MAX_MODEL` | Model used when Speed = Max (default `claude-opus-4-6`). |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM` | Online checkout for the $20 / $100 / $500 plans. Without them, "Choose plan" emails `SALES_EMAIL`. |
| `SALES_EMAIL` | Where plan requests go when Stripe is not set up (default hello@cognitiveai.dev). |
| `ALLOWED_ORIGINS` | Lets another frontend call this API, e.g. `https://*.lovable.app,https://app.cognitiveai.dev`. |

## Using the bots
Prefix a message with an agent name to route it: `@Cognitive qa: test plan for checkout`, `/cognitive devops: GitHub Actions for a Node API`. No prefix goes to the Engineer.

## How Autopilot keeps work honest
The agent can call `finish` only with a test command. The platform re-runs that command in the sandbox itself; if it fails, the agent is told to keep working. Every command, file edit, and verification is shown in the timeline, and nothing merges without a human reviewing the PR.

| `DANIEL_BASH_CAP_SEC` | Max seconds per command on Vercel (default 150, keeps each step inside the function limit). |
| `PRICE_FAST_IN/OUT`, `PRICE_MAIN_IN/OUT`, `PRICE_MAX_IN/OUT` | USD per million tokens used for cost estimates. |

## How Daniel avoids getting stuck
- **Verified finish** — a task only completes when the platform re-runs its test command (plus your regression check) and it passes.
- **Retries** — when an attempt runs out of steps, its work is summarised and a fresh attempt starts with a different approach.
- **Escalation** — fast model for exploring, main model for changing code, strongest model on retries or after the same failure three times.
- **Compaction** — long conversations are summarised so the agent keeps its bearings.
- **Blocked tasks** — parked with their partial diff saved, the tree is reset, other tasks continue, and blocked ones are revisited at the end.
- **Guardrails** — budget and time caps pause the mission; raise the cap and resume.
- **Resilience** — the desktop/CLI engine persists every step to disk and resumes after a crash or restart; the web app resumes cloud missions when you reopen the page.

## Benchmark
Benchmark → paste a suite (repo + tasks + hidden tests) → Run. Record Devin's result on the same tasks for a side-by-side scorecard, then export it.
