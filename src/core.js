/* <core> */
/* ==========================================================================
   CORE — the business rules. Pure functions: no DOM, no network, no storage.

   Conventions
   • Money is integer cents. Times are epoch milliseconds.
   • Every mutating function is (state, input, now) -> result, or throws
     AppError. The API layer runs each call on a clone and only commits if
     nothing threw, so a failed call can never half-apply.
   • Identity is the Instagram username (lower-case, no @).
   • Money moves through ONE mechanism: payment_allocations.
       order.paid   = sum of allocations from CONFIRMED payments
       order.due    = order.total - order.paid
       buyer credit = confirmed payment amounts not yet allocated to an order
   ========================================================================== */
const HOUR = 3600e3, DAY = 24 * HOUR;
const REJECT_GRACE_H = 12;           // time a buyer gets to fix a rejected payment
const MAX_PAYMENT_CENTS = 200000;    // sanity cap for one submitted payment ($2,000)
const MAX_PRICE_CENTS = 500000;      // one product / variant price ($5,000)
const MAX_STOCK = 999999;
const MAX_QTY = 99;                  // of one item in one claim
const MAX_CLAIM_LINES = 60;
const AMBIGUITY_MARGIN = 8;          // matcher: a rival pairing this close in score makes a match "possible"
const DEFAULT_METHODS = [
  { key: 'paypal', label: 'PayPal',  handle: '@your-paypal',  enabled: true,  hint: 'Send as Friends & Family, no note.' },
  { key: 'venmo',  label: 'Venmo',   handle: '@your-venmo',   enabled: true,  hint: 'No note needed.' },
  { key: 'zelle',  label: 'Zelle',   handle: 'you@example.com', enabled: true, hint: 'Zelle has no transaction ID — we match by amount, time and your name.' },
  { key: 'wise',   label: 'Wise',    handle: '@your-wise',    enabled: false, hint: 'Send in USD. Fees are on you.' },
  { key: 'other',  label: 'Other',   handle: '',              enabled: false, hint: 'Cash / other — only when the seller agreed.' },
];

class AppError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

/* ---------- small utilities ---------- */
const sumBy = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
const byId = (arr, id) => arr.find(x => x.id === id);
const uid = (p = 'x') => p + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** "$1,234.50" / "12.5" / 12.5 -> 123450 / 1250 / 1250. NaN if it isn't money. */
function parseMoney(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : NaN;
  let t = String(input == null ? '' : input).trim();
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  t = t.replace(/[\s$,]/g, '');
  if (t[0] === '+') t = t.slice(1);
  if (t[0] === '-') { neg = !neg; t = t.slice(1); }
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
  const [w, f = ''] = t.split('.');
  const v = parseInt(w, 10) * 100 + parseInt((f + '00').slice(0, 2), 10);
  return neg ? -v : v;
}
function fmt(c) {
  const a = Math.abs(c);
  const d = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (c < 0 ? '-' : '') + '$' + d + '.' + String(a % 100).padStart(2, '0');
}

/** Instagram handles: letters, digits, '.' and '_' , 1–30 chars. */
function normUser(raw) {
  const u = String(raw == null ? '' : raw).trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(u)) {
    throw new AppError('bad_username', 'Enter your Instagram username (letters, numbers, . and _ only).');
  }
  return u;
}
function validPasscode(code) {
  const c = String(code == null ? '' : code).trim();
  if (c.length < 4 || c.length > 20) throw new AppError('bad_passcode', 'Passcode must be 4 to 20 characters.');
  if (!/^[!-~]+$/.test(c)) throw new AppError('bad_passcode', 'Passcode: letters, numbers and symbols only — no spaces or emoji.');
  return c;
}

/** Pure-JS SHA-256 (hex). Used for the demo passcodes so the prototype also runs from file://. */
function sha256Hex(str) {
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const bytes = [];
  const s = unescape(encodeURIComponent(String(str)));
  for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bitLen >>> (i * 8)) & 0xff);
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < bytes.length; off += 64) {
    const w = new Array(64);
    for (let i = 0; i < 16; i++) w[i] = (bytes[off+4*i] << 24) | (bytes[off+4*i+1] << 16) | (bytes[off+4*i+2] << 8) | bytes[off+4*i+3];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i-15], 7) ^ rotr(w[i-15], 18) ^ (w[i-15] >>> 3);
      const s1 = rotr(w[i-2], 17) ^ rotr(w[i-2], 19) ^ (w[i-2] >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/* ---------- theme: from one accent colour to a set that is always readable ---------- */
const DEFAULT_ACCENT = '#96D6F0';          // sky blue, a little lighter than the CSS "skyblue"
const HEX6 = /^#[0-9a-f]{6}$/i;
function hexToRgb(h) { return [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); }
function rgbToHex(c) { return '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToHex(h, s, l) {
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
/** One accent in, a whole set out. Guarantees (tested on thousands of colours): text on the accent, links on white and
 *  links on the pale tint all reach WCAG AA (4.5:1), whatever colour the seller picks. */
function themeFrom(input) {
  const accent = HEX6.test(input || '') ? input.toLowerCase() : DEFAULT_ACCENT.toLowerCase();
  const [h, s, l0] = rgbToHsl(hexToRgb(accent));
  // tints that sit behind text: light enough that the page's grey secondary text (--text3) stays readable on them
  const TEXT3 = '#6b6a65';
  const tintOf = (sat, L) => { let c = hslToHex(h, sat, L); while (contrast(TEXT3, c) < 4.6 && L < 0.99) { L += 0.005; c = hslToHex(h, sat, L); } return c; };
  const light = tintOf(Math.min(s, 0.85), 0.95), bg = tintOf(Math.min(s, 0.7), 0.97), soft = tintOf(Math.min(s, 0.45), 0.93);
  // link / active-tab colour: the accent's hue, darkened until it reads on white AND on every tint it can sit on
  const worst = c => Math.min(contrast(c, '#ffffff'), contrast(c, light), contrast(c, bg), contrast(c, soft));
  let dark = accent, L = Math.min(l0, 0.4);
  for (let i = 0; i < 60; i++) { dark = hslToHex(h, Math.min(s, 0.8), L); if (worst(dark) >= 4.6) break; L = Math.max(0, L - 0.015); }
  if (worst(dark) < 4.5) dark = '#000000';
  // text on the accent itself: a deep tint of the same hue, or white, whichever reads better
  const tint = hslToHex(h, Math.min(s, 0.6), 0.12);
  let ink = contrast(tint, accent) >= contrast('#ffffff', accent) ? tint : '#ffffff';
  if (contrast(ink, accent) < 4.5) ink = contrast('#000000', accent) >= contrast('#ffffff', accent) ? '#000000' : '#ffffff';
  // hover: a touch darker (or lighter if that would make the label hard to read); never worse than AA
  const step = d => hslToHex(h, s, Math.max(0, Math.min(1, l0 + d)));
  const hover = [step(-0.07), step(0.07)].find(c => contrast(ink, c) >= 4.5) || accent;
  return { accent, hover, light, dark, ink, bg, soft };
}

/* ---------- state ---------- */
function emptyState(now) {
  return {
    v: 1,
    clockOffsetMs: 0,
    seq: { order: 1000, payment: 500, incoming: 100 },
    settings: {
      shopName: 'Shop Manager',
      shopOpen: true,
      holdHours: 48,
      nearTolCents: 100,          // incoming amounts within $1.00 count as "near" candidates
      requireProof: true,
      maxOpenUnpaidOrders: 8,
      maxPendingPayments: 3,
      accentColor: DEFAULT_ACCENT,   // the shop's look: sky blue until the seller picks another colour
      tagline: '',                   // one line under the shop name
      notice: '',                    // an announcement banner on the shop page ("orders close Sunday")
      methods: JSON.parse(JSON.stringify(DEFAULT_METHODS)),
    },
    groups: [], products: [], variants: [],
    buyers: {},            // username -> {username, salt, passHash, createdAt, blocked, note, fails, lockUntil}
    orders: [], payments: [], allocations: [], incoming: [],
    log: [],
    createdAt: now,
  };
}
const nextNo = (state, kind) => ++state.seq[kind];
function log(state, actor, msg, now) {
  state.log.push({ at: now, actor, msg });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
}

/* ---------- derived numbers (never stored, so they can't drift) ---------- */
const orderSubtotal = o => sumBy(o.lines, l => l.qty * l.unitCents);
const orderTotal = o => orderSubtotal(o) + (o.shippingFeeCents || 0);
function paymentStatusOf(state, id) { const p = byId(state.payments, id); return p ? p.status : null; }
function orderPaid(state, orderId) {
  return sumBy(state.allocations.filter(a => a.orderId === orderId && paymentStatusOf(state, a.paymentId) === 'confirmed'), a => a.amountCents);
}
function orderPending(state, orderId) {
  return sumBy(state.allocations.filter(a => a.orderId === orderId && paymentStatusOf(state, a.paymentId) === 'submitted'), a => a.amountCents);
}
function orderDue(state, o) { return o.status === 'open' ? Math.max(0, orderTotal(o) - orderPaid(state, o.id)) : 0; }
function orderPayState(state, o) {
  const t = orderTotal(o), p = orderPaid(state, o.id);
  if (t > 0 && p >= t) return 'paid';
  return p > 0 ? 'partial' : 'unpaid';
}
const paymentAllocated = (state, p) => sumBy(state.allocations.filter(a => a.paymentId === p.id), a => a.amountCents);
const paymentRemaining = (state, p) => p.status === 'confirmed' ? p.amountCents - paymentAllocated(state, p) : 0;
const buyerCredit = (state, u) => sumBy(state.payments.filter(p => p.username === u), p => paymentRemaining(state, p));
const buyerDue = (state, u) => sumBy(state.orders.filter(o => o.username === u), o => orderDue(state, o));
const buyerPending = (state, u) => sumBy(state.payments.filter(p => p.username === u && p.status === 'submitted'), p => p.amountCents);

function addAlloc(state, paymentId, orderId, cents) {
  if (cents <= 0) return;
  const ex = state.allocations.find(a => a.paymentId === paymentId && a.orderId === orderId);
  if (ex) ex.amountCents += cents;
  else state.allocations.push({ id: uid('al'), paymentId, orderId, amountCents: cents });
}

/** Spend a buyer's credit on their oldest unpaid orders. Returns cents applied. */
function autoApplyCredit(state, username) {
  let applied = 0;
  const pays = state.payments.filter(p => p.username === username && p.status === 'confirmed' && paymentRemaining(state, p) > 0)
    .sort((a, b) => a.confirmedAt - b.confirmedAt);
  const orders = state.orders.filter(o => o.username === username && o.status === 'open' && orderDue(state, o) > 0)
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const o of orders) {
    for (const p of pays) {
      const due = orderDue(state, o); if (due <= 0) break;
      const rem = paymentRemaining(state, p); if (rem <= 0) continue;
      const c = Math.min(due, rem);
      addAlloc(state, p.id, o.id, c); applied += c;
    }
  }
  return applied;
}

/** Decide which orders a payment of `amount` pays: buyer's chosen orders first, then (optionally) oldest-due. */
function planAllocation(state, payment, amount, { autoApply = true } = {}) {
  let remaining = amount;
  const plan = [];
  const take = o => {
    if (remaining <= 0 || !o || o.status !== 'open' || o.username !== payment.username) return;
    const already = (plan.find(x => x.orderId === o.id) || {}).cents || 0;
    const due = orderDue(state, o) - already;
    if (due <= 0) return;
    const c = Math.min(due, remaining);
    remaining -= c;
    const e = plan.find(x => x.orderId === o.id);
    if (e) e.cents += c; else plan.push({ orderId: o.id, cents: c });
  };
  (payment.intendedOrderIds || []).forEach(id => take(byId(state.orders, id)));
  if (autoApply && remaining > 0) {
    state.orders.filter(o => o.username === payment.username && o.status === 'open')
      .sort((a, b) => a.createdAt - b.createdAt).forEach(take);
  }
  return { plan, creditCents: remaining };
}

/* ---------- catalog helpers ---------- */
const productVariants = (state, productId) => state.variants.filter(v => v.productId === productId && !v.archived);
function productState(state, p, now) {
  if (p.status !== 'active') return { kind: 'hidden' };
  if (p.opensAt && p.opensAt > now) return { kind: 'soon', opensAt: p.opensAt };
  const stock = sumBy(productVariants(state, p.id), v => v.stock);
  if (stock <= 0) return { kind: 'soldout', stock: 0 };
  return { kind: 'open', stock, incoming: p.availability === 'incoming', payBy: p.payBy || null };
}
const unitPrice = (product, variant) => variant.priceCents != null ? variant.priceCents : product.priceCents;
function lineDeadline(state, product, now) {
  if (product.availability === 'incoming' && product.payBy && product.payBy > now) return product.payBy;
  return now + state.settings.holdHours * HOUR;
}

/* ---------- buyers ---------- */
function ensureBuyer(state, username, passHash, salt, now) {
  let b = state.buyers[username];
  if (!b) b = state.buyers[username] = { username, salt: null, passHash: null, createdAt: now, blocked: false, note: '', fails: 0, lockUntil: 0 };
  if (passHash) { b.passHash = passHash; b.salt = salt; b.fails = 0; b.lockUntil = 0; }
  return b;
}

/* ---------- ORDERS ---------- */
/** Claim items. Pre-claim (incoming) lines with a different pay-by date become their own order. */
function placeOrder(state, { username, lines }, now) {
  const u = normUser(username);
  const S = state.settings;
  if (!S.shopOpen) throw new AppError('closed', 'The shop is closed right now — check back soon.');
  const buyer = state.buyers[u];
  if (buyer && buyer.blocked) throw new AppError('blocked', 'This username can’t place new claims. Please DM the seller.');
  if (!Array.isArray(lines) || !lines.length) throw new AppError('empty', 'Your claim list is empty.');

  if (lines.length > MAX_CLAIM_LINES) throw new AppError('bad_qty', 'That’s too many items in one claim.');
  const want = new Map();
  for (const l of lines) {
    const q = Math.floor(Number(l.qty));
    if (!(q >= 1)) throw new AppError('bad_qty', 'Quantity must be at least 1.');
    want.set(l.variantId, (want.get(l.variantId) || 0) + q);
  }
  for (const q of want.values()) if (q > MAX_QTY) throw new AppError('bad_qty', 'You can claim at most ' + MAX_QTY + ' of one item.');
  const resolved = [];
  for (const [variantId, qty] of want) {
    const v = byId(state.variants, variantId);
    const p = v && byId(state.products, v.productId);
    if (!v || !p || v.archived || p.status !== 'active') throw new AppError('unavailable', 'One of those items is no longer available.');
    if (p.opensAt && p.opensAt > now) throw new AppError('not_open', p.name + ' isn’t open for claims yet.');
    if (v.stock < qty) {
      throw new AppError('oversold', v.stock > 0 ? `Only ${v.stock} left of ${p.name}${v.name ? ' – ' + v.name : ''}.` : `${p.name}${v.name ? ' – ' + v.name : ''} just sold out.`, { available: v.stock, variantId });
    }
    resolved.push({ v, p, qty });
  }
  // per-buyer product caps (count what they already hold)
  const perProduct = new Map();
  resolved.forEach(r => perProduct.set(r.p.id, (perProduct.get(r.p.id) || 0) + r.qty));
  for (const [pid, q] of perProduct) {
    const p = byId(state.products, pid);
    if (p.maxPerUser) {
      const held = sumBy(state.orders.filter(o => o.username === u && o.status === 'open'), o => sumBy(o.lines.filter(l => l.productId === pid), l => l.qty));
      if (held + q > p.maxPerUser) throw new AppError('limit', `Limit ${p.maxPerUser} per person for ${p.name}${held ? ` (you already have ${held})` : ''}.`);
    }
  }
  // bucket by pay-by deadline
  const buckets = new Map();
  resolved.forEach(r => {
    const d = lineDeadline(state, r.p, now);
    if (!buckets.has(d)) buckets.set(d, []);
    buckets.get(d).push(r);
  });
  const openUnpaid = state.orders.filter(o => o.username === u && o.status === 'open' && orderPayState(state, o) !== 'paid').length;
  if (openUnpaid + buckets.size > S.maxOpenUnpaidOrders) {
    throw new AppError('too_many', `You already have ${openUnpaid} unpaid claims — please pay or cancel some first.`);
  }

  const orders = [];
  for (const [deadline, rs] of buckets) {
    const o = {
      id: uid('o'), no: nextNo(state, 'order'), username: u, status: 'open', fulfillment: 'pending', tracking: '',
      createdAt: now, holdExpiresAt: deadline, shippingFeeCents: 0, note: '',
      lines: rs.map(r => ({ variantId: r.v.id, productId: r.p.id, name: r.p.name, variantName: r.v.name || '', qty: r.qty, unitCents: unitPrice(r.p, r.v) })),
    };
    rs.forEach(r => { r.v.stock -= r.qty; });
    state.orders.push(o);
    orders.push(o);
  }
  const creditApplied = autoApplyCredit(state, u);
  log(state, '@' + u, `claimed ${orders.map(o => '#' + o.no).join(', ')} (${fmt(sumBy(orders, orderTotal))})`, now);
  return { orders, creditAppliedCents: creditApplied };
}

function restock(state, o) {
  o.lines.forEach(l => { const v = byId(state.variants, l.variantId); if (v) v.stock += l.qty; });
}
function cancelOrder(state, { orderId, actor = 'admin', reason = '' }, now) {
  const o = byId(state.orders, orderId);
  if (!o) throw new AppError('not_found', 'Order not found.');
  if (o.status !== 'open') throw new AppError('bad_state', 'That order is already ' + o.status + '.');
  if (o.fulfillment === 'shipped') throw new AppError('shipped', 'A shipped order can’t be cancelled.');
  if (actor !== 'admin' && (orderPaid(state, o.id) > 0 || orderPending(state, o.id) > 0)) {
    throw new AppError('has_money', 'This order has a payment on it — message the seller to cancel it.');
  }
  const refundable = orderPaid(state, o.id);
  state.allocations = state.allocations.filter(a => a.orderId !== o.id);   // confirmed money returns to credit
  restock(state, o);
  o.status = 'cancelled'; o.cancelledAt = now; o.cancelReason = reason || (actor === 'admin' ? 'Cancelled by seller' : 'Cancelled by buyer');
  const reapplied = autoApplyCredit(state, o.username);   // credit may immediately pay another of their orders
  log(state, actor === 'admin' ? 'admin' : '@' + o.username, `cancelled #${o.no}` + (refundable ? ` (${fmt(refundable)} returned to credit)` : ''), now);
  return { refundedToCreditCents: refundable, reappliedCents: reapplied };
}

/** Release unpaid holds that ran out. Orders with money on them, or a payment in review, are never auto-expired. */
function expireHolds(state, now) {
  const expired = [];
  for (const o of state.orders) {
    if (o.status !== 'open' || o.holdExpiresAt > now) continue;
    if (orderPaid(state, o.id) > 0 || orderPending(state, o.id) > 0) continue;
    restock(state, o);
    o.status = 'expired'; o.cancelledAt = now; o.cancelReason = 'Hold expired — not paid in time';
    expired.push(o);
  }
  if (expired.length) log(state, 'system', `released ${expired.length} unpaid hold${expired.length === 1 ? '' : 's'}: ${expired.map(o => '#' + o.no).join(', ')}`, now);
  return expired;
}

function setFulfillment(state, { orderId, to, tracking = '' }, now) {
  const o = byId(state.orders, orderId);
  if (!o || o.status !== 'open') throw new AppError('bad_state', 'Only open orders can be updated.');
  if (!['pending', 'packed', 'shipped'].includes(to)) throw new AppError('bad_state', 'Unknown status.');
  if (to !== 'pending' && orderDue(state, o) > 0) throw new AppError('unpaid', 'This order isn’t fully paid yet.');
  o.fulfillment = to;
  const tr = String(tracking || '').trim().slice(0, 80);
  if (to === 'shipped' || tr) o.tracking = tr;       // keep a number typed before "Packed"; shipping with none clears it
  log(state, 'admin', `#${o.no} → ${to}`, now);
}
/** If an order is now worth less than what was paid on it (fee lowered), push the excess back to credit. */
function trimOverpayment(state, o) {
  let excess = orderPaid(state, o.id) - orderTotal(o);
  if (excess <= 0) return 0;
  const rows = state.allocations.filter(a => a.orderId === o.id && paymentStatusOf(state, a.paymentId) === 'confirmed')
    .sort((a, b) => byId(state.payments, b.paymentId).confirmedAt - byId(state.payments, a.paymentId).confirmedAt);
  let freed = 0;
  for (const a of rows) {
    if (excess <= 0) break;
    const c = Math.min(a.amountCents, excess);
    a.amountCents -= c; excess -= c; freed += c;
  }
  state.allocations = state.allocations.filter(a => a.amountCents > 0);
  return freed;
}
function setShippingFee(state, { orderId, cents }, now) {
  const o = byId(state.orders, orderId);
  if (!o || o.status !== 'open') throw new AppError('bad_state', 'Only open orders can take a shipping fee.');
  if (!(cents >= 0) || cents > 50000) throw new AppError('bad_amount', 'Enter a shipping fee between $0 and $500.');
  o.shippingFeeCents = Math.round(cents);
  const freed = trimOverpayment(state, o);
  const applied = autoApplyCredit(state, o.username);
  log(state, 'admin', `#${o.no} shipping fee ${fmt(o.shippingFeeCents)}` + (freed ? ` (${fmt(freed)} returned to credit)` : '') + (applied ? ` (credit ${fmt(applied)} applied)` : ''), now);
  return { creditAppliedCents: applied, returnedToCreditCents: freed };
}
function extendHold(state, { orderId, hours }, now) {
  const o = byId(state.orders, orderId);
  if (!o || o.status !== 'open') throw new AppError('bad_state', 'Only open orders can be extended.');
  o.holdExpiresAt = Math.max(o.holdExpiresAt, now) + hours * HOUR;
  log(state, 'admin', `#${o.no} hold +${hours}h`, now);
}

/* ---------- PAYMENTS ---------- */
const normTxn = s => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const meaningfulTxn = s => normTxn(s).length >= 6;

function methodOf(state, key) { return state.settings.methods.find(m => m.key === key); }

/** Buyer says "I paid". Nothing is confirmed until the seller matches it to real money. */
function submitPayment(state, { username, method, amountCents, txnId = '', senderName = '', paidAt = null, proof = null, orderIds = [] }, now) {
  const u = normUser(username);
  const S = state.settings;
  const m = methodOf(state, method);
  if (!m || !m.enabled) throw new AppError('bad_method', 'Pick one of the payment methods shown.');
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new AppError('bad_amount', 'Enter the amount you sent.');
  if (amountCents > MAX_PAYMENT_CENTS) throw new AppError('bad_amount', 'That amount looks too large — message the seller instead.');
  if (S.requireProof && !proof) throw new AppError('need_proof', 'Please attach a screenshot of your payment.');
  const when = paidAt == null ? now : paidAt;
  if (when > now + 10 * 60e3) throw new AppError('bad_time', 'The payment time can’t be in the future.');
  if (when < now - 60 * DAY) throw new AppError('bad_time', 'That payment time is too far in the past.');
  if (state.payments.filter(p => p.username === u && p.status === 'submitted').length >= S.maxPendingPayments) {
    throw new AppError('too_many_pending', 'You already have payments waiting for confirmation — please wait for those first.');
  }
  const ids = [...new Set(orderIds)];
  for (const id of ids) {
    const o = byId(state.orders, id);
    if (!o || o.username !== u || o.status !== 'open') throw new AppError('bad_order', 'One of the selected orders can’t be paid right now.');
  }
  const cleanTxn = String(txnId || '').trim().slice(0, 64);
  if (meaningfulTxn(cleanTxn) && state.payments.some(q => q.status === 'confirmed' && q.method === method && normTxn(q.txnId) === normTxn(cleanTxn))) {
    throw new AppError('txn_used', 'That transaction ID was already confirmed on another payment.');
  }
  const p = {
    id: uid('p'), no: nextNo(state, 'payment'), username: u, method, amountCents,
    txnId: cleanTxn, senderName: String(senderName || '').trim().slice(0, 60),
    paidAt: when, createdAt: now, status: 'submitted', source: 'buyer',
    proof: proof || null, rejectReason: '', confirmedAt: null, verifiedManually: false, incomingId: null,
    intendedOrderIds: ids, note: '',
  };
  state.payments.push(p);
  const { plan } = planAllocation(state, p, amountCents, { autoApply: false });
  plan.forEach(x => addAlloc(state, p.id, x.orderId, x.cents));
  log(state, '@' + u, `submitted payment #${p.no} (${fmt(amountCents)} ${method})`, now);
  return p;
}

/** Things the seller should look at before confirming. */
function paymentFlags(state, p) {
  const flags = [];
  const nt = normTxn(p.txnId);
  state.payments.forEach(q => {
    if (q.id === p.id || q.status === 'rejected') return;
    if (nt.length >= 6 && q.method === p.method && normTxn(q.txnId) === nt) {
      flags.push({ code: 'dup_txn', level: q.status === 'confirmed' ? 'high' : 'warn', text: `Same transaction ID as payment #${q.no} (@${q.username}, ${q.status}).` });
    }
    if (p.proof && q.proof && p.proof.sha256 && q.proof.sha256 === p.proof.sha256) {
      flags.push({ code: 'dup_image', level: 'high', text: `Identical screenshot to payment #${q.no} (@${q.username}).` });
    }
  });
  if (p.status === 'submitted' && p.intendedOrderIds && p.intendedOrderIds.length) {
    const due = sumBy(p.intendedOrderIds.map(id => byId(state.orders, id)).filter(o => o && o.status === 'open'), o => orderDue(state, o));
    if (due === 0) flags.push({ code: 'nothing_due', level: 'info', text: 'The selected orders are already paid — this will become credit.' });
    else if (p.amountCents < due) flags.push({ code: 'short', level: 'warn', text: `Less than the ${fmt(due)} due on the selected orders.` });
    else if (p.amountCents > due) flags.push({ code: 'over', level: 'info', text: `${fmt(p.amountCents - due)} more than due — the extra becomes credit.` });
  }
  if (!p.proof) flags.push({ code: 'no_proof', level: 'info', text: 'No screenshot attached.' });
  return flags;
}

function confirmPayment(state, { paymentId, incomingId = null, amountCents = null, manualVerified = false, autoApply = true }, now) {
  const p = byId(state.payments, paymentId);
  if (!p) throw new AppError('not_found', 'Payment not found.');
  if (p.status !== 'submitted') throw new AppError('bad_state', 'Only payments awaiting confirmation can be confirmed.');
  let t = null;
  if (incomingId) {
    t = byId(state.incoming, incomingId);
    if (!t) throw new AppError('not_found', 'Incoming transfer not found.');
    if (t.status !== 'unmatched') throw new AppError('incoming_taken', 'That incoming transfer is already matched to another payment.');
  }
  if (!t && !manualVerified) throw new AppError('verify_required', 'Pick the incoming transfer, or tick “I checked my account” to confirm without one.');
  const amt = amountCents != null ? amountCents : (t ? t.amountCents : p.amountCents);
  if (!Number.isInteger(amt) || amt <= 0) throw new AppError('bad_amount', 'Enter a valid amount.');
  const method = t ? t.method : p.method;
  const txn = p.txnId || (t ? t.extId : '');
  if (meaningfulTxn(txn) && state.payments.some(q => q.id !== p.id && q.status === 'confirmed' && q.method === method && normTxn(q.txnId) === normTxn(txn))) {
    throw new AppError('txn_used', 'This transaction ID was already confirmed on another payment.');
  }
  p.amountCents = amt; p.method = method; p.txnId = txn;
  if (t) { t.status = 'matched'; t.paymentId = p.id; p.incomingId = t.id; }
  p.verifiedManually = !t;
  p.status = 'confirmed'; p.confirmedAt = now;
  state.allocations = state.allocations.filter(a => a.paymentId !== p.id);
  const { plan, creditCents } = planAllocation(state, p, amt, { autoApply });
  plan.forEach(x => addAlloc(state, p.id, x.orderId, x.cents));
  log(state, 'admin', `confirmed payment #${p.no} ${fmt(amt)} from @${p.username}` + (creditCents ? ` (${fmt(creditCents)} held as credit)` : ''), now);
  return { payment: p, allocated: plan, creditCents };
}
function previewConfirm(state, args, now) {
  const s = structuredClone(state);
  const r = confirmPayment(s, args, now);
  return { allocated: r.allocated.map(x => ({ ...x, orderNo: byId(s.orders, x.orderId).no, fullyPaid: orderDue(s, byId(s.orders, x.orderId)) === 0 })), creditCents: r.creditCents, amountCents: r.payment.amountCents };
}

function rejectPayment(state, { paymentId, reason = '' }, now) {
  const p = byId(state.payments, paymentId);
  if (!p) throw new AppError('not_found', 'Payment not found.');
  if (p.status !== 'submitted') throw new AppError('bad_state', 'Only payments awaiting confirmation can be rejected.');
  p.status = 'rejected'; p.rejectReason = String(reason || '').trim().slice(0, 200);
  state.allocations = state.allocations.filter(a => a.paymentId !== p.id);
  (p.intendedOrderIds || []).forEach(id => {
    const o = byId(state.orders, id);
    if (o && o.status === 'open') o.holdExpiresAt = Math.max(o.holdExpiresAt, now + REJECT_GRACE_H * HOUR);
  });
  log(state, 'admin', `rejected payment #${p.no}` + (p.rejectReason ? ` — ${p.rejectReason}` : ''), now);
}

/** Money the seller received that nobody submitted proof for (or that they typed in themselves). */
function assignIncoming(state, { incomingId, username, orderIds = [], autoApply = true }, now) {
  const t = byId(state.incoming, incomingId);
  if (!t) throw new AppError('not_found', 'Incoming transfer not found.');
  if (t.status !== 'unmatched') throw new AppError('incoming_taken', 'That transfer is already matched or ignored.');
  const u = normUser(username);
  if (!state.buyers[u]) ensureBuyer(state, u, null, null, now);
  if (meaningfulTxn(t.extId) && state.payments.some(q => q.status === 'confirmed' && q.method === t.method && normTxn(q.txnId) === normTxn(t.extId))) {
    throw new AppError('txn_used', 'This transaction ID was already confirmed on another payment.');
  }
  const p = {
    id: uid('p'), no: nextNo(state, 'payment'), username: u, method: t.method, amountCents: t.amountCents,
    txnId: t.extId || '', senderName: t.senderName || '', paidAt: t.occurredAt, createdAt: now,
    status: 'confirmed', source: 'admin', proof: null, rejectReason: '', confirmedAt: now, verifiedManually: false,
    incomingId: t.id, intendedOrderIds: orderIds.slice(), note: 'Assigned from feed',
  };
  state.payments.push(p);
  t.status = 'matched'; t.paymentId = p.id;
  const { plan, creditCents } = planAllocation(state, p, p.amountCents, { autoApply });
  plan.forEach(x => addAlloc(state, p.id, x.orderId, x.cents));
  log(state, 'admin', `assigned ${fmt(t.amountCents)} ${t.method} to @${u}` + (creditCents ? ` (${fmt(creditCents)} credit)` : ''), now);
  return { payment: p, allocated: plan, creditCents };
}

/** Cash / anything that never shows up in a feed. */
function recordManualPayment(state, { username, method = 'other', amountCents, note = '', orderIds = [], autoApply = true }, now) {
  const u = normUser(username);
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > MAX_PAYMENT_CENTS) throw new AppError('bad_amount', 'Enter a valid amount.');
  if (!state.buyers[u]) ensureBuyer(state, u, null, null, now);
  const p = {
    id: uid('p'), no: nextNo(state, 'payment'), username: u, method, amountCents, txnId: '', senderName: '',
    paidAt: now, createdAt: now, status: 'confirmed', source: 'admin', proof: null, rejectReason: '',
    confirmedAt: now, verifiedManually: true, incomingId: null, intendedOrderIds: orderIds.slice(), note: String(note || '').slice(0, 120),
  };
  state.payments.push(p);
  const { plan, creditCents } = planAllocation(state, p, amountCents, { autoApply });
  plan.forEach(x => addAlloc(state, p.id, x.orderId, x.cents));
  log(state, 'admin', `recorded ${fmt(amountCents)} ${method} for @${u}`, now);
  return { payment: p, allocated: plan, creditCents };
}

/* ---------- INCOMING FEED ---------- */
function addIncoming(state, items, now) {
  let added = 0, skipped = 0;
  for (const it of items) {
    const amountCents = it.amountCents;
    if (!Number.isInteger(amountCents) || amountCents <= 0) { skipped++; continue; }
    const ext = String(it.extId || '').trim();
    if (meaningfulTxn(ext) && state.incoming.some(t => t.method === it.method && normTxn(t.extId) === normTxn(ext))) { skipped++; continue; }
    state.incoming.push({
      id: uid('t'), no: nextNo(state, 'incoming'), method: it.method, extId: ext, occurredAt: it.occurredAt || now,
      amountCents, senderName: String(it.senderName || '').trim().slice(0, 80), note: String(it.note || '').slice(0, 120),
      status: 'unmatched', paymentId: null, source: it.source || 'manual',
    });
    added++;
  }
  if (added) log(state, 'admin', `added ${added} transfer${added === 1 ? '' : 's'} to the feed` + (skipped ? ` (${skipped} skipped)` : ''), now);
  return { added, skipped };
}
function ignoreIncoming(state, { incomingId, ignore = true }, now) {
  const t = byId(state.incoming, incomingId);
  if (!t) throw new AppError('not_found', 'Incoming transfer not found.');
  if (t.status === 'matched') throw new AppError('bad_state', 'That transfer is already matched.');
  t.status = ignore ? 'ignored' : 'unmatched';
}

/** Parse a pasted CSV/TSV export (PayPal, Venmo, Wise… or a simple date,name,amount,id list). */
function parseDelimited(text) {
  const firstLine = String(text).split(/\r?\n/).find(l => l.trim()) || '';
  const count = ch => firstLine.split(ch).length;
  const delim = firstLine.includes('\t') ? '\t' : (count(';') > count(',') ? ';' : ',');
  const rows = []; let row = [], cur = '', q = false;
  const src = String(text);
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows.map(r => r.map(c => c.trim()));
}
function parseFeed(text, { defaultMethod = 'paypal', now = Date.now() } = {}) {
  const rows = parseDelimited(text);
  const items = [], errors = [];
  if (!rows.length) return { items, errors: [{ line: 0, text: '', why: 'Nothing to import.' }] };
  const H = {
    date: /^(date|datetime|timestamp|time stamp|occurred.*|created.*)$/i, time: /^time$/i,
    name: /^(name|from|sender|payer|counterparty|from name|sender name)$/i,
    amount: /^(amount|amount \(.*\)|gross|net|total|value)$/i,
    id: /^(id|txn|txn id|transaction id|transaction|reference|ref|confirmation|confirmation (number|#)|payment id)$/i,
    method: /^(method|source|platform|app)$/i, type: /^(type|direction)$/i, status: /^(status)$/i, note: /^(note|memo|description|message)$/i,
  };
  const hasHeader = rows[0].some(c => Object.values(H).some(re => re.test(c)));
  const col = {};
  let start = 0;
  if (hasHeader) {
    start = 1;
    rows[0].forEach((c, i) => { for (const k of Object.keys(H)) if (col[k] == null && H[k].test(c)) { col[k] = i; break; } });
    if (col.amount == null) return { items, errors: [{ line: 1, text: rows[0].join(','), why: 'No amount column found.' }] };
  } else Object.assign(col, { date: 0, name: 1, amount: 2, id: 3, method: 4 });
  const pick = (r, k) => (col[k] != null && col[k] < r.length ? r[col[k]] : '');
  for (let i = start; i < rows.length; i++) {
    const r = rows[i], line = i + 1;
    const raw = pick(r, 'amount');
    const a = parseMoney(raw);
    if (Number.isNaN(a)) { errors.push({ line, text: r.join(', '), why: 'Couldn’t read the amount “' + raw + '”.' }); continue; }
    if (a <= 0) { errors.push({ line, text: r.join(', '), why: 'Skipped — not money coming in.' }); continue; }
    const type = pick(r, 'type'), status = pick(r, 'status');
    if (/sent|withdraw|payout|transfer out|charge/i.test(type)) { errors.push({ line, text: r.join(', '), why: 'Skipped — outgoing (' + type + ').' }); continue; }
    if (status && /pending|fail|denied|cancel|refund|reversed|declin/i.test(status)) { errors.push({ line, text: r.join(', '), why: 'Skipped — status “' + status + '”.' }); continue; }
    let ds = pick(r, 'date');
    if (col.time != null && col.time !== col.date) ds = (ds + ' ' + pick(r, 'time')).trim();
    let ms = ds ? Date.parse(ds) : now;
    if (Number.isNaN(ms) && ds) ms = Date.parse(ds.replace(/-/g, '/'));
    if (Number.isNaN(ms)) { errors.push({ line, text: r.join(', '), why: 'Couldn’t read the date “' + ds + '”.' }); continue; }
    const mraw = pick(r, 'method').toLowerCase();
    const method = ['paypal', 'venmo', 'zelle', 'wise'].find(k => mraw.includes(k)) || defaultMethod;
    items.push({ method, extId: pick(r, 'id'), occurredAt: ms, amountCents: a, senderName: pick(r, 'name'), note: pick(r, 'note'), source: 'csv' });
  }
  return { items, errors };
}

/* ---------- MATCHING: buyer submissions <-> seller's real incoming money ---------- */
function nameTokens(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(t => t.length >= 2);
}
/** 0..1 — how much the shorter name is contained in the other. "Hee B" vs "Hee Bunny Kim" -> 1 */
function nameSim(a, b) {
  const A = nameTokens(a), B = nameTokens(b);
  if (!A.length || !B.length) return 0;
  const hit = t => B.some(x => x === t || (x.length >= 3 && t.length >= 3 && (x.startsWith(t) || t.startsWith(x))));
  return A.filter(hit).length / Math.min(A.length, B.length);
}
function scorePair(p, t, opts) {
  if (p.method && t.method && p.method !== t.method) return null;
  const pt = normTxn(p.txnId), tt = normTxn(t.extId);
  const txnMatch = pt.length >= 6 && tt.length >= 6 && pt === tt;
  const diff = Math.abs(p.amountCents - t.amountCents);
  const amountExact = diff === 0;
  const amountNear = !amountExact && diff <= opts.nearTolCents;
  if (!txnMatch && !amountExact && !amountNear) return null;
  const dtH = Math.abs(t.occurredAt - p.paidAt) / HOUR;
  const nm = nameSim(p.senderName, t.senderName);
  const reasons = [];
  let score = 0;
  if (txnMatch) { score += 60; reasons.push('Transaction ID matches'); }
  if (amountExact) { score += 30; reasons.push('Amount matches'); }
  else if (amountNear) { score += 10; reasons.push('Amount is ' + fmt(diff) + ' off'); }
  if (dtH <= 6) { score += 10; reasons.push('Within 6 hours'); }
  else if (dtH <= 48) { score += 6; reasons.push('Within 2 days'); }
  else if (dtH <= 168) { score += 2; reasons.push('Within a week'); }
  if (nm >= 0.99) { score += 10; reasons.push('Name matches'); }
  else if (nm >= 0.5) { score += 6; reasons.push('Name looks similar'); }
  else if (nm > 0) { score += 3; reasons.push('Name partly matches'); }
  return { score, reasons, txnMatch, amountExact, amountNear, diff, dtH, nm };
}
/**
 * For every submitted payment: the best unmatched incoming transfer, how sure we are, and why.
 *   exact    = transaction ID + amount both match (safe to bulk-confirm)
 *   check    = transaction ID matches but the amount differs
 *   likely   = amount matches, close in time, nothing else competes
 *   possible = plausible, but two things look alike or evidence is thin — look at the screenshot
 * Nothing is ever confirmed automatically.
 */
function suggestMatches(state, now) {
  const opts = { nearTolCents: state.settings.nearTolCents };
  const subs = state.payments.filter(p => p.status === 'submitted');
  const open = state.incoming.filter(t => t.status === 'unmatched');
  const cand = [];   // every viable pair
  subs.forEach(p => open.forEach(t => {
    const s = scorePair(p, t, opts);
    if (s) cand.push({ p, t, ...s });
  }));
  const used = { p: new Set(), t: new Set() };
  const chosen = new Map();
  [...cand].sort((a, b) => b.score - a.score || a.dtH - b.dtH).forEach(c => {
    if (used.p.has(c.p.id) || used.t.has(c.t.id)) return;
    used.p.add(c.p.id); used.t.add(c.t.id);
    chosen.set(c.p.id, c);
  });
  const out = {};
  subs.forEach(p => {
    const mine = cand.filter(c => c.p.id === p.id).sort((a, b) => b.score - a.score);
    const alternatives = mine.map(c => ({ incomingId: c.t.id, score: c.score }));
    const c = chosen.get(p.id);
    if (!c) { out[p.id] = { paymentId: p.id, incomingId: null, level: 'none', score: 0, reasons: [], alternatives }; return; }
    // a rival is another pairing within AMBIGUITY_MARGIN points: a full name match (+10) settles it, "looks similar" (+6) doesn't
    const rivalsForP = mine.filter(x => x.t.id !== c.t.id && x.score > c.score - AMBIGUITY_MARGIN).length;
    const rivalsForT = cand.filter(x => x.t.id === c.t.id && x.p.id !== p.id && x.score > c.score - AMBIGUITY_MARGIN).length;
    const ambiguous = rivalsForP + rivalsForT > 0;
    let level;
    if (c.txnMatch && c.amountExact) level = 'exact';
    else if (c.txnMatch) level = 'check';
    else if (c.amountExact && c.dtH <= 48 && !ambiguous && (c.dtH <= 6 || c.nm >= 0.5)) level = 'likely';
    else level = 'possible';
    out[p.id] = { paymentId: p.id, incomingId: c.t.id, level, score: c.score, reasons: c.reasons, ambiguous, alternatives };
  });
  return out;
}
/** For money with no submission: which buyers could it belong to? (amount equals what they owe, name resembles handle) */
function suggestBuyersForIncoming(state, t) {
  const res = [];
  const users = new Set(state.orders.filter(o => o.status === 'open').map(o => o.username));
  users.forEach(u => {
    const orders = state.orders.filter(o => o.username === u && o.status === 'open' && orderDue(state, o) > 0);
    if (!orders.length) return;
    const total = sumBy(orders, o => orderDue(state, o));
    const single = orders.find(o => orderDue(state, o) === t.amountCents);
    const reasons = []; let score = 0;
    if (single) { score += 30; reasons.push('equals order #' + single.no); }
    else if (total === t.amountCents) { score += 30; reasons.push('equals everything they owe'); }
    else if (Math.abs(total - t.amountCents) <= 100) { score += 8; reasons.push('close to what they owe'); }
    const hs = nameSim(u.replace(/[._]+/g, ' '), t.senderName);
    if (hs >= 0.99) { score += 12; reasons.push('name resembles @' + u); }
    else if (hs > 0) { score += 6; reasons.push('name partly resembles @' + u); }
    if (score >= 8) res.push({ username: u, score, reasons, orderIds: single ? [single.id] : orders.map(o => o.id), dueCents: total });
  });
  return res.sort((a, b) => b.score - a.score).slice(0, 4);
}

/* ---------- CATALOG ADMIN ---------- */
function upsertGroup(state, g, now) {
  const name = String(g.name || '').trim();
  if (!name) throw new AppError('bad_input', 'Give the group a name.');
  const members = (g.members || []).map(s => String(s).trim()).filter(Boolean);
  let x = g.id ? byId(state.groups, g.id) : null;
  if (!x) { x = { id: uid('g'), position: state.groups.length, active: true }; state.groups.push(x); }
  Object.assign(x, { name, color: g.color || x.color || '#5BAFD6', members, active: g.active !== false });
  return x;
}
function upsertProduct(state, d, now) {
  const name = String(d.name || '').trim();
  if (!name) throw new AppError('bad_input', 'Give the product a name.');
  if (!byId(state.groups, d.groupId)) throw new AppError('bad_input', 'Pick a group.');
  if (!Number.isInteger(d.priceCents) || d.priceCents < 0 || d.priceCents > MAX_PRICE_CENTS) throw new AppError('bad_input', 'Enter a valid price (up to ' + fmt(MAX_PRICE_CENTS) + ').');
  const vs = (d.variants || []).filter(v => String(v.name == null ? '' : v.name).trim() !== '' || (d.variants || []).length === 1);
  if (!vs.length) throw new AppError('bad_input', 'Add at least one variant (or one line with the stock count).');
  for (const v of vs) {
    if (!Number.isInteger(v.stock) || v.stock < 0 || v.stock > MAX_STOCK) throw new AppError('bad_input', 'Stock must be 0 or more for “' + (v.name || 'default') + '”.');
    if (v.priceCents != null && (!Number.isInteger(v.priceCents) || v.priceCents < 0 || v.priceCents > MAX_PRICE_CENTS)) throw new AppError('bad_input', 'Variant price must be a valid amount.');
  }
  let p = d.id ? byId(state.products, d.id) : null;
  if (!p) { p = { id: uid('pr'), position: state.products.length }; state.products.push(p); }
  Object.assign(p, {
    groupId: d.groupId, name, category: d.category || 'other', description: String(d.description || '').trim(),
    priceCents: d.priceCents, availability: d.availability === 'incoming' ? 'incoming' : 'in_stock',
    payBy: d.availability === 'incoming' && d.payBy ? d.payBy : null, opensAt: d.opensAt || null,
    maxPerUser: d.maxPerUser > 0 ? Math.floor(d.maxPerUser) : null, status: d.status === 'hidden' ? 'hidden' : 'active',
    imageUrl: d.imageUrl || '',
  });
  const keep = new Set();
  vs.forEach((v, i) => {
    let x = v.id ? byId(state.variants, v.id) : null;
    if (!x) { x = { id: uid('v'), productId: p.id }; state.variants.push(x); }
    Object.assign(x, { name: String(v.name == null ? '' : v.name).trim(), stock: v.stock, priceCents: v.priceCents == null ? null : v.priceCents, position: i, archived: false });
    keep.add(x.id);
  });
  state.variants.filter(v => v.productId === p.id && !keep.has(v.id)).forEach(v => {
    const used = state.orders.some(o => o.lines.some(l => l.variantId === v.id));
    if (used) { v.archived = true; v.stock = 0; } else state.variants.splice(state.variants.indexOf(v), 1);
  });
  return p;
}
function deleteProduct(state, productId) {
  const used = state.orders.some(o => o.lines.some(l => l.productId === productId));
  if (used) throw new AppError('in_use', 'This product has orders — hide it instead of deleting.');
  state.variants = state.variants.filter(v => v.productId !== productId);
  state.products = state.products.filter(p => p.id !== productId);
}

/* ---------- BUYERS ADMIN ---------- */
function mergeBuyer(state, { from, to }, now) {
  const a = normUser(from), b = normUser(to);
  if (a === b) throw new AppError('bad_input', 'Those are the same username.');
  if (!state.buyers[a]) throw new AppError('not_found', 'No such buyer: @' + a);
  state.orders.forEach(o => { if (o.username === a) o.username = b; });
  state.payments.forEach(p => { if (p.username === a) p.username = b; });
  if (!state.buyers[b]) { state.buyers[b] = state.buyers[a]; state.buyers[b].username = b; }
  delete state.buyers[a];
  const applied = autoApplyCredit(state, b);
  log(state, 'admin', `merged @${a} into @${b}` + (applied ? ` (credit ${fmt(applied)} applied)` : ''), now);
}

/* ---------- VIEWS (what screens read) ---------- */
function accountView(state, username, now) {
  const orders = state.orders.filter(o => o.username === username).sort((a, b) => b.createdAt - a.createdAt).map(o => {
    const total = orderTotal(o), paid = orderPaid(state, o.id), due = orderDue(state, o), pending = orderPending(state, o.id);
    // toSend = what the buyer still has to send: the amount due minus money already sent and waiting for the seller
    return { ...o, subtotal: orderSubtotal(o), total, paid, due, pending, toSend: Math.max(0, due - pending), payState: orderPayState(state, o), leftMs: o.holdExpiresAt - now };
  });
  const payments = state.payments.filter(p => p.username === username).sort((a, b) => b.createdAt - a.createdAt).map(p => ({
    ...p,
    covers: state.allocations.filter(a => a.paymentId === p.id).map(a => ({ orderNo: (byId(state.orders, a.orderId) || {}).no, cents: a.amountCents })),
    remaining: paymentRemaining(state, p),
  }));
  return { username, orders, payments, creditCents: buyerCredit(state, username), dueCents: buyerDue(state, username), pendingCents: buyerPending(state, username),
    toSendCents: sumBy(orders.filter(o => o.status === 'open'), o => o.toSend) };
}
function dashboard(state, now) {
  const open = state.orders.filter(o => o.status === 'open');
  const soon = open.filter(o => orderPaid(state, o.id) === 0 && orderPending(state, o.id) === 0 && o.holdExpiresAt - now <= 6 * HOUR && o.holdExpiresAt > now);
  const lateUnpaid = open.filter(o => orderPaid(state, o.id) === 0 && orderPending(state, o.id) === 0 && o.holdExpiresAt <= now);
  return {
    toReview: state.payments.filter(p => p.status === 'submitted').length,
    unmatchedIncoming: state.incoming.filter(t => t.status === 'unmatched').length,
    unmatchedIncomingCents: sumBy(state.incoming.filter(t => t.status === 'unmatched'), t => t.amountCents),
    expiringSoon: soon.length, overdue: lateUnpaid.length,
    toPack: open.filter(o => orderPayState(state, o) === 'paid' && o.fulfillment === 'pending').length,
    toShip: open.filter(o => orderPayState(state, o) === 'paid' && o.fulfillment === 'packed').length,
    receivableCents: sumBy(open, o => orderDue(state, o)),
    receivedCents: sumBy(state.payments.filter(p => p.status === 'confirmed'), p => p.amountCents),
    creditCents: sumBy(Object.keys(state.buyers), u => buyerCredit(state, u)),
    lowStock: state.variants.filter(v => !v.archived && v.stock > 0 && v.stock <= 2 && (byId(state.products, v.productId) || {}).status === 'active').length,
  };
}
/** Self-check used by tests and the Settings page: money must balance and stock can't go negative. */
function checkInvariants(state) {
  const problems = [];
  state.payments.forEach(p => { if (paymentAllocated(state, p) > p.amountCents) problems.push(`payment #${p.no} is over-allocated`); });
  state.orders.forEach(o => {
    if (orderPaid(state, o.id) > orderTotal(o)) problems.push(`order #${o.no} is overpaid`);
    if ((o.status === 'cancelled' || o.status === 'expired') && state.allocations.some(a => a.orderId === o.id)) problems.push(`closed order #${o.no} still holds money`);
  });
  state.variants.forEach(v => { if (v.stock < 0) problems.push(`negative stock on ${v.name || v.id}`); });
  state.allocations.forEach(a => {
    if (!byId(state.payments, a.paymentId) || !byId(state.orders, a.orderId)) problems.push('dangling allocation');
    if (!(a.amountCents > 0)) problems.push('non-positive allocation');
  });
  state.incoming.forEach(t => { if (t.status === 'matched' && !byId(state.payments, t.paymentId)) problems.push(`incoming #${t.no} matched to nothing`); });
  return problems;
}

const Core = {
  HOUR, DAY, REJECT_GRACE_H, MAX_PAYMENT_CENTS, MAX_PRICE_CENTS, MAX_STOCK, MAX_QTY, MAX_CLAIM_LINES, AMBIGUITY_MARGIN, DEFAULT_METHODS, AppError,
  parseMoney, fmt, normUser, validPasscode, sha256Hex, uid, sumBy, byId,
  DEFAULT_ACCENT, HEX6, themeFrom, contrast,
  emptyState, log, ensureBuyer,
  orderSubtotal, orderTotal, orderPaid, orderPending, orderDue, orderPayState,
  paymentAllocated, paymentRemaining, buyerCredit, buyerDue, buyerPending,
  autoApplyCredit, planAllocation, productVariants, productState, unitPrice,
  placeOrder, cancelOrder, expireHolds, setFulfillment, setShippingFee, extendHold,
  normTxn, meaningfulTxn, methodOf, submitPayment, paymentFlags, confirmPayment, previewConfirm, rejectPayment,
  assignIncoming, recordManualPayment, addIncoming, ignoreIncoming, parseDelimited, parseFeed,
  nameSim, scorePair, suggestMatches, suggestBuyersForIncoming,
  upsertGroup, upsertProduct, deleteProduct, mergeBuyer, accountView, dashboard, checkInvariants,
};
/* </core> */
