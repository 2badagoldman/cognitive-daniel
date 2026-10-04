import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
process.env.SESSION_SECRET = 'q'.repeat(40);
process.env.PORTAL_ACCESS_CODE = 'code-123';
const handler = (await import('../api/trading.js')).default;
const { sanitizeRisk } = await import('../api/trading.js');
const { seal } = await import('../api/_auth.js');
const { _resetAccessState } = await import('../api/_lib.js');

let price = 60000;
globalThis.fetch = async url => {
  if (/exchange\.coinbase\.com\/products\/BTC-USD\/ticker/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ price: String(price), bid: String(price), ask: String(price) }) };
  return { ok: false, status: 404, text: async () => '{}' };
};
// a tiny cookie jar + request runner
function client() {
  const jar = {};
  return async (action, body = {}, method = 'POST') => {
    const req = { method, url: `/api/trading?action=${action}`, query: { action }, body, headers: { 'x-access-code': 'code-123', 'x-forwarded-for': '1.1.1.1', cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } };
    const res = { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
    await handler(req, res);
    for (const c of [].concat(res.headers['set-cookie'] || [])) { const [kv, ...attrs] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (attrs.some(a => /Max-Age=0$/.test(a.trim()))) delete jar[k]; else jar[k] = v; }
    return res;
  };
}
beforeEach(() => _resetAccessState());

test('end-to-end: connect simulator, confirm a ticket, see the position', async () => {
  const call = client();
  assert.equal((await call('status', {}, 'GET')).body.brokers.sim.connected, false);
  assert.equal((await call('connect', { broker: 'sim' })).body.connected, true);
  assert.equal((await call('status', {}, 'GET')).body.brokers.sim.connected, true);
  const order = { symbol: 'BTC-USD', side: 'buy', notional: 1200, qty: null, type: 'market', tif: 'day', limitPrice: null, stopPrice: null, clientId: 'cog_t1' };
  const ticket = seal({ id: 'tp1', kind: 'order', broker: 'sim', live: false, order, price: 60000, summary: 'Paper BUY $1200 of BTC-USD', exp: Date.now() + 60000 }, 'trade:proposal');
  const ex = await call('execute', { token: ticket });
  assert.equal(ex.statusCode, 200, JSON.stringify(ex.body)); assert.equal(ex.body.result.status, 'filled'); assert.equal(ex.body.audit.mode, 'paper');
  const pf = await call('portfolio');
  const sim = pf.body.accounts.find(a => a.broker === 'sim');
  assert.equal(sim.positions[0].symbol, 'BTC-USD'); assert.equal(sim.account.cash, 100000 - 1200);
  assert.equal((await call('status', {}, 'GET')).body.ordersToday.sim, 1);
});

test('confirmation re-checks risk and price, and rejects tampered tickets', async () => {
  const call = client(); await call('connect', { broker: 'sim' });
  const mk = (o, extra = {}) => seal({ id: 'x', kind: 'order', broker: 'sim', live: false, order: { symbol: 'BTC-USD', side: 'buy', qty: null, type: 'market', tif: 'day', limitPrice: null, stopPrice: null, clientId: 'c', ...o }, price: 60000, summary: 's', exp: Date.now() + 60000, ...extra }, 'trade:proposal');
  assert.equal((await call('execute', { token: mk({ notional: 500 }).slice(0, -4) + 'AAAA' })).statusCode, 400);
  assert.equal((await call('execute', { token: mk({ notional: 500 }, { exp: Date.now() - 1 }) })).statusCode, 400);
  await call('risk', { risk: { maxOrderUsd: 100 } });
  const blocked = await call('execute', { token: mk({ notional: 500 }) });
  assert.equal(blocked.statusCode, 422); assert.match(blocked.body.error, /per-order limit/);
  await call('risk', { risk: { maxOrderUsd: 5000, killSwitch: true } });
  assert.match((await call('execute', { token: mk({ notional: 500 }) })).body.error, /kill switch/);
  await call('risk', { risk: { maxOrderUsd: 5000 } });
  price = 63000;
  const moved = await call('execute', { token: mk({ notional: 500 }) });
  assert.equal(moved.statusCode, 409); assert.match(moved.body.error, /Price moved 5%/);
  price = 60000;
  assert.equal((await call('execute', { token: mk({ notional: 500 }) })).statusCode, 200);
  assert.equal((await call('execute', { token: mk({ notional: 500 }, { live: true }) })).statusCode, 409, 'paper ticket cannot be replayed as live');
});

test('requires an access code (or sign-in) for trading actions', async () => {
  const req = { method: 'POST', url: '/api/trading?action=portfolio', query: { action: 'portfolio' }, body: {}, headers: { 'x-forwarded-for': '2.2.2.2' } };
  const res = { headers: {}, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler(req, res); assert.equal(res.statusCode, 401);
});

test('risk settings are sanitized', () => {
  const r = sanitizeRisk({ maxOrderUsd: '-5', maxPositionPct: 400, liveTrading: 'yes', allowedSymbols: 'aapl, btc-usd, $$$' });
  assert.equal(r.maxOrderUsd, 1); assert.equal(r.maxPositionPct, 100); assert.equal(r.liveTrading, false); assert.deepEqual(r.allowedSymbols, ['AAPL', 'BTC-USD']);
});
