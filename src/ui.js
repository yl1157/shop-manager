/* ==========================================================================
   UI — renders from state, never decides business rules (those live in <core>).
   All dynamic text goes through the `html` tag, which escapes by default.
   ========================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
class Raw { constructor(s) { this.s = s; } }
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rend = v => v instanceof Raw ? v.s : Array.isArray(v) ? v.map(rend).join('') : (v == null || v === false) ? '' : esc(v);
const html = (st, ...v) => new Raw(st.reduce((o, s, i) => o + s + (i < v.length ? rend(v[i]) : ''), ''));
const raw = s => new Raw(s);
const money = Core.fmt;
const safeUrl = u => /^(https:\/\/|data:image\/)/i.test(u || '') ? u : '';
const byPos = (a, b) => (a.position || 0) - (b.position || 0);
const groupColor = g => (/^#[0-9a-f]{6}$/i.test(g.color) ? g.color : '#5BAFD6');

const I = (d) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICON = {
  photocard: I('<rect x="6" y="3" width="12" height="18" rx="2.5"/><path d="M12 8.5l1.1 2.3 2.4.3-1.8 1.7.5 2.4L12 14l-2.2 1.2.5-2.4-1.8-1.7 2.4-.3z"/>'),
  album: I('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.4"/>'),
  merch: I('<path d="M5.5 8h13l1 12h-15z"/><path d="M9 8V6.5a3 3 0 016 0V8"/>'),
  other: I('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>'),
  check: I('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  exact: I('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16.5 9"/>'),
  help: I('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 114 2c-.9.6-1.6 1-1.6 2.1M12 16.8h.01"/>'),
  alert: I('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>'),
  none: I('<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>'),
  copy: I('<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/>'),
  image: I('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 4 4 3-3 4 4"/>'),
};
const ic = k => raw(ICON[k] || ICON.other);
const catLabel = c => ({ photocard: 'Photocard', album: 'Album', merch: 'Merch' }[c] || 'Other');

const dt = ms => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dday = ms => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const ago = ms => { const m = Math.round((NOW() - ms) / 60e3); if (m < 1) return 'just now'; if (m < 60) return m + 'm ago'; const h = Math.round(m / 60); return h < 48 ? h + 'h ago' : Math.round(h / 24) + 'd ago'; };
const left = ms => { if (ms <= 0) return '0m'; const m = Math.floor(ms / 60e3), h = Math.floor(m / 60); return h >= 72 ? Math.floor(h / 24) + 'd ' + (h % 24) + 'h' : h > 0 ? h + 'h ' + (m % 60) + 'm' : m + 'm'; };
const localInput = ms => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60e3); return d.toISOString().slice(0, 16); };

/* ---------- UI state ---------- */
const ui = {
  group: 'all',
  cart: (() => { try { return JSON.parse(store.get('shopmgr.cart') || '[]'); } catch (e) { return []; } })(),
  user: store.get('shopmgr.user') || '',
  session: null,            // { username, passcode } — memory only, never stored
  lastClaim: null, pay: null, paid: null, loginErr: '',
  modal: null, opener: null,
  admin: !LIVE.on && store.get('shopmgr.admin') === '1',   // live: only after a real sign-in
  ofilter: 'open', choice: {}, feedPreview: null,
};
const saveCart = () => store.set('shopmgr.cart', JSON.stringify(ui.cart));
let renderToken = 0, toastTimer = 0;
function toast(msg, bad) { const t = $('#toast'); t.textContent = msg; t.className = (bad ? 'bad ' : '') + 'show'; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, bad ? 4200 : 2600); }
const errMsg = e => (e && e.message) || String(e);
const go = h => { if (location.hash === h) render(); else location.hash = h; };

/* ---------- cart ---------- */
function cartLines() {
  const out = [];
  ui.cart.forEach(l => {
    const v = Core.byId(S.variants, l.variantId), p = v && Core.byId(S.products, v.productId);
    if (!v || !p || v.archived || p.status !== 'active') return;
    out.push({ variant: v, product: p, group: Core.byId(S.groups, p.groupId), qty: Math.max(1, Math.min(l.qty, Math.max(v.stock, 1))), unit: Core.unitPrice(p, v), soldOut: v.stock <= 0 });
  });
  return out;
}
const cartCount = () => cartLines().reduce((n, l) => n + l.qty, 0);
const cartTotal = () => cartLines().reduce((s, l) => s + l.qty * l.unit, 0);

/** What the seller has to look at on Reconcile: submissions to review, plus feed money that no submission points at. */
function reconcileState() {
  const sugs = Core.suggestMatches(S, NOW());
  const subs = S.payments.filter(p => p.status === 'submitted').sort((a, b) => a.createdAt - b.createdAt);
  const free = S.incoming.filter(t => t.status === 'unmatched').sort((a, b) => b.occurredAt - a.occurredAt);
  const proposed = new Set(subs.map(p => (p.id in ui.choice ? ui.choice[p.id] : sugs[p.id].incomingId)).filter(Boolean));
  return { sugs, subs, free, proposed, orphans: free.filter(t => !proposed.has(t.id)) };
}

/* ---------- chrome ---------- */
function renderNav(r) {
  const rs = ui.admin ? reconcileState() : null;
  const todo = rs ? rs.subs.length + rs.orphans.length : 0;
  const tab = (h, label, on, extra) => html`<a class="tab ${on ? 'on' : ''}" href="${h}" ${on ? raw('aria-current="page"') : ''}>${label}${extra || ''}</a>`;
  $('#nav').innerHTML = html`<a class="logo" href="#/shop">${S.settings.shopName}</a>
    <div class="tabs">${tab('#/shop', 'Shop', r.name === 'shop' || r.name === 'checkout')}${tab('#/orders', 'My orders', r.name === 'orders' || r.name === 'pay')}${tab('#/rules', 'How it works', r.name === 'rules')}${ui.admin ? tab('#/admin', 'Seller desk', r.name === 'admin', todo ? html`<span class="dot" aria-label="${todo} to review">${todo}</span>` : '') : DEMO ? tab('#/seller', 'Seller', r.name === 'seller') : ''}</div>
    <div class="nav-end">${cartCount() && r.name !== 'checkout' ? html`<a class="btn sm primary" href="#/checkout">Claim list (${cartCount()})</a>` : ''}</div>`.s;
  const demo = $('#demo');
  const note = DEMO ? html`<span><b>Demo.</b> Saved only in this browser. Sample buyers use passcode <span class="mono">1234</span>.</span><button type="button" data-act="reset-demo">Reset</button>${store.degraded ? html`<span>Storage is blocked, so changes last only until you close this tab.</span>` : ''}`
    : !LIVE.on ? html`<span><b>Preview only.</b> ${LIVE.problem || 'This page isn’t connected to the shop’s database yet, so nothing here is saved for anyone else.'}</span>${store.degraded ? html`<span>Storage is blocked, so changes last only until you close this tab.</span>` : ''}`
    : null;
  demo.hidden = !note;
  demo.innerHTML = note ? note.s : '';
}

/* ---------- the shop's look: one accent colour in, a readable set out (rules in Core.themeFrom) ---------- */
function applyTheme(hex) {
  const t = Core.themeFrom(hex), st = document.documentElement.style;
  st.setProperty('--accent', t.accent); st.setProperty('--accent-hover', t.hover); st.setProperty('--accent-light', t.light);
  st.setProperty('--accent-dark', t.dark); st.setProperty('--accent-ink', t.ink); st.setProperty('--bg', t.bg); st.setProperty('--surface2', t.soft);
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', t.accent);
}
function renderCartBar(r) {
  const el = $('#cartbar');
  if (!cartCount() || r.name !== 'shop') { el.innerHTML = ''; return; }
  el.innerHTML = html`<div class="cartbar" role="region" aria-label="Claim list"><span class="grow"><b>${cartCount()} item${cartCount() === 1 ? '' : 's'}</b> in your claim list &nbsp;${money(cartTotal())}</span><a class="btn" href="#/checkout">Review claim</a></div>`.s;
}

/* ---------- modal layer ---------- */
function openModal(m) { ui.opener = document.activeElement; ui.modal = m; renderModal(); }
function closeModal() { const m = ui.modal; ui.modal = null; $('#modal').innerHTML = ''; document.body.style.overflow = ''; if (m && m.resolve) m.resolve(false); if (ui.opener && document.contains(ui.opener)) ui.opener.focus(); ui.opener = null; }
function renderModal() {
  const m = ui.modal, el = $('#modal');
  if (!m) { el.innerHTML = ''; return; }
  const key = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
  const body = MODALS[m.type](m);
  el.innerHTML = html`<div class="backdrop" data-act="backdrop"><div class="sheet ${m.wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${m.label || 'Dialog'}">${body}</div></div>`.s;
  document.body.style.overflow = 'hidden';
  const f = (key && $(`[data-fk="${key}"]`, el)) || $('[autofocus], input:not([type=hidden]), select, textarea, .x', el);
  if (f) f.focus();
}
const closeBtn = raw('<button type="button" class="x" data-act="close-modal" aria-label="Close">×</button>');
function askConfirm({ title, body, ok = 'Confirm', danger = false }) {
  return new Promise(resolve => openModal({ type: 'confirm', label: title, title, body, ok, danger, resolve }));
}

/* ---------- router ---------- */
const route = () => { const [name, ...rest] = (location.hash || '#/shop').replace(/^#\/?/, '').split('/'); return { name: name || 'shop', rest }; };
async function render() {
  const token = ++renderToken;
  sweep();
  const r = route();
  if (LIVE.on) {                                   // shared shop: pull fresh numbers (cheap; skipped if loaded a moment ago)
    try { await LIVE.refresh(); ui.loadError = ''; } catch (e) { ui.loadError = LIVE.loaded ? '' : errMsg(e); }
    if (token !== renderToken) return;
  }
  applyTheme(S.settings.accentColor);
  document.title = S.settings.shopName || 'Shop';
  if (r.name !== 'pay' && ui.paid && !ui.paidFresh) ui.paid = null;
  ui.paidFresh = false;
  let view;
  if (ui.loadError) view = html`<div class="page narrow"><div class="err" role="alert">${ui.loadError}</div><p style="margin-top:12px"><button type="button" class="btn" data-act="retry">Try again</button></p></div>`;
  else try { view = await (VIEWS[r.name] || VIEWS.shop)(r); }
  catch (e) { console.error(e); view = html`<div class="page narrow"><div class="err" role="alert">${errMsg(e)}</div></div>`; }
  if (token !== renderToken) return;
  $('#app').innerHTML = view.s;
  renderNav(r); renderCartBar(r);
  if (ui.modal) renderModal();
  if (r.name === 'pay') updatePayTotals();
}

/* ======================= BUYER VIEWS ======================= */
function priceLabel(p, variants) {
  const ps = variants.map(v => Core.unitPrice(p, v));
  const lo = Math.min(...ps), hi = Math.max(...ps);
  return lo === hi ? money(lo) : 'from ' + money(lo);
}
function tile(p, g, now) {
  const st = Core.productState(S, p, now), vs = Core.productVariants(S, p.id);
  let stat, cls = '', flag = '';
  if (st.kind === 'soon') { stat = 'Opens ' + dt(st.opensAt); flag = 'Opens ' + dday(st.opensAt); }
  else if (st.kind === 'soldout') { stat = 'Sold out'; cls = 'out'; }
  else if (st.incoming) { stat = (st.payBy ? 'Pay by ' + dday(st.payBy) : 'Pre-claim') + ' · ' + st.stock + ' left'; flag = 'Pre-claim'; if (st.stock <= 3) cls = 'low'; }
  else { stat = st.stock + ' left'; if (st.stock <= 3) cls = 'low'; }
  const img = safeUrl(p.imageUrl);
  return html`<button type="button" class="tile ${st.kind === 'soldout' ? 'off' : ''}" data-act="open-product" data-id="${p.id}">
    <span class="art" style="--g:${groupColor(g)}">
      ${img ? html`<img src="${img}" alt="" loading="lazy">` : html`<span class="mono-i" aria-hidden="true">${(g.name.match(/[A-Za-z0-9]/) || ['?'])[0]}</span>`}
      <span class="cat">${ic(p.category)}${catLabel(p.category)}</span>
      ${flag ? html`<span class="flag">${flag}</span>` : ''}
    </span>
    <span class="tbody"><span class="tname">${p.name}</span><span class="tprice">${priceLabel(p, vs)}</span><span class="tstat ${cls}">${stat}</span></span>
  </button>`;
}
function viewShop() {
  const now = NOW();
  const groups = S.groups.filter(g => g.active).sort(byPos);
  if (ui.group !== 'all' && !groups.some(g => g.id === ui.group)) ui.group = 'all';
  const shown = ui.group === 'all' ? groups : groups.filter(g => g.id === ui.group);
  const sections = shown.map(g => {
    const prods = S.products.filter(p => p.groupId === g.id && p.status === 'active').sort(byPos);
    if (!prods.length) return '';
    return html`<section aria-label="${g.name}">${ui.group === 'all' ? html`<div class="ghead"><b>${g.name}</b><span>${prods.length} item${prods.length === 1 ? '' : 's'}</span></div>` : ''}<div class="grid">${prods.map(p => tile(p, g, now))}</div></section>`;
  });
  return html`<div class="page">
    <h1 class="title">${S.settings.shopName}</h1>
    ${S.settings.tagline ? html`<p class="tagline">${S.settings.tagline}</p>` : ''}
    ${S.settings.notice ? html`<div class="note info" role="note" style="margin-bottom:14px">${S.settings.notice}</div>` : ''}
    <p class="sub">Claim what you want now, then pay within ${S.settings.holdHours} hours. Your Instagram username is your account.</p>
    ${S.settings.shopOpen ? '' : html`<div class="note amber" style="margin-bottom:14px">The shop is closed right now. You can still look around and check your orders.</div>`}
    <div class="chips" role="group" aria-label="Filter by group">${[{ id: 'all', name: 'All groups' }, ...groups].map(g => html`<button type="button" class="chip ${ui.group === g.id ? 'on' : ''}" data-act="group" data-id="${g.id}" aria-pressed="${ui.group === g.id}">${g.name}</button>`)}</div>
    ${sections.some(Boolean) ? sections : html`<div class="empty"><b>Nothing for sale yet</b>New items will show up here.</div>`}
  </div>`;
}

function modalProduct(m) {
  const p = Core.byId(S.products, m.id);
  if (!p) return html`<p>That item is no longer available.</p>`;
  const g = Core.byId(S.groups, p.groupId), now = NOW();
  const st = Core.productState(S, p, now), vs = Core.productVariants(S, p.id).sort(byPos);
  const plain = vs.length === 1 && vs[0].name === '';
  if (plain && !m.variantId) m.variantId = vs[0].id;
  const v = m.variantId && vs.find(x => x.id === m.variantId);
  const cap = v ? Math.max(1, Math.min(v.stock, p.maxPerUser || 99)) : 1;
  m.qty = Math.min(Math.max(1, m.qty || 1), cap);
  const can = st.kind === 'open' && v && v.stock > 0 && S.settings.shopOpen;
  let banner = '';
  if (!S.settings.shopOpen) banner = html`<div class="note amber">The shop is closed right now.</div>`;
  else if (st.kind === 'soon') banner = html`<div class="note amber">Claims open ${dt(st.opensAt)}.</div>`;
  else if (st.kind === 'soldout') banner = html`<div class="note amber">Sold out.</div>`;
  else if (st.incoming) banner = html`<div class="note">Pre-claim: this hasn’t arrived yet. Claim now and pay by <b>${st.payBy ? dday(st.payBy) : 'the date we message you'}</b>.</div>`;
  else banner = html`<div class="note">Your claim is held for ${S.settings.holdHours} hours. Pay any time before that.</div>`;
  return html`<div class="shead"><div class="grow"><div class="small muted">${g.name}</div><h2>${p.name}</h2><div style="margin-top:4px;font-weight:500">${priceLabel(p, vs)}${p.maxPerUser ? html` <span class="muted small">limit ${p.maxPerUser} each</span>` : ''}</div></div>${closeBtn}</div>
    ${p.description ? html`<p style="margin-bottom:12px;color:var(--text2)">${p.description}</p>` : ''}
    ${banner}
    ${plain ? '' : html`<div class="lbl" style="margin-top:14px" id="vlbl">Choose one</div><div class="vgrid" role="group" aria-labelledby="vlbl">${vs.map(x => html`<button type="button" class="vt ${x.id === m.variantId ? 'on' : ''}" data-act="pick-variant" data-id="${x.id}" data-fk="v-${x.id}" aria-pressed="${x.id === m.variantId}" ${x.stock <= 0 ? raw('disabled') : ''}><b>${x.name}</b><span>${x.stock <= 0 ? 'Sold out' : x.stock + ' left'}${x.priceCents != null && x.priceCents !== p.priceCents ? ' · ' + money(x.priceCents) : ''}</span></button>`)}</div>`}
    <div class="row" style="margin-top:14px"><div class="step" role="group" aria-label="Quantity"><button type="button" data-act="qty" data-d="-1" data-fk="q-" aria-label="One fewer">−</button><output aria-live="polite">${m.qty}</output><button type="button" data-act="qty" data-d="1" data-fk="q+" aria-label="One more">+</button></div>
      <div class="grow right" style="text-align:right;font-weight:600">${v ? money(m.qty * Core.unitPrice(p, v)) : ''}</div></div>
    <button type="button" class="btn primary block" style="margin-top:14px" data-act="add-cart" ${can && v ? '' : raw('disabled')}>${v || plain ? 'Add to claim list' : 'Choose an option first'}</button>`;
}

function viewCheckout() {
  const ls = cartLines();
  if (ui.lastClaim) return claimDone();
  if (!ls.length) return html`<div class="page narrow"><h1 class="title">Your claim</h1><div class="empty"><b>Your claim list is empty</b>Pick something from the shop first.<div style="margin-top:12px"><a class="btn primary" href="#/shop">Browse the shop</a></div></div></div>`;
  const pre = ls.filter(l => l.product.availability === 'incoming');
  const anySold = ls.some(l => l.soldOut);
  return html`<div class="page narrow"><h1 class="title">Review your claim</h1><p class="sub">Claiming holds your items. You pay afterwards, from My orders.</p>
    <div class="card">${ls.map(l => html`<div class="cline"><div class="cl-main"><b>${l.product.name}</b>${l.variant.name ? html` <span class="muted">– ${l.variant.name}</span>` : ''}<div class="small muted">${l.group.name}, ${money(l.unit)} each${l.soldOut ? html` <b style="color:var(--red-800)">Sold out. Remove it to continue.</b>` : ''}</div></div>
      <div class="cl-ctl"><div class="step"><button type="button" data-act="cart-qty" data-id="${l.variant.id}" data-d="-1" aria-label="One fewer ${l.product.name}">−</button><output>${l.qty}</output><button type="button" data-act="cart-qty" data-id="${l.variant.id}" data-d="1" aria-label="One more ${l.product.name}">+</button></div>
      <b class="cl-price">${money(l.qty * l.unit)}</b>
      <button type="button" class="btn ghost sm" data-act="cart-remove" data-id="${l.variant.id}" aria-label="Remove ${l.product.name}">Remove</button></div></div>`)}
      <div class="row" style="padding-top:12px"><b>Total</b><b class="right">${money(cartTotal())}</b></div>
      ${pre.length ? html`<div class="note" style="margin-top:10px">Pre-claim items (${pre.map(l => l.product.name).join(', ')}) are held as a separate order with their own pay-by date.</div>` : ''}</div>
    <form class="card" data-form="checkout" novalidate>
      <h2 class="ch" style="margin-bottom:12px">Who’s claiming?</h2>
      <div class="field"><label for="co-user">Instagram username</label><div class="affix"><span>@</span><input id="co-user" name="user" value="${ui.user}" autocomplete="username" autocapitalize="none" spellcheck="false" data-input="co-user" required></div></div>
      <div class="field"><label for="co-pass" id="co-pass-lbl">Passcode</label><input id="co-pass" name="pass" type="password" autocomplete="current-password" required><div class="hint" id="co-pass-hint">Enter your username and we’ll tell you whether to create a passcode or use your existing one.</div></div>
      <div class="err" id="co-err" role="alert" hidden></div>
      <button class="btn primary block" ${anySold ? raw('disabled') : ''}>Claim now</button></form></div>`;
}
/** The orders just claimed, as the buyer's own account reports them (a visitor's browser never holds anyone's orders). */
async function claimedOrders(c) {
  try { const a = await api.myAccount(ui.session); return a.orders.filter(o => c.orderIds.includes(o.id)); } catch (e) { return []; }
}
async function claimDone() {
  const c = ui.lastClaim, orders = await claimedOrders(c);
  const due = orders.reduce((s, o) => s + o.due, 0);
  return html`<div class="page narrow"><h1 class="title">Claimed</h1>
    <p class="sub">${due > 0 ? 'Your items are on hold. Send payment before the time runs out.' : 'Your credit covered everything — nothing more to pay.'}</p>
    ${orders.map(o => html`<div class="card"><div class="row"><b>Order #${o.no}</b><span class="badge ${o.payState === 'paid' ? 'b-paid' : 'b-unpaid'}">${o.payState === 'paid' ? 'Paid' : 'Unpaid'}</span><span class="right"><b>${money(o.total)}</b></span></div>
      <div class="small muted" style="margin-top:4px">${o.lines.map(l => l.qty + '× ' + l.name + (l.variantName ? ' (' + l.variantName + ')' : '')).join(', ')}</div>
      ${o.due > 0 ? html`<div style="margin-top:8px"><span class="timer">${o.holdExpiresAt - NOW() > 3 * Core.DAY ? 'Pay by ' + dday(o.holdExpiresAt) : 'Pay within ' + left(o.holdExpiresAt - NOW())}</span></div>` : ''}</div>`)}
    ${c.creditAppliedCents ? html`<div class="note teal" style="margin-bottom:14px">${money(c.creditAppliedCents)} of your credit was applied automatically.</div>` : ''}
    <div class="row">${due > 0 ? html`<button type="button" class="btn primary" data-act="pay-now">Pay ${money(due)} now</button>` : ''}<button type="button" class="btn" data-act="keep-shopping">Keep shopping</button></div></div>`;
}

function lookupView(msg) {
  return html`<div class="page narrow"><h1 class="title">My orders</h1><p class="sub">Look up your claims, payments and shipping.</p>
    <form class="lookup" data-form="login" novalidate><div class="field"><label for="lg-user">Instagram username</label><div class="affix"><span>@</span><input id="lg-user" name="user" value="${ui.user}" autocomplete="username" autocapitalize="none" spellcheck="false" required></div></div>
      <div class="field"><label for="lg-pass">Passcode</label><input id="lg-pass" name="pass" type="password" autocomplete="current-password" required></div>
      ${msg || ui.loginErr ? html`<div class="err" role="alert">${msg || ui.loginErr}</div>` : ''}
      <button class="btn primary block">View my orders</button>
      <p class="hint" style="margin-top:12px">First time? Your passcode is created when you make your first claim. Forgot it? Message the seller to reset it.</p></form>
    ${DEMO ? html`<div class="note" style="max-width:440px;margin:0 auto">Demo: try <b>sora_ru</b> (one unpaid order) or <b>minjae.k</b> (has $5 credit), passcode <span class="mono">1234</span>.</div>` : ''}</div>`;
}
function orderChips(o) {
  const c = [];
  if (o.status === 'cancelled') c.push(['Cancelled', '']);
  else if (o.status === 'expired') c.push(['Expired', '']);
  else {
    if (o.payState === 'paid') c.push(['Paid', 'b-paid']);
    else if (o.payState === 'partial') c.push(['Partly paid', 'b-pending']);
    else if (!(o.pending > 0)) c.push(['Unpaid', 'b-unpaid']);
    if (o.pending > 0 && o.payState !== 'paid') c.push(['Payment in review', 'b-pending']);
    if (o.fulfillment === 'packed') c.push(['Packed', 'b-ok']);
    if (o.fulfillment === 'shipped') c.push(['Shipped', 'b-ok']);
  }
  return c.map(([t, k]) => html`<span class="badge ${k}">${t}</span>`);
}
const timerChip = o => (o.status === 'open' && o.due > 0 && o.pending === 0 && o.paid === 0)
  ? html`<span class="timer ${o.leftMs < 6 * Core.HOUR ? 'late' : ''}">${o.leftMs > 3 * Core.DAY ? 'Pay by ' + dday(o.holdExpiresAt) : 'Pay within ' + left(o.leftMs)}</span>` : '';
async function viewOrders() {
  if (!ui.session) return lookupView();
  let a;
  try { a = await api.myAccount(ui.session); } catch (e) { ui.session = null; ui.loginErr = errMsg(e); return lookupView(); }
  ui.loginErr = '';
  const open = a.orders.filter(o => o.status === 'open'), closed = a.orders.filter(o => o.status !== 'open');
  const hints = [a.pendingCents > 0 ? 'In review means you sent it and the seller hasn’t confirmed it yet.' : '', a.creditCents > 0 ? 'Credit is used on your next claim automatically.' : ''].filter(Boolean).join(' ');
  return html`<div class="page narrow"><div class="row"><h1 class="title who grow">@${a.username}</h1><button type="button" class="btn sm" data-act="logout">Log out</button></div>
    <div class="stats three" style="margin-top:8px">
      <div class="stat ${a.toSendCents > 0 ? 'hot' : ''}"><b>${money(a.toSendCents)}</b><span>To pay</span></div>
      <div class="stat"><b>${money(a.pendingCents)}</b><span>In review</span></div>
      <div class="stat"><b>${money(a.creditCents)}</b><span>Credit</span></div></div>
    ${hints ? html`<p class="small muted" style="margin:-6px 0 14px">${hints}</p>` : ''}
    <div class="row" style="margin-bottom:18px">${a.toSendCents > 0 ? html`<button type="button" class="btn primary" data-act="pay-all">Pay ${money(a.toSendCents)}</button>` : ''}<button type="button" class="btn" data-act="pay-ahead">Add credit ahead of time</button><a class="btn ghost" href="#/shop">Keep shopping</a></div>
    ${a.orders.length ? '' : html`<div class="empty"><b>No claims yet</b>When you claim something it will show up here.</div>`}
    ${open.map(o => orderCard(o))}
    ${a.payments.length ? html`<h2 class="h" style="margin-top:22px">Payments you’ve sent</h2><div class="card" style="padding:2px 16px">${a.payments.map(p => html`<div class="prow">
      <div class="grow"><b>${money(p.amountCents)}</b> <span class="muted">via ${(Core.methodOf(S, p.method) || {}).label || p.method}</span>
        <div class="small muted">Sent ${dt(p.createdAt)}</div>
        ${p.covers.length ? html`<div class="small">${p.status === 'confirmed' ? 'Paid' : 'For'} ${p.covers.map(c => '#' + c.orderNo).join(', ')}${p.status === 'confirmed' && p.remaining > 0 ? html`, ${money(p.remaining)} kept as credit` : ''}</div>` : (p.status === 'confirmed' ? html`<div class="small">Kept as credit</div>` : '')}
        ${p.status === 'rejected' && p.rejectReason ? html`<div class="small" style="color:var(--red-800)">${p.rejectReason}</div>` : ''}</div>
      <div class="prow-end"><span class="badge ${p.status === 'confirmed' ? 'b-ok' : p.status === 'rejected' ? 'b-bad' : 'b-pending'}">${p.status === 'confirmed' ? 'Confirmed' : p.status === 'rejected' ? 'Rejected' : 'In review'}</span>${p.hasProof ? html`<span class="small muted">Screenshot attached</span>` : ''}</div></div>`)}</div>` : ''}
    ${closed.length ? html`<h2 class="h" style="margin-top:22px">Past claims</h2>${closed.map(o => orderCard(o))}` : ''}</div>`;
}
function orderCard(o) {
  const shipFee = o.shippingFeeCents || 0, isOpen = o.status === 'open';
  const waiting = isOpen && o.due > 0 && o.toSend === 0;                       // everything still owed is already sent and waiting for the seller
  const preorder = o.lines.some(l => { const p = Core.byId(S.products, l.productId); return p && p.availability === 'incoming'; });
  const note = isOpen && o.payState === 'paid' && o.fulfillment === 'pending' ? (preorder ? 'Paid. The seller will pack it once the item arrives.' : 'Paid. The seller will pack it soon.')
    : waiting ? 'The seller will confirm your payment soon.' : !isOpen ? (o.cancelReason || '') : '';
  return html`<article class="ocard" aria-label="Order ${o.no}"><div class="ohead"><b>#${o.no}</b>${orderChips(o)}${timerChip(o)}<span class="right small muted">${dt(o.createdAt)}</span></div>
    <div class="olines">${o.lines.map(l => html`<div class="oline"><div class="grow">${l.name}${l.variantName ? html` <span class="muted">– ${l.variantName}</span>` : ''}</div><div class="muted">${l.qty} × ${money(l.unitCents)}</div><div style="width:68px;text-align:right">${money(l.qty * l.unitCents)}</div></div>`)}</div>
    <div class="ototals"><span>Items</span><span style="text-align:right">${money(o.subtotal)}</span>${shipFee ? html`<span>Shipping</span><span style="text-align:right">${money(shipFee)}</span>` : ''}<span>Paid so far</span><span style="text-align:right">${money(o.paid)}</span>${isOpen && o.pending > 0 ? html`<span>In review</span><span style="text-align:right">${money(o.pending)}</span>` : ''}<span class="big">${isOpen ? 'Still to pay' : 'Total'}</span><span class="big" style="text-align:right">${money(isOpen ? o.toSend : o.total)}</span></div>
    ${isOpen || o.tracking || note ? html`<div class="ofoot">${isOpen && o.toSend > 0 ? html`<button type="button" class="btn primary sm" data-act="pay-order" data-id="${o.id}">Pay ${money(o.toSend)}</button>` : ''}${isOpen && o.paid === 0 && o.pending === 0 ? html`<button type="button" class="btn sm" data-act="cancel-mine" data-id="${o.id}">Cancel claim</button>` : ''}${o.fulfillment === 'shipped' && o.tracking ? html`<span class="small">Tracking <span class="mono">${o.tracking}</span></span>` : ''}${note ? html`<span class="small muted">${note}</span>` : ''}</div>` : ''}</article>`;
}

const TXN_LABEL = { paypal: 'PayPal transaction ID', venmo: 'Venmo transaction ID', zelle: 'Zelle confirmation number', wise: 'Wise transfer number', other: 'Reference' };
function payState() { return ui.pay || (ui.pay = { orderIds: null, method: null, extraText: '', amountText: '', touched: false, txn: '', name: '', when: '', proof: null, err: '' }); }
function capturePay() {
  const f = $('#pay-form'); if (!f || !ui.pay) return;
  const P = ui.pay, g = n => (f.elements[n] ? f.elements[n].value : '');
  P.amountText = g('amount'); P.txn = g('txn'); P.name = g('name'); P.when = g('when'); P.extraText = g('extra');
  P.orderIds = $$('input[name=ord]:checked', f).map(x => x.value);
}
function payDueTotal(a) { const P = payState(); return a.orders.filter(o => o.status === 'open' && o.toSend > 0 && (P.orderIds == null || P.orderIds.includes(o.id))).reduce((s, o) => s + o.toSend, 0); }
function updatePayTotals() {
  const f = $('#pay-form'); if (!f || !ui.payAcct) return;
  const P = ui.pay;
  const selected = $$('input[name=ord]:checked', f).reduce((s, x) => s + Number(x.dataset.due), 0);
  const extra = Core.parseMoney(f.elements.extra ? f.elements.extra.value || '0' : '0');
  const total = selected + (Number.isNaN(extra) ? 0 : Math.max(0, extra));
  $('#pay-total').textContent = money(total);
  $$('.pay-send').forEach(x => { x.textContent = money(total); });
  if (!P.touched && f.elements.amount) f.elements.amount.value = total ? (total / 100).toFixed(2) : '';
}
async function viewPay() {
  if (!ui.session) { ui.loginErr = 'Log in to pay for your claims.'; return lookupView(); }
  if (ui.paid) {
    const p = ui.paid;
    return html`<div class="page narrow"><h1 class="title">Payment sent</h1><div class="card"><div class="row"><span class="badge b-pending">In review</span><b>${money(p.amountCents)} via ${p.method}</b></div><p style="margin-top:10px">Thanks. The seller will match it against their account and confirm it, usually within a day. Your claims stay on hold while it’s in review.</p></div><div class="row"><a class="btn primary" href="#/orders">Back to my orders</a><a class="btn" href="#/shop">Keep shopping</a></div></div>`;
  }
  let a;
  try { a = await api.myAccount(ui.session); } catch (e) { ui.session = null; ui.loginErr = errMsg(e); return lookupView(); }
  ui.payAcct = a;
  const P = payState();
  const methods = S.settings.methods.filter(m => m.enabled);
  if (!P.method || !methods.some(m => m.key === P.method)) P.method = methods[0] && methods[0].key;
  const m = methods.find(x => x.key === P.method);
  const dueOrders = a.orders.filter(o => o.status === 'open' && o.toSend > 0);
  const inReview = a.orders.filter(o => o.status === 'open' && o.due > 0 && o.toSend === 0);
  if (P.orderIds == null) P.orderIds = dueOrders.map(o => o.id);
  const total = payDueTotal(a) + Math.max(0, Core.parseMoney(P.extraText || '0') || 0);
  if (!P.touched && !P.amountText) P.amountText = total ? (total / 100).toFixed(2) : '';
  return html`<div class="page narrow"><h1 class="title">Pay</h1><p class="sub">Send the money in your own payment app, then tell us you did. The seller checks it against their account before anything is marked paid.</p>
    <form id="pay-form" data-form="pay" novalidate>
    <div class="card"><h2 class="ch" style="margin-bottom:8px">1. What are you paying for?</h2>
      ${dueOrders.length ? dueOrders.map(o => html`<label class="check"><input type="checkbox" name="ord" value="${o.id}" data-due="${o.toSend}" data-change="pay-recalc" ${P.orderIds.includes(o.id) ? raw('checked') : ''}><span class="grow"><b>Order #${o.no}</b> <span class="muted">${o.lines.map(l => l.qty + '× ' + l.name).join(', ')}</span>${o.pending > 0 ? html`<div class="small" style="color:var(--amber-800)">${money(o.pending)} of this is already in review, so only the rest is shown.</div>` : ''}</span><b>${money(o.toSend)}</b></label>`) : html`<p class="muted">${inReview.length ? 'Everything you owe has already been sent and is waiting for the seller to confirm.' : 'Nothing is due right now.'} You can still add credit ahead of time, and it will pay your next claim automatically.</p>`}
      ${dueOrders.length && inReview.length ? html`<p class="small muted">${inReview.map(o => '#' + o.no).join(', ')} already sent and in review.</p>` : ''}
      <div class="field" style="margin-top:10px"><label for="pay-extra">Add extra credit (optional)</label><div class="affix"><span>$</span><input id="pay-extra" name="extra" inputmode="decimal" value="${P.extraText}" data-change="pay-recalc" placeholder="0.00"></div><div class="hint">Credit pays for your next claim automatically.</div></div>
      <div class="row"><span>Total to send</span><b class="right" id="pay-total" style="font-size:18px">${money(total)}</b></div></div>
    <div class="card"><h2 class="ch" style="margin-bottom:10px">2. Send it</h2>
      <div class="mgrid" role="group" aria-label="Payment method">${methods.map(x => html`<button type="button" class="mt ${x.key === P.method ? 'on' : ''}" data-act="pick-method" data-key="${x.key}" data-fk="m-${x.key}" aria-pressed="${x.key === P.method}">${x.label}</button>`)}</div>
      ${m ? html`<div class="handle"><span class="grow mono" id="handle-text">${m.handle || 'Ask the seller for details'}</span>${m.handle ? html`<button type="button" class="btn sm" data-act="copy" data-text="${m.handle}">${ic('copy')} Copy</button>` : ''}</div><p class="hint">Send exactly <b class="pay-send">${money(total)}</b>. ${m.hint}</p>` : html`<div class="note amber">The seller hasn’t turned on any payment methods yet.</div>`}</div>
    <div class="card"><h2 class="ch" style="margin-bottom:10px">3. Tell us you paid</h2>
      <div class="two"><div class="field"><label for="pay-amount">Amount you sent</label><div class="affix"><span>$</span><input id="pay-amount" name="amount" inputmode="decimal" value="${P.amountText}" data-input="pay-amount" required></div></div>
        <div class="field"><label for="pay-txn">${TXN_LABEL[P.method] || 'Reference'} <span class="muted">(optional)</span></label><input id="pay-txn" name="txn" value="${P.txn}" autocomplete="off" spellcheck="false"></div></div>
      <div class="field"><label for="pay-name">Name on your payment account <span class="muted">(optional)</span></label><input id="pay-name" name="name" value="${P.name}" autocomplete="name"><div class="hint">Banks and PayPal show your real name, not your Instagram handle. This helps the seller find your payment.</div></div>
      <details style="margin-bottom:14px"><summary class="small" style="cursor:pointer">Sent it earlier? Change the time</summary><div class="field" style="margin-top:8px"><label for="pay-when">When did you send it?</label><input id="pay-when" name="when" type="datetime-local" value="${P.when}" max="${localInput(NOW())}"></div></details>
      <div class="field"><span class="lbl" id="shot-lbl">Screenshot of your payment ${S.settings.requireProof ? '' : html`<span class="muted">(optional)</span>`}</span>
        <label class="upload" aria-labelledby="shot-lbl">${P.proof ? html`<span class="row" style="justify-content:center"><img class="thumb" src="${safeUrl(P.proof.dataUrl)}" alt="Your screenshot"><span class="small">${P.proof.name}<br>${Math.round(P.proof.bytes / 1024)} KB — tap to replace</span></span>` : html`<span>${ic('image')} Tap to choose a screenshot</span>`}<input type="file" name="shot" accept="image/*" data-change="proof"></label>
        <div class="hint">Show the amount, date and transaction ID. Crop out balances and account numbers — the seller doesn’t need them.</div></div>
      <div class="err" id="pay-err" role="alert" ${P.err ? '' : raw('hidden')}>${P.err}</div>
      <button class="btn primary block" ${m ? '' : raw('disabled')}>Send payment details</button></div></form></div>`;
}

function viewRules() {
  const ms = S.settings.methods.filter(m => m.enabled);
  return html`<div class="page narrow"><h1 class="title">How it works</h1><p class="sub">Short version: claim, pay, we match it, we ship.</p>
    <div class="card"><h2 class="ch">Claiming</h2><ul style="margin:8px 0 0 18px"><li>Pick items, then claim with your Instagram username. First time, you also create a passcode.</li><li>A claim holds your items for <b>${S.settings.holdHours} hours</b>. If nothing is paid by then, the hold is released for the next person.</li><li><b>Pre-claim</b> items haven’t arrived yet. You can claim them early and pay by the date shown.</li></ul></div>
    <div class="card"><h2 class="ch">Paying</h2><ul style="margin:8px 0 0 18px"><li>Send money with ${ms.length ? ms.map(m => m.label).join(', ') : 'the seller’s payment methods'}, then open <b>My orders → Pay</b> and upload a screenshot.</li><li>The seller checks your payment against their own account. A screenshot alone never marks an order paid.</li><li>Paid too much, or paid before claiming? The extra stays as <b>credit</b> and is used on your next claim automatically.</li><li>If a payment is rejected you’ll see why, and your hold gets extra time to fix it.</li></ul></div>
    <div class="card"><h2 class="ch">Shipping</h2><ul style="margin:8px 0 0 18px"><li>Paid orders are packed, then shipped. Tracking appears on your order when there is one.</li><li>Some orders get a shipping fee added after packing. It shows up as a new amount to pay.</li></ul></div></div>`;
}

/* ======================= SELLER VIEWS ======================= */
const ATABS = [['dashboard', 'Overview'], ['reconcile', 'Reconcile'], ['orders', 'Orders'], ['catalog', 'Catalog'], ['buyers', 'Buyers'], ['settings', 'Settings']];
/** The seller's door. It is not linked from anywhere: the seller opens  .../#/seller  directly. */
function viewSeller() {
  if (ui.admin) { queueMicrotask(() => go('#/admin')); return html``; }
  if (LIVE.on) {
    return html`<div class="page narrow"><h1 class="title">Seller sign-in</h1><form class="lookup" data-form="signin" novalidate>
      <div class="field"><label for="sl-email">Email</label><input id="sl-email" name="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="sl-pass">Password</label><input id="sl-pass" name="password" type="password" autocomplete="current-password" required></div>
      <div class="err" id="sl-err" role="alert" hidden></div>
      <button class="btn primary block">Sign in</button></form></div>`;
  }
  return html`<div class="page narrow"><h1 class="title">Seller desk</h1><div class="lookup"><p style="margin-bottom:14px">${DEMO ? 'Demo mode: there’s no password. In the live version this is a real email and password login.' : 'Preview mode: there’s no password because nothing here is shared. Once the shop is connected to its database, this becomes a real email and password sign-in.'}</p><button type="button" class="btn primary block" data-act="admin-in">Enter as seller</button></div></div>`;
}
function adminShell(tab, body) {
  const n = Core.dashboard(S, NOW()), rs = reconcileState();
  const dots = { reconcile: rs.subs.length + rs.orphans.length, orders: n.toPack };
  return html`<div class="page"><div class="row"><h1 class="title grow">Seller desk</h1><button type="button" class="btn sm ghost" data-act="admin-out">Leave seller desk</button></div>
    <div class="atabs" role="tablist" aria-label="Seller sections">${ATABS.map(([k, l]) => html`<a class="atab ${tab === k ? 'on' : ''}" role="tab" aria-selected="${tab === k}" href="#/admin/${k}" style="text-decoration:none">${l}${dots[k] ? html`<span class="dot">${dots[k]}</span>` : ''}</a>`)}</div>${body}</div>`;
}
function viewAdmin(r) {
  if (!ui.admin) { queueMicrotask(() => go(DEMO ? '#/seller' : '#/shop')); return html``; }   // visitors never see the desk, not even a sign-in box
  const tab = ATABS.some(t => t[0] === r.rest[0]) ? r.rest[0] : 'dashboard';
  return adminShell(tab, ADMIN[tab](r));
}

function admDashboard() {
  const n = Core.dashboard(S, NOW()), rs = reconcileState();
  const start = S.groups.length ? '' : html`<div class="card" style="margin-bottom:16px"><h2 class="ch">Your shop is open and empty. Start here:</h2><ol style="margin:8px 0 0 18px"><li><a href="#/admin/settings">Settings</a>: shop name, tagline, colour, and your PayPal / Venmo / Zelle details.</li><li><a href="#/admin/catalog">Catalog</a>: add a group (an artist or theme), then its products with prices and stock.</li><li>Share your shop link. Buyers claim with their Instagram username; you confirm their payments under <a href="#/admin/reconcile">Reconcile</a>.</li></ol></div>`;
  const st = (num, label, to, hot) => html`<button type="button" class="stat ${hot ? 'hot' : ''}" data-act="goto" data-to="${to}"><b>${num}</b><span>${label}</span></button>`;
  return html`${start}<div class="stats">
    ${st(rs.subs.length, 'Buyers say they paid', '#/admin/reconcile', rs.subs.length > 0)}
    ${st(money(Core.sumBy(rs.orphans, t => t.amountCents)), `Received, no buyer yet (${rs.orphans.length})`, '#/admin/reconcile', rs.orphans.length > 0)}
    ${st(n.expiringSoon, 'Holds ending within 6 hours', '#/admin/orders', n.expiringSoon > 0)}
    ${st(n.toPack, 'Paid, ready to pack', '#/admin/orders', n.toPack > 0)}
    ${st(n.toShip, 'Packed, ready to ship', '#/admin/orders')}
    ${st(money(n.receivableCents), 'Owed to you on open orders', '#/admin/orders')}
    ${st(money(n.receivedCents), 'Confirmed payments, all time', '#/admin/reconcile')}
    ${st(money(n.creditCents), 'Credit you’re holding for buyers', '#/admin/buyers')}
    ${st(n.lowStock, 'Variants with 2 or fewer left', '#/admin/catalog')}</div>
    <div class="card"><h2 class="ch" style="margin-bottom:8px">Recent activity</h2>${S.log.length ? [...S.log].sort((a, b) => b.at - a.at).slice(0, 14).map(e => html`<div class="oline" style="font-size:13px"><span class="muted" style="width:74px;flex:none">${ago(e.at)}</span><span class="grow"><b>${e.actor}</b> ${e.msg}</span></div>`) : html`<p class="muted">Nothing yet.</p>`}</div>`;
}

/* ---- Reconcile: buyer submissions on the left, money you actually received on the right ---- */
const LEVEL = {
  exact: ['exact', 'Exact match', 'Transaction ID and amount both match.'],
  likely: ['exact', 'Likely match', ''],
  possible: ['help', 'Possible match, check the screenshot', ''],
  check: ['alert', 'Transaction ID matches but the amount differs', ''],
  manual: ['help', 'The transfer you picked', ''],
  none: ['none', 'No matching transfer in your feed', 'Import your latest export, or check your account and confirm by hand.'],
};
function incomingLine(t) {
  return html`<div class="inrow"><div class="row"><b>${money(t.amountCents)}</b><span class="badge b-info">${t.method}</span><span>${t.senderName || 'Unknown sender'}</span><span class="right small muted">${dt(t.occurredAt)}</span></div>${t.extId ? html`<div class="small">Transaction <span class="mono">${t.extId}</span></div>` : ''}</div>`;
}
function ticket(p, sug, free) {
  const chosenId = p.id in ui.choice ? ui.choice[p.id] : sug.incomingId;
  const t = chosenId ? Core.byId(S.incoming, chosenId) : null;
  const level = !t ? 'none' : chosenId === sug.incomingId ? sug.level : 'manual';
  const [icon, label, sub] = LEVEL[level];
  const flags = Core.paymentFlags(S, p);
  const orders = (p.intendedOrderIds || []).map(id => Core.byId(S.orders, id)).filter(Boolean);
  const sentence = a => a.length ? a.map((r, i) => (i ? r.charAt(0).toLowerCase() + r.slice(1) : r)).join(', ') + '.' : '';
  const reasons = chosenId === sug.incomingId ? sentence(sug.reasons) : '';
  const sameMethod = free.filter(x => x.method === p.method || x.id === chosenId);
  return html`<article class="ticket" aria-label="Payment ${p.no} from ${p.username}"><div class="ticket-top"><div class="grow">
      <div class="row"><b>@${p.username}</b><span class="badge b-info">${p.method}</span><span class="small muted">sent ${ago(p.createdAt)}</span></div>
      <div class="amt" style="margin:4px 0">${money(p.amountCents)}</div>
      <div class="small muted">${orders.length ? 'For ' + orders.map(o => '#' + o.no + ' (' + money(Core.orderDue(S, o)) + ' due)').join(', ') : 'Not tied to an order (credit)'}</div>
      ${p.senderName ? html`<div class="small">Name on account: <b>${p.senderName}</b></div>` : ''}
      ${p.txnId ? html`<div class="small">Transaction <span class="mono">${p.txnId}</span></div>` : ''}
      ${flags.length ? html`<div class="flags">${flags.map(f => html`<span class="badge ${f.level === 'high' ? 'b-bad' : f.level === 'warn' ? 'b-pending' : ''}">${f.text}</span>`)}</div>` : ''}</div>
      ${p.proof ? html`<button type="button" class="thumbbtn" style="border:0;background:none;padding:0" data-act="view-proof" data-id="${p.id}" aria-label="View screenshot"><img class="thumb" src="${safeUrl(p.proof.dataUrl)}" alt="Screenshot from @${p.username}"></button>` : html`<span class="badge">No screenshot</span>`}</div>
    <div class="match ${level}"><div class="mlabel ${level}">${ic(icon)} ${label}</div>
      ${t ? incomingLine(t) : ''}
      ${reasons || sub ? html`<div class="small">${reasons || sub}${t && sug.ambiguous && chosenId === sug.incomingId ? ' Another transfer looks similar, so compare the screenshot with your account.' : ''}</div>` : ''}
      ${free.length ? html`<div><label class="small" for="ch-${p.id}">Transfer in your feed</label><select class="inp" id="ch-${p.id}" data-change="choose" data-id="${p.id}" data-fk="ch-${p.id}"><option value="" ${chosenId ? '' : raw('selected')}>None, I’ll check my account myself</option>${sameMethod.map(x => html`<option value="${x.id}" ${x.id === chosenId ? raw('selected') : ''}>${money(x.amountCents)} ${x.method}, ${x.senderName || 'unknown'}, ${ago(x.occurredAt)}</option>`)}</select></div>` : ''}
      <div class="tick-act"><button type="button" class="btn primary sm" data-act="confirm-pay" data-id="${p.id}">Confirm payment</button><button type="button" class="btn ghost sm" data-act="reject-pay" data-id="${p.id}">Reject</button></div></div></article>`;
}
function admReconcile() {
  const { sugs, subs, free, orphans } = reconcileState();
  const exact = subs.filter(p => sugs[p.id].level === 'exact' && !(p.id in ui.choice));
  const recent = S.incoming.filter(t => t.status === 'matched').sort((a, b) => b.occurredAt - a.occurredAt).slice(0, 5);
  const proposedN = free.length - orphans.length;
  return html`<p class="sub">Buyers tell you what they paid. Your own PayPal, Venmo or Zelle feed is what proves it. Match the two here.</p>
    <div class="row" style="margin-bottom:16px"><button type="button" class="btn sm" data-act="open-import">Import export</button><button type="button" class="btn sm" data-act="open-addin">Add one transfer</button>${exact.length ? html`<button type="button" class="btn sm primary" data-act="confirm-exact">Confirm ${exact.length} exact match${exact.length === 1 ? '' : 'es'}</button>` : ''}</div>
    <div class="fgrid two-col">
      <section aria-label="Buyers say they paid"><h2 class="h">Buyers say they paid (${subs.length})</h2>${subs.length ? subs.map(p => ticket(p, sugs[p.id], free)) : html`<div class="empty"><b>Nothing to review</b>When a buyer sends payment details, it shows up here.</div>`}</section>
      <section aria-label="Money received with no buyer yet"><h2 class="h">Money you received, no buyer yet (${orphans.length})</h2>
        ${proposedN ? html`<p class="small muted" style="margin:-4px 0 10px">${proposedN} more transfer${proposedN === 1 ? ' is' : 's are'} already proposed as a match on the left.</p>` : ''}
        ${orphans.length ? orphans.map(t => { const sg = Core.suggestBuyersForIncoming(S, t); return html`<div class="card" style="padding:12px 14px">${incomingLine(t)}
          ${sg.length ? html`<div class="small" style="margin:8px 0 4px">Could be:</div>${sg.map(x => html`<div class="row" style="margin-bottom:4px"><span class="grow small"><b>@${x.username}</b> owes ${money(x.dueCents)} (${x.reasons.join(', ')})</span><button type="button" class="btn sm primary" data-act="assign-quick" data-id="${t.id}" data-user="${x.username}" aria-label="Assign ${money(t.amountCents)} to @${x.username}">Assign</button></div>`)}` : html`<div class="small muted" style="margin:8px 0 4px">No buyer owes this amount.</div>`}
          <div class="row"><button type="button" class="btn sm" data-act="assign-open" data-id="${t.id}">Assign to someone…</button><button type="button" class="btn sm ghost" data-act="ignore-in" data-id="${t.id}">Ignore</button></div></div>`; }) : html`<div class="empty"><b>No loose money</b>${proposedN ? 'Every transfer left in your feed is proposed as a match on the left.' : 'Import your latest export to check for new money.'}</div>`}
        ${recent.length ? html`<details style="margin-top:14px"><summary class="small" style="cursor:pointer">Recently matched (${recent.length})</summary>${recent.map(t => html`<div class="small" style="padding:6px 0;border-bottom:1px solid var(--line)">${money(t.amountCents)} ${t.method} from ${t.senderName || 'unknown'}, matched to payment #${(Core.byId(S.payments, t.paymentId) || {}).no}</div>`)}</details>` : ''}</section></div>`;
}

const ORDER_FILTERS = [['open', 'All open'], ['unpaid', 'Unpaid'], ['partial', 'Part paid'], ['pack', 'To pack'], ['ship', 'To ship'], ['sent', 'Shipped'], ['closed', 'Expired or cancelled']];
/** Table cell that also works as a labelled row on phones (see .tw.stack in the CSS). */
const cell = (label, inner, cls = '') => html`<td data-label="${label}" class="${cls}"><div>${inner}</div></td>`;
function admOrders() {
  const now = NOW();
  const rows = S.orders.slice().sort((a, b) => b.createdAt - a.createdAt).filter(o => {
    const ps = Core.orderPayState(S, o);
    switch (ui.ofilter) {
      case 'open': return o.status === 'open';
      case 'unpaid': return o.status === 'open' && ps === 'unpaid';
      case 'partial': return o.status === 'open' && ps === 'partial';
      case 'pack': return o.status === 'open' && ps === 'paid' && o.fulfillment === 'pending';
      case 'ship': return o.status === 'open' && ps === 'paid' && o.fulfillment === 'packed';
      case 'sent': return o.status === 'open' && o.fulfillment === 'shipped';
      default: return o.status !== 'open';
    }
  });
  return html`<div class="chips" role="group" aria-label="Filter orders">${ORDER_FILTERS.map(([k, l]) => html`<button type="button" class="chip ${ui.ofilter === k ? 'on' : ''}" data-act="ofilter" data-k="${k}" aria-pressed="${ui.ofilter === k}">${l}</button>`)}</div>
    ${rows.length ? html`<div class="card" style="padding:6px 14px"><div class="tw stack"><table><thead><tr><th>Order</th><th>Buyer</th><th>Items</th><th class="num">Total</th><th class="num">Paid</th><th>Status</th><th><span class="sr">Open</span></th></tr></thead><tbody>${rows.map(o => {
      const v = { ...o, paid: Core.orderPaid(S, o.id), due: Core.orderDue(S, o), pending: Core.orderPending(S, o.id), payState: Core.orderPayState(S, o), leftMs: o.holdExpiresAt - now };
      const first = o.lines[0], more = o.lines.length - 1;
      return html`<tr>${cell('Order', html`<b>#${o.no}</b> <span class="small muted">${dt(o.createdAt)}</span>`)}${cell('Buyer', '@' + o.username)}${cell('Items', html`${first.qty}× ${first.name}${first.variantName ? ' (' + first.variantName + ')' : ''}${more > 0 ? html` <span class="muted">+${more} more</span>` : ''}`)}${cell('Total', money(Core.orderTotal(o)), 'num')}${cell('Paid', money(v.paid), 'num')}${cell('Status', html`<span class="row" style="gap:4px">${orderChips(v)}${timerChip(v)}</span>`)}${cell('', html`<button type="button" class="btn sm" data-act="open-order" data-id="${o.id}">Manage</button>`)}</tr>`;
    })}</tbody></table></div></div>` : html`<div class="empty"><b>No orders here</b>Try another filter.</div>`}`;
}

function admCatalog() {
  const gs = S.groups.slice().sort(byPos);
  return html`<p class="sub">Groups hold products. Each product has variants (a member, a version, a size) with their own stock.</p>
    <div class="row" style="margin-bottom:14px"><button type="button" class="btn sm" data-act="edit-group" data-id="">New group</button><button type="button" class="btn sm primary" data-act="edit-product" data-id="">New product</button></div>
    ${gs.map(g => { const ps = S.products.filter(p => p.groupId === g.id).sort(byPos); return html`<div class="card"><div class="row"><span class="badge" style="font-size:12px"><i class="swatch" style="background:${groupColor(g)}"></i>${g.name}</span><span class="small muted">${g.members.length} members</span><button type="button" class="btn sm ghost right" data-act="edit-group" data-id="${g.id}">Edit group</button></div>
      ${ps.length ? html`<div class="tw"><table><thead><tr><th>Product</th><th class="num">Price</th><th>Stock by variant</th><th>Status</th><th><span class="sr">Edit</span></th></tr></thead><tbody>${ps.map(p => { const vs = Core.productVariants(S, p.id).sort(byPos); return html`<tr><td><b>${p.name}</b><div class="small muted">${catLabel(p.category)}${p.availability === 'incoming' ? ', pre-claim' : ''}</div></td><td class="num">${money(p.priceCents)}</td><td>${vs.map(v => html`<span class="tag" style="margin:0 4px 4px 0;${v.stock === 0 ? 'text-decoration:line-through;color:var(--text3)' : ''}">${v.name || 'stock'} ${v.stock}</span>`)}</td><td><span class="badge ${p.status === 'active' ? 'b-ok' : ''}">${p.status === 'active' ? 'Visible' : 'Hidden'}</span></td><td><button type="button" class="btn sm" data-act="edit-product" data-id="${p.id}">Edit</button></td></tr>`; })}</tbody></table></div>` : html`<p class="muted" style="margin-top:8px">No products yet.</p>`}</div>`; })}
    ${gs.length ? '' : html`<div class="empty"><b>Start with a group</b>Add the first group, then its products.</div>`}`;
}

function admBuyers() {
  const names = new Set([...Object.keys(S.buyers), ...S.orders.map(o => o.username), ...S.payments.map(p => p.username)]);
  const rows = [...names].sort().map(u => ({ u, b: S.buyers[u] || {}, open: S.orders.filter(o => o.username === u && o.status === 'open').length, due: Core.buyerDue(S, u), credit: Core.buyerCredit(S, u) }));
  return html`<p class="sub">Typed the wrong handle? Merge it into the right one and all orders and payments move over. Reset a passcode when someone forgets theirs.</p>
    <div class="card" style="padding:6px 14px"><div class="tw stack"><table><thead><tr><th>Username</th><th class="num">Open orders</th><th class="num">Owes</th><th class="num">Credit</th><th>Passcode</th><th><span class="sr">Actions</span></th></tr></thead><tbody>${rows.map(r => html`<tr>${cell('Buyer', html`<b>@${r.u}</b>${r.b.blocked ? html` <span class="badge b-bad">Blocked</span>` : ''}`)}${cell('Open orders', r.open, 'num')}${cell('Owes', money(r.due), 'num')}${cell('Credit', money(r.credit), 'num')}${cell('Passcode', html`${r.b.passHash ? 'Set' : 'Not set'}${r.b.lockUntil > NOW() ? html` <span class="badge b-pending">Locked</span>` : ''}`)}
      ${cell('', html`<span class="row" style="gap:6px"><button type="button" class="btn sm" data-act="reset-pass" data-u="${r.u}">Reset passcode</button><button type="button" class="btn sm" data-act="toggle-block" data-u="${r.u}">${r.b.blocked ? 'Unblock' : 'Block'}</button><button type="button" class="btn sm" data-act="merge-open" data-u="${r.u}">Merge into…</button></span>`)}</tr>`)}</tbody></table></div></div>`;
}

function admSettings() {
  const s = S.settings, now = NOW();
  return html`<form data-form="settings" novalidate>
    <div class="card"><h2 class="ch" style="margin-bottom:10px">Shop</h2><div class="two"><div class="field"><label for="st-name">Shop name</label><input id="st-name" name="shopName" value="${s.shopName}" maxlength="40"></div>
      <div class="field"><label for="st-hold">Hold time after a claim (hours)</label><input id="st-hold" name="holdHours" type="number" min="1" max="720" value="${s.holdHours}"></div></div>
      <label class="check"><input type="checkbox" name="shopOpen" ${s.shopOpen ? raw('checked') : ''}><span>Shop is open for new claims</span></label>
      <label class="check"><input type="checkbox" name="requireProof" ${s.requireProof ? raw('checked') : ''}><span>Buyers must attach a screenshot when they send payment details</span></label></div>
    <div class="card"><h2 class="ch" style="margin-bottom:10px">Look of the shop</h2>
      <div class="two"><div class="field"><label for="st-accent">Main colour</label><div class="row"><input id="st-accent" name="accentColor" type="color" value="${Core.HEX6.test(s.accentColor || '') ? s.accentColor : Core.DEFAULT_ACCENT}" data-input="accent" style="width:64px;height:40px;padding:3px"><button type="button" class="btn sm" data-act="accent-reset">Back to sky blue</button></div><div class="hint">Buttons, tabs and highlights. Text colours adjust themselves so everything stays readable.</div></div>
        <div class="field"><label for="st-tag">Tagline (under the shop name)</label><input id="st-tag" name="tagline" value="${s.tagline || ''}" maxlength="80"></div></div>
      <div class="field"><label for="st-notice">Announcement banner (optional)</label><input id="st-notice" name="notice" value="${s.notice || ''}" maxlength="200"><div class="hint">Shown at the top of the shop page, for example “Orders close Sunday 9pm ET.” Leave it empty to hide it.</div></div></div>
    <div class="card"><h2 class="ch" style="margin-bottom:10px">Matching and limits</h2><div class="two"><div class="field"><label for="st-tol">Treat amounts within this much as a near match ($)</label><input id="st-tol" name="tol" inputmode="decimal" value="${(s.nearTolCents / 100).toFixed(2)}"><div class="hint">Covers small fee differences on Wise or PayPal.</div></div>
      <div class="field"><label for="st-unpaid">Most unpaid claims one buyer can hold</label><input id="st-unpaid" name="maxOpenUnpaidOrders" type="number" min="1" max="50" value="${s.maxOpenUnpaidOrders}"></div></div>
      <div class="field"><label for="st-pend">Most payments one buyer can have in review at once</label><input id="st-pend" name="maxPendingPayments" type="number" min="1" max="50" value="${s.maxPendingPayments}" style="max-width:120px"></div></div>
    <div class="card"><h2 class="ch" style="margin-bottom:10px">Payment methods buyers see</h2>${s.methods.map(m => html`<div class="field" style="border-bottom:1px solid var(--line);padding-bottom:12px"><label class="check" style="padding-top:0"><input type="checkbox" name="m-on-${m.key}" ${m.enabled ? raw('checked') : ''}><b>${m.label}</b></label><div class="two"><div><label class="small" for="m-h-${m.key}">Your handle, email or phone</label><input class="inp" id="m-h-${m.key}" name="m-h-${m.key}" value="${m.handle}"></div><div><label class="small" for="m-t-${m.key}">Instructions for the buyer</label><input class="inp" id="m-t-${m.key}" name="m-t-${m.key}" value="${m.hint}"></div></div></div>`)}</div>
    <div class="err" id="st-err" role="alert" hidden></div><button class="btn primary">Save settings</button></form>
    ${DEMO ? '' : html`<div class="card" style="margin-top:18px"><h2 class="ch" style="margin-bottom:6px">Backup</h2><p class="small muted" style="margin-bottom:10px">Download everything (catalog, orders, payments, buyers) as one file. The free database plan has no automatic backups, so do this now and then.</p><button type="button" class="btn sm" data-act="export">Download backup (JSON)</button></div>`}
    ${DEMO ? html`<div class="card" style="margin-top:18px"><h2 class="ch" style="margin-bottom:6px">Demo tools</h2><p class="small muted" style="margin-bottom:10px">The shop’s clock reads <b>${dt(now)}</b>${S.clockOffsetMs ? html` (${Math.round(S.clockOffsetMs / Core.HOUR)}h ahead)` : ''}. Jump forward to see holds expire.</p><div class="row"><button type="button" class="btn sm" data-act="warp" data-h="6">+6 hours</button><button type="button" class="btn sm" data-act="warp" data-h="24">+24 hours</button><button type="button" class="btn sm" data-act="selfcheck">Check the books balance</button><button type="button" class="btn sm" data-act="export">Download data (JSON)</button><button type="button" class="btn sm danger" data-act="reset-demo">Reset demo data</button></div></div>` : ''}`;
}
const ADMIN = { dashboard: admDashboard, reconcile: admReconcile, orders: admOrders, catalog: admCatalog, buyers: admBuyers, settings: admSettings };
const VIEWS = { shop: viewShop, checkout: viewCheckout, orders: viewOrders, pay: viewPay, rules: viewRules, admin: viewAdmin, seller: viewSeller };

/* ======================= MODALS ======================= */
const MODALS = {
  product: modalProduct,
  confirm: m => html`<div class="shead"><h2 class="grow">${m.title}</h2>${closeBtn}</div><div style="margin-bottom:16px">${m.body}</div><div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-act="close-modal">Cancel</button><button type="button" class="btn ${m.danger ? 'danger' : 'primary'}" data-act="confirm-yes" autofocus>${m.ok}</button></div>`,
  proof: m => { const p = Core.byId(S.payments, m.id); return html`<div class="shead"><h2 class="grow">Screenshot from @${p ? p.username : ''}</h2>${closeBtn}</div>${p && p.proof ? html`<img class="thumb lg" src="${safeUrl(p.proof.dataUrl)}" alt="Payment screenshot"><p class="small muted" style="margin-top:8px">${p.proof.name}${p.proof.sample ? ' (sample image)' : ''}. This is only what the buyer says happened. Check your own account before confirming.</p>` : html`<p>No screenshot.</p>`}`; },
  confirmpay: m => {
    const p = Core.byId(S.payments, m.id); if (!p) return html`<p>Payment not found.</p>`;
    const free = S.incoming.filter(t => t.status === 'unmatched');
    const t = m.incomingId ? Core.byId(S.incoming, m.incomingId) : null;
    const amt = Core.parseMoney(m.amountText);
    let preview = '', perr = '';
    try {
      if (Number.isNaN(amt)) throw new Core.AppError('bad_amount', 'Enter the amount you received, like 23.00.');
      const pv = Core.previewConfirm(S, { paymentId: p.id, incomingId: m.incomingId || null, amountCents: amt, manualVerified: m.manual, autoApply: m.autoApply }, NOW());
      preview = html`<div class="note teal"><b>This will:</b><ul style="margin:4px 0 0 18px">${pv.allocated.map(x => html`<li>Put ${money(x.cents)} on order #${x.orderNo}${x.fullyPaid ? ' (paid in full)' : ' (still part unpaid)'}</li>`)}${pv.creditCents ? html`<li>Keep ${money(pv.creditCents)} as credit for @${p.username}</li>` : ''}${pv.allocated.length || pv.creditCents ? '' : html`<li>Nothing</li>`}</ul></div>`;
    } catch (e) { perr = errMsg(e); }
    return html`<div class="shead"><div class="grow"><div class="small muted">Payment #${p.no}</div><h2>Confirm ${money(p.amountCents)} from @${p.username}</h2></div>${closeBtn}</div>
      <div class="field"><label for="cp-in">Which transfer in your feed is this?</label><select id="cp-in" data-change="cp-in" data-fk="cp-in"><option value="">None, I checked my account myself</option>${free.map(x => html`<option value="${x.id}" ${x.id === m.incomingId ? raw('selected') : ''}>${money(x.amountCents)} ${x.method}, ${x.senderName || 'unknown'}, ${ago(x.occurredAt)}${x.extId ? ', ' + x.extId : ''}</option>`)}</select></div>
      ${t ? incomingLine(t) : html`<label class="check"><input type="checkbox" data-change="cp-manual" data-fk="cp-manual" ${m.manual ? raw('checked') : ''}><span>I opened my own payment account and can see this payment there.</span></label>`}
      <div class="field" style="margin-top:10px"><label for="cp-amt">Amount you actually received</label><div class="affix"><span>$</span><input id="cp-amt" data-input="cp-amt" data-change="cp-amt" data-fk="cp-amt" value="${m.amountText}" inputmode="decimal"></div><div class="hint">Your account is the truth. If the buyer typed a different amount, use yours.</div></div>
      <label class="check"><input type="checkbox" data-change="cp-auto" data-fk="cp-auto" ${m.autoApply ? raw('checked') : ''}><span>If they sent more than they owe on these orders, use the extra on their other unpaid orders.</span></label>
      ${perr ? html`<div class="err" role="alert">${perr}</div>` : preview}
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button type="button" class="btn" data-act="close-modal">Cancel</button><button type="button" class="btn primary" data-act="confirm-pay-go" ${perr ? raw('disabled') : ''}>Confirm payment</button></div>`;
  },
  rejectpay: m => { const p = Core.byId(S.payments, m.id); return html`<div class="shead"><h2 class="grow">Reject payment #${p ? p.no : ''}</h2>${closeBtn}</div><form data-form="reject"><div class="field"><label for="rj-why">Reason (the buyer will see this)</label><select id="rj-why" name="why"><option>I can’t find this payment in my account</option><option>The amount doesn’t match</option><option>The screenshot is unreadable</option><option>This screenshot was already used</option><option value="">Other (write below)</option></select></div><div class="field"><label for="rj-note">Add a note <span class="muted">(optional)</span></label><input id="rj-note" name="note" maxlength="120"></div><p class="hint" style="margin-bottom:12px">Their claim stays on hold for ${Core.REJECT_GRACE_H} more hours so they can send it again.</p><div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-act="close-modal">Cancel</button><button class="btn danger">Reject payment</button></div></form>`; },
  import: m => html`<div class="shead"><div class="grow"><h2>Import money you received</h2><p class="small muted">Paste or load an export from PayPal, Venmo or your bank. Outgoing and unfinished rows are skipped, and anything already imported is ignored.</p></div>${closeBtn}</div>
    <form data-form="import"><div class="field"><label for="im-m">If a row doesn’t say which app it came from</label><select id="im-m" name="method">${S.settings.methods.filter(x => x.key !== 'other').map(x => html`<option value="${x.key}" ${x.key === (m.method || 'paypal') ? raw('selected') : ''}>${x.label}</option>`)}</select></div>
      <div class="field"><label for="im-t">Export text (CSV)</label><textarea id="im-t" name="text" rows="7" spellcheck="false" placeholder="Date,Name,Amount,Transaction ID">${m.text || ''}</textarea><div class="row" style="margin-top:6px"><label class="btn sm" style="cursor:pointer">Load a file<input type="file" accept=".csv,.tsv,.txt,text/csv" data-change="feedfile" style="display:none"></label>${DEMO ? html`<button type="button" class="btn sm ghost" data-act="sample-feed">Fill with a sample export</button>` : ''}</div></div>
      ${m.preview ? html`<div class="note ${m.preview.items.length ? 'teal' : 'amber'}"><b>${m.preview.items.length} transfer${m.preview.items.length === 1 ? '' : 's'} ready to add.</b>${m.preview.errors.length ? html`<ul style="margin:4px 0 0 18px">${m.preview.errors.slice(0, 6).map(e => html`<li>Line ${e.line}: ${e.why}</li>`)}${m.preview.errors.length > 6 ? html`<li>…and ${m.preview.errors.length - 6} more</li>` : ''}</ul>` : ''}</div>` : ''}
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button type="button" class="btn" data-act="close-modal">Cancel</button><button type="submit" class="btn ${m.preview && m.preview.items.length ? '' : 'primary'}" name="go" value="preview">Preview</button>${m.preview && m.preview.items.length ? html`<button type="submit" class="btn primary" name="go" value="add">Add ${m.preview.items.length}</button>` : ''}</div></form>`,
  addin: m => html`<div class="shead"><h2 class="grow">Add a transfer you received</h2>${closeBtn}</div><form data-form="addin" novalidate><div class="two"><div class="field"><label for="ai-m">App</label><select id="ai-m" name="method">${S.settings.methods.filter(x => x.key !== 'other').map(x => html`<option value="${x.key}">${x.label}</option>`)}</select></div><div class="field"><label for="ai-a">Amount</label><div class="affix"><span>$</span><input id="ai-a" name="amount" inputmode="decimal" required></div></div></div>
    <div class="two"><div class="field"><label for="ai-n">Sender name</label><input id="ai-n" name="name"></div><div class="field"><label for="ai-t">Transaction ID <span class="muted">(if any)</span></label><input id="ai-t" name="txn"></div></div>
    <div class="field"><label for="ai-w">When</label><input id="ai-w" name="when" type="datetime-local" value="${localInput(NOW())}"></div><div class="err" id="ai-err" role="alert" hidden></div><div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-act="close-modal">Cancel</button><button class="btn primary">Add to feed</button></div></form>`,
  assign: m => {
    const t = Core.byId(S.incoming, m.id); if (!t) return html`<p>Transfer not found.</p>`;
    let u = ''; try { u = Core.normUser(m.user || ''); } catch (e) { u = ''; }
    const orders = u ? S.orders.filter(o => o.username === u && o.status === 'open' && Core.orderDue(S, o) > 0) : [];
    return html`<div class="shead"><h2 class="grow">Assign ${money(t.amountCents)} to a buyer</h2>${closeBtn}</div>${incomingLine(t)}
      <form data-form="assign" novalidate style="margin-top:12px"><div class="field"><label for="as-u">Buyer’s Instagram username</label><div class="affix"><span>@</span><input id="as-u" name="user" value="${m.user || ''}" data-change="as-user" data-fk="as-u" autocapitalize="none" required></div></div>
      ${u ? (orders.length ? html`<div class="lbl">Pay these orders</div>${orders.map(o => html`<label class="check"><input type="checkbox" name="ord" value="${o.id}" ${(m.orderIds || orders.map(x => x.id)).includes(o.id) ? raw('checked') : ''}><span class="grow"><b>#${o.no}</b> <span class="muted">${o.lines.map(l => l.qty + '× ' + l.name).join(', ')}</span></span><b>${money(Core.orderDue(S, o))}</b></label>`)}` : html`<div class="note">@${u} has nothing unpaid. The whole amount will be kept as credit.</div>`) : ''}
      <div class="err" id="as-err" role="alert" hidden></div><div class="row" style="justify-content:flex-end;margin-top:14px"><button type="button" class="btn" data-act="close-modal">Cancel</button><button class="btn primary">Assign money</button></div></form>`;
  },
  order: m => {
    const o = Core.byId(S.orders, m.id); if (!o) return html`<p>Order not found.</p>`;
    const paid = Core.orderPaid(S, o.id), due = Core.orderDue(S, o), pend = Core.orderPending(S, o.id), ps = Core.orderPayState(S, o);
    const allocs = S.allocations.filter(a => a.orderId === o.id).map(a => ({ a, p: Core.byId(S.payments, a.paymentId) }));
    return html`<div class="shead"><div class="grow"><div class="small muted">@${o.username}</div><h2>Order #${o.no}</h2><div class="row" style="margin-top:6px">${orderChips({ ...o, payState: ps, pending: pend })}</div></div>${closeBtn}</div>
      ${o.lines.map(l => html`<div class="oline"><div class="grow">${l.name}${l.variantName ? ' (' + l.variantName + ')' : ''}</div><div class="muted">${l.qty} × ${money(l.unitCents)}</div><b style="width:68px;text-align:right">${money(l.qty * l.unitCents)}</b></div>`)}
      <div class="ototals" style="border-radius:10px;margin:8px 0"><span>Total</span><b style="text-align:right">${money(Core.orderTotal(o))}</b><span>Paid</span><span style="text-align:right">${money(paid)}</span><span class="big">Due</span><span class="big" style="text-align:right">${money(due)}</span></div>
      ${allocs.length ? html`<div class="small" style="margin-bottom:8px"><b>Money on this order</b>${allocs.map(({ a, p }) => html`<div>${money(a.amountCents)} from payment #${p ? p.no : '?'} (${p ? p.status : ''}${p && p.verifiedManually ? ', checked by hand' : ''})</div>`)}</div>` : ''}
      ${o.status === 'open' ? html`<hr class="div">
        <div class="field"><label for="om-ship">Shipping fee</label><div class="row" style="flex-wrap:nowrap"><div class="affix grow"><span>$</span><input id="om-ship" value="${((o.shippingFeeCents || 0) / 100).toFixed(2)}" inputmode="decimal"></div><button type="button" class="btn" data-act="save-ship" data-id="${o.id}">Save</button></div><div class="hint">Added to what the buyer owes. If they’ve already paid, the new balance shows up on their order.</div></div>
        ${paid === 0 && pend === 0 ? html`<div class="row" style="margin-bottom:12px"><span class="small">Hold ends ${dt(o.holdExpiresAt)}</span><button type="button" class="btn sm" data-act="extend" data-id="${o.id}">Add 24 hours</button></div>` : ''}
        <div class="field"><label for="om-track">Tracking number</label><input id="om-track" value="${o.tracking || ''}" maxlength="80"></div>
        <div class="row">${['pending', 'packed', 'shipped'].map(k => html`<button type="button" class="btn sm ${o.fulfillment === k ? 'primary' : ''}" data-act="fulfil" data-id="${o.id}" data-to="${k}" ${k !== 'pending' && due > 0 ? raw('disabled title="Not fully paid yet"') : ''}>${{ pending: 'Not packed', packed: 'Packed', shipped: 'Shipped' }[k]}</button>`)}</div>
        <hr class="div"><div class="row"><button type="button" class="btn sm" data-act="manual-pay" data-id="${o.id}" ${due > 0 ? '' : raw('disabled')}>Record cash or other payment</button><button type="button" class="btn sm danger right" data-act="cancel-admin" data-id="${o.id}">Cancel order and restock</button></div>` : html`<div class="note">${o.cancelReason || 'Closed'}</div>`}`;
  },
  manualpay: m => { const o = Core.byId(S.orders, m.id); return html`<div class="shead"><h2 class="grow">Record a payment for #${o ? o.no : ''}</h2>${closeBtn}</div><form data-form="manualpay" novalidate><div class="two"><div class="field"><label for="mp-a">Amount received</label><div class="affix"><span>$</span><input id="mp-a" name="amount" inputmode="decimal" value="${o ? (Core.orderDue(S, o) / 100).toFixed(2) : ''}"></div></div><div class="field"><label for="mp-m">How</label><select id="mp-m" name="method">${S.settings.methods.map(x => html`<option value="${x.key}" ${x.key === 'other' ? raw('selected') : ''}>${x.label}</option>`)}</select></div></div><div class="field"><label for="mp-n">Note</label><input id="mp-n" name="note" maxlength="120" placeholder="Cash at pickup"></div><div class="err" id="mp-err" role="alert" hidden></div><div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-act="close-modal">Cancel</button><button class="btn primary">Record payment</button></div></form>`; },
  group: m => { const g = m.id ? Core.byId(S.groups, m.id) : null; return html`<div class="shead"><h2 class="grow">${g ? 'Edit group' : 'New group'}</h2>${closeBtn}</div><form data-form="group" novalidate><div class="two"><div class="field"><label for="gp-n">Name</label><input id="gp-n" name="name" value="${g ? g.name : ''}" required></div><div class="field"><label for="gp-c">Colour</label><input id="gp-c" name="color" type="color" value="${g ? g.color : '#5BAFD6'}" style="height:40px;padding:3px"></div></div>
    <div class="field"><label for="gp-m">Members <span class="muted">(one per line, used to fill in variants)</span></label><textarea id="gp-m" name="members" rows="5">${g ? g.members.join('\n') : ''}</textarea></div>${g ? html`<label class="check"><input type="checkbox" name="active" ${g.active ? raw('checked') : ''}><span>Show this group in the shop</span></label>` : ''}<div class="err" id="gp-err" role="alert" hidden></div><div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-act="close-modal">Cancel</button><button class="btn primary">Save group</button></div></form>`; },
  product: undefined,
  editproduct: m => {
    const p = m.id ? Core.byId(S.products, m.id) : null;
    const vs = p ? Core.productVariants(S, p.id).sort(byPos) : [];
    const vtext = p ? (vs.length === 1 && vs[0].name === '' ? String(vs[0].stock) : vs.map(v => v.name + ' | ' + v.stock + (v.priceCents != null ? ' | ' + (v.priceCents / 100).toFixed(2) : '')).join('\n')) : '';
    const sel = (n, opts, cur) => html`<select name="${n}" id="pe-${n}">${opts.map(([k, l]) => html`<option value="${k}" ${k === cur ? raw('selected') : ''}>${l}</option>`)}</select>`;
    return html`<div class="shead"><h2 class="grow">${p ? 'Edit product' : 'New product'}</h2>${closeBtn}</div><form data-form="product" novalidate>
      <div class="two"><div class="field"><label for="pe-groupId">Group</label>${sel('groupId', S.groups.map(g => [g.id, g.name]), p ? p.groupId : (S.groups[0] || {}).id)}</div><div class="field"><label for="pe-category">Type</label>${sel('category', [['photocard', 'Photocard'], ['album', 'Album'], ['merch', 'Merch'], ['other', 'Other']], p ? p.category : 'photocard')}</div></div>
      <div class="field"><label for="pe-name">Name</label><input id="pe-name" name="name" value="${p ? p.name : ''}" required></div>
      <div class="two"><div class="field"><label for="pe-price">Price</label><div class="affix"><span>$</span><input id="pe-price" name="price" inputmode="decimal" value="${p ? (p.priceCents / 100).toFixed(2) : ''}" required></div></div><div class="field"><label for="pe-max">Limit per person <span class="muted">(blank = none)</span></label><input id="pe-max" name="max" type="number" min="1" value="${p && p.maxPerUser ? p.maxPerUser : ''}"></div></div>
      <div class="field"><label for="pe-vars">Variants and stock</label><textarea id="pe-vars" name="variants" rows="6" spellcheck="false">${vtext}</textarea><div class="row" style="margin-top:6px"><button type="button" class="btn sm" data-act="fill-members">Fill from the group’s members</button></div><div class="hint">One per line: <span class="mono">Name | stock | price</span> (price only if different). No variants? Type just the stock number.</div></div>
      <div class="two"><div class="field"><label for="pe-availability">Availability</label>${sel('availability', [['in_stock', 'In stock now'], ['incoming', 'Pre-claim (not here yet)']], p ? p.availability : 'in_stock')}</div><div class="field"><label for="pe-payBy">Pay-by date <span class="muted">(pre-claim only)</span></label><input id="pe-payBy" name="payBy" type="date" value="${p && p.payBy ? localInput(p.payBy).slice(0, 10) : ''}"></div></div>
      <div class="two"><div class="field"><label for="pe-opens">Claims open at <span class="muted">(blank = now)</span></label><input id="pe-opens" name="opensAt" type="datetime-local" value="${p && p.opensAt ? localInput(p.opensAt) : ''}"></div><div class="field"><label for="pe-status">Visibility</label>${sel('status', [['active', 'Visible in the shop'], ['hidden', 'Hidden']], p ? p.status : 'active')}</div></div>
      <div class="field"><label for="pe-image">Image link <span class="muted">(optional, https)</span></label><input id="pe-image" name="imageUrl" value="${p ? p.imageUrl || '' : ''}" placeholder="https://"></div>
      <div class="field"><label for="pe-desc">Description</label><textarea id="pe-desc" name="description" rows="2">${p ? p.description : ''}</textarea></div>
      <div class="err" id="pe-err" role="alert" hidden></div><div class="row"><button type="button" class="btn danger sm" data-act="delete-product" data-id="${p ? p.id : ''}" ${p ? '' : raw('hidden')}>Delete</button><span class="right row"><button type="button" class="btn" data-act="close-modal">Cancel</button><button class="btn primary">Save product</button></span></div></form>`;
  },
  merge: m => html`<div class="shead"><h2 class="grow">Merge @${m.from} into…</h2>${closeBtn}</div><form data-form="merge" novalidate><p class="small muted" style="margin-bottom:10px">Use this when someone claimed under a misspelled handle. Orders, payments and credit move to the handle you pick, and @${m.from} is removed.</p><div class="field"><label for="mg-to">Correct Instagram username</label><div class="affix"><span>@</span><input id="mg-to" name="to" autocapitalize="none" required></div></div><div class="err" id="mg-err" role="alert" hidden></div><div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-act="close-modal">Cancel</button><button class="btn primary">Merge</button></div></form>`,
};
delete MODALS.product_unused;
MODALS.product = modalProduct;

/* ======================= ACTIONS ======================= */
const showErr = (id, msg) => { const e = $('#' + id); if (e) { e.textContent = msg; e.hidden = !msg; } };
async function guard(fn, errId) {
  try { return await fn(); }
  catch (e) { if (!(e instanceof Core.AppError)) console.error(e); if (errId) showErr(errId, errMsg(e)); else toast(errMsg(e), true); return undefined; }
}
const pickPaymentTarget = (ids) => { ui.pay = null; payState().orderIds = ids; };

const ACT = {
  'backdrop': (el, ev) => { if (ev.target === el) closeModal(); },
  'close-modal': () => closeModal(),
  'goto': el => go(el.dataset.to),
  'reset-demo': async () => { if (await askConfirm({ title: 'Reset demo data?', body: 'This puts the sample shop back to how it started and clears everything you did.', ok: 'Reset', danger: true })) { await adm.resetDemo(); ui.cart = []; saveCart(); ui.session = null; ui.lastClaim = null; ui.pay = null; ui.choice = {}; closeModal(); toast('Demo data reset'); go('#/shop'); } },
  'confirm-yes': () => { const m = ui.modal; ui.modal = null; $('#modal').innerHTML = ''; document.body.style.overflow = ''; if (m && m.resolve) m.resolve(true); },

  /* shop */
  'group': el => { ui.group = el.dataset.id; render(); },
  'open-product': el => openModal({ type: 'product', id: el.dataset.id, variantId: null, qty: 1, label: 'Choose an option' }),
  'pick-variant': el => { ui.modal.variantId = el.dataset.id; ui.modal.qty = 1; renderModal(); },
  'qty': el => { ui.modal.qty += Number(el.dataset.d); renderModal(); },
  'add-cart': () => {
    const m = ui.modal, v = Core.byId(S.variants, m.variantId), p = v && Core.byId(S.products, v.productId); if (!v) return;
    const cap = Math.max(1, Math.min(v.stock, p.maxPerUser || 99)), ex = ui.cart.find(l => l.variantId === v.id);
    if (ex) ex.qty = Math.min(cap, ex.qty + m.qty); else ui.cart.push({ variantId: v.id, qty: m.qty });
    saveCart(); closeModal(); toast('Added to your claim list'); render();
  },
  'cart-qty': el => { const l = ui.cart.find(x => x.variantId === el.dataset.id), v = Core.byId(S.variants, el.dataset.id); if (!l || !v) return; l.qty = Math.max(1, Math.min(l.qty + Number(el.dataset.d), Math.max(v.stock, 1))); saveCart(); render(); },
  'cart-remove': el => { ui.cart = ui.cart.filter(l => l.variantId !== el.dataset.id); saveCart(); render(); },
  'pay-now': async () => { const ids = (await claimedOrders(ui.lastClaim)).filter(o => o.due > 0).map(o => o.id); ui.lastClaim = null; pickPaymentTarget(ids); go('#/pay'); },
  'keep-shopping': () => { ui.lastClaim = null; go('#/shop'); },

  /* my orders */
  'logout': () => { ui.session = null; ui.pay = null; render(); },
  'pay-all': () => { ui.pay = null; go('#/pay'); },
  'pay-ahead': () => { pickPaymentTarget([]); go('#/pay'); },
  'pay-order': el => { pickPaymentTarget([el.dataset.id]); go('#/pay'); },
  'cancel-mine': async el => {
    if (!await askConfirm({ title: 'Cancel this claim?', body: 'The items go back on sale for other people.', ok: 'Cancel claim', danger: true })) return;
    await guard(async () => { await api.cancelMyOrder({ ...ui.session, orderId: el.dataset.id }); toast('Claim cancelled'); render(); });
  },
  'pick-method': el => { capturePay(); payState().method = el.dataset.key; render(); },
  'copy': async el => { try { await navigator.clipboard.writeText(el.dataset.text); toast('Copied'); } catch (e) { toast('Select the text and copy it'); } },
  'view-proof': el => openModal({ type: 'proof', id: el.dataset.id, label: 'Payment screenshot', wide: true }),

  /* seller */
  'admin-in': () => { ui.admin = true; store.set('shopmgr.admin', '1'); go('#/admin'); },       // preview and demo only: the live shop needs a real sign-in
  'admin-out': async () => { if (LIVE.on) await guard(() => LIVE.signOut()); ui.admin = false; store.del('shopmgr.admin'); go('#/shop'); },
  'retry': () => render(),
  'accent-reset': () => { const i = $('#st-accent'); if (i) { i.value = Core.DEFAULT_ACCENT; applyTheme(i.value); } },
  'ofilter': el => { ui.ofilter = el.dataset.k; render(); },
  'confirm-pay': el => { const sug = Core.suggestMatches(S, NOW())[el.dataset.id]; const id = el.dataset.id; const p = Core.byId(S.payments, id); const chosen = id in ui.choice ? ui.choice[id] : (sug && sug.incomingId); const t = chosen && Core.byId(S.incoming, chosen); openModal({ type: 'confirmpay', id, incomingId: chosen || '', amountText: ((t ? t.amountCents : p.amountCents) / 100).toFixed(2), manual: false, autoApply: true, label: 'Confirm payment' }); },
  'confirm-pay-go': () => guard(async () => { const m = ui.modal; const r = await adm.confirmPayment({ paymentId: m.id, incomingId: m.incomingId || null, amountCents: Core.parseMoney(m.amountText), manualVerified: m.manual, autoApply: m.autoApply }); closeModal(); delete ui.choice[m.id]; toast('Payment confirmed' + (r.creditCents ? ` (${money(r.creditCents)} kept as credit)` : '')); render(); }),
  'reject-pay': el => openModal({ type: 'rejectpay', id: el.dataset.id, label: 'Reject payment' }),
  'confirm-exact': async () => {
    const sugs = Core.suggestMatches(S, NOW());
    const list = S.payments.filter(p => p.status === 'submitted' && sugs[p.id].level === 'exact' && !(p.id in ui.choice));
    if (!await askConfirm({ title: `Confirm ${list.length} exact match${list.length === 1 ? '' : 'es'}?`, body: html`<p>Each of these has the same transaction ID and amount as a transfer in your feed:</p><ul style="margin:6px 0 0 18px">${list.map(p => html`<li>@${p.username}, ${money(p.amountCents)} ${p.method}</li>`)}</ul>`, ok: 'Confirm all' })) return;
    let n = 0;
    for (const p of list) { try { await adm.confirmPayment({ paymentId: p.id, incomingId: sugs[p.id].incomingId }); n++; } catch (e) { toast(errMsg(e), true); } }
    toast(`Confirmed ${n} payment${n === 1 ? '' : 's'}`); render();
  },
  'open-import': () => openModal({ type: 'import', method: 'paypal', text: '', preview: null, label: 'Import money received', wide: true }),
  'sample-feed': () => { const f = $('[data-form=import]'); ui.modal.text = sampleFeedText(NOW()); ui.modal.method = f.elements.method.value; ui.modal.preview = null; renderModal(); },
  'open-addin': () => openModal({ type: 'addin', label: 'Add a transfer' }),
  'assign-quick': el => guard(async () => { const t = Core.byId(S.incoming, el.dataset.id); const sg = Core.suggestBuyersForIncoming(S, t).find(x => x.username === el.dataset.user); const r = await adm.assignIncoming({ incomingId: t.id, username: el.dataset.user, orderIds: sg ? sg.orderIds : [] }); toast(`Assigned to @${el.dataset.user}` + (r.creditCents ? ` (${money(r.creditCents)} credit)` : '')); render(); }),
  'assign-open': el => openModal({ type: 'assign', id: el.dataset.id, user: '', label: 'Assign money' }),
  'ignore-in': el => guard(async () => { await adm.ignoreIncoming({ incomingId: el.dataset.id }); toast('Ignored'); render(); }),
  'open-order': el => openModal({ type: 'order', id: el.dataset.id, label: 'Order', wide: true }),
  'save-ship': el => guard(async () => { const c = Core.parseMoney($('#om-ship').value || '0'); if (Number.isNaN(c)) throw new Core.AppError('bad_amount', 'Enter the shipping fee like 3.80.'); const r = await adm.setShippingFee({ orderId: el.dataset.id, cents: c }); toast('Shipping fee saved' + (r.returnedToCreditCents ? ` (${money(r.returnedToCreditCents)} back to credit)` : '')); renderModal(); render(); }),
  'extend': el => guard(async () => { await adm.extendHold({ orderId: el.dataset.id, hours: 24 }); toast('Hold extended by 24 hours'); renderModal(); render(); }),
  'fulfil': el => guard(async () => { await adm.setFulfillment({ orderId: el.dataset.id, to: el.dataset.to, tracking: ($('#om-track') || {}).value || '' }); toast('Order updated'); renderModal(); render(); }),
  'manual-pay': el => openModal({ type: 'manualpay', id: el.dataset.id, label: 'Record a payment' }),
  'cancel-admin': async el => { if (!await askConfirm({ title: 'Cancel this order?', body: 'The items go back into stock. Any money already paid on it becomes credit for the buyer.', ok: 'Cancel order', danger: true })) return; await guard(async () => { await adm.cancelOrder({ orderId: el.dataset.id }); toast('Order cancelled'); render(); }); },
  'edit-group': el => openModal({ type: 'group', id: el.dataset.id, label: 'Group' }),
  'edit-product': el => openModal({ type: 'editproduct', id: el.dataset.id, label: 'Product', wide: true }),
  'fill-members': () => { const f = $('[data-form=product]'), g = Core.byId(S.groups, f.elements.groupId.value); if (g) f.elements.variants.value = g.members.map(m => m + ' | 3').join('\n'); },
  'delete-product': async el => { if (!await askConfirm({ title: 'Delete this product?', body: 'This can’t be undone. Products that already have orders can only be hidden.', ok: 'Delete', danger: true })) return; await guard(async () => { await adm.deleteProduct(el.dataset.id); closeModal(); toast('Product deleted'); render(); }); },
  'reset-pass': async el => { if (!await askConfirm({ title: `Reset @${el.dataset.u}’s passcode?`, body: 'They will create a new one the next time they claim.', ok: 'Reset passcode' })) return; await guard(async () => { await adm.resetPasscode(el.dataset.u); toast('Passcode reset'); render(); }); },
  'toggle-block': el => guard(async () => { const b = !(S.buyers[el.dataset.u] || {}).blocked; await adm.setBlocked({ username: el.dataset.u, blocked: b }); toast(b ? 'Blocked from new claims' : 'Unblocked'); render(); }),
  'merge-open': el => openModal({ type: 'merge', from: el.dataset.u, label: 'Merge buyers' }),
  'warp': el => guard(async () => { const n = await adm.timeTravel(Number(el.dataset.h)); toast(`Moved ${el.dataset.h} hours ahead` + (n ? `, ${n} hold${n === 1 ? '' : 's'} released` : '')); render(); }),
  'selfcheck': () => { const bad = Core.checkInvariants(S); toast(bad.length ? 'Problems: ' + bad.join('; ') : 'The books balance: money and stock all add up', !!bad.length); },
  'export': () => guard(async () => { const text = await adm.exportJson(); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = DEMO ? 'shop-manager-demo.json' : 'shop-backup-' + new Date().toISOString().slice(0, 10) + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }),
};

/* ---------- screenshot handling: resize before storing/uploading, hash the original for duplicate checks ---------- */
async function sha256File(buf) {
  if (globalThis.crypto && crypto.subtle) { const d = await crypto.subtle.digest('SHA-256', buf); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); }
  return Core.sha256Hex(String.fromCharCode(...new Uint8Array(buf).slice(0, 4096)) + buf.byteLength);
}
async function compressImage(file) {
  if (!/^image\//.test(file.type)) throw new Core.AppError('bad_file', 'Please choose an image (a screenshot).');
  if (file.size > 15 * 1024 * 1024) throw new Core.AppError('bad_file', 'That file is over 15 MB. Take a fresh screenshot instead.');
  const buf = await file.arrayBuffer(), sha = await sha256File(buf);
  let bmp;
  try { bmp = await createImageBitmap(new Blob([buf], { type: file.type })); }
  catch (e) { throw new Core.AppError('bad_file', 'That image format can’t be read here. Try a PNG or JPG screenshot.'); }
  const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height);
  const dataUrl = c.toDataURL('image/jpeg', 0.72);
  return { dataUrl, sha256: sha, name: String(file.name || 'screenshot').slice(0, 60), bytes: Math.round(dataUrl.length * 3 / 4) };
}

/* ---------- forms ---------- */
const FORMS = {
  signin: f => guard(async () => { await LIVE.signIn(f.email.value, f.password.value); ui.admin = true; go('#/admin'); }, 'sl-err'),
  login: async f => {
    ui.user = f.user.value.trim().replace(/^@/, '');
    try {
      const r = await api.login({ username: f.user.value, passcode: f.pass.value });
      ui.session = { username: r.username, passcode: f.pass.value }; ui.user = r.username; store.set('shopmgr.user', r.username); ui.loginErr = '';
      await render();
    } catch (e) {
      if (!(e instanceof Core.AppError)) console.error(e);
      ui.session = null; ui.loginErr = errMsg(e);
      await render(); const pw = $('#lg-pass'); if (pw) pw.focus();
    }
  },
  checkout: f => guard(async () => {
    const ls = cartLines();
    const r = await api.placeOrder({ username: f.user.value, passcode: f.pass.value, lines: ls.map(l => ({ variantId: l.variant.id, qty: l.qty })) });
    const u = Core.normUser(f.user.value);
    ui.session = { username: u, passcode: f.pass.value }; ui.user = u; store.set('shopmgr.user', u);
    ui.cart = []; saveCart(); ui.lastClaim = r; render(); window.scrollTo(0, 0);
  }, 'co-err'),
  pay: f => guard(async () => {
    capturePay();
    const P = ui.pay, amountCents = Core.parseMoney(P.amountText);
    if (Number.isNaN(amountCents)) throw new Core.AppError('bad_amount', 'Enter the amount you sent, like 23.00.');
    const r = await api.submitPayment({ ...ui.session, method: P.method, amountCents, txnId: P.txn, senderName: P.name, paidAt: P.when ? Date.parse(P.when) : null, proof: P.proof, orderIds: P.orderIds || [] });
    ui.paid = { amountCents, method: (Core.methodOf(S, P.method) || {}).label || P.method, no: r.no }; ui.paidFresh = true; ui.pay = null; render(); window.scrollTo(0, 0);
  }, 'pay-err'),
  reject: f => guard(async () => { const why = [f.why.value, f.note.value.trim()].filter(Boolean).join(': '); await adm.rejectPayment({ paymentId: ui.modal.id, reason: why }); closeModal(); toast('Payment rejected'); render(); }),
  import: f => guard(async () => {
    const m = ui.modal; m.text = f.text.value; m.method = f.method.value;
    const res = Core.parseFeed(m.text, { defaultMethod: m.method, now: NOW() });
    const go2 = (f.querySelector('button[type=submit]:focus') || {}).value || (ev0 && ev0.submitter && ev0.submitter.value);
    if (go2 === 'add' && res.items.length) { const r = await adm.addIncoming(res.items); closeModal(); toast(`Added ${r.added} transfer${r.added === 1 ? '' : 's'}` + (r.skipped ? `, ${r.skipped} already there` : '')); render(); }
    else { m.preview = res; renderModal(); }
  }),
  addin: f => guard(async () => {
    const a = Core.parseMoney(f.amount.value); if (Number.isNaN(a) || a <= 0) throw new Core.AppError('bad_amount', 'Enter the amount, like 23.00.');
    const r = await adm.addIncoming([{ method: f.method.value, amountCents: a, senderName: f.name.value, extId: f.txn.value, occurredAt: f.when.value ? Date.parse(f.when.value) : NOW() }]);
    if (!r.added) throw new Core.AppError('dup', 'That transaction ID is already in your feed.');
    closeModal(); toast('Added to your feed'); render();
  }, 'ai-err'),
  assign: f => guard(async () => {
    const ids = $$('input[name=ord]:checked', f).map(x => x.value);
    const r = await adm.assignIncoming({ incomingId: ui.modal.id, username: f.user.value, orderIds: ids });
    closeModal(); toast('Assigned' + (r.creditCents ? ` (${money(r.creditCents)} kept as credit)` : '')); render();
  }, 'as-err'),
  manualpay: f => guard(async () => {
    const a = Core.parseMoney(f.amount.value); if (Number.isNaN(a) || a <= 0) throw new Core.AppError('bad_amount', 'Enter the amount, like 23.00.');
    const o = Core.byId(S.orders, ui.modal.id);
    await adm.recordManualPayment({ username: o.username, method: f.method.value, amountCents: a, note: f.note.value, orderIds: [o.id] });
    ui.modal = { type: 'order', id: o.id, label: 'Order', wide: true }; renderModal(); toast('Payment recorded'); render();
  }, 'mp-err'),
  group: f => guard(async () => {
    await adm.upsertGroup({ id: ui.modal.id || undefined, name: f.name.value, color: f.color.value, members: f.members.value.split('\n'), active: f.active ? f.active.checked : true });
    closeModal(); toast('Group saved'); render();
  }, 'gp-err'),
  product: f => guard(async () => {
    const existing = ui.modal.id ? Core.productVariants(S, ui.modal.id) : [];
    const price = Core.parseMoney(f.price.value); if (Number.isNaN(price)) throw new Core.AppError('bad_input', 'Enter the price like 18.00.');
    const lines = f.variants.value.split('\n').map(l => l.trim()).filter(Boolean);
    let variants;
    if (lines.length === 1 && /^\d+$/.test(lines[0])) { const ex = existing.find(v => v.name === ''); variants = [{ id: ex && ex.id, name: '', stock: parseInt(lines[0], 10), priceCents: null }]; }
    else variants = lines.map(l => {
      const [n, st, pr] = l.split('|').map(x => x.trim());
      const stock = st === undefined || st === '' ? NaN : Number(st);
      if (!n || !Number.isInteger(stock) || stock < 0) throw new Core.AppError('bad_input', `“${l}” needs a name and a stock count, like  Hana | 5`);
      const pc = pr ? Core.parseMoney(pr) : null; if (pr && Number.isNaN(pc)) throw new Core.AppError('bad_input', `“${l}” has a price that isn’t a number.`);
      const ex = existing.find(v => v.name.toLowerCase() === n.toLowerCase());
      return { id: ex && ex.id, name: n, stock, priceCents: pc };
    });
    if (f.imageUrl.value.trim() && !safeUrl(f.imageUrl.value.trim())) throw new Core.AppError('bad_input', 'The image link must start with https://');
    await adm.upsertProduct({ id: ui.modal.id || undefined, groupId: f.groupId.value, name: f.name.value, category: f.category.value, priceCents: price, availability: f.availability.value,
      payBy: f.payBy.value ? Date.parse(f.payBy.value + 'T23:59:00') : null, opensAt: f.opensAt.value ? Date.parse(f.opensAt.value) : null, maxPerUser: f.max.value ? Number(f.max.value) : null,
      status: f.status.value, imageUrl: f.imageUrl.value.trim(), description: f.description.value, variants });
    closeModal(); toast('Product saved'); render();
  }, 'pe-err'),
  merge: f => guard(async () => { await adm.mergeBuyer({ from: ui.modal.from, to: f.to.value }); closeModal(); toast('Buyers merged'); render(); }, 'mg-err'),
  settings: f => guard(async () => {
    const tol = Core.parseMoney(f.tol.value); if (Number.isNaN(tol)) throw new Core.AppError('bad_input', 'Near-match amount should look like 1.00.');
    await adm.saveSettings({ shopName: f.shopName.value, holdHours: Number(f.holdHours.value), shopOpen: f.shopOpen.checked, requireProof: f.requireProof.checked, nearTolCents: tol,
      maxOpenUnpaidOrders: Number(f.maxOpenUnpaidOrders.value), maxPendingPayments: Number(f.maxPendingPayments.value),
      accentColor: f.accentColor.value, tagline: f.tagline.value, notice: f.notice.value,
      methods: S.settings.methods.map(m => ({ key: m.key, enabled: f['m-on-' + m.key].checked, handle: f['m-h-' + m.key].value, hint: f['m-t-' + m.key].value })) });
    toast('Settings saved'); render();
  }, 'st-err'),
};
let ev0 = null;

/* ---------- event wiring (one listener per event type) ---------- */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act]; if (fn) { ev0 = e; Promise.resolve(fn(el, e)).catch(err => { console.error(err); toast(errMsg(err), true); }); }
});
document.addEventListener('submit', e => {
  const f = e.target.closest('form[data-form]'); if (!f) return; e.preventDefault(); ev0 = e;
  const fn = FORMS[f.dataset.form]; if (fn) fn(f);
});
let statusTimer = 0;
document.addEventListener('input', e => {
  const t = e.target, k = t.dataset && t.dataset.input;
  if (k === 'pay-amount') payState().touched = true;
  if (k === 'accent') applyTheme(t.value);
  if (k === 'cp-amt' && ui.modal) ui.modal.amountText = t.value;
  if (k === 'co-user') {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(async () => {
      const lbl = $('#co-pass-lbl'), hint = $('#co-pass-hint'); if (!lbl) return;
      try { const s = await api.buyerStatus(t.value); lbl.textContent = s.exists ? 'Your passcode' : 'Create a passcode'; hint.textContent = s.exists ? 'The passcode you made on your first claim. Forgot it? Message the seller to reset it.' : 'New here. Pick 4 to 20 letters, numbers or symbols. You’ll use it to see and pay for your orders.'; }
      catch (err) { lbl.textContent = 'Passcode'; hint.textContent = 'Enter your username and we’ll tell you whether to create a passcode or use your existing one.'; }
    }, 250);
  }
  if (t.name === 'extra' && ui.pay) { updatePayTotals(); }
});
document.addEventListener('change', async e => {
  const t = e.target, k = t.dataset && t.dataset.change; if (!k) return;
  if (k === 'pay-recalc') { if (ui.pay) ui.pay.touched = false; updatePayTotals(); return; }
  if (k === 'proof') {
    const file = t.files && t.files[0]; if (!file) return;
    capturePay();
    try { payState().proof = await compressImage(file); payState().err = ''; } catch (err) { showErr('pay-err', errMsg(err)); return; }
    render(); return;
  }
  if (k === 'choose') { ui.choice[t.dataset.id] = t.value; render(); return; }
  if (!ui.modal) return;
  const m = ui.modal;
  if (k === 'cp-in') { m.incomingId = t.value; const x = t.value && Core.byId(S.incoming, t.value); if (x) m.amountText = (x.amountCents / 100).toFixed(2); m.manual = false; renderModal(); }
  else if (k === 'cp-manual') { m.manual = t.checked; renderModal(); }
  else if (k === 'cp-auto') { m.autoApply = t.checked; renderModal(); }
  else if (k === 'cp-amt') { m.amountText = t.value; renderModal(); }
  else if (k === 'as-user') { m.user = t.value; renderModal(); }
  else if (k === 'feedfile') { const file = t.files[0]; if (!file) return; const text = await file.text(); const f = $('[data-form=import]'); m.method = f.elements.method.value; m.text = text.slice(0, 400000); m.preview = null; renderModal(); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && ui.modal) closeModal(); });
window.addEventListener('hashchange', () => { if (ui.modal) closeModal(); render(); window.scrollTo(0, 0); });
setInterval(() => {   // keep countdowns fresh, but never while someone is typing or a dialog is open
  const a = document.activeElement;
  if (ui.modal || (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) || route().name === 'pay') return;
  render();
}, 60000);

async function boot() {
  if (LIVE.on) {
    S = LIVE.empty();
    LIVE.onAuthLost = () => { ui.admin = false; toast('Your seller session ended. Please sign in again.', true); go('#/seller'); };
    try { ui.admin = await LIVE.restore(); } catch (e) { ui.loadError = errMsg(e); }
  } else loadState();
  render();
}
boot();
