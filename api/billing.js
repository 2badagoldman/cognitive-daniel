import { cors } from './_lib.js';
// Subscriptions via Stripe Checkout. Set STRIPE_SECRET_KEY and one price ID per plan:
// STRIPE_PRICE_STARTER ($20/mo), STRIPE_PRICE_PRO ($100/mo), STRIPE_PRICE_TEAM ($500/mo).
export const config = { maxDuration: 20 };
const PRICES = { starter: 'STRIPE_PRICE_STARTER', pro: 'STRIPE_PRICE_PRO', team: 'STRIPE_PRICE_TEAM' };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const plan = String(req.body?.plan || '');
  if (!PRICES[plan]) return res.status(400).json({ error: 'Unknown plan.' });
  const key = process.env.STRIPE_SECRET_KEY, price = process.env[PRICES[plan]];
  if (!key || !price) return res.status(501).json({ error: 'Online checkout is not set up yet.', contact: process.env.SALES_EMAIL || 'hello@cognitiveai.dev' });
  const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const email = String(req.body?.email || '').trim();
  const form = new URLSearchParams({
    mode: 'subscription', 'line_items[0][price]': price, 'line_items[0][quantity]': '1',
    success_url: `${origin}/?checkout=success&plan=${plan}`, cancel_url: `${origin}/?checkout=cancelled`,
    allow_promotion_codes: 'true', 'metadata[plan]': plan
  });
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) form.set('customer_email', email);
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return res.status(502).json({ error: d.error?.message || 'Stripe error.' });
  return res.status(200).json({ url: d.url });
}
