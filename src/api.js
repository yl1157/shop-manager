/* ==========================================================================
   API LAYER — the only place the UI reads or writes data.

   Two backends behind the same function names, arguments and result shapes:
     • live.js   the shared shop on Supabase (used when config.js is filled in; DESIGN.md §9, db/schema.sql)
     • this file the private preview: everything stays in this browser's localStorage (no config.js, or the demo build)

   In the preview, every write runs on a clone of the state and is committed only if
   nothing threw, so a failed action can never leave half-applied money behind.
   ========================================================================== */
const DEMO = false;   // `node build.mjs --demo` flips this: sample shop + demo banner + demo tools
const STORE_KEY = DEMO ? 'shopmgr.demo.v1' : 'shopmgr.preview.v1';   // separate keys: a demo on the same site can't leak into the real preview
const MAX_FAILS = 5, LOCK_MS = 15 * 60e3;
const mem = {};
const store = {
  degraded: false,
  get(k) { if (k in mem) return mem[k]; try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); delete mem[k]; return true; } catch (e) { mem[k] = v; this.degraded = true; return false; } },
  del(k) { delete mem[k]; try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};
let S = null;                                        // live state (demo only: the UI reads catalog/admin data from it directly)
const NOW = () => Date.now() + (S ? S.clockOffsetMs || 0 : 0);
const saveState = () => store.set(STORE_KEY, JSON.stringify(S));
function loadState() {
  const raw = store.get(STORE_KEY);
  if (raw) { try { const p = JSON.parse(raw); if (p && p.v === 1 && Array.isArray(p.orders)) S = p; } catch (e) { S = null; } }
  if (!S) { S = DEMO ? makeSeed(Date.now()) : Core.emptyState(Date.now()); saveState(); }
  sweep();
}
function sweep() { if (LIVE.on) return 0; const ex = Core.expireHolds(S, NOW()); if (ex.length) saveState(); return ex.length; }
function tx(fn) {
  sweep();
  const draft = structuredClone(S);
  const out = fn(draft, NOW());                      // throws AppError -> draft discarded, S untouched
  S = draft; saveState();
  return out;
}
/** Passcode check on the LIVE state: a wrong try must persist its counter even though the call fails. */
function checkPass(u, passcode) {
  const b = S.buyers[u], now = NOW();
  if (!b || !b.passHash) throw new Core.AppError('no_passcode', 'No account for @' + u + ' yet — your passcode is created with your first claim.');
  if (b.lockUntil > now) throw new Core.AppError('locked', `Too many wrong tries. Try again in ${Math.ceil((b.lockUntil - now) / 60e3)} min, or ask the seller to reset it.`);
  if (Core.sha256Hex(b.salt + ':' + String(passcode == null ? '' : passcode).trim()) !== b.passHash) {
    b.fails = (b.fails || 0) + 1;
    let msg = 'That passcode doesn’t match.';
    if (b.fails >= MAX_FAILS) { b.lockUntil = now + LOCK_MS; b.fails = 0; msg = 'Too many wrong tries — locked for 15 minutes.'; }
    saveState();
    throw new Core.AppError('wrong_passcode', msg);
  }
  if (b.fails) { b.fails = 0; saveState(); }
}

/* ---------- buyer-facing calls (production: SECURITY DEFINER RPCs that verify the passcode) ---------- */
const api = {
  async buyerStatus(username) {
    const u = Core.normUser(username); sweep();
    const b = S.buyers[u];
    return { exists: !!(b && b.passHash), blocked: !!(b && b.blocked) };
  },
  async login({ username, passcode }) {
    const u = Core.normUser(username); sweep(); checkPass(u, passcode);
    return { ok: true, username: u };
  },
  async myAccount({ username, passcode }) {
    const u = Core.normUser(username); sweep(); checkPass(u, passcode);
    const v = structuredClone(Core.accountView(S, u, NOW()));
    // Same shape as production: buyers learn THAT a screenshot is attached, never get the image back.
    v.payments = v.payments.map(({ proof, ...p }) => ({ ...p, hasProof: !!proof }));
    return v;
  },
  /** First claim under a handle creates the passcode; later claims must supply it. */
  async placeOrder({ username, passcode, lines }) {
    const u = Core.normUser(username); sweep();
    const known = !!(S.buyers[u] && S.buyers[u].passHash);
    if (known) checkPass(u, passcode); else Core.validPasscode(passcode);
    return tx((d, now) => {
      if (!known) { const salt = Core.uid('s'); Core.ensureBuyer(d, u, Core.sha256Hex(salt + ':' + Core.validPasscode(passcode)), salt, now); }
      const r = Core.placeOrder(d, { username: u, lines }, now);
      return { orderIds: r.orders.map(o => o.id), creditAppliedCents: r.creditAppliedCents };
    });
  },
  async submitPayment({ username, passcode, ...rest }) {
    const u = Core.normUser(username); sweep(); checkPass(u, passcode);
    return tx((d, now) => { const p = Core.submitPayment(d, { username: u, ...rest }, now); return { paymentId: p.id, no: p.no }; });
  },
  async cancelMyOrder({ username, passcode, orderId }) {
    const u = Core.normUser(username); sweep(); checkPass(u, passcode);
    return tx((d, now) => {
      const o = Core.byId(d.orders, orderId);
      if (!o || o.username !== u) throw new Core.AppError('not_found', 'Order not found.');
      return Core.cancelOrder(d, { orderId, actor: 'buyer' }, now);
    });
  },
};

/* ---------- seller calls (production: authenticated Supabase session + RLS) ---------- */
const adm = {};
['confirmPayment', 'rejectPayment', 'assignIncoming', 'recordManualPayment', 'ignoreIncoming', 'cancelOrder',
 'setFulfillment', 'setShippingFee', 'extendHold', 'upsertGroup', 'upsertProduct', 'mergeBuyer'].forEach(name => {
  adm[name] = async args => tx((d, now) => { const r = Core[name](d, args, now); return r === undefined ? null : r; });
});
adm.addIncoming = async items => tx((d, now) => Core.addIncoming(d, items, now));
adm.deleteProduct = async id => tx(d => Core.deleteProduct(d, id));
adm.releaseExpired = async () => sweep();
adm.setBlocked = async ({ username, blocked }) => tx((d, now) => {
  const u = Core.normUser(username);
  if (!d.buyers[u]) throw new Core.AppError('not_found', 'No such buyer.');
  d.buyers[u].blocked = !!blocked;
  Core.log(d, 'admin', (blocked ? 'blocked @' : 'unblocked @') + u, now);
});
adm.resetPasscode = async username => tx((d, now) => {
  const u = Core.normUser(username);
  if (!d.buyers[u]) throw new Core.AppError('not_found', 'No such buyer.');
  Object.assign(d.buyers[u], { passHash: null, salt: null, fails: 0, lockUntil: 0 });
  Core.log(d, 'admin', 'reset passcode for @' + u, now);
});
adm.saveSettings = async patch => tx((d, now) => {
  const s = d.settings;
  if ('holdHours' in patch) { if (!(patch.holdHours >= 1 && patch.holdHours <= 24 * 30)) throw new Core.AppError('bad_input', 'Hold time must be between 1 hour and 30 days.'); s.holdHours = Math.round(patch.holdHours); }
  if ('nearTolCents' in patch) { if (!(patch.nearTolCents >= 0 && patch.nearTolCents <= 1000)) throw new Core.AppError('bad_input', 'Amount tolerance must be between $0 and $10.'); s.nearTolCents = patch.nearTolCents; }
  ['shopOpen', 'requireProof'].forEach(k => { if (k in patch) s[k] = !!patch[k]; });
  ['maxOpenUnpaidOrders', 'maxPendingPayments'].forEach(k => { if (k in patch) { if (!(patch[k] >= 1 && patch[k] <= 50)) throw new Core.AppError('bad_input', 'Limits must be between 1 and 50.'); s[k] = Math.round(patch[k]); } });
  if ('shopName' in patch) s.shopName = String(patch.shopName).trim().slice(0, 40) || 'Shop Manager';
  if ('accentColor' in patch) { if (!Core.HEX6.test(String(patch.accentColor))) throw new Core.AppError('bad_input', 'Pick a colour like #96D6F0.'); s.accentColor = String(patch.accentColor).toLowerCase(); }
  if ('tagline' in patch) s.tagline = String(patch.tagline == null ? '' : patch.tagline).trim().slice(0, 80);
  if ('notice' in patch) s.notice = String(patch.notice == null ? '' : patch.notice).trim().slice(0, 200);
  if (patch.methods) patch.methods.forEach(pm => { const m = s.methods.find(x => x.key === pm.key); if (m) { m.enabled = !!pm.enabled; m.handle = String(pm.handle || '').trim().slice(0, 80); m.hint = String(pm.hint || '').trim().slice(0, 140); } });
  Core.log(d, 'admin', 'changed settings', now);
});
/* demo-only tools */
adm.timeTravel = async hours => tx((d, now) => { d.clockOffsetMs = (d.clockOffsetMs || 0) + hours * Core.HOUR; return Core.expireHolds(d, now + hours * Core.HOUR).length; });
adm.resetDemo = async () => { S = makeSeed(Date.now()); saveState(); };
adm.exportJson = async () => JSON.stringify(S, (k, v) => (k === 'dataUrl' ? undefined : v), 2);

/* ---------- demo data ---------- */
function sampleProofObj(n, amountCents, method, txn) {
  const e = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const rows = ['Amount  ' + Core.fmt(amountCents), 'Method  ' + method, 'Transaction  ' + (txn || '—'), 'Status  Sent']
    .map((t, i) => `<text x='36' y='${170 + i * 36}' font-family='sans-serif' font-size='17' fill='#2C2C2A'>${e(t)}</text>`).join('');
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='360' height='460' viewBox='0 0 360 460'><rect width='360' height='460' fill='#F1EFE8'/><rect x='14' y='14' width='332' height='432' rx='22' fill='#fff' stroke='#2C2C2A' stroke-width='2'/><text x='36' y='66' font-family='sans-serif' font-size='13' font-weight='700' fill='#C2406F'>SAMPLE SCREENSHOT</text><text x='36' y='90' font-family='sans-serif' font-size='12' fill='#6B6A65'>Demo data — not a real payment</text><line x1='36' y1='112' x2='324' y2='112' stroke='#2C2C2A' stroke-opacity='.25'/>${rows}</svg>`;
  return { dataUrl: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg), sha256: 'sample-' + n, name: 'sample-' + n + '.svg', bytes: 900, sample: true };
}

function makeSeed(now) {
  const H = Core.HOUR, D = Core.DAY, at = h => now - h * H;
  const s = Core.emptyState(now);
  const buyer = u => { const salt = 'seed-' + u; Core.ensureBuyer(s, u, Core.sha256Hex(salt + ':1234'), salt, at(80)); };
  const G = (name, color, members) => Core.upsertGroup(s, { name, color, members }, now);
  const P = (g, name, category, priceCents, variants, extra = {}) => Core.upsertProduct(s, { groupId: g.id, name, category, priceCents, variants, ...extra }, now);
  const V = (p, name = '') => s.variants.find(v => v.productId === p.id && v.name === name);

  const nova = G('NOVA9', '#7C6CF2', ['Hana', 'Jiwoo', 'Seoyun', 'Mina', 'Yuri']);
  const luna = G('Luna Bloom', '#D8487F', ['Aria', 'Bomi', 'Chaeun', 'Dahye']);
  const hexa = G('HEXA', '#1F9C93', ['Ren', 'Taeo', 'Joon', 'Kai', 'Sol', 'Woo']);

  const novaAlbum = P(nova, 'Starfall — album', 'album', 1800, [{ name: 'A ver.', stock: 4 }, { name: 'B ver.', stock: 2 }], { description: 'Sealed. Photobook + 1 random photocard.' });
  const novaCard = P(nova, 'Starfall — photocard', 'photocard', 350, nova.members.map((m, i) => ({ name: m, stock: [6, 3, 0, 5, 2][i] })), { maxPerUser: 4, description: 'Member version. Mint, in a sleeve.' });
  const novaStick = P(nova, 'Official lightstick', 'merch', 3200, [{ name: '', stock: 3 }], { description: 'Batteries included.' });
  const lunaSG = P(luna, 'Season’s Greetings 2027', 'merch', 2400, [{ name: '', stock: 10 }], { availability: 'incoming', payBy: now + 9 * D, description: 'Arrives mid-November. Claim now and pay by the date shown.' });
  const lunaSet = P(luna, 'Petal photocard set (all 4)', 'photocard', 1200, [{ name: '', stock: 3 }], { description: 'One full set of 4 cards.' });
  const lunaTote = P(luna, 'Bloom tote bag', 'merch', 1400, [{ name: 'Cream', stock: 5 }, { name: 'Black', stock: 0 }]);
  const lunaHood = P(luna, 'Midnight pop-up hoodie', 'merch', 4500, [{ name: 'S', stock: 2 }, { name: 'M', stock: 4 }, { name: 'L', stock: 3 }], { opensAt: now + 30 * H, description: 'Claims open soon.' });
  const hexaAlbum = P(hexa, 'Prism — mini album', 'album', 1500, [{ name: 'Random', stock: 7 }]);
  const hexaCard = P(hexa, 'Prism — photocard', 'photocard', 300, hexa.members.map((m, i) => ({ name: m, stock: [3, 3, 3, 2, 2, 1][i] })), { maxPerUser: 6 });
  const hexaStick = P(hexa, 'Sticker pack', 'merch', 500, [{ name: '', stock: 12 }]);
  P(hexa, 'Fan-meeting badge', 'merch', 600, [{ name: '', stock: 0 }]);
  void lunaSG; void lunaTote; void lunaHood;

  const demoHandles = { paypal: '@your-paypal', venmo: '@your-venmo', zelle: 'you@example.com' };
  s.settings.methods.forEach(m => { if (demoHandles[m.key]) m.handle = demoHandles[m.key]; });
  ['minjae.k', 'sora_ru', 'bunnyhee', 'yuna.wp', 'dohyun_s', 'chloe_p', 'mina.rae', 'old_hold'].forEach(buyer);

  const claim = (u, lines, hAgo) => Core.placeOrder(s, { username: u, lines }, at(hAgo)).orders;
  const lastIn = () => s.incoming[s.incoming.length - 1];
  const feedIn = it => { Core.addIncoming(s, [{ source: 'sample', ...it }], it.occurredAt); return lastIn(); };

  // an old unpaid hold that already lapsed (stock came back)
  claim('old_hold', [{ variantId: V(hexaStick).id, qty: 2 }], 120);
  Core.expireHolds(s, at(70));

  // 1 · paid early with a little extra ($5 credit), already packed
  const [o1] = claim('minjae.k', [{ variantId: V(novaCard, 'Hana').id, qty: 2 }], 72);
  const t1 = feedIn({ method: 'paypal', extId: '7XK31982AB', occurredAt: at(70), amountCents: 1200, senderName: 'Minjae Kim' });
  const p1 = Core.submitPayment(s, { username: 'minjae.k', method: 'paypal', amountCents: 1200, txnId: '7XK31982AB', senderName: 'Minjae Kim', paidAt: at(70), proof: sampleProofObj(1, 1200, 'PayPal', '7XK31982AB'), orderIds: [o1.id] }, at(70));
  Core.confirmPayment(s, { paymentId: p1.id, incomingId: t1.id, autoApply: false }, at(69));
  Core.setFulfillment(s, { orderId: o1.id, to: 'packed' }, at(60));

  // 2 · claimed, nothing paid yet (the one to try as a buyer)
  claim('sora_ru', [{ variantId: V(hexaAlbum, 'Random').id, qty: 1 }, { variantId: V(hexaStick).id, qty: 2 }], 8);

  // 3 · paid via PayPal with a transaction ID → will match "exact"
  const [o3] = claim('bunnyhee', [{ variantId: V(novaAlbum, 'A ver.').id, qty: 1 }, { variantId: V(hexaStick).id, qty: 1 }], 6);
  feedIn({ method: 'paypal', extId: '5AB77201CD', occurredAt: at(3), amountCents: 2300, senderName: 'Heebunny Kim' });
  Core.submitPayment(s, { username: 'bunnyhee', method: 'paypal', amountCents: 2300, txnId: '5AB77201CD', senderName: 'Hee Bunny', paidAt: at(3), proof: sampleProofObj(2, 2300, 'PayPal', '5AB77201CD'), orderIds: [o3.id] }, at(3));

  // 4 + 5 · two Zelle payments of the same amount → one has a name ("likely"), one doesn't ("possible")
  const [o4] = claim('yuna.wp', [{ variantId: V(lunaSet).id, qty: 1 }], 5);
  feedIn({ method: 'zelle', extId: '', occurredAt: at(4), amountCents: 1200, senderName: 'YUNA PARK' });
  Core.submitPayment(s, { username: 'yuna.wp', method: 'zelle', amountCents: 1200, senderName: 'Yuna Park', paidAt: at(4), proof: sampleProofObj(3, 1200, 'Zelle', ''), orderIds: [o4.id] }, at(4));
  const [o5] = claim('dohyun_s', [{ variantId: V(hexaCard, 'Ren').id, qty: 2 }, { variantId: V(hexaCard, 'Taeo').id, qty: 2 }], 5);
  feedIn({ method: 'zelle', extId: '', occurredAt: at(3.5), amountCents: 1200, senderName: 'D SEO' });
  Core.submitPayment(s, { username: 'dohyun_s', method: 'zelle', amountCents: 1200, senderName: '', paidAt: at(3.5), proof: sampleProofObj(4, 1200, 'Zelle', ''), orderIds: [o5.id] }, at(3.5));

  // 6 · money arrived by Venmo but the buyer never sent proof
  claim('chloe_p', [{ variantId: V(hexaAlbum, 'Random').id, qty: 1 }, { variantId: V(hexaStick).id, qty: 3 }], 22);
  feedIn({ method: 'venmo', extId: 'VN-3381-ZQ', occurredAt: at(20), amountCents: 3000, senderName: 'Chloe Park' });

  // 7 · hold about to run out
  claim('mina.rae', [{ variantId: V(novaStick).id, qty: 1 }], 45 + 1 / 3);

  // a stray transfer nobody has claimed
  feedIn({ method: 'paypal', extId: 'PP-77120-QQ', occurredAt: at(48), amountCents: 800, senderName: 'Mina Choi' });
  return s;
}

/** Text the "Load sample export" button drops into the import box (dates are relative to now). */
function sampleFeedText(now) {
  const f = ms => { const d = new Date(ms); const p = n => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()},${p(d.getHours())}:${p(d.getMinutes())}:00`; };
  const H = Core.HOUR;
  return [
    'Date,Time,TimeZone,Name,Type,Status,Currency,Gross,Fee,Net,Transaction ID',
    `${f(now - 1 * H)},EDT,Sora Ru,Payment Received,Completed,USD,25.00,0.00,25.00,SR25A0B1C2`,
    `${f(now - 2 * H)},EDT,Mina Rae,Payment Received,Completed,USD,32.00,0.00,32.00,MR32D3E4F5`,
    `${f(now - 5 * H)},EDT,Packing Supplies Co,Payment Sent,Completed,USD,-14.20,0.00,-14.20,OUT1234567`,
    `${f(now - 6 * H)},EDT,Pending Person,Payment Received,Pending,USD,9.00,0.00,9.00,PEND765432`,
    `${f(now - 48 * H)},EDT,Mina Choi,Payment Received,Completed,USD,8.00,0.00,8.00,PP-77120-QQ`,
  ].join('\n');
}
