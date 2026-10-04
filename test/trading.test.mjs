import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { krakenSign, coinbaseJwt, makeAdapter, newSimState, normalizeOrder, checkRisk, DEFAULT_RISK, sma, ema, rsi, macd, analyze, backtest, runTraderTool, traderChat, usMarketOpen } from '../api/_trading.js';

process.env.SESSION_SECRET = 'z'.repeat(40);

/* ---------- a fake HTTP layer that records requests ---------- */
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? String(opts.body) : '' });
    for (const [re, h] of routes) if (re.test(String(url)) && (!h.method || h.method === (opts.method || 'GET'))) {
      const body = typeof h.body === 'function' ? h.body(String(url), opts) : h.body;
      return { ok: (h.status || 200) < 400, status: h.status || 200, text: async () => JSON.stringify(body) };
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'no route ' + url }) };
  };
  f.calls = calls; return f;
}

/* ---------- signing ---------- */
test('Kraken signature matches Kraken\'s published example', () => {
  const secret = 'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==';
  const sig = krakenSign('/0/private/AddOrder', '1616492376594', 'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25', secret);
  assert.equal(sig, '4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==');
});

test('Coinbase JWT is a valid ES256 token with the right claims', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'sec1', format: 'pem' });
  const jwt = coinbaseJwt({ keyName: 'organizations/o/apiKeys/k', privateKey: pem }, 'POST', 'api.coinbase.com', '/api/v3/brokerage/orders', 1_700_000_000);
  const [h, p, s] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url')), payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(header.alg, 'ES256'); assert.equal(header.kid, 'organizations/o/apiKeys/k');
  assert.deepEqual([payload.iss, payload.sub, payload.nbf, payload.exp, payload.uri], ['cdp', 'organizations/o/apiKeys/k', 1_700_000_000, 1_700_000_120, 'POST api.coinbase.com/api/v3/brokerage/orders']);
  assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), true);
});

/* ---------- adapters: request shapes and parsing ---------- */
test('Alpaca paper: account, quote and order requests', async () => {
  const f = fakeFetch([
    [/paper-api\.alpaca\.markets\/v2\/account$/, { body: { account_number: 'PA1', equity: '10500', last_equity: '10000', cash: '4000', buying_power: '8000', currency: 'USD' } }],
    [/stocks\/AAPL\/quotes\/latest/, { body: { quote: { bp: 199, ap: 201 } } }],
    [/paper-api\.alpaca\.markets\/v2\/orders$/, { method: 'POST', body: { id: 'o1', status: 'accepted' } }]
  ]);
  const a = makeAdapter('alpaca', { env: 'paper', keyId: 'K', secret: 'S' }, { fetchImpl: f });
  assert.deepEqual(await a.account(), { id: 'PA1', equity: 10500, cash: 4000, buyingPower: 8000, dayPnl: 500, currency: 'USD' });
  assert.equal((await a.quote('aapl')).price, 200);
  const { order } = normalizeOrder({ symbol: 'AAPL', side: 'buy', qty: 3, type: 'limit', limitPrice: 199.5, tif: 'day' });
  assert.deepEqual(await a.placeOrder(order), { id: 'o1', status: 'accepted' });
  const post = f.calls.at(-1);
  assert.equal(post.headers['APCA-API-KEY-ID'], 'K');
  assert.deepEqual(JSON.parse(post.body), { symbol: 'AAPL', side: 'buy', type: 'limit', time_in_force: 'day', client_order_id: order.clientId, qty: '3', limit_price: '199.5' });
  assert.equal(a.live, false);
  assert.match(makeAdapter('alpaca', { env: 'live', keyId: 'K', secret: 'S' }, { fetchImpl: f }).live ? 'live' : '', /live/);
});

test('Tradier sandbox: form-encoded order to the right account', async () => {
  const f = fakeFetch([[/sandbox\.tradier\.com\/v1\/accounts\/VA123\/orders$/, { method: 'POST', body: { order: { id: 77, status: 'ok' } } }]]);
  const a = makeAdapter('tradier', { env: 'paper', token: 'T', accountId: 'VA123' }, { fetchImpl: f });
  const r = await a.placeOrder(normalizeOrder({ symbol: 'MSFT', side: 'sell', qty: 2, type: 'market', tif: 'day' }).order);
  assert.deepEqual(r, { id: '77', status: 'ok' });
  const c = f.calls[0];
  assert.equal(c.headers.authorization, 'Bearer T');
  assert.equal(c.body, 'class=equity&symbol=MSFT&side=sell&quantity=2&type=market&duration=day');
});

test('OANDA practice: sell becomes negative units on a market order', async () => {
  const f = fakeFetch([[/api-fxpractice\.oanda\.com\/v3\/accounts\/001-1\/orders$/, { method: 'POST', body: { orderFillTransaction: { orderID: '55' } } }]]);
  const a = makeAdapter('oanda', { env: 'paper', token: 'T', accountId: '001-1' }, { fetchImpl: f });
  assert.deepEqual(await a.placeOrder(normalizeOrder({ symbol: 'EUR/USD', side: 'sell', qty: 1000, type: 'market' }).order), { id: '55', status: 'filled' });
  assert.deepEqual(JSON.parse(f.calls[0].body), { order: { type: 'MARKET', instrument: 'EUR_USD', units: '-1000', timeInForce: 'FOK' } });
});

test('Coinbase: market buy by dollar amount, signed per request', async () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const f = fakeFetch([[/api\.coinbase\.com\/api\/v3\/brokerage\/orders$/, { method: 'POST', body: { success: true, success_response: { order_id: 'cb1' } } }]]);
  const a = makeAdapter('coinbase', { keyName: 'k', privateKey: privateKey.export({ type: 'sec1', format: 'pem' }) }, { fetchImpl: f });
  assert.equal(a.live, true);
  assert.deepEqual(await a.placeOrder(normalizeOrder({ symbol: 'btc/usd', side: 'buy', notional: 50, type: 'market' }).order), { id: 'cb1', status: 'submitted' });
  const body = JSON.parse(f.calls[0].body);
  assert.equal(body.product_id, 'BTC-USD'); assert.equal(body.side, 'BUY'); assert.deepEqual(body.order_configuration, { market_market_ioc: { quote_size: '50' } });
  const jwt = f.calls[0].headers.authorization.replace('Bearer ', '');
  assert.equal(JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')).uri, 'POST api.coinbase.com/api/v3/brokerage/orders');
});

test('Kraken: AddOrder is signed and uses XBT pair naming', async () => {
  const secret = Buffer.from('s'.repeat(64)).toString('base64');
  const f = fakeFetch([[/api\.kraken\.com\/0\/private\/AddOrder$/, { method: 'POST', body: { error: [], result: { txid: ['TX1'] } } }]]);
  const a = makeAdapter('kraken', { key: 'KEY', secret }, { fetchImpl: f });
  assert.deepEqual(await a.placeOrder(normalizeOrder({ symbol: 'BTC-USD', side: 'buy', qty: 0.01, type: 'limit', limitPrice: 60000 }).order), { id: 'TX1', status: 'submitted' });
  const c = f.calls[0]; const params = new URLSearchParams(c.body);
  assert.equal(params.get('pair'), 'XBTUSD'); assert.equal(params.get('ordertype'), 'limit'); assert.equal(params.get('price'), '60000');
  assert.equal(c.headers['API-Sign'], krakenSign('/0/private/AddOrder', params.get('nonce'), c.body, secret));
});

test('Kraken surfaces exchange errors', async () => {
  const f = fakeFetch([[/Ticker/, { body: { error: ['EQuery:Unknown asset pair'], result: {} } }]]);
  await assert.rejects(makeAdapter('kraken', { key: 'k', secret: 'c2VjcmV0' }, { fetchImpl: f }).quote('ZZZ-USD'), /Unknown asset pair/);
});

test('IBKR: symbol resolves to conid before the order', async () => {
  const f = fakeFetch([
    [/secdef\/search\?symbol=AAPL/, { body: [{ conid: 265598 }] }],
    [/iserver\/account\/U1\/orders$/, { method: 'POST', body: [{ order_id: '9', order_status: 'Submitted' }] }]
  ]);
  const a = makeAdapter('ibkr', { env: 'paper', gatewayUrl: 'https://gw.example.com', accountId: 'U1' }, { fetchImpl: f });
  assert.deepEqual(await a.placeOrder(normalizeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, type: 'market' }).order), { id: '9', status: 'Submitted' });
  assert.equal(f.calls[1].url, 'https://gw.example.com/v1/api/iserver/account/U1/orders');
  assert.equal(JSON.parse(f.calls[1].body).orders[0].conid, 265598);
});

/* ---------- simulator ---------- */
const ticker = px => [/exchange\.coinbase\.com\/products\/BTC-USD\/ticker/, { body: { price: String(px), bid: String(px - 1), ask: String(px + 1) } }];
test('Simulator: buy, mark, sell, no shorting, no overspending', async () => {
  let price = 50000;
  const f = fakeFetch([[/exchange\.coinbase\.com\/products\/BTC-USD\/ticker/, { body: () => ({ price: String(price), bid: String(price - 1), ask: String(price + 1) }) }]]);
  const sim = makeAdapter('sim', {}, { fetchImpl: f, sim: newSimState(100000) });
  const r = await sim.placeOrder(normalizeOrder({ symbol: 'BTC-USD', side: 'buy', notional: 10001, type: 'market' }).order);
  assert.equal(r.status, 'filled'); assert.equal(r.filledAvg, 50001);
  price = 55000;
  const acct = await sim.account();
  const held = sim.state.positions['BTC-USD'].qty;
  assert.ok(Math.abs(held - 10001 / 50001) < 1e-8);
  assert.equal(acct.cash, 89999); assert.ok(Math.abs(acct.equity - (89999 + held * 55000)) < 0.01);
  await assert.rejects(sim.placeOrder(normalizeOrder({ symbol: 'BTC-USD', side: 'sell', qty: 1, type: 'market' }).order), /cannot sell more/);
  await assert.rejects(sim.placeOrder(normalizeOrder({ symbol: 'BTC-USD', side: 'buy', qty: 100, type: 'market' }).order), /not enough cash/);
  await sim.placeOrder(normalizeOrder({ symbol: 'BTC-USD', side: 'sell', qty: held, type: 'market' }).order);
  assert.deepEqual(await sim.positions(), []);
  assert.ok(Math.abs(sim.state.realized - held * (54999 - 50001)) < 0.01);
});

test('Simulator: limit order rests, then fills when price crosses', async () => {
  let price = 50000;
  const f = fakeFetch([[/ticker/, { body: () => ({ price: String(price), bid: String(price), ask: String(price) }) }]]);
  const sim = makeAdapter('sim', {}, { fetchImpl: f, sim: newSimState(100000) });
  const r = await sim.placeOrder(normalizeOrder({ symbol: 'BTC-USD', side: 'buy', qty: 0.1, type: 'limit', limitPrice: 48000, tif: 'gtc' }).order);
  assert.equal(r.status, 'open');
  price = 47500; await sim.checkOpenOrders();
  const o = (await sim.orders())[0]; assert.equal(o.status, 'filled'); assert.equal(o.filledAvg, 48000);
  assert.equal(sim.state.cash, 100000 - 4800);
});

test('Simulator asks for a data source before trading stocks', async () => {
  const sim = makeAdapter('sim', {}, { fetchImpl: fakeFetch([]), sim: newSimState() });
  await assert.rejects(sim.quote('AAPL'), /connect a free Alpaca paper account/);
});

/* ---------- order validation + risk ---------- */
test('normalizeOrder rejects malformed orders', () => {
  assert.match(normalizeOrder({ symbol: 'AAPL', side: 'buy', type: 'market' }).errors.join(' '), /exactly one of qty or notional/);
  assert.match(normalizeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, type: 'limit' }).errors.join(' '), /limit price/);
  assert.match(normalizeOrder({ symbol: 'AAPL', side: 'hold', qty: 1 }).errors.join(' '), /buy or sell/);
  assert.match(normalizeOrder({ symbol: 'AAPL', side: 'buy', notional: 100, type: 'limit', limitPrice: 5 }).errors.join(' '), /must be market/);
  assert.deepEqual(normalizeOrder({ symbol: 'aapl', side: 'BUY', qty: '2' }).errors, []);
});

test('Symbol classes: crypto vs forex vs stocks', async () => {
  const { normSymbol } = await import('../api/_trading.js');
  assert.equal(normSymbol('btc/usd'), 'BTC-USD'); assert.equal(normSymbol('EUR/USD'), 'EUR/USD'); assert.equal(normSymbol('aapl'), 'AAPL');
});

test('Risk engine enforces every limit', () => {
  const ord = x => normalizeOrder({ symbol: 'AAPL', side: 'buy', type: 'market', ...x }).order;
  const ctx = { price: 100, account: { equity: 10000, dayPnl: 0 }, positions: [], ordersToday: 0, live: false, now: new Date('2026-10-05T15:00:00Z') };
  assert.equal(checkRisk(ord({ qty: 10 }), ctx).ok, true);
  assert.match(checkRisk(ord({ qty: 30 }), ctx).reasons.join(), /per-order limit/);
  assert.match(checkRisk(ord({ qty: 19 }), { ...ctx, positions: [{ symbol: 'AAPL', qty: 10, value: 1000 }] }).reasons.join(), /% of the account/);
  assert.match(checkRisk(ord({ qty: 1 }), { ...ctx, live: true }).reasons.join(), /Live trading is off/);
  assert.equal(checkRisk(ord({ qty: 1 }), { ...ctx, live: true }, { liveTrading: true }).ok, true);
  assert.match(checkRisk(ord({ qty: 1 }), ctx, { killSwitch: true }).reasons.join(), /kill switch/);
  assert.match(checkRisk(ord({ qty: 1 }), { ...ctx, account: { equity: 10000, dayPnl: -1500 } }).reasons.join(), /Daily loss limit/);
  assert.match(checkRisk(ord({ qty: 1 }), { ...ctx, ordersToday: 25 }).reasons.join(), /25 orders today/);
  assert.match(checkRisk(normalizeOrder({ symbol: 'AAPL', side: 'sell', qty: 5, type: 'market' }).order, ctx).reasons.join(), /shorting is off/);
  assert.equal(checkRisk(normalizeOrder({ symbol: 'AAPL', side: 'sell', qty: 5, type: 'market' }).order, { ...ctx, positions: [{ symbol: 'AAPL', qty: 5, value: 500 }] }).ok, true);
  assert.match(checkRisk(ord({ qty: 1 }), ctx, { blockedSymbols: ['AAPL'] }).reasons.join(), /blocked list/);
  assert.match(checkRisk(ord({ qty: 1 }), ctx, { allowedSymbols: ['MSFT'] }).reasons.join(), /not on your allowed list/);
  assert.match(checkRisk(ord({ qty: 1 }), { ...ctx, price: NaN }).reasons.join(), /Could not price/);
  assert.match(checkRisk(ord({ qty: 1 }), { ...ctx, now: new Date('2026-10-04T15:00:00Z') }).warnings.join(), /market is closed/);
});

test('US market hours (Eastern time)', () => {
  assert.equal(usMarketOpen(new Date('2026-10-05T13:30:00Z')), true);   // Mon 9:30 ET
  assert.equal(usMarketOpen(new Date('2026-10-05T13:29:00Z')), false);
  assert.equal(usMarketOpen(new Date('2026-10-05T20:00:00Z')), false);  // 4:00 pm ET
  assert.equal(usMarketOpen(new Date('2026-10-03T15:00:00Z')), false);  // Saturday
});

/* ---------- indicators ---------- */
test('SMA, EMA and MACD basics', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const e = ema([1, 2, 3, 4, 5], 3); assert.equal(e[2], 2); assert.equal(e[3], 3); assert.equal(e[4], 4);
  const m = macd(Array.from({ length: 60 }, (_, i) => 100 + i));
  assert.ok(m.line.at(-1) > 0 && m.signal.at(-1) > 0);
});

test('RSI matches the StockCharts worked example (Wilder smoothing)', () => {
  const c = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.2820, 46.0028, 46.0328, 46.4116];
  const r = rsi(c, 14);
  assert.equal(Math.round(r[14] * 100) / 100, 70.53);
  assert.equal(Math.round(r[15] * 100) / 100, 66.32);
  assert.equal(Math.round(r[16] * 100) / 100, 66.55);
  assert.equal(Math.round(r[17] * 100) / 100, 69.41);
});

/* ---------- backtester ---------- */
const mkBars = closes => closes.map((c, i) => ({ t: new Date(Date.UTC(2024, 0, 1) + i * 864e5).toISOString(), o: i ? closes[i - 1] : c, h: Math.max(c, i ? closes[i - 1] : c), l: Math.min(c, i ? closes[i - 1] : c), c }));
test('Backtest: buy-and-hold equals the market move minus costs', () => {
  const bars = mkBars(Array.from({ length: 120 }, (_, i) => 100 + i));
  const r = backtest(bars, 'buy_hold', {}, { costBps: 0 });
  // enters at bar 1 open (=100) and ends at 219
  assert.equal(r.totalReturnPct, 119); assert.equal(r.maxDrawdownPct, 0); assert.equal(r.trades, 1);
  assert.ok(backtest(bars, 'buy_hold', {}, { costBps: 50 }).totalReturnPct < 119);
});

test('Backtest: no look-ahead, and a trend filter avoids a crash', () => {
  const up = Array.from({ length: 80 }, (_, i) => 100 + i), down = Array.from({ length: 80 }, (_, i) => 179 - i * 1.5);
  const bars = mkBars([...up, ...down]);
  const trend = backtest(bars, 'sma_cross', { fast: 5, slow: 20 }, { costBps: 0 });
  const hold = backtest(bars, 'buy_hold', {}, { costBps: 0 });
  assert.ok(trend.maxDrawdownPct > hold.maxDrawdownPct, `trend dd ${trend.maxDrawdownPct} vs hold ${hold.maxDrawdownPct}`);
  assert.ok(trend.totalReturnPct > hold.totalReturnPct);
  // shifting the last bar's close cannot change any trade that already happened
  const bars2 = bars.map((b, i) => (i === bars.length - 1 ? { ...b, c: b.c * 3 } : b));
  assert.deepEqual(backtest(bars2, 'sma_cross', { fast: 5, slow: 20 }, { costBps: 0 }).lastTrades.slice(0, -1), trend.lastTrades.slice(0, -1));
  for (const s of ['rsi_revert', 'breakout', 'macd_trend']) assert.equal(typeof backtest(bars, s).totalReturnPct, 'number', s);
  assert.match(backtest(bars.slice(0, 10), 'buy_hold').error, /at least 40/);
  assert.match(backtest(bars, 'nope').error, /Unknown strategy/);
});

test('analyze returns a full technical snapshot', () => {
  const a = analyze(mkBars(Array.from({ length: 260 }, (_, i) => 100 + i * 0.5 + Math.sin(i / 5) * 3)));
  for (const k of ['last', 'sma20', 'sma50', 'sma200', 'rsi14', 'macd', 'atr14', 'volatilityAnnualPct', 'trend']) assert.ok(a[k] !== null && a[k] !== undefined, k);
  assert.equal(a.trend, 'uptrend');
});

/* ---------- agent tools and loop ---------- */
const sealer = p => Buffer.from(JSON.stringify(p)).toString('base64url');
test('place_order produces a confirmable proposal; risk blocks oversize and live', async () => {
  const f = fakeFetch([ticker(50000)]);
  const adapters = { sim: makeAdapter('sim', {}, { fetchImpl: f, sim: newSimState(100000) }) };
  const ok = await runTraderTool('place_order', { broker: 'sim', symbol: 'BTC-USD', side: 'buy', notional: 1000, type: 'market' }, { adapters, risk: {}, seal: sealer });
  assert.equal(ok.ok, true); assert.equal(ok.proposal.kind, 'order'); assert.match(ok.proposal.summary, /Paper BUY \$1000 of BTC-USD/); assert.ok(ok.proposal.token);
  assert.equal(adapters.sim.state.cash, 100000, 'nothing executed before confirmation');
  const big = await runTraderTool('place_order', { broker: 'sim', symbol: 'BTC-USD', side: 'buy', notional: 5000, type: 'market' }, { adapters, risk: {}, seal: sealer });
  assert.equal(big.ok, false); assert.match(big.output, /per-order limit/);
  const liveA = { alpaca: { ...makeAdapter('sim', {}, { fetchImpl: f, sim: newSimState() }), broker: 'alpaca', live: true } };
  const live = await runTraderTool('place_order', { broker: 'alpaca', symbol: 'BTC-USD', side: 'buy', notional: 100, type: 'market' }, { adapters: liveA, risk: {}, seal: sealer });
  assert.match(live.output, /Live trading is off/);
  assert.match((await runTraderTool('get_quote', { broker: 'kraken', symbol: 'X' }, { adapters })).output, /not connected/);
});

test('traderChat runs analysis + backtest + order tools and returns proposals', async () => {
  const closes = Array.from({ length: 300 }, (_, i) => 30000 + i * 50);
  const candles = closes.map((c, i) => [Math.floor(Date.UTC(2025, 0, 1) / 1000) + i * 86400, c - 100, c + 100, c - 50, c, 10]);
  const f = fakeFetch([ticker(45000), [/candles/, { body: candles }]]);
  const adapters = { sim: makeAdapter('sim', {}, { fetchImpl: f, sim: newSimState(100000) }) };
  const turns = [
    { content: [{ type: 'tool_use', id: 'a', name: 'analyze', input: { broker: 'sim', symbol: 'BTC-USD' } }, { type: 'tool_use', id: 'b', name: 'backtest', input: { broker: 'sim', symbol: 'BTC-USD', strategy: 'sma_cross' } }] },
    { content: [{ type: 'tool_use', id: 'c', name: 'place_order', input: { broker: 'sim', symbol: 'BTC-USD', side: 'buy', notional: 500, type: 'market' } }] },
    { content: [{ type: 'text', text: 'Prepared a paper buy of $500 BTC-USD for your confirmation.' }] }
  ];
  let i = 0; const seen = [];
  const callModel = async (_k, body) => { seen.push(body); return { ok: true, status: 200, json: async () => ({ ...turns[i++], usage: { input_tokens: 1, output_tokens: 1 } }) }; };
  const out = await traderChat({ key: 'k', callModel, messages: [{ role: 'user', content: 'Analyze BTC and buy $500 if trend is up' }], adapters, risk: {}, seal: sealer });
  assert.equal(out.proposals.length, 1); assert.deepEqual(out.tools.map(t => t.tool), ['analyze', 'backtest', 'place_order']);
  assert.ok(out.tools.every(t => t.ok));
  const results = seen[2].messages.flatMap(m => (Array.isArray(m.content) ? m.content : [])).filter(b => b.type === 'tool_result');
  const byId = id => results.find(r => r.tool_use_id === id).content;
  assert.match(byId('a'), /"trend":"uptrend"/); assert.match(byId('b'), /"maxDrawdownPct"/); assert.match(byId('c'), /waiting for the user's confirmation/);
  assert.match(seen[0].system, /never place or cancel orders yourself/);
});
