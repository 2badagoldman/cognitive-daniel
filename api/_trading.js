// Cognitive Trader — broker adapters, risk engine, analytics and backtesting for the Cognitive AI suite.
//
// Brokers (one normalized interface: account · positions · orders · quote · bars · placeOrder · cancelOrder):
//   sim       Built-in simulator. $100k virtual cash, no account needed. Crypto prices from Coinbase's public feed;
//             stock prices need a connected Alpaca (free paper account) or Tradier key.
//   alpaca    US stocks, ETFs, crypto. Paper or live.
//   tradier   US stocks, ETFs. Sandbox or live.
//   oanda     Forex and CFDs. Practice or live.
//   coinbase  Coinbase Advanced Trade (crypto). Live only (Coinbase has no sandbox for Advanced Trade).
//   kraken    Kraken spot (crypto). Live only.
//   ibkr      Interactive Brokers via the user's Client Portal Gateway (must be reachable over HTTPS). Beta.
//
// Safety model: the agent never trades on its own. Every order and cancel is a proposal that the user confirms
// in the app; the risk engine re-checks at confirmation; live (real-money) trading is off until the user turns it on.
import crypto from 'node:crypto';

/* ======================= helpers ======================= */
const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const FIAT = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK', 'DKK', 'SGD', 'HKD', 'MXN', 'ZAR', 'TRY', 'PLN', 'CNH']);
const isCryptoSymbol = s => { const m = String(s || '').toUpperCase().match(/^([A-Z0-9]{2,10})[-/](USD|USDT|USDC|EUR|GBP|BTC|ETH)$/); return !!m && !FIAT.has(m[1]); };
const isFxSymbol = s => { const m = String(s || '').toUpperCase().match(/^([A-Z]{3})[-_/]([A-Z]{3})$/); return !!m && FIAT.has(m[1]) && FIAT.has(m[2]); };
export const normSymbol = (s, style = 'dash') => {
  const x = String(s || '').trim().toUpperCase();
  if (isCryptoSymbol(x)) return style === 'slash' ? x.replace('-', '/') : x.replace('/', '-');
  return x;
};
async function http(fetchImpl, url, opts = {}, label = 'Broker') {
  const r = await fetchImpl(url, opts);
  const text = await r.text();
  let d; try { d = text ? JSON.parse(text) : {}; } catch { d = { raw: text }; }
  if (!r.ok) {
    const msg = d?.message || d?.error?.message || (Array.isArray(d?.error) ? d.error.join(', ') : d?.error) || d?.errorMessage || d?.fault?.faultstring || d?.raw || r.status;
    throw Object.assign(new Error(`${label}: ${String(msg).slice(0, 300)}`), { status: r.status >= 500 ? 502 : r.status });
  }
  return d;
}

/* ======================= signing ======================= */
// Kraken: API-Sign = base64( HMAC-SHA512( base64decode(secret), path + SHA256(nonce + postData) ) )
export function krakenSign(path, nonce, postData, secret) {
  const sha = crypto.createHash('sha256').update(String(nonce) + postData).digest();
  return crypto.createHmac('sha512', Buffer.from(secret, 'base64')).update(Buffer.concat([Buffer.from(path), sha])).digest('base64');
}
// Coinbase Advanced Trade (CDP keys): ES256 JWT, one per request, valid 2 minutes.
export function coinbaseJwt({ keyName, privateKey }, method, host, path, now = Math.floor(Date.now() / 1000)) {
  const header = { alg: 'ES256', kid: keyName, nonce: crypto.randomBytes(16).toString('hex'), typ: 'JWT' };
  const payload = { sub: keyName, iss: 'cdp', nbf: now, exp: now + 120, uri: `${method} ${host}${path}` };
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${b64(header)}.${b64(payload)}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: String(privateKey).replace(/\\n/g, '\n'), dsaEncoding: 'ieee-p1363' });
  return `${data}.${sig.toString('base64url')}`;
}

/* ======================= broker registry ======================= */
export const BROKERS = {
  sim: { label: 'Cognitive Simulator', assets: 'Stocks (with Alpaca/Tradier data), crypto', fields: [], envs: ['paper'] },
  alpaca: { label: 'Alpaca', assets: 'US stocks, ETFs, crypto', fields: ['keyId', 'secret'], envs: ['paper', 'live'], help: 'alpaca.markets → Paper Trading → API Keys' },
  tradier: { label: 'Tradier', assets: 'US stocks, ETFs', fields: ['token', 'accountId'], envs: ['paper', 'live'], help: 'tradier.com → Settings → API Access (sandbox token for paper)' },
  oanda: { label: 'OANDA', assets: 'Forex, CFDs', fields: ['token', 'accountId'], envs: ['paper', 'live'], help: 'OANDA → Manage API Access (fxTrade Practice for paper)' },
  coinbase: { label: 'Coinbase Advanced', assets: 'Crypto', fields: ['keyName', 'privateKey'], envs: ['live'], help: 'Coinbase Developer Platform → API keys (ECDSA, trade permission)' },
  kraken: { label: 'Kraken', assets: 'Crypto', fields: ['key', 'secret'], envs: ['live'], help: 'Kraken → Settings → API (Query + Create & Modify Orders)' },
  ibkr: { label: 'Interactive Brokers (beta)', assets: 'Stocks, options, futures, forex', fields: ['gatewayUrl', 'accountId'], envs: ['paper', 'live'], help: 'Run IBKR Client Portal Gateway, log in, and expose it over HTTPS' }
};
export const UNSUPPORTED = [
  ['Robinhood (stocks)', 'No public trading API for stocks.'],
  ['Fidelity, Vanguard', 'No public retail trading API.'],
  ['Charles Schwab / thinkorswim', 'API requires Schwab developer approval for this app first.'],
  ['E*TRADE, Webull, MetaTrader', 'Planned; each needs its own app approval or bridge.']
];

/* ======================= adapters ======================= */
export function makeAdapter(broker, cred = {}, { fetchImpl = fetch, sim, dataSource } = {}) {
  const env = cred.env || (BROKERS[broker]?.envs[0]);
  const live = env === 'live';
  if (broker === 'alpaca') {
    const base = live ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
    const data = 'https://data.alpaca.markets';
    const H = { 'APCA-API-KEY-ID': cred.keyId, 'APCA-API-SECRET-KEY': cred.secret, 'content-type': 'application/json' };
    const g = (u, o = {}) => http(fetchImpl, u, { ...o, headers: H }, 'Alpaca');
    return {
      broker, env, live,
      async account() { const a = await g(`${base}/v2/account`); return { id: a.account_number || a.id, equity: num(a.equity), cash: num(a.cash), buyingPower: num(a.buying_power), dayPnl: num(a.equity) - num(a.last_equity), currency: a.currency || 'USD' }; },
      async positions() { return (await g(`${base}/v2/positions`)).map(p => ({ symbol: p.symbol, qty: num(p.qty), avgPrice: num(p.avg_entry_price), price: num(p.current_price), value: num(p.market_value), pnl: num(p.unrealized_pl) })); },
      async orders() { return (await g(`${base}/v2/orders?status=all&limit=50&direction=desc`)).map(o => ({ id: o.id, symbol: o.symbol, side: o.side, qty: num(o.qty), type: o.type, status: o.status, limitPrice: num(o.limit_price), filledAvg: num(o.filled_avg_price), at: o.submitted_at })); },
      async quote(symbol) {
        const s = normSymbol(symbol);
        if (isCryptoSymbol(s)) { const d = await g(`${data}/v1beta3/crypto/us/latest/quotes?symbols=${encodeURIComponent(normSymbol(s, 'slash'))}`); const q = d.quotes?.[normSymbol(s, 'slash')]; return { symbol: s, bid: num(q?.bp), ask: num(q?.ap), price: (num(q?.bp) + num(q?.ap)) / 2 }; }
        const d = await g(`${data}/v2/stocks/${encodeURIComponent(s)}/quotes/latest`); const q = d.quote || {}; return { symbol: s, bid: num(q.bp), ask: num(q.ap), price: num(q.ap) && num(q.bp) ? (num(q.ap) + num(q.bp)) / 2 : num(q.ap) || num(q.bp) };
      },
      async bars(symbol, days = 250) {
        const s = normSymbol(symbol); const start = new Date(Date.now() - Math.ceil(days * 1.6) * 864e5).toISOString().slice(0, 10);
        const d = isCryptoSymbol(s) ? await g(`${data}/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(normSymbol(s, 'slash'))}&timeframe=1Day&start=${start}&limit=1000`) : await g(`${data}/v2/stocks/${encodeURIComponent(s)}/bars?timeframe=1Day&start=${start}&limit=1000&adjustment=all`);
        const rows = isCryptoSymbol(s) ? d.bars?.[normSymbol(s, 'slash')] || [] : d.bars || [];
        return rows.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })).slice(-days);
      },
      async placeOrder(o) {
        const body = { symbol: isCryptoSymbol(o.symbol) ? normSymbol(o.symbol, 'slash') : o.symbol, side: o.side, type: o.type, time_in_force: isCryptoSymbol(o.symbol) && o.tif === 'day' ? 'gtc' : o.tif, client_order_id: o.clientId };
        if (o.qty) body.qty = String(o.qty); else body.notional = String(o.notional);
        if (o.limitPrice) body.limit_price = String(o.limitPrice); if (o.stopPrice) body.stop_price = String(o.stopPrice);
        const r = await g(`${base}/v2/orders`, { method: 'POST', body: JSON.stringify(body) }); return { id: r.id, status: r.status };
      },
      async cancelOrder(id) { await g(`${base}/v2/orders/${encodeURIComponent(id)}`, { method: 'DELETE' }); return { id, status: 'canceled' }; }
    };
  }
  if (broker === 'tradier') {
    const base = live ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';
    const H = { authorization: `Bearer ${cred.token}`, accept: 'application/json' };
    const g = (u, o = {}) => http(fetchImpl, `${base}${u}`, { ...o, headers: { ...H, ...(o.headers || {}) } }, 'Tradier');
    const acct = encodeURIComponent(cred.accountId || '');
    const arr = x => (x == null || x === 'null' ? [] : Array.isArray(x) ? x : [x]);
    return {
      broker, env, live,
      async account() { const b = (await g(`/accounts/${acct}/balances`)).balances || {}; return { id: cred.accountId, equity: num(b.total_equity), cash: num(b.total_cash), buyingPower: num(b.margin?.stock_buying_power ?? b.cash?.cash_available ?? b.total_cash), dayPnl: num(b.close_pl ?? 0), currency: 'USD' }; },
      async positions() { return arr((await g(`/accounts/${acct}/positions`)).positions?.position).map(p => ({ symbol: p.symbol, qty: num(p.quantity), avgPrice: num(p.cost_basis) / num(p.quantity), price: NaN, value: NaN, pnl: NaN })); },
      async orders() { return arr((await g(`/accounts/${acct}/orders`)).orders?.order).map(o => ({ id: String(o.id), symbol: o.symbol, side: o.side, qty: num(o.quantity), type: o.type, status: o.status, limitPrice: num(o.price), filledAvg: num(o.avg_fill_price), at: o.create_date })); },
      async quote(symbol) { const q = arr((await g(`/markets/quotes?symbols=${encodeURIComponent(symbol)}`)).quotes?.quote)[0] || {}; return { symbol: q.symbol || symbol, bid: num(q.bid), ask: num(q.ask), price: num(q.last) || (num(q.bid) + num(q.ask)) / 2 }; },
      async bars(symbol, days = 250) { const start = new Date(Date.now() - Math.ceil(days * 1.6) * 864e5).toISOString().slice(0, 10); return arr((await g(`/markets/history?symbol=${encodeURIComponent(symbol)}&interval=daily&start=${start}`)).history?.day).map(d => ({ t: d.date, o: d.open, h: d.high, l: d.low, c: d.close, v: d.volume })).slice(-days); },
      async placeOrder(o) {
        const f = new URLSearchParams({ class: 'equity', symbol: o.symbol, side: o.side, quantity: String(o.qty), type: o.type, duration: o.tif });
        if (o.limitPrice) f.set('price', String(o.limitPrice)); if (o.stopPrice) f.set('stop', String(o.stopPrice));
        const r = await g(`/accounts/${acct}/orders`, { method: 'POST', body: f, headers: { 'content-type': 'application/x-www-form-urlencoded' } }); return { id: String(r.order?.id), status: r.order?.status || 'submitted' };
      },
      async cancelOrder(id) { await g(`/accounts/${acct}/orders/${encodeURIComponent(id)}`, { method: 'DELETE' }); return { id, status: 'canceled' }; }
    };
  }
  if (broker === 'oanda') {
    const base = live ? 'https://api-fxtrade.oanda.com/v3' : 'https://api-fxpractice.oanda.com/v3';
    const H = { authorization: `Bearer ${cred.token}`, 'content-type': 'application/json' };
    const g = (u, o = {}) => http(fetchImpl, `${base}${u}`, { ...o, headers: H }, 'OANDA');
    const acct = encodeURIComponent(cred.accountId || '');
    const inst = s => String(s).toUpperCase().replace(/[-/]/, '_');
    return {
      broker, env, live,
      async account() { const a = (await g(`/accounts/${acct}/summary`)).account || {}; return { id: a.id, equity: num(a.NAV), cash: num(a.balance), buyingPower: num(a.marginAvailable), dayPnl: num(a.unrealizedPL), currency: a.currency }; },
      async positions() { return ((await g(`/accounts/${acct}/openPositions`)).positions || []).map(p => { const u = num(p.long?.units) + num(p.short?.units); return { symbol: p.instrument, qty: u, avgPrice: num(u >= 0 ? p.long?.averagePrice : p.short?.averagePrice), price: NaN, value: NaN, pnl: num(p.unrealizedPL) }; }); },
      async orders() { return ((await g(`/accounts/${acct}/orders?state=ALL&count=50`)).orders || []).map(o => ({ id: o.id, symbol: o.instrument, side: num(o.units) < 0 ? 'sell' : 'buy', qty: Math.abs(num(o.units)), type: String(o.type || '').toLowerCase(), status: String(o.state || '').toLowerCase(), limitPrice: num(o.price), at: o.createTime })); },
      async quote(symbol) { const p = ((await g(`/accounts/${acct}/pricing?instruments=${inst(symbol)}`)).prices || [])[0] || {}; const bid = num(p.bids?.[0]?.price), ask = num(p.asks?.[0]?.price); return { symbol: inst(symbol), bid, ask, price: (bid + ask) / 2 }; },
      async bars(symbol, days = 250) { return ((await g(`/instruments/${inst(symbol)}/candles?granularity=D&count=${Math.min(days, 5000)}&price=M`)).candles || []).filter(c => c.complete !== false).map(c => ({ t: c.time, o: num(c.mid.o), h: num(c.mid.h), l: num(c.mid.l), c: num(c.mid.c), v: c.volume })); },
      async placeOrder(o) {
        const units = String((o.side === 'sell' ? -1 : 1) * Math.abs(num(o.qty)));
        const order = o.type === 'limit' ? { type: 'LIMIT', instrument: inst(o.symbol), units, price: String(o.limitPrice), timeInForce: o.tif === 'day' ? 'GFD' : 'GTC' } : { type: 'MARKET', instrument: inst(o.symbol), units, timeInForce: 'FOK' };
        const r = await g(`/accounts/${acct}/orders`, { method: 'POST', body: JSON.stringify({ order }) });
        return { id: r.orderFillTransaction?.orderID || r.orderCreateTransaction?.id, status: r.orderFillTransaction ? 'filled' : r.orderCancelTransaction ? 'canceled' : 'accepted' };
      },
      async cancelOrder(id) { await g(`/accounts/${acct}/orders/${encodeURIComponent(id)}/cancel`, { method: 'PUT' }); return { id, status: 'canceled' }; }
    };
  }
  if (broker === 'coinbase') {
    const host = 'api.coinbase.com', prefix = '/api/v3/brokerage';
    const call = (method, path, body) => http(fetchImpl, `https://${host}${prefix}${path}`, { method, headers: { authorization: `Bearer ${coinbaseJwt(cred, method, host, prefix + path.split('?')[0])}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }, 'Coinbase');
    return {
      broker, env: 'live', live: true,
      async account() {
        const accts = (await call('GET', '/accounts?limit=250')).accounts || [];
        let equity = 0; const cash = accts.filter(a => ['USD', 'USDC'].includes(a.currency)).reduce((s, a) => s + num(a.available_balance?.value), 0);
        for (const a of accts) { const v = num(a.available_balance?.value) + num(a.hold?.value || 0); if (!v) continue; if (['USD', 'USDC'].includes(a.currency)) { equity += v; continue; } try { equity += v * (await this.quote(`${a.currency}-USD`)).price; } catch {} }
        return { id: 'coinbase', equity: round(equity), cash: round(cash), buyingPower: round(cash), dayPnl: NaN, currency: 'USD' };
      },
      async positions() { return ((await call('GET', '/accounts?limit=250')).accounts || []).filter(a => !['USD', 'USDC'].includes(a.currency) && num(a.available_balance?.value) + num(a.hold?.value || 0) > 0).map(a => ({ symbol: `${a.currency}-USD`, qty: num(a.available_balance?.value) + num(a.hold?.value || 0), avgPrice: NaN, price: NaN, value: NaN, pnl: NaN })); },
      async orders() { return ((await call('GET', '/orders/historical/batch?limit=50')).orders || []).map(o => ({ id: o.order_id, symbol: o.product_id, side: String(o.side).toLowerCase(), qty: num(o.filled_size), type: String(o.order_type).toLowerCase(), status: String(o.status).toLowerCase(), filledAvg: num(o.average_filled_price), at: o.created_time })); },
      async quote(symbol) { const p = await call('GET', `/products/${encodeURIComponent(normSymbol(symbol))}`); return { symbol: normSymbol(symbol), bid: NaN, ask: NaN, price: num(p.price) }; },
      async bars(symbol, days = 250) { const end = Math.floor(Date.now() / 1000), start = end - Math.min(days, 300) * 86400; return ((await call('GET', `/products/${encodeURIComponent(normSymbol(symbol))}/candles?start=${start}&end=${end}&granularity=ONE_DAY`)).candles || []).map(c => ({ t: new Date(num(c.start) * 1000).toISOString(), o: num(c.open), h: num(c.high), l: num(c.low), c: num(c.close), v: num(c.volume) })).sort((a, b) => a.t.localeCompare(b.t)); },
      async placeOrder(o) {
        const cfg = o.type === 'limit' ? { limit_limit_gtc: { base_size: String(o.qty), limit_price: String(o.limitPrice), post_only: false } } : { market_market_ioc: o.qty ? { base_size: String(o.qty) } : { quote_size: String(o.notional) } };
        const r = await call('POST', '/orders', { client_order_id: o.clientId, product_id: normSymbol(o.symbol), side: o.side.toUpperCase(), order_configuration: cfg });
        if (r.success === false) throw Object.assign(new Error(`Coinbase: ${r.error_response?.message || r.failure_reason || 'order rejected'}`), { status: 400 });
        return { id: r.success_response?.order_id || r.order_id, status: 'submitted' };
      },
      async cancelOrder(id) { const r = await call('POST', '/orders/batch_cancel', { order_ids: [id] }); return { id, status: r.results?.[0]?.success ? 'canceled' : 'cancel-failed' }; }
    };
  }
  if (broker === 'kraken') {
    const base = 'https://api.kraken.com';
    const pair = s => normSymbol(s).replace('-', '').replace(/^BTC/, 'XBT');
    const pub = async (p) => { const d = await http(fetchImpl, `${base}/0/public/${p}`, {}, 'Kraken'); if (d.error?.length) throw Object.assign(new Error(`Kraken: ${d.error.join(', ')}`), { status: 400 }); return d.result; };
    const priv = async (method, params = {}) => {
      const path = `/0/private/${method}`, nonce = String(Date.now() * 1000 + Math.floor(Math.random() * 1000));
      const post = new URLSearchParams({ nonce, ...params }).toString();
      const d = await http(fetchImpl, base + path, { method: 'POST', body: post, headers: { 'API-Key': cred.key, 'API-Sign': krakenSign(path, nonce, post, cred.secret), 'content-type': 'application/x-www-form-urlencoded' } }, 'Kraken');
      if (d.error?.length) throw Object.assign(new Error(`Kraken: ${d.error.join(', ')}`), { status: 400 }); return d.result;
    };
    const self = {
      broker, env: 'live', live: true,
      async account() { const bal = await priv('Balance'); const tb = await priv('TradeBalance', { asset: 'ZUSD' }).catch(() => ({})); const cash = num(bal.ZUSD || bal.USD || 0); return { id: 'kraken', equity: num(tb.eb) || cash, cash, buyingPower: num(tb.mf) || cash, dayPnl: NaN, currency: 'USD' }; },
      async positions() { const bal = await priv('Balance'); return Object.entries(bal).filter(([k, v]) => !/^Z?USD$/.test(k) && num(v) > 0).map(([k, v]) => ({ symbol: `${k.replace(/^X(?=[A-Z]{3,})/, '').replace(/^XBT$/, 'BTC')}-USD`, qty: num(v), avgPrice: NaN, price: NaN, value: NaN, pnl: NaN })); },
      async orders() { const o = await priv('OpenOrders'); const c = await priv('ClosedOrders').catch(() => ({ closed: {} })); return [...Object.entries(o.open || {}), ...Object.entries(c.closed || {})].slice(0, 50).map(([id, x]) => ({ id, symbol: x.descr?.pair, side: x.descr?.type, qty: num(x.vol), type: x.descr?.ordertype, status: x.status, limitPrice: num(x.descr?.price), filledAvg: num(x.price), at: x.opentm ? new Date(x.opentm * 1000).toISOString() : null })); },
      async quote(symbol) { const r = await pub(`Ticker?pair=${pair(symbol)}`); const t = Object.values(r)[0] || {}; return { symbol: normSymbol(symbol), bid: num(t.b?.[0]), ask: num(t.a?.[0]), price: num(t.c?.[0]) }; },
      async bars(symbol, days = 250) { const r = await pub(`OHLC?pair=${pair(symbol)}&interval=1440`); const rows = Object.entries(r).find(([k]) => k !== 'last')?.[1] || []; return rows.map(b => ({ t: new Date(b[0] * 1000).toISOString(), o: num(b[1]), h: num(b[2]), l: num(b[3]), c: num(b[4]), v: num(b[6]) })).slice(-days); },
      async placeOrder(o) { const p = { pair: pair(o.symbol), type: o.side, ordertype: o.type === 'limit' ? 'limit' : 'market', volume: String(o.qty), userref: String(parseInt(String(o.clientId).replace(/\D/g, '').slice(-9) || '0', 10)) }; if (o.type === 'limit') p.price = String(o.limitPrice); const r = await priv('AddOrder', p); return { id: r.txid?.[0], status: 'submitted' }; },
      async cancelOrder(id) { await priv('CancelOrder', { txid: id }); return { id, status: 'canceled' }; }
    };
    return self;
  }
  if (broker === 'ibkr') {
    const base = String(cred.gatewayUrl || '').replace(/\/+$/, '') + (/(\/v1\/api)$/.test(String(cred.gatewayUrl || '').replace(/\/+$/, '')) ? '' : '/v1/api');
    const g = (u, o = {}) => http(fetchImpl, `${base}${u}`, { ...o, headers: { 'content-type': 'application/json', 'user-agent': 'cognitive-ai' } }, 'IBKR');
    const acct = encodeURIComponent(cred.accountId || '');
    const conid = async s => { const r = await g(`/iserver/secdef/search?symbol=${encodeURIComponent(s)}`); const c = (Array.isArray(r) ? r : [])[0]?.conid; if (!c) throw Object.assign(new Error(`IBKR: unknown symbol ${s}`), { status: 400 }); return c; };
    return {
      broker, env, live,
      async account() { const s = await g(`/portfolio/${acct}/summary`); const v = k => num(s[k]?.amount); return { id: cred.accountId, equity: v('netliquidation'), cash: v('totalcashvalue'), buyingPower: v('buyingpower'), dayPnl: NaN, currency: s.netliquidation?.currency || 'USD' }; },
      async positions() { return ((await g(`/portfolio/${acct}/positions/0`)) || []).map(p => ({ symbol: p.contractDesc || p.ticker, qty: num(p.position), avgPrice: num(p.avgCost), price: num(p.mktPrice), value: num(p.mktValue), pnl: num(p.unrealizedPnl) })); },
      async orders() { return ((await g('/iserver/account/orders')).orders || []).map(o => ({ id: String(o.orderId), symbol: o.ticker, side: String(o.side).toLowerCase(), qty: num(o.totalSize), type: String(o.orderType).toLowerCase(), status: String(o.status).toLowerCase(), limitPrice: num(o.price), at: o.lastExecutionTime_r ? new Date(o.lastExecutionTime_r).toISOString() : null })); },
      async quote(symbol) { const c = await conid(symbol); const r = (await g(`/iserver/marketdata/snapshot?conids=${c}&fields=31,84,86`))[0] || {}; return { symbol, bid: num(r['84']), ask: num(r['86']), price: num(String(r['31'] || '').replace(/[^\d.]/g, '')) }; },
      async bars(symbol, days = 250) { const c = await conid(symbol); const r = await g(`/iserver/marketdata/history?conid=${c}&period=${Math.min(days, 365)}d&bar=1d`); return (r.data || []).map(b => ({ t: new Date(b.t).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })); },
      async placeOrder(o) { const c = await conid(o.symbol); const ord = { conid: c, orderType: { market: 'MKT', limit: 'LMT', stop: 'STP', stop_limit: 'STP_LIMIT' }[o.type], side: o.side.toUpperCase(), quantity: num(o.qty), tif: o.tif === 'gtc' ? 'GTC' : 'DAY', cOID: o.clientId }; if (o.limitPrice) ord.price = num(o.limitPrice); if (o.stopPrice) ord.auxPrice = num(o.stopPrice); const r = await g(`/iserver/account/${acct}/orders`, { method: 'POST', body: JSON.stringify({ orders: [ord] }) }); const x = Array.isArray(r) ? r[0] : r; if (x?.id && x?.message) return { id: x.id, status: 'needs-confirmation', message: [].concat(x.message).join(' ') }; return { id: x?.order_id, status: x?.order_status || 'submitted' }; },
      async cancelOrder(id) { await g(`/iserver/account/${acct}/order/${encodeURIComponent(id)}`, { method: 'DELETE' }); return { id, status: 'canceled' }; }
    };
  }
  if (broker === 'sim') return simAdapter(sim, { fetchImpl, dataSource });
  throw Object.assign(new Error(`Unknown broker ${broker}.`), { status: 400 });
}

/* ======================= simulator ======================= */
export function newSimState(cash = 100000) { return { cash, positions: {}, orders: [], realized: 0, startEquity: cash, dayStart: { date: new Date().toISOString().slice(0, 10), equity: cash } }; }
async function coinbasePublic(fetchImpl, path) { return http(fetchImpl, `https://api.exchange.coinbase.com${path}`, { headers: { 'user-agent': 'cognitive-ai' } }, 'Coinbase market data'); }
function simAdapter(state, { fetchImpl, dataSource }) {
  const st = state || newSimState();
  const quote = async symbol => {
    const s = normSymbol(symbol);
    if (isCryptoSymbol(s)) { const t = await coinbasePublic(fetchImpl, `/products/${encodeURIComponent(s)}/ticker`); return { symbol: s, bid: num(t.bid), ask: num(t.ask), price: num(t.price) }; }
    if (dataSource) return dataSource.quote(s);
    throw Object.assign(new Error('The simulator needs stock prices: connect a free Alpaca paper account (or Tradier sandbox) and it will use that data.'), { status: 400 });
  };
  const bars = async (symbol, days = 250) => {
    const s = normSymbol(symbol);
    if (isCryptoSymbol(s)) { const end = new Date(), start = new Date(Date.now() - Math.min(days, 300) * 864e5); const r = await coinbasePublic(fetchImpl, `/products/${encodeURIComponent(s)}/candles?granularity=86400&start=${start.toISOString()}&end=${end.toISOString()}`); return (r || []).map(c => ({ t: new Date(c[0] * 1000).toISOString(), l: c[1], h: c[2], o: c[3], c: c[4], v: c[5] })).sort((a, b) => a.t.localeCompare(b.t)); }
    if (dataSource) return dataSource.bars(s, days);
    throw Object.assign(new Error('Connect Alpaca or Tradier for stock history.'), { status: 400 });
  };
  const mark = async () => { let v = 0; for (const [s, p] of Object.entries(st.positions)) { try { p.price = (await quote(s)).price; } catch {} v += p.qty * (p.price || p.avgPrice); } return v; };
  const fill = (o, px) => {
    const p = st.positions[o.symbol] || { qty: 0, avgPrice: 0 };
    const qty = o.qty || round(o.notional / px, 8);
    if (o.side === 'buy') { const cost = qty * px; if (cost > st.cash + 1e-6) throw Object.assign(new Error('Simulator: not enough cash.'), { status: 400 }); st.cash -= cost; p.avgPrice = (p.avgPrice * p.qty + cost) / (p.qty + qty); p.qty += qty; }
    else { if (qty > p.qty + 1e-9) throw Object.assign(new Error('Simulator: cannot sell more than you hold (no shorting).'), { status: 400 }); st.cash += qty * px; st.realized += (px - p.avgPrice) * qty; p.qty -= qty; }
    if (p.qty <= 1e-9) delete st.positions[o.symbol]; else st.positions[o.symbol] = p;
    return qty;
  };
  return {
    broker: 'sim', env: 'paper', live: false, state: st,
    async account() { const pv = await mark(); const eq = st.cash + pv; const today = new Date().toISOString().slice(0, 10); if (st.dayStart?.date !== today) st.dayStart = { date: today, equity: eq }; return { id: 'simulator', equity: round(eq), cash: round(st.cash), buyingPower: round(st.cash), dayPnl: round(eq - st.dayStart.equity), currency: 'USD' }; },
    async positions() { await mark(); return Object.entries(st.positions).map(([s, p]) => ({ symbol: s, qty: p.qty, avgPrice: round(p.avgPrice, 4), price: p.price, value: round(p.qty * (p.price || p.avgPrice)), pnl: round(p.qty * ((p.price || p.avgPrice) - p.avgPrice)) })); },
    async orders() { return st.orders.slice(-50).reverse(); },
    quote, bars,
    async placeOrder(o) {
      const s = normSymbol(o.symbol); const q = await quote(s); const px = o.side === 'buy' ? (q.ask || q.price) : (q.bid || q.price);
      const id = 'sim_' + crypto.randomBytes(5).toString('hex');
      const rec = { id, symbol: s, side: o.side, qty: o.qty || null, notional: o.notional || null, type: o.type, limitPrice: o.limitPrice || null, status: 'open', at: new Date().toISOString() };
      const marketable = o.type === 'market' || (o.type === 'limit' && (o.side === 'buy' ? px <= o.limitPrice : px >= o.limitPrice));
      if (marketable) { const fpx = o.type === 'limit' ? (o.side === 'buy' ? Math.min(px, o.limitPrice) : Math.max(px, o.limitPrice)) : px; rec.qty = fill({ ...o, symbol: s }, fpx); rec.filledAvg = fpx; rec.status = 'filled'; }
      st.orders.push(rec); if (st.orders.length > 12) st.orders.splice(0, st.orders.length - 12);
      return { id, status: rec.status, filledAvg: rec.filledAvg };
    },
    async cancelOrder(id) { const o = st.orders.find(x => x.id === id && x.status === 'open'); if (!o) throw Object.assign(new Error('No open simulator order with that id.'), { status: 404 }); o.status = 'canceled'; return { id, status: 'canceled' }; },
    async checkOpenOrders() { for (const o of st.orders.filter(x => x.status === 'open')) { try { const q = await quote(o.symbol); const px = o.side === 'buy' ? (q.ask || q.price) : (q.bid || q.price); if (o.side === 'buy' ? px <= o.limitPrice : px >= o.limitPrice) { o.qty = fill(o, o.limitPrice); o.filledAvg = o.limitPrice; o.status = 'filled'; } } catch {} } }
  };
}

/* ======================= order validation + risk engine ======================= */
export const DEFAULT_RISK = { maxOrderUsd: 2000, maxPositionPct: 25, dailyLossLimitUsd: 1000, maxOrdersPerDay: 25, allowShort: false, liveTrading: false, killSwitch: false, allowedSymbols: [], blockedSymbols: [] };

export function normalizeOrder(input = {}) {
  const errors = [];
  const o = {
    symbol: normSymbol(input.symbol), side: String(input.side || '').toLowerCase(), type: String(input.type || 'market').toLowerCase().replace('-', '_'),
    qty: input.qty != null && input.qty !== '' ? Number(input.qty) : null, notional: input.notional != null && input.notional !== '' ? Number(input.notional) : null,
    limitPrice: input.limitPrice != null && input.limitPrice !== '' ? Number(input.limitPrice) : null, stopPrice: input.stopPrice != null && input.stopPrice !== '' ? Number(input.stopPrice) : null,
    tif: String(input.tif || 'day').toLowerCase(), clientId: input.clientId || 'cog_' + crypto.randomBytes(8).toString('hex')
  };
  if (!/^[A-Z0-9._\-/]{1,20}$/.test(o.symbol)) errors.push('A valid symbol is required.');
  if (!['buy', 'sell'].includes(o.side)) errors.push('Side must be buy or sell.');
  if (!['market', 'limit', 'stop', 'stop_limit'].includes(o.type)) errors.push('Type must be market, limit, stop or stop_limit.');
  if (!['day', 'gtc', 'ioc', 'fok'].includes(o.tif)) errors.push('Time in force must be day, gtc, ioc or fok.');
  if ((o.qty == null) === (o.notional == null)) errors.push('Give exactly one of qty or notional (dollar amount).');
  if (o.qty != null && !(o.qty > 0)) errors.push('Quantity must be positive.');
  if (o.notional != null && !(o.notional > 0)) errors.push('Dollar amount must be positive.');
  if (o.notional != null && o.type !== 'market') errors.push('Dollar-amount orders must be market orders.');
  if (['limit', 'stop_limit'].includes(o.type) && !(o.limitPrice > 0)) errors.push('Limit orders need a positive limit price.');
  if (['stop', 'stop_limit'].includes(o.type) && !(o.stopPrice > 0)) errors.push('Stop orders need a positive stop price.');
  return { order: o, errors };
}

// Pure pre-trade check. ctx: { price, account:{equity}, positions:[{symbol,qty,value}], ordersToday, live, broker }
export function checkRisk(order, ctx, risk = DEFAULT_RISK) {
  const R = { ...DEFAULT_RISK, ...risk };
  const reasons = [], warnings = [];
  const px = order.limitPrice || ctx.price;
  const notional = order.notional ?? (Number.isFinite(px) ? order.qty * px : NaN);
  const sym = order.symbol;
  if (R.killSwitch) reasons.push('Trading is paused (kill switch is on).');
  if (ctx.live && !R.liveTrading) reasons.push('Live trading is off. Turn it on in Trading → Risk to place real-money orders.');
  if (R.blockedSymbols?.map(s => normSymbol(s)).includes(sym)) reasons.push(`${sym} is on your blocked list.`);
  if (R.allowedSymbols?.length && !R.allowedSymbols.map(s => normSymbol(s)).includes(sym)) reasons.push(`${sym} is not on your allowed list.`);
  if (!Number.isFinite(notional)) reasons.push('Could not price this order; add a limit price or try again when a quote is available.');
  else {
    if (notional > R.maxOrderUsd) reasons.push(`Order value $${round(notional)} is over your $${R.maxOrderUsd} per-order limit.`);
    const equity = num(ctx.account?.equity);
    const held = (ctx.positions || []).find(p => normSymbol(p.symbol) === sym);
    const heldValue = Math.abs(num(held?.value)) || Math.abs(num(held?.qty) * (ctx.price || 0)) || 0;
    if (order.side === 'buy' && Number.isFinite(equity) && equity > 0) {
      const after = heldValue + notional;
      if (after / equity * 100 > R.maxPositionPct) reasons.push(`${sym} would be ${round(after / equity * 100, 1)}% of the account, over your ${R.maxPositionPct}% limit.`);
    }
    if (order.side === 'sell' && !R.allowShort) {
      const heldQty = num(held?.qty) || 0;
      const sellQty = order.qty ?? (Number.isFinite(px) ? order.notional / px : NaN);
      if (!(heldQty > 0) || sellQty > heldQty + 1e-9) reasons.push(`Selling more ${sym} than you hold would open a short position, and shorting is off.`);
    }
    if (Number.isFinite(ctx.price) && order.limitPrice && Math.abs(order.limitPrice - ctx.price) / ctx.price > 0.1) warnings.push(`Limit price is ${round(Math.abs(order.limitPrice - ctx.price) / ctx.price * 100, 1)}% away from the market.`);
  }
  const dayPnl = num(ctx.account?.dayPnl);
  if (Number.isFinite(dayPnl) && dayPnl <= -Math.abs(R.dailyLossLimitUsd) && order.side === 'buy') reasons.push(`Daily loss limit reached ($${round(dayPnl)} today). New buys are blocked until tomorrow.`);
  if ((ctx.ordersToday || 0) >= R.maxOrdersPerDay) reasons.push(`You have reached ${R.maxOrdersPerDay} orders today.`);
  if (!isCryptoSymbol(sym) && !isFxSymbol(sym) && order.type === 'market' && !usMarketOpen(ctx.now)) warnings.push('US stock market is closed; a market order will wait for the next open (or be rejected by some brokers).');
  return { ok: reasons.length === 0, reasons, warnings, notional: round(notional) };
}

export function usMarketOpen(now = new Date()) {
  const d = new Date(now);
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay(), mins = et.getHours() * 60 + et.getMinutes();
  return day >= 1 && day <= 5 && mins >= 570 && mins < 960;
}

/* ======================= indicators ======================= */
export function sma(xs, n) { const out = Array(xs.length).fill(null); let s = 0; for (let i = 0; i < xs.length; i++) { s += xs[i]; if (i >= n) s -= xs[i - n]; if (i >= n - 1) out[i] = s / n; } return out; }
export function ema(xs, n) { const out = Array(xs.length).fill(null); const k = 2 / (n + 1); let e = null; for (let i = 0; i < xs.length; i++) { if (i === n - 1) e = xs.slice(0, n).reduce((a, b) => a + b, 0) / n; else if (i >= n) e = xs[i] * k + e * (1 - k); out[i] = e; } return out; }
export function rsi(xs, n = 14) {
  const out = Array(xs.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  }
  return out;
}
export function macd(xs, f = 12, s = 26, sig = 9) { const a = ema(xs, f), b = ema(xs, s); const line = xs.map((_, i) => (a[i] != null && b[i] != null ? a[i] - b[i] : null)); const start = line.findIndex(v => v != null); const sl = Array(xs.length).fill(null); if (start >= 0) { const e = ema(line.slice(start), sig); e.forEach((v, j) => (sl[start + j] = v)); } return { line, signal: sl, hist: line.map((v, i) => (v != null && sl[i] != null ? v - sl[i] : null)) }; }
export function atr(bars, n = 14) { const tr = bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)))); return sma(tr, n); }

export function analyze(bars) {
  const c = bars.map(b => num(b.c)).filter(Number.isFinite);
  if (c.length < 30) return { error: `Need at least 30 daily bars, got ${c.length}.` };
  const last = c.at(-1), ret = (a, b) => round((a / b - 1) * 100, 2);
  const s20 = sma(c, 20).at(-1), s50 = c.length >= 50 ? sma(c, 50).at(-1) : null, s200 = c.length >= 200 ? sma(c, 200).at(-1) : null;
  const m = macd(c); const r = rsi(c).at(-1); const a = atr(bars, 14).at(-1);
  const dr = c.slice(1).map((v, i) => v / c[i] - 1); const vol = Math.sqrt(dr.slice(-60).reduce((s, x) => s + x * x, 0) / Math.min(60, dr.length)) * Math.sqrt(252) * 100;
  const hi = Math.max(...c.slice(-252)), lo = Math.min(...c.slice(-252));
  const trend = s50 && s200 ? (s50 > s200 && last > s50 ? 'uptrend' : s50 < s200 && last < s50 ? 'downtrend' : 'mixed') : s20 ? (last > s20 ? 'above 20-day average' : 'below 20-day average') : 'n/a';
  return { last: round(last, 4), change1d: ret(last, c.at(-2)), change1m: c.length > 21 ? ret(last, c.at(-22)) : null, change3m: c.length > 63 ? ret(last, c.at(-64)) : null, sma20: round(s20, 4), sma50: round(s50, 4), sma200: round(s200, 4), rsi14: round(r, 1), macd: round(m.line.at(-1), 4), macdSignal: round(m.signal.at(-1), 4), atr14: round(a, 4), volatilityAnnualPct: round(vol, 1), high52w: round(hi, 4), low52w: round(lo, 4), fromHighPct: ret(last, hi), trend, bars: c.length };
}

/* ======================= backtester ======================= */
// Long-only, daily close-to-close, signal on bar i executes at bar i+1 open (no look-ahead). Fees+slippage in bps per side.
export const STRATEGIES = {
  buy_hold: { label: 'Buy and hold', params: {} },
  sma_cross: { label: 'Moving-average crossover', params: { fast: 20, slow: 50 } },
  rsi_revert: { label: 'RSI mean reversion', params: { period: 14, buyBelow: 30, sellAbove: 55 } },
  breakout: { label: 'Donchian breakout', params: { entry: 55, exit: 20 } },
  macd_trend: { label: 'MACD trend', params: { fast: 12, slow: 26, signal: 9 } }
};
export function backtest(bars, strategy = 'sma_cross', params = {}, { costBps = 5, startCash = 10000 } = {}) {
  const B = bars.filter(b => Number.isFinite(num(b.c)) && Number.isFinite(num(b.o)));
  if (!STRATEGIES[strategy]) return { error: `Unknown strategy ${strategy}. Choose: ${Object.keys(STRATEGIES).join(', ')}.` };
  const P = { ...STRATEGIES[strategy].params, ...params };
  if (B.length < 40) return { error: `Need at least 40 daily bars, got ${B.length}.` };
  const c = B.map(b => num(b.c));
  let want;
  if (strategy === 'buy_hold') want = c.map(() => 1);
  if (strategy === 'sma_cross') { const f = sma(c, P.fast), s = sma(c, P.slow); want = c.map((_, i) => (f[i] != null && s[i] != null && f[i] > s[i] ? 1 : 0)); }
  if (strategy === 'rsi_revert') { const r = rsi(c, P.period); let pos = 0; want = c.map((_, i) => { if (r[i] == null) return 0; if (!pos && r[i] < P.buyBelow) pos = 1; else if (pos && r[i] > P.sellAbove) pos = 0; return pos; }); }
  if (strategy === 'breakout') { let pos = 0; want = c.map((_, i) => { if (i < P.entry) return 0; const hi = Math.max(...c.slice(i - P.entry, i)), lo = Math.min(...c.slice(i - P.exit, i)); if (!pos && c[i] > hi) pos = 1; else if (pos && c[i] < lo) pos = 0; return pos; }); }
  if (strategy === 'macd_trend') { const m = macd(c, P.fast, P.slow, P.signal); want = c.map((_, i) => (m.line[i] != null && m.signal[i] != null && m.line[i] > m.signal[i] ? 1 : 0)); }
  const cost = costBps / 1e4;
  let cash = startCash, units = 0, peak = startCash, maxDd = 0, trades = [], entry = null; const curve = [];
  for (let i = 0; i < B.length; i++) {
    if (i > 0 && want[i - 1] !== (units > 0 ? 1 : 0)) {
      const px = num(B[i].o);
      if (want[i - 1] === 1) { units = cash * (1 - cost) / px; entry = { t: B[i].t, px }; cash = 0; }
      else { cash = units * px * (1 - cost); trades.push({ entry: entry.t, exit: B[i].t, ret: round((px * (1 - cost)) / (entry.px / (1 - cost)) * 100 - 100, 2) }); units = 0; entry = null; }
    }
    const eq = cash + units * c[i]; curve.push(eq); peak = Math.max(peak, eq); maxDd = Math.min(maxDd, eq / peak - 1);
  }
  if (units > 0) trades.push({ entry: entry.t, exit: '(open)', ret: round(c.at(-1) / entry.px * 100 - 100, 2) });
  const dr = curve.slice(1).map((v, i) => v / curve[i] - 1); const mean = dr.reduce((a, b) => a + b, 0) / dr.length; const sd = Math.sqrt(dr.reduce((a, b) => a + (b - mean) ** 2, 0) / dr.length);
  const years = Math.max((Date.parse(B.at(-1).t) - Date.parse(B[0].t)) / (365.25 * 864e5), dr.length / 252) || dr.length / 252;
  const total = curve.at(-1) / startCash - 1, bh = c.at(-1) / num(B[0].o) - 1;
  const closed = trades.filter(t => t.exit !== '(open)');
  return {
    strategy, params: P, bars: B.length, from: B[0].t, to: B.at(-1).t,
    totalReturnPct: round(total * 100, 2), cagrPct: round((Math.pow(1 + total, 1 / years) - 1) * 100, 2), buyHoldReturnPct: round(bh * 100, 2),
    maxDrawdownPct: round(maxDd * 100, 2), sharpe: sd > 0 ? round(mean / sd * Math.sqrt(252), 2) : null, trades: trades.length,
    winRatePct: closed.length ? round(closed.filter(t => t.ret > 0).length / closed.length * 100, 1) : null,
    exposurePct: round(want.slice(0, -1).filter(Boolean).length / Math.max(1, want.length - 1) * 100, 1), costBps,
    lastTrades: trades.slice(-5), equityCurve: curve.filter((_, i) => i % Math.ceil(curve.length / 60) === 0 || i === curve.length - 1).map(v => round(v)),
    note: 'Backtests use past prices, include fees/slippage, and ignore dividends, taxes and gaps; past results do not predict future returns.'
  };
}

/* ======================= the agent ======================= */
export const TRADER_PROMPT = `You are Cognitive Trader, the trading desk agent in the Cognitive AI suite. You work across the user's connected brokers: you read accounts, positions, orders and quotes, run technical analysis and backtests, and prepare orders.

Rules you always follow:
- You never place or cancel orders yourself. place_order and cancel_order create proposals; the user must press Confirm in the app. Say clearly what you prepared and that it is waiting for their confirmation.
- Every proposal runs through the user's risk limits. If the risk engine blocks it, explain why and what setting would change it; never try to split an order to get around a limit.
- Use real data from the tools. Never invent prices, balances, fills or performance. Say when data is delayed or missing.
- Distinguish paper (simulated) from live (real money) accounts every time you mention an order.
- Before proposing a trade, show the price you used, the order size in units and dollars, and the main risk (for example distance to a stop, or position size as a % of the account).
- You provide information and execution tools, not personalized investment advice. When asked what to buy, give the analysis and the trade-offs, note that the decision is theirs, and suggest a licensed adviser for major financial decisions.
- Backtests: report return, max drawdown, Sharpe, trade count and the buy-and-hold comparison, and warn about overfitting when parameters were tuned.
Be concise and numeric. Use tables for portfolios and comparisons.`;

export const TRADER_TOOLS = [
  { name: 'list_accounts', description: 'List connected brokers and whether each is paper or live.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_account', description: 'Balances for one broker account.', input_schema: { type: 'object', properties: { broker: { type: 'string' } }, required: ['broker'] } },
  { name: 'get_positions', description: 'Open positions for one broker.', input_schema: { type: 'object', properties: { broker: { type: 'string' } }, required: ['broker'] } },
  { name: 'get_orders', description: 'Recent orders for one broker.', input_schema: { type: 'object', properties: { broker: { type: 'string' } }, required: ['broker'] } },
  { name: 'get_quote', description: 'Latest quote. Symbols: stocks "AAPL", crypto "BTC-USD", forex "EUR_USD".', input_schema: { type: 'object', properties: { broker: { type: 'string' }, symbol: { type: 'string' } }, required: ['broker', 'symbol'] } },
  { name: 'analyze', description: 'Technical snapshot from daily bars: returns, SMA 20/50/200, RSI, MACD, ATR, volatility, 52-week range, trend.', input_schema: { type: 'object', properties: { broker: { type: 'string' }, symbol: { type: 'string' } }, required: ['broker', 'symbol'] } },
  { name: 'backtest', description: `Backtest a long-only daily strategy on real history. Strategies: ${Object.entries(STRATEGIES).map(([k, v]) => `${k} (${v.label}${Object.keys(v.params).length ? '; params ' + Object.keys(v.params).join(', ') : ''})`).join('; ')}.`, input_schema: { type: 'object', properties: { broker: { type: 'string' }, symbol: { type: 'string' }, strategy: { type: 'string' }, params: { type: 'object' }, days: { type: 'integer', minimum: 60, maximum: 1000 }, cost_bps: { type: 'number' } }, required: ['broker', 'symbol', 'strategy'] } },
  { name: 'place_order', description: 'Prepare an order for the user to confirm. Give qty (units) or notional (dollars, market orders only).', input_schema: { type: 'object', properties: { broker: { type: 'string' }, symbol: { type: 'string' }, side: { type: 'string', enum: ['buy', 'sell'] }, qty: { type: 'number' }, notional: { type: 'number' }, type: { type: 'string', enum: ['market', 'limit', 'stop', 'stop_limit'] }, limitPrice: { type: 'number' }, stopPrice: { type: 'number' }, tif: { type: 'string', enum: ['day', 'gtc', 'ioc', 'fok'] } }, required: ['broker', 'symbol', 'side', 'type'] } },
  { name: 'cancel_order', description: 'Prepare a cancel for the user to confirm.', input_schema: { type: 'object', properties: { broker: { type: 'string' }, orderId: { type: 'string' } }, required: ['broker', 'orderId'] } }
];

const fmt = v => (Number.isFinite(v) ? v : null);
export async function runTraderTool(name, input, ctx) {
  const { adapters, risk, ordersToday = {}, seal, now } = ctx;
  if (name === 'list_accounts') return { ok: true, output: JSON.stringify(Object.values(adapters).map(a => ({ broker: a.broker, name: BROKERS[a.broker]?.label, mode: a.live ? 'LIVE (real money)' : 'paper' }))) };
  const a = adapters[input.broker];
  if (!a) return { ok: false, output: `Broker "${input.broker}" is not connected. Connected: ${Object.keys(adapters).join(', ') || 'none'}.` };
  if (name === 'get_account') { const x = await a.account(); return { ok: true, output: JSON.stringify({ ...x, mode: a.live ? 'live' : 'paper' }) }; }
  if (name === 'get_positions') return { ok: true, output: JSON.stringify(await a.positions()) };
  if (name === 'get_orders') return { ok: true, output: JSON.stringify((await a.orders()).slice(0, 25)) };
  if (name === 'get_quote') return { ok: true, output: JSON.stringify(await a.quote(input.symbol)) };
  if (name === 'analyze') return { ok: true, output: JSON.stringify({ symbol: normSymbol(input.symbol), ...analyze(await a.bars(input.symbol, 260)) }) };
  if (name === 'backtest') { const bars = await a.bars(input.symbol, Math.min(1000, input.days || 500)); return { ok: true, output: JSON.stringify(backtest(bars, input.strategy, input.params || {}, { costBps: input.cost_bps ?? 5 })) }; }
  if (name === 'place_order' || name === 'cancel_order') {
    if (name === 'cancel_order') {
      const p = { id: 'tp_' + crypto.randomBytes(5).toString('hex'), kind: 'cancel', broker: a.broker, live: a.live, orderId: String(input.orderId), summary: `Cancel order ${input.orderId} on ${BROKERS[a.broker].label} (${a.live ? 'LIVE' : 'paper'})` };
      return { ok: true, output: `Prepared, waiting for the user's confirmation: ${p.summary}`, proposal: { ...p, token: seal({ ...p, exp: (now || Date.now()) + 15 * 60000 }) } };
    }
    const { order, errors } = normalizeOrder(input);
    if (errors.length) return { ok: false, output: `Order not valid: ${errors.join(' ')}` };
    let quote = null; try { quote = await a.quote(order.symbol); } catch (e) { quote = null; }
    const [account, positions] = await Promise.all([a.account().catch(() => ({})), a.positions().catch(() => [])]);
    const check = checkRisk(order, { price: quote?.price, account, positions, ordersToday: ordersToday[a.broker] || 0, live: a.live, now }, risk);
    if (!check.ok) return { ok: false, output: `Blocked by risk limits: ${check.reasons.join(' ')}`, blocked: { order, reasons: check.reasons } };
    const sizeTxt = order.qty != null ? `${order.qty} ${order.symbol}` : `$${order.notional} of ${order.symbol}`;
    const p = { id: 'tp_' + crypto.randomBytes(5).toString('hex'), kind: 'order', broker: a.broker, live: a.live, order, price: fmt(quote?.price), notional: check.notional, warnings: check.warnings,
      summary: `${a.live ? 'LIVE' : 'Paper'} ${order.side.toUpperCase()} ${sizeTxt} · ${order.type}${order.limitPrice ? ' @ ' + order.limitPrice : ''}${order.stopPrice ? ' stop ' + order.stopPrice : ''} · ≈$${check.notional} · ${BROKERS[a.broker].label}` };
    return { ok: true, output: `Prepared, waiting for the user's confirmation: ${p.summary}${check.warnings.length ? ' Warnings: ' + check.warnings.join(' ') : ''}`, proposal: { ...p, token: seal({ ...p, exp: (now || Date.now()) + 15 * 60000 }) } };
  }
  return { ok: false, output: `Unknown tool ${name}.` };
}

export async function traderChat({ key, callModel, messages, adapters, risk, ordersToday, seal, maxTurns = 8 }) {
  const accts = Object.values(adapters).map(a => `${BROKERS[a.broker]?.label} [${a.broker}] (${a.live ? 'LIVE' : 'paper'})`).join(', ') || 'none — suggest the built-in simulator or connecting a paper account';
  const system = `${TRADER_PROMPT}\n\nNow: ${new Date().toISOString()} (US stock market ${usMarketOpen() ? 'open' : 'closed'}).\nConnected accounts: ${accts}.\nRisk limits: ${JSON.stringify({ ...DEFAULT_RISK, ...risk })}.`;
  const convo = messages.slice(-30); const proposals = [], blocked = [], tools = [];
  let text = '', usage = { input: 0, output: 0 };
  for (let turn = 0; turn < maxTurns; turn++) {
    const r = await callModel(key, { max_tokens: 3000, system, tools: TRADER_TOOLS, messages: convo });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data?.error?.message || `Model error (${r.status}).`), { status: r.status });
    usage.input += data.usage?.input_tokens || 0; usage.output += data.usage?.output_tokens || 0;
    const calls = (data.content || []).filter(b => b.type === 'tool_use');
    text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || text;
    if (!calls.length) break;
    convo.push({ role: 'assistant', content: data.content });
    const results = [];
    for (const c of calls) {
      let out; try { out = await runTraderTool(c.name, c.input || {}, { adapters, risk, ordersToday, seal }); } catch (e) { out = { ok: false, output: String(e.message || e).slice(0, 400) }; }
      if (out.proposal) proposals.push(out.proposal); if (out.blocked) blocked.push(out.blocked);
      tools.push({ tool: c.name, ok: out.ok });
      results.push({ type: 'tool_result', tool_use_id: c.id, content: out.output.slice(0, 12000), ...(out.ok ? {} : { is_error: true }) });
    }
    convo.push({ role: 'user', content: results });
  }
  return { text, proposals, blocked, tools, usage };
}
