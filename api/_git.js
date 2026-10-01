import { githubToken } from './_auth.js';
// GitHub + GitLab: parse repo references, load code for context, clone credentials, and open PRs / MRs.
const GITLAB_HOST = () => (process.env.GITLAB_URL || 'https://gitlab.com').replace(/\/+$/, '');

export function parseRepo(input) {
  let s = String(input || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const glHost = GITLAB_HOST().replace(/^https?:\/\//, '');
  let m = s.match(new RegExp(`^(?:https?:\\/\\/)?(?:www\\.)?(?:gitlab\\.com|${glHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\/(.+?)(?:\\/-\\/tree\\/([^?#]+))?$`, 'i'));
  if (/^gitlab:/i.test(s)) m = [null, s.slice(7), null];
  if (m) return { provider: 'gitlab', path: m[1], branch: m[2] || null };
  m = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+)(?:\/tree\/([^?#]+))?$/i);
  if (m) return { provider: 'github', path: `${m[1]}/${m[2]}`, branch: m[3] || null };
  return null;
}

export function ghHeaders() {
  const h = { accept: 'application/vnd.github+json', 'user-agent': 'cognitive-ai', 'x-github-api-version': '2022-11-28' };
  if (githubToken()) h.authorization = `Bearer ${githubToken()}`;
  return h;
}
export function glHeaders() {
  const h = { 'content-type': 'application/json' };
  if (process.env.GITLAB_TOKEN) h['private-token'] = process.env.GITLAB_TOKEN;
  return h;
}
export async function gh(pathname, opts = {}) {
  const r = await fetch(`https://api.github.com${pathname}`, { ...opts, headers: { ...ghHeaders(), ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } });
  if (!r.ok) { const d = await r.json().catch(() => ({})); const e = new Error(`GitHub: ${d.message || r.status}${d.errors ? ' — ' + JSON.stringify(d.errors).slice(0, 200) : ''}`); e.status = r.status; throw e; }
  return r.status === 204 ? {} : r.json();
}
export async function gl(pathname, opts = {}) {
  const r = await fetch(`${GITLAB_HOST()}/api/v4${pathname}`, { ...opts, headers: { ...glHeaders(), ...(opts.headers || {}) } });
  if (!r.ok) { const d = await r.json().catch(() => ({})); const e = new Error(`GitLab: ${d.message ? JSON.stringify(d.message) : d.error || r.status}`); e.status = r.status; throw e; }
  return r.json();
}

export function cloneInfo(repo) {
  if (repo.provider === 'gitlab') return { cloneUrl: `${GITLAB_HOST()}/${repo.name}.git`, username: 'oauth2', password: process.env.GITLAB_TOKEN || '', publicUrl: `${GITLAB_HOST()}/${repo.name}.git` };
  return { cloneUrl: `https://github.com/${repo.name}.git`, username: 'x-access-token', password: githubToken(), publicUrl: `https://github.com/${repo.name}.git` };
}

/* ---------- repo context loading ---------- */
const SKIP_DIR = /(^|\/)(node_modules|dist|build|out|\.next|\.git|vendor|coverage|__pycache__|\.venv|venv|target|bin|obj)(\/|$)/;
const SKIP_FILE = /(\.lock|-lock\.json|\.min\.(js|css)|\.map|\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tar|mp4|mp3|woff2?|ttf|eot|exe|dll|so|dylib|jar|class|pyc|db|sqlite))$/i;
const TEXT = /\.(js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|kt|cs|rb|php|swift|c|cc|cpp|h|hpp|scala|sql|sh|ps1|yml|yaml|toml|ini|cfg|json|md|txt|html|css|scss|vue|svelte|tf|bicep|gradle|xml|graphql|proto)$|(^|\/)(Dockerfile|Makefile|Procfile|\.gitignore|\.env\.example)$/i;
function score(p) {
  const base = p.split('/').pop().toLowerCase(), depth = p.split('/').length - 1;
  if (/^readme(\.|$)/.test(base) && depth === 0) return 0;
  if (['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'cargo.toml', 'pom.xml', 'build.gradle', 'composer.json', 'gemfile'].includes(base) && depth === 0) return 1;
  if (/^(dockerfile|docker-compose\.ya?ml|vercel\.json|netlify\.toml|tsconfig\.json|next\.config\.\w+|vite\.config\.\w+|\.gitlab-ci\.yml)$/.test(base)) return 2;
  if (p.startsWith('.github/workflows/')) return 3;
  if (/\.(tf|bicep)$/.test(base)) return 4;
  if (/(^|\/)(src|app|lib|api|server|pages|routes|components|cmd|internal|pkg)\//.test(p) || depth === 0) return 5 + depth;
  if (/(^|\/)(test|tests|__tests__|spec)\//.test(p)) return 9 + depth;
  return 12 + depth;
}
function pick(blobs) {
  return blobs.filter(b => TEXT.test(b.path) && !SKIP_FILE.test(b.path) && (b.size ?? 0) < 60000)
    .sort((a, b) => score(a.path) - score(b.path) || (a.size || 0) - (b.size || 0)).slice(0, 45);
}
function budget(fetched) {
  let left = 90000; const files = [];
  for (const f of fetched) { if (!f || f.content.length > left) continue; left -= f.content.length; files.push(f); }
  return files;
}

export async function loadRepo(ref) {
  const p = parseRepo(ref);
  if (!p) { const e = new Error('Enter a repo like owner/repo, a GitHub URL, or a GitLab URL.'); e.status = 400; throw e; }
  return p.provider === 'gitlab' ? loadGitlab(p) : loadGithub(p);
}
async function loadGithub(p) {
  let info;
  try { info = await gh(`/repos/${p.path}`); } catch (e) {
    if (e.status === 404) throw Object.assign(new Error('Repo not found. If it is private, sign in with a GitHub account that can see it.'), { status: 404 });
    if (e.status === 403 || e.status === 429) throw Object.assign(new Error('GitHub rate limit reached. Add a GITHUB_TOKEN in Vercel settings.'), { status: 429 });
    throw e;
  }
  const branch = p.branch || info.default_branch;
  const tree = await gh(`/repos/${p.path}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const blobs = (tree.tree || []).filter(t => t.type === 'blob' && !SKIP_DIR.test(t.path));
  const fetched = await Promise.all(pick(blobs).map(async b => {
    try {
      if (githubToken()) {
        const d = await gh(`/repos/${p.path}/contents/${b.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`);
        return { path: b.path, content: Buffer.from(d.content || '', 'base64').toString('utf8').slice(0, 20000) };
      }
      const r = await fetch(`https://raw.githubusercontent.com/${p.path}/${encodeURIComponent(branch)}/${b.path.split('/').map(encodeURIComponent).join('/')}`);
      return r.ok ? { path: b.path, content: (await r.text()).slice(0, 20000) } : null;
    } catch { return null; }
  }));
  const paths = blobs.map(b => b.path);
  return { provider: 'github', name: p.path, branch, description: info.description || '', private: !!info.private, fileCount: paths.length, tree: paths.slice(0, 500), files: budget(fetched), truncated: !!tree.truncated || paths.length > 500, webUrl: `https://github.com/${p.path}` };
}
async function loadGitlab(p) {
  const id = encodeURIComponent(p.path);
  let info;
  try { info = await gl(`/projects/${id}`); } catch (e) {
    if (e.status === 404 || e.status === 401) throw Object.assign(new Error('GitLab project not found. If it is private, add a GITLAB_TOKEN in Vercel settings.'), { status: 404 });
    throw e;
  }
  const branch = p.branch || info.default_branch;
  let items = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gl(`/projects/${id}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(branch)}`);
    items = items.concat(batch); if (batch.length < 100) break;
  }
  const blobs = items.filter(t => t.type === 'blob' && !SKIP_DIR.test(t.path)).map(t => ({ path: t.path, size: 0 }));
  const fetched = await Promise.all(pick(blobs).map(async b => {
    try {
      const r = await fetch(`${GITLAB_HOST()}/api/v4/projects/${id}/repository/files/${encodeURIComponent(b.path)}/raw?ref=${encodeURIComponent(branch)}`, { headers: glHeaders() });
      return r.ok ? { path: b.path, content: (await r.text()).slice(0, 20000) } : null;
    } catch { return null; }
  }));
  const paths = blobs.map(b => b.path);
  return { provider: 'gitlab', name: info.path_with_namespace || p.path, branch, description: info.description || '', private: info.visibility !== 'public', fileCount: paths.length, tree: paths.slice(0, 500), files: budget(fetched), truncated: items.length >= 500, webUrl: info.web_url || `${GITLAB_HOST()}/${p.path}` };
}

/* ---------- PR / MR creation ---------- */
// changes: [{ path, status: 'added'|'modified'|'deleted', content?: Buffer, executable?: bool }]
export async function openPullRequest(repo, { branch, title, body, changes }) {
  if (!changes.length) throw Object.assign(new Error('No file changes to commit.'), { status: 400 });
  if (repo.provider === 'gitlab') {
    if (!process.env.GITLAB_TOKEN) throw Object.assign(new Error('Add a GITLAB_TOKEN in Vercel settings to open merge requests.'), { status: 400 });
    const id = encodeURIComponent(repo.name);
    await gl(`/projects/${id}/repository/commits`, { method: 'POST', body: JSON.stringify({
      branch, start_branch: repo.branch, commit_message: title,
      actions: changes.map(c => c.status === 'deleted'
        ? { action: 'delete', file_path: c.path }
        : { action: c.status === 'added' ? 'create' : 'update', file_path: c.path, content: c.content.toString('base64'), encoding: 'base64', ...(c.executable ? { execute_filemode: true } : {}) })
    }) });
    const mr = await gl(`/projects/${id}/merge_requests`, { method: 'POST', body: JSON.stringify({ source_branch: branch, target_branch: repo.branch, title, description: body, remove_source_branch: true }) });
    return { url: mr.web_url, number: mr.iid, kind: 'merge request' };
  }
  if (!githubToken()) throw Object.assign(new Error('Sign in with GitHub to open pull requests.'), { status: 400 });
  const r = repo.name;
  const baseRef = await gh(`/repos/${r}/git/ref/heads/${encodeURIComponent(repo.branch)}`);
  const baseSha = baseRef.object.sha;
  const baseCommit = await gh(`/repos/${r}/git/commits/${baseSha}`);
  const entries = await Promise.all(changes.map(async c => {
    if (c.status === 'deleted') return { path: c.path, mode: '100644', type: 'blob', sha: null };
    const blob = await gh(`/repos/${r}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: c.content.toString('base64'), encoding: 'base64' }) });
    return { path: c.path, mode: c.executable ? '100755' : '100644', type: 'blob', sha: blob.sha };
  }));
  const tree = await gh(`/repos/${r}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: entries }) });
  const commit = await gh(`/repos/${r}/git/commits`, { method: 'POST', body: JSON.stringify({ message: title, tree: tree.sha, parents: [baseSha] }) });
  await gh(`/repos/${r}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) });
  const pr = await gh(`/repos/${r}/pulls`, { method: 'POST', body: JSON.stringify({ title, head: branch, base: repo.branch, body }) });
  return { url: pr.html_url, number: pr.number, kind: 'pull request' };
}
