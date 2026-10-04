// Repositories.
//   POST /api/repo {url}           -> loads a GitHub or GitLab repo's structure and key files for the agents
//   POST /api/repo?action=list     -> the signed-in user's GitHub repos (Sign in with GitHub), for the picker
import { checkAccess, cors } from './_lib.js';
import { loadRepo, gh } from './_git.js';
import { currentSession } from './_auth.js';

export const config = { maxDuration: 30 };

export async function listUserRepos(ghImpl = gh, pages = 3) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const batch = await ghImpl(`/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`);
    for (const r of batch || []) out.push({ name: r.full_name, private: !!r.private, branch: r.default_branch, description: r.description || '', pushedAt: r.pushed_at, owner: r.owner?.login || '' });
    if (!batch || batch.length < 100) break;
  }
  return out;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkAccess(req, res, { route: 'repo', spend: false })) return;
  const action = req.query?.action || new URL(req.url, 'http://x').searchParams.get('action');
  try {
    if (action === 'list') {
      if (!currentSession()) return res.status(401).json({ error: 'Sign in with GitHub to see your repositories.', needLogin: true });
      if (!currentSession().githubToken) return res.status(409).json({ error: 'Connect your GitHub account to see your repositories.', needGithub: true });
      return res.status(200).json({ repos: await listUserRepos() });
    }
    return res.status(200).json(await loadRepo(req.body?.url));
  }
  catch (e) { return res.status(e.status && e.status < 600 ? e.status : 502).json({ error: e.status ? e.message : 'Could not reach the git provider. Try again.' }); }
}
