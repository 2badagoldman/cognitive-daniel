import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personalChat, runPersonalTool, executeProposal, memoryBlock } from '../api/_personal.js';

process.env.SESSION_SECRET = 'y'.repeat(40);
const fakeRes = () => ({ headers: {}, getHeader(k) { return this.headers[k]; }, setHeader(k, v) { this.headers[k] = v; } });
const modelScript = turns => { let i = 0; return async () => ({ ok: true, status: 200, json: async () => turns[Math.min(i++, turns.length - 1)] }); };
const use = (name, input, id = 't' + Math.random()) => ({ type: 'tool_use', id, name, input });

test('remember returns a memory op; refuses card numbers and passwords', async () => {
  const ok = await runPersonalTool('remember', { text: 'Sister Ada lives in Houston' }, { conns: {} });
  assert.deepEqual(ok.memoryOp, { op: 'save', text: 'Sister Ada lives in Houston' });
  const bad = await runPersonalTool('remember', { text: 'My card is 4111111111111111' }, { conns: {} });
  assert.equal(bad.ok, false);
});

test('send actions become proposals, never direct sends', async () => {
  let called = false;
  const r = await runPersonalTool('text_send', { to: '+14695550123', body: 'Running late' }, { conns: { sms: { server: true } }, fetchImpl: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(r.proposal.kind, 'text_send');
  assert.ok(r.proposal.token);
});

test('unconnected account gives a clear instruction', async () => {
  const r = await runPersonalTool('email_search', { query: 'from:alex' }, { conns: {} });
  assert.equal(r.ok, false);
  assert.match(r.output, /Connections/);
});

test('personalChat runs tools and returns memory ops and proposals without params', async () => {
  const callModel = modelScript([
    { content: [use('remember', { text: 'Prefers morning meetings' }), use('social_post', { text: 'Launch day!' })], usage: { input_tokens: 5, output_tokens: 5 } },
    { content: [{ type: 'text', text: 'Saved that, and your post is ready to confirm.' }], usage: { input_tokens: 5, output_tokens: 5 } }
  ]);
  const out = await personalChat({ key: 'k', callModel, messages: [{ role: 'user', content: 'hi' }], memory: [], conns: { x: { access: 'a' } }, res: fakeRes() });
  assert.equal(out.text, 'Saved that, and your post is ready to confirm.');
  assert.equal(out.memoryOps[0].text, 'Prefers morning meetings');
  assert.equal(out.proposals.length, 1);
  assert.equal(out.proposals[0].params, undefined);
});

test('executeProposal sends the confirmed text through Twilio and rejects tampering', async () => {
  process.env.TWILIO_ACCOUNT_SID = 'AC1'; process.env.TWILIO_AUTH_TOKEN = 'tok'; process.env.TWILIO_FROM = '+15550000000';
  const p = (await runPersonalTool('text_send', { to: '+14695550123', body: 'Hi' }, { conns: { sms: { server: true } } })).proposal;
  const calls = [];
  const out = await executeProposal(p.token, { conns: {}, res: fakeRes(), fetchImpl: async (u, o) => { calls.push([u, String(o.body)]); return { ok: true, status: 201, json: async () => ({ sid: 'SM1' }) }; } });
  assert.match(out.text, /Text sent/);
  assert.match(calls[0][0], /Accounts\/AC1\/Messages/);
  assert.match(calls[0][1], /To=%2B14695550123/);
  await assert.rejects(executeProposal(p.token.slice(0, -3) + 'abc', { conns: {}, res: fakeRes() }), /expired/);
});

test('memoryBlock lists ids for forgetting', () => {
  assert.match(memoryBlock([{ id: 'm1', text: 'Likes jazz' }]), /\[m1\] Likes jazz/);
});
