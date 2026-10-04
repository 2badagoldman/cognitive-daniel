import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTestPath, testIntegrityViolations, goalAllowsTestEdits, isTrivialCommand, detectStacks, toolchainScript, agentStep, newMission } from '../api/_engine.js';

test('isTestPath recognises test files across stacks', () => {
  for (const p of ['test/cart.test.js', 'tests/test_store.py', 'shortener_test.go', 'src/test/java/bank/AccountTest.java', 'a/__tests__/x.tsx', 'spec/user_spec.rb', 'web/app.spec.ts'])
    assert.equal(isTestPath(p), true, p);
  for (const p of ['src/cart.js', 'inventory/store.py', 'shortener.go', 'src/main/java/bank/Account.java', 'contest.js', 'latest.py'])
    assert.equal(isTestPath(p), false, p);
});

test('testIntegrityViolations flags edited or deleted tests, allows new ones', () => {
  const changes = [
    { path: 'src/cart.js', status: 'modified' },
    { path: 'test/cart.test.js', status: 'modified' },
    { path: 'tests/test_old.py', status: 'deleted' },
    { path: 'test/new_case.test.js', status: 'added' }
  ];
  assert.deepEqual(testIntegrityViolations(changes), ['modified test/cart.test.js', 'deleted tests/test_old.py']);
  assert.deepEqual(testIntegrityViolations(changes, { allow: true }), []);
});

test('goalAllowsTestEdits only when the goal asks for it', () => {
  assert.equal(goalAllowsTestEdits('Fix the failing tests in 01-node-shopping-cart'), false);
  assert.equal(goalAllowsTestEdits('Make every test in this repo pass'), false);
  assert.equal(goalAllowsTestEdits('Update the tests for the new API'), true);
  assert.equal(goalAllowsTestEdits('The tests are outdated after the refactor'), true);
});

test('isTrivialCommand rejects commands that prove nothing', () => {
  for (const c of ['true', 'exit 0', ':', 'echo done', 'npm test || true', 'pytest; true', 'npx jest --passWithNoTests', 'ls'])
    assert.equal(isTrivialCommand(c), true, c);
  for (const c of ['npm test', 'python -m unittest', 'go test ./...', 'cd 05 && mvn -q test', 'echo start && npm test', ''])
    assert.equal(isTrivialCommand(c), false, c);
});

test('detectStacks and toolchainScript cover the six daniel-test stacks', () => {
  const listing = ['01-node/package.json', '02-py/inventory/store.py', '04-go/go.mod', '05-java/pom.xml', '06-rust/Cargo.toml'].join('\n');
  const st = detectStacks(listing);
  assert.deepEqual([st.node, st.python, st.go, st.java, st.maven, st.rust, st.ruby], [true, true, true, true, true, true, false]);
  const sh = toolchainScript(st);
  assert.match(sh, /golang/); assert.match(sh, /maven/); assert.match(sh, /java-17/); assert.match(sh, /rustup/);
  assert.match(sh, /Toolchains:/);
  assert.doesNotMatch(toolchainScript(detectStacks('package.json')), /golang|maven|rustup/);
});

test('newMission is version 7 with guards on by default', () => {
  const m = newMission({ goal: 'x', repo: { provider: 'github', name: 'a/b', branch: 'main' } });
  assert.equal(m.version, 7);
  assert.equal(m.settings.guardTests, true);
  assert.equal(m.settings.autoToolchains, true);
});

// agentStep end-to-end with a fake model and a fake sandbox.
function fakeModel(input) {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'tool_use', id: 'tu1', name: 'finish', input }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'tool_use' }) });
}
function fakeBox({ diffRaw = '', exitCode = 0 } = {}) {
  const ran = [];
  return { ran, async exec(cmd) { ran.push(cmd); if (cmd.startsWith('git diff --cached --raw')) return { stdout: diffRaw, stderr: '', exitCode: 0 }; if (cmd.startsWith('git')) return { stdout: '', stderr: '', exitCode: 0 }; return { stdout: 'ok', stderr: '', exitCode }; }, async readFile() { return Buffer.from('x'); } };
}
const raw = (st, path) => `:100644 100644 aaaaaaa bbbbbbb ${st}\0${path}\0`;
const base = { key: 'k', system: 's', messages: [{ role: 'user', content: 'go' }], speed: 'fast', attempt: 1 };

test('agentStep rejects a trivial test command without running it', async () => {
  fakeModel({ summary: 'done', test_command: 'true' });
  const box = fakeBox();
  const r = await agentStep({ ...base, box, guardTests: true });
  assert.equal(r.done, false);
  assert.match(JSON.stringify(r.toolMessage), /exits 0 without proving/);
  assert.equal(box.ran.includes('true'), false);
});

test('agentStep rejects a finish that edited an existing test file', async () => {
  fakeModel({ summary: 'done', test_command: 'npm test' });
  const box = fakeBox({ diffRaw: raw('M', 'src/cart.js') + raw('M', 'test/cart.test.js') });
  const r = await agentStep({ ...base, box, guardTests: true });
  assert.equal(r.done, false);
  assert.match(JSON.stringify(r.toolMessage), /test\/cart\.test\.js/);
});

test('agentStep accepts a real, passing command when only source changed', async () => {
  fakeModel({ summary: 'fixed', test_command: 'npm test' });
  const box = fakeBox({ diffRaw: raw('M', 'src/cart.js') + raw('A', 'test/extra.test.js') });
  const r = await agentStep({ ...base, box, guardTests: true });
  assert.equal(r.done, true);
  assert.equal(r.testsVerified, true);
  assert.ok(box.ran.includes('npm test'));
});

test('agentStep still rejects when the platform re-run fails', async () => {
  fakeModel({ summary: 'fixed', test_command: 'npm test' });
  const box = fakeBox({ exitCode: 1 });
  const r = await agentStep({ ...base, box, guardTests: true });
  assert.equal(r.done, false);
  assert.match(JSON.stringify(r.toolMessage), /Verification failed/);
});
