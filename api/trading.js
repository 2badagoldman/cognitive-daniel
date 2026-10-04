// Cognitive Trader API.
//   GET  /api/trading?action=status                 brokers, connections (paper/live), risk limits
//   POST /api/trading?action=connect  {broker, env, ...credentials}   validates by reading the account, then saves
//   POST /api/trading?action=disconnect {broker}
//   POST /api/trading?action=risk {risk}            save risk limits (kill switch, live trading, sizes, symbols)
//   POST /api/trading?action=portfolio              accounts + positions + recent orders across connected brokers
//   POST /api/trading?action=chat {messages}        the agent; returns {text, proposals, blocked}
//   POST /api/trading?action=execute {token}        user-confirmed order or cancel (risk re-checked here)
//   POST /api/trading?action=sim-reset              reset the simulator to $100,000
// Credentials, simulator state and risk limits live in encrypted httpOnly cookies on the user's browser.
import crypto from 'node:crypto';
import { checkAccess, requireKey, cleanMessages, callAnthropic, cors } from './_lib.js';
import { seal, unseal, parseCookies, cookie, appendCookie } from './_auth.js';
import { BROKERS, UNSUPPORTED, DEFAULT_RISK, makeAdapter, newSimState, checkRisk, traderChat } from './_trading.js';

export const config = { maxDuration: 120 };
const C = { cred: b => `cog_tr_${b}`, sim: 'cog_tr_simstate', risk: 'cog_tr_risk', count: 'cog_tr_count' };
const YEAR = 60 * 60 * 24 * 365;

export function readTrading(req) {
  const ck = parseCookies(req), creds = {};
  for (const b of Object.keys(BROKERS)) { if (b === 'sim') continue; const v = unseal(ck[C.cred(b)], `trade:${b}`); if (v) creds[b] = v; }
  const simOn = unseal(ck[C.cred('sim')], 'trade:sim');
  const sim = unseal(ck[C.sim], 'trade:simstate') || null;
  const risk = { ...DEFAULT_RISK, ...(unseal(ck[C.risk], 'trade:risk') || {}) };
  const today = new Date().toISOString().slice(0, 10);
  const cnt = unseal(ck[C.count], 'trade:count'); const counts = cnt?.date === today ? cnt.counts : {};
  return { creds, simOn: !!simOn, sim, risk, counts, today };
}
export function buildAdapters(t, fetchImpl = fetch) {
  const adapters = {};
  for (const [b, cred] of Object.entries(t.creds)) adapters[b] = makeAdapter(b, cred, { fetchImpl });
  if (t.simOn) adapters.sim = makeAdapter('sim', {}, { fetchImpl, sim: t.sim || newSimState(), dataSource: adapters.alpaca || adapters.tradier });
  return adapters;
}
const saveSim = (res, adapters) => { if (adapters.sim) appendCookie(res, cookie(C.sim, seal(adapters.sim.state, 'trade:simstate'), { maxAge: YEAR })); };
export function sanitizeRisk(r = {}) {
  const n = (v, d, lo, hi) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  const list = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(s => String(s).trim().toUpperCase()).filter(s => /^[A-Z0-9._\-/]{1,20}$/.test(s)).slice(0, 100);
  return { maxOrderUsd: n(r.maxOrderUsd, DEFAULT_RISK.maxOrderUsd, 1, 10_000_000), maxPositionPct: n(r.maxPositionPct, DEFAULT_RISK.maxPositionPct, 1, 100), dailyLossLimitUsd: n(r.dailyLossLimitUsd, DEFAULT_RISK.dailyLossLimitUsd, 1, 10_000_000), maxOrdersPerDay: n(r.maxOrdersPerDay, DEFAULT_RISK.maxOrdersPerDay, 1, 1000), allowShort: r.allowShort === true, liveTrading: r.liveTrading === true, killSwitch: r.killSwitch === true, allowedSymbols: list(r.allowedSymbols), blockedSymbols: list(r.blockedSymbols) };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const action = req.query?.action || new URL(req.url, 'http://x').searchParams.get('action');
  if (!checkAccess(req, res, { route: 'trading', spend: action === 'chat' || action === 'execute' })) return;
  const t = readTrading(req);
  try {
    if (action === 'status') {
      return res.status(200).json({ brokers: Object.fromEntries(Object.entries(BROKERS).map(([k, v]) => [k, { ...v, connected: k === 'sim' ? t.simOn : !!t.creds[k], env: k === 'sim' ? 'paper' : t.creds[k]?.env || null }])), risk: t.risk, ordersToday: t.counts, unsupported: UNSUPPORTED });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const b = req.body || {};

    if (action === 'connect') {
      const B = BROKERS[b.broker]; if (!B) return res.status(400).json({ error: 'Unknown broker.' });
      if (b.broker === 'sim') { appendCookie(res, cookie(C.cred('sim'), seal({ on: true }, 'trade:sim'), { maxAge: YEAR })); if (!t.sim) appendCookie(res, cookie(C.sim, seal(newSimState(), 'trade:simstate'), { maxAge: YEAR })); return res.status(200).json({ connected: true, account: { equity: (t.sim || newSimState()).cash } }); }
      const env = B.envs.includes(b.env) ? b.env : B.envs[0];
      const cred = { env }; for (const f of B.fields) { const v = String(b[f] || '').trim(); if (!v) return res.status(400).json({ error: `Missing ${f}.` }); cred[f] = v.slice(0, 4000); }
      if (b.broker === 'ibkr' && !/^https:\/\//.test(cred.gatewayUrl)) return res.status(400).json({ error: 'The IBKR gateway must be reachable at an https:// address.' });
      const account = await makeAdapter(b.broker, cred).account();
      appendCookie(res, cookie(C.cred(b.broker), seal(cred, `trade:${b.broker}`), { maxAge: YEAR }));
      return res.status(200).json({ connected: true, env, account });
    }
    if (action === 'disconnect') {
      if (!BROKERS[b.broker]) return res.status(400).json({ error: 'Unknown broker.' });
      appendCookie(res, cookie(C.cred(b.broker), '', { maxAge: 0 })); return res.status(200).json({ disconnected: true });
    }
    if (action === 'risk') { const r = sanitizeRisk(b.risk); appendCookie(res, cookie(C.risk, seal(r, 'trade:risk'), { maxAge: YEAR })); return res.status(200).json({ risk: r }); }
    if (action === 'sim-reset') { appendCookie(res, cookie(C.sim, seal(newSimState(), 'trade:simstate'), { maxAge: YEAR })); return res.status(200).json({ reset: true }); }

    const adapters = buildAdapters(t);
    if (action === 'portfolio') {
      if (adapters.sim?.checkOpenOrders) await adapters.sim.checkOpenOrders();
      const out = await Promise.all(Object.values(adapters).map(async a => {
        const [account, positions, orders] = await Promise.allSettled([a.account(), a.positions(), a.orders()]);
        return { broker: a.broker, label: BROKERS[a.broker].label, mode: a.live ? 'live' : 'paper', account: account.value || null, positions: positions.value || [], orders: (orders.value || []).slice(0, 15), error: [account, positions].find(x => x.status === 'rejected')?.reason?.message || null };
      }));
      saveSim(res, adapters);
      return res.status(200).json({ accounts: out });
    }
    if (action === 'chat') {
      const key = requireKey(res); if (!key) return;
      const messages = cleanMessages(b.messages); if (!messages) return res.status(400).json({ error: 'Conversation is too long or malformed. Start a new chat.' });
      const out = await traderChat({ key, callModel: callAnthropic, messages, adapters, risk: t.risk, ordersToday: t.counts, seal: p => seal(p, 'trade:proposal') });
      saveSim(res, adapters);
      return res.status(200).json(out);
    }
    if (action === 'execute') {
      const p = unseal(String(b.token || ''), 'trade:proposal');
      if (!p || p.exp < Date.now()) return res.status(400).json({ error: 'This trade ticket expired. Ask again for a fresh quote.' });
      const a = adapters[p.broker]; if (!a) return res.status(400).json({ error: `${BROKERS[p.broker]?.label || p.broker} is no longer connected.` });
      if (a.live !== p.live) return res.status(409).json({ error: 'The account mode changed since this ticket was prepared. Ask again.' });
      if (p.kind === 'cancel') { const r = await a.cancelOrder(p.orderId); saveSim(res, adapters); return res.status(200).json({ ok: true, result: r, text: `Canceled order ${p.orderId}.` }); }
      // Re-check risk with fresh data at the moment of confirmation.
      const [quote, account, positions] = await Promise.all([a.quote(p.order.symbol).catch(() => null), a.account().catch(() => ({})), a.positions().catch(() => [])]);
      const check = checkRisk(p.order, { price: quote?.price, account, positions, ordersToday: t.counts[a.broker] || 0, live: a.live }, t.risk);
      if (!check.ok) return res.status(422).json({ error: `Blocked by risk limits: ${check.reasons.join(' ')}` });
      if (Number.isFinite(p.price) && Number.isFinite(quote?.price) && Math.abs(quote.price - p.price) / p.price > 0.02 && p.order.type === 'market') return res.status(409).json({ error: `Price moved ${Math.round(Math.abs(quote.price - p.price) / p.price * 1000) / 10}% since the ticket was prepared (now ${quote.price}). Ask again to re-quote.` });
      const r = await a.placeOrder(p.order);
      const counts = { ...t.counts, [a.broker]: (t.counts[a.broker] || 0) + 1 };
      appendCookie(res, cookie(C.count, seal({ date: t.today, counts }, 'trade:count'), { maxAge: 60 * 60 * 36 }));
      saveSim(res, adapters);
      return res.status(200).json({ ok: true, result: r, audit: { at: new Date().toISOString(), broker: a.broker, mode: a.live ? 'live' : 'paper', order: p.order, price: quote?.price ?? null, result: r }, text: `${a.live ? 'LIVE' : 'Paper'} order sent: ${p.summary}. Broker status: ${r.status}${r.filledAvg ? ` at ${r.filledAvg}` : ''}.` });
    }
    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    return res.status(e.status && e.status < 600 ? e.status : 502).json({ error: String(e.message || e).replace(/(key|secret|token)=[^&\s]+/gi, '$1=***').slice(0, 500) });
  }
}
