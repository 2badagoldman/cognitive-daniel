// Loads a GitHub or GitLab repository's structure and key files so agents can reason about the real codebase.
import { checkAccess, cors } from './_lib.js';
import { loadRepo } from './_git.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkAccess(req, res)) return;
  try { return res.status(200).json(await loadRepo(req.body?.url)); }
  catch (e) { return res.status(e.status && e.status < 600 ? e.status : 502).json({ error: e.status ? e.message : 'Could not reach the git provider. Try again.' }); }
}
