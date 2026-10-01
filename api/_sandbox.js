// Isolated execution environments for Autopilot.
// Production: Vercel Sandbox (Firecracker micro-VMs), authenticated automatically via the project's OIDC token.
// Development / self-hosting: SANDBOX_DRIVER=local runs tasks in temp directories on the server.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const MAX_OUT = 12000;
const clip = s => (s.length > MAX_OUT ? s.slice(0, MAX_OUT / 2) + `\n…[${s.length - MAX_OUT} chars truncated]…\n` + s.slice(-MAX_OUT / 2) : s);
export const driverName = () => (process.env.SANDBOX_DRIVER || 'vercel');

/* ---------- Vercel Sandbox ---------- */
const ROOT_VERCEL = '/vercel/sandbox';
async function vercelSdk() { return (await import('@vercel/sandbox')).Sandbox; }

const vercel = {
  async create({ cloneUrl, username, password, branch }) {
    const Sandbox = await vercelSdk();
    const source = { type: 'git', url: cloneUrl, depth: 50, ...(branch ? { revision: branch } : {}), ...(password ? { username, password } : {}) };
    const sbx = await Sandbox.create({ source, timeout: 45 * 60 * 1000, resources: { vcpus: 4 } });
    return sbx.name;
  },
  async open(id) {
    const Sandbox = await vercelSdk();
    const sbx = await Sandbox.get({ name: id });
    // Keep long missions alive: push the auto-stop timer out on every use (ignored if the plan limit is reached).
    sbx.extendTimeout?.(15 * 60 * 1000).catch(() => {});
    return {
      root: ROOT_VERCEL,
      async exec(cmd, timeoutMs = 120000, env) {
        let r;
        try { r = await sbx.runCommand({ cmd: 'bash', args: ['-lc', cmd], cwd: ROOT_VERCEL, ...(env && Object.keys(env).length ? { env } : {}), signal: AbortSignal.timeout(timeoutMs) }); }
        catch (e) { return { exitCode: 124, stdout: '', stderr: /abort|timeout/i.test(String(e?.name || e?.message)) ? `[timed out after ${Math.round(timeoutMs / 1000)}s]` : String(e?.message || e) }; }
        const [out, err] = await Promise.all([r.stdout(), r.stderr()]);
        return { exitCode: r.exitCode ?? 1, stdout: clip(out || ''), stderr: clip(err || '') };
      },
      async readFile(p) { return sbx.readFileToBuffer({ path: p, cwd: ROOT_VERCEL }); },
      async writeFile(p, content) {
        const dir = path.posix.dirname(p);
        if (dir && dir !== '.') await this.exec(`mkdir -p ${shq(dir)}`);
        await sbx.writeFiles([{ path: path.posix.join(ROOT_VERCEL, p), content: Buffer.from(content) }]);
      },
      async stop() { await sbx.stop().catch(() => {}); }
    };
  }
};

/* ---------- Local driver ---------- */
const LOCAL_BASE = process.env.DANIEL_SANDBOX_DIR || path.join(os.tmpdir(), 'cognitive-sandboxes');
// Windows needs Git for Windows' bash; macOS/Linux use the system bash.
const BASH = process.env.DANIEL_BASH || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash');
function run(cmd, cwd, timeoutMs, env) {
  return new Promise(resolve => {
    // Commands get a clean environment: never leak the server's own API keys into agent-run code.
    const base = { PATH: process.env.PATH, HOME: process.env.HOME || process.env.USERPROFILE, SYSTEMROOT: process.env.SYSTEMROOT, LANG: process.env.LANG || 'C.UTF-8', TMPDIR: process.env.TMPDIR || '/tmp', CI: '1' };
    const p = spawn(BASH, ['-lc', cmd], { cwd, env: Object.fromEntries(Object.entries({ ...base, ...(env || {}), GIT_TERMINAL_PROMPT: '0' }).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])), detached: process.platform !== 'win32' });
    let out = '', err = '', done = false;
    const t = setTimeout(() => { if (!done) { try { process.kill(-p.pid, 'SIGKILL'); } catch { p.kill('SIGKILL'); } err += `\n[timed out after ${timeoutMs / 1000}s]`; } }, timeoutMs);
    p.stdout.on('data', d => { if (out.length < 400000) out += d; });
    p.stderr.on('data', d => { if (err.length < 400000) err += d; });
    p.on('error', e => { done = true; clearTimeout(t); resolve({ exitCode: 127, stdout: '', stderr: `Could not start a shell (${e.message}). On Windows, install Git for Windows or set DANIEL_BASH.` }); });
    p.on('close', code => { done = true; clearTimeout(t); resolve({ exitCode: code ?? 124, stdout: clip(out), stderr: clip(err) }); });
  });
}
const local = {
  async create({ cloneUrl, username, password, branch, localPath }) {
    await fs.mkdir(LOCAL_BASE, { recursive: true });
    const id = 'local-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const dir = path.join(LOCAL_BASE, id);
    let url = localPath || process.env.LOCAL_CLONE_OVERRIDE || cloneUrl;
    if (password && /^https:/.test(url)) url = url.replace('https://', `https://${encodeURIComponent(username)}:${encodeURIComponent(password)}@`);
    const r = await run(`git clone ${localPath ? '--no-hardlinks' : '--depth 50'} ${branch ? `--branch ${shq(branch)}` : ''} ${shq(url)} ${shq(dir)}`, LOCAL_BASE, 180000);
    if (r.exitCode !== 0) throw new Error('Clone failed: ' + (r.stderr || r.stdout).replace(/https:\/\/[^@\s]+@/g, 'https://***@').slice(0, 400));
    return id;
  },
  async open(id) {
    if (!/^local-[a-z0-9]+$/.test(id)) throw new Error('Bad sandbox id');
    const root = path.join(LOCAL_BASE, id);
    await fs.access(root).catch(() => { throw new Error('Sandbox not found or expired.'); });
    return {
      root,
      exec: (cmd, timeoutMs = 120000, env) => run(cmd, root, timeoutMs, env),
      async readFile(p) { return fs.readFile(path.join(root, p)).catch(() => null); },
      async writeFile(p, content) { const f = path.join(root, p); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, content); },
      async stop() { await fs.rm(root, { recursive: true, force: true }); }
    };
  }
};

export function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
export function safePath(p) {
  const n = path.posix.normalize(String(p || '.').replace(/^\/+/, '').replace(/^vercel\/sandbox\/?/, ''));
  if (n.startsWith('..') || n.includes('/../') || n === '.git' || n.startsWith('.git/')) throw new Error(`Path not allowed: ${p}`);
  return n === '' ? '.' : n;
}
export const sandboxes = () => (driverName() === 'local' ? local : vercel);
export const LOCAL_SANDBOX_BASE = LOCAL_BASE;
