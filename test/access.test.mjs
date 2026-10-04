import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkAccess, rateLimit, safeEqual, _resetAccessState } from '../api/_lib.js';

const req = (code, ip = '1.2.3.4') => ({ headers: { 'x-forwarded-for': ip, ...(code != null ? { 'x-access-code': code } : {}) } });
const res = () => { const r = { code: 0, body: null, headers: {} }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; };

beforeEach(() => { _resetAccessState(); delete process.env.PORTAL_ACCESS_CODE; delete process.env.ALLOW_PUBLIC_ACCESS; delete process.env.RATE_LIMIT_PER_MIN; });

test('no access code: spend routes closed, read-only routes open', () => {
  let r = res(); assert.equal(checkAccess(req(), r), false); assert.equal(r.code, 403); assert.equal(r.body.needSetup, true);
  r = res(); assert.equal(checkAccess(req(), r, { spend: false }), true);
});

test('ALLOW_PUBLIC_ACCESS opens spend routes deliberately', () => {
  process.env.ALLOW_PUBLIC_ACCESS = 'true';
  assert.equal(checkAccess(req(), res()), true);
});

test('access code required and compared exactly', () => {
  process.env.PORTAL_ACCESS_CODE = 'Secret-123';
  let r = res(); assert.equal(checkAccess(req(), r), false); assert.equal(r.code, 401);
  r = res(); assert.equal(checkAccess(req('secret-123'), r), false); assert.equal(r.code, 401);
  assert.equal(checkAccess(req('Secret-123'), res()), true);
});

test('ten wrong codes lock the IP out', () => {
  process.env.PORTAL_ACCESS_CODE = 'Secret-123';
  for (let i = 0; i < 10; i++) checkAccess(req('nope', '9.9.9.9'), res());
  const r = res(); assert.equal(checkAccess(req('Secret-123', '9.9.9.9'), r), false); assert.equal(r.code, 429);
  assert.equal(checkAccess(req('Secret-123', '8.8.8.8'), res()), true);
});

test('rate limit returns 429 after the limit, per IP and route', () => {
  const now = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(rateLimit(req(null, 'a'), res(), { route: 'chat', limit: 3, now }), true);
  const r = res(); assert.equal(rateLimit(req(null, 'a'), r, { route: 'chat', limit: 3, now }), false); assert.equal(r.code, 429); assert.ok(r.headers['retry-after']);
  assert.equal(rateLimit(req(null, 'b'), res(), { route: 'chat', limit: 3, now }), true);
  assert.equal(rateLimit(req(null, 'a'), res(), { route: 'chat', limit: 3, now: now + 61000 }), true);
});

test('safeEqual handles different lengths', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('signed-in GitHub session passes without any access code', async () => {
  process.env.SESSION_SECRET = 'x'.repeat(40); process.env.GITHUB_CLIENT_ID = 'id'; process.env.GITHUB_CLIENT_SECRET = 'sec';
  process.env.PORTAL_ACCESS_CODE = 'Secret-123';
  const { seal, SESSION_COOKIE, currentSession } = await import('../api/_auth.js');
  const tok = seal({ user: { login: 'dan' }, githubToken: 'gho_test', exp: Date.now() + 60000 });
  const r = { headers: { 'x-forwarded-for': '5.5.5.5', cookie: `${SESSION_COOKIE}=${encodeURIComponent(tok)}` } };
  assert.equal(checkAccess(r, res()), true);
  assert.equal(currentSession().user.login, 'dan');
  // no session, no code, sign-in enabled -> asked to sign in, not for a code
  const x = res(); assert.equal(checkAccess(req(null, '6.6.6.6'), x), false); assert.equal(x.body.needLogin, true);
  // tampered cookie is rejected
  const bad = { headers: { 'x-forwarded-for': '7.7.7.7', cookie: `${SESSION_COOKIE}=${encodeURIComponent(tok.slice(0, -4) + 'AAAA')}` } };
  const y = res(); assert.equal(checkAccess(bad, y), false);
  delete process.env.SESSION_SECRET; delete process.env.GITHUB_CLIENT_ID; delete process.env.GITHUB_CLIENT_SECRET;
});

test('listUserRepos maps and paginates the signed-in user\'s repos', async () => {
  const { listUserRepos } = await import('../api/repo.js');
  const calls = [];
  const page1 = Array.from({ length: 100 }, (_, i) => ({ full_name: `dan/r${i}`, private: i % 2 === 0, default_branch: 'main', owner: { login: 'dan' } }));
  const page2 = [{ full_name: 'org/app', private: true, default_branch: 'develop', owner: { login: 'org' } }];
  const repos = await listUserRepos(async p => { calls.push(p); return calls.length === 1 ? page1 : page2; });
  assert.equal(repos.length, 101);
  assert.deepEqual(repos.at(-1), { name: 'org/app', private: true, branch: 'develop', description: '', pushedAt: undefined, owner: 'org' });
  assert.match(calls[0], /affiliation=owner,collaborator,organization_member/);
  assert.equal(calls.length, 2);
});

test('allowedUser supports open access, exact users and @domain rules', async () => {
  const { allowedUser } = await import('../api/auth.js');
  delete process.env.ALLOWED_USERS; delete process.env.ALLOWED_GITHUB_USERS;
  assert.equal(allowedUser({ login: 'anyone' }), true);
  process.env.ALLOWED_USERS = 'dan, @cognitiveai.dev';
  assert.equal(allowedUser({ login: 'Dan' }), true);
  assert.equal(allowedUser({ login: 'x@cognitiveai.dev', email: 'x@cognitiveai.dev' }), true);
  assert.equal(allowedUser({ login: 'eve', email: 'eve@gmail.com' }), false);
  delete process.env.ALLOWED_USERS;
});
