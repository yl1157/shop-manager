/* ==========================================================================
   LIVE MODE — the shared shop. Talks to Supabase with plain fetch (no library).

   On when config.js has a valid supabaseUrl + supabaseAnonKey; otherwise the page runs the private
   preview in api.js. It keeps the same function names and result shapes as api.js, so the screens
   don't know the difference. The rules (money, stock, holds, passcodes) live in db/schema.sql.

   Visitors: the catalog and look come from one public call, shop_info().
   Seller:   email + password sign-in (Supabase Auth), then admin_snapshot() fills the same state
             object the screens already read. Every seller action calls one function, then reloads.
   ========================================================================== */
const LIVE = (() => {
  const cfg = (typeof window !== 'undefined' && window.SHOP_CONFIG) || {};
  const url = String(cfg.supabaseUrl || '').trim().replace(/\/+$/, '');
  const key = String(cfg.supabaseAnonKey || '').trim();

  /** A secret key in a public file would hand the whole database to the world — refuse to run with one. */
  function looksSecret(k) {
    if (/^sb_secret_/i.test(k)) return true;
    const parts = k.split('.');
    if (parts.length !== 3) return false;
    try { return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'service_role'; } catch (e) { return false; }
  }
  let problem = '';
  if (url || key) {
    if (!url || !key) problem = 'config.js needs both supabaseUrl and supabaseAnonKey.';
    else if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(url)) problem = 'supabaseUrl in config.js should look like https://abcdxyz.supabase.co';
    else if (looksSecret(key)) problem = 'config.js contains a SECRET key. Remove it now and reset the key in Supabase (Project Settings → API). Use the anon / publishable key instead.';
  }
  const on = !!(url && key) && !problem;
  const isJwt = /^eyJ/.test(key);               // legacy anon keys are JWTs; new publishable keys (sb_publishable_…) go in `apikey` only

  const SESSION_KEY = 'shopmgr.sb.session';
  const STALE_MS = 20000;
  let session = null, loadedAt = 0, kind = 'none', inflight = null, refreshing = null;
  const L = { on, problem, error: '', onAuthLost: () => {}, get kind() { return kind; }, get loaded() { return kind !== 'none'; } };

  /* ---------- plumbing ---------- */
  const NET = 'Can’t reach the shop right now. Check your connection and try again.';
  async function http(path, { method = 'POST', headers = {}, body, token } = {}) {
    const h = { apikey: key, ...headers };
    if (token) h.Authorization = 'Bearer ' + token; else if (isJwt) h.Authorization = 'Bearer ' + key;
    try { return await fetch(url + path, { method, headers: h, body }); }
    catch (e) { throw new Core.AppError('network', NET); }
  }
  const json = async res => { const t = await res.text(); try { return t ? JSON.parse(t) : null; } catch (e) { return null; } };
  const AUTH_MSG = 'Your seller session ended. Please sign in again.';

  function saveSession(s) {
    session = s;
    try { if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s)); else localStorage.removeItem(SESSION_KEY); } catch (e) { /* private window: stays in memory */ }
  }
  function readSession() {
    try { const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); return s && s.access_token && s.refresh_token ? s : null; } catch (e) { return null; }
  }
  const fromToken = j => ({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600) });

  const lost = quiet => { saveSession(null); kind = 'none'; if (!quiet) L.onAuthLost(); return new Core.AppError('auth', AUTH_MSG); };
  async function ensureSession(quiet) {
    if (!session) session = readSession();
    if (!session) throw lost(quiet);
    if (session.expires_at - 60 > Date.now() / 1000) return;
    if (!refreshing) {
      refreshing = (async () => {
        const res = await http('/auth/v1/token?grant_type=refresh_token', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh_token }) });
        if (!res.ok) throw new Core.AppError('auth', AUTH_MSG);
        saveSession(fromToken(await res.json()));
      })().finally(() => { refreshing = null; });
    }
    try { await refreshing; } catch (e) { if (e.code === 'auth') throw lost(quiet); throw e; }
  }

  function toError(res, d, seller, quiet) {
    const hint = d && d.hint, msg = d && d.message;
    if (seller && (res.status === 401 || res.status === 403 || hint === 'forbidden')) return lost(quiet);
    if (hint && msg) return new Core.AppError(hint, msg);                       // a rule said no: show its words
    if (res.status === 404 || (d && d.code === 'PGRST202')) return new Core.AppError('setup', 'The shop’s database isn’t set up yet (or is missing a piece). Run db/schema.sql in Supabase again.');
    if (res.status === 429) return new Core.AppError('rate', 'Too many requests. Wait a minute and try again.');
    if (res.status >= 500) return new Core.AppError('server', 'Something went wrong on the server. Try again in a moment.');
    return new Core.AppError('error', msg || 'Something went wrong. Try again.');
  }

  /** Call a database function. `seller: true` sends the seller's login; everything else goes out as a visitor. */
  async function rpc(fn, args = {}, { seller = false, quiet = false } = {}) {
    if (seller) await ensureSession(quiet);
    const res = await http('/rest/v1/rpc/' + fn, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args), token: seller ? session.access_token : null });
    const d = await json(res);
    if (res.ok) return d;
    throw toError(res, d, seller, quiet);
  }

  /* ---------- state the screens read ---------- */
  const blank = () => ({ v: 1, clockOffsetMs: 0, seq: {}, settings: {}, groups: [], products: [], variants: [], buyers: {}, orders: [], payments: [], allocations: [], incoming: [], log: [] });

  /** Shown only until the first load finishes (or fails), so the screens never meet an undefined setting. */
  L.empty = () => {
    const st = blank();
    st.settings = { shopName: 'Shop', shopOpen: true, holdHours: 48, nearTolCents: 100, requireProof: true, maxOpenUnpaidOrders: 8, maxPendingPayments: 3, accentColor: Core.DEFAULT_ACCENT, tagline: '', notice: '', methods: [] };
    return st;
  };

  async function loadPublic() {
    const { groups, products, variants, now, ...settings } = await rpc('shop_info');
    const st = blank();
    st.settings = { nearTolCents: 100, maxOpenUnpaidOrders: 8, maxPendingPayments: 3, ...settings };
    Object.assign(st, { groups, products, variants, clockOffsetMs: now - Date.now() });
    S = st; kind = 'public'; loadedAt = Date.now();
  }

  async function signProofs(snap) {
    const withProof = snap.payments.filter(p => p.proof && p.proof.path);
    if (!withProof.length) return;
    try {
      await ensureSession(true);
      const paths = [...new Set(withProof.map(p => p.proof.path))].slice(-300);
      const res = await http('/storage/v1/object/sign/payment-proofs', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 3600, paths }), token: session.access_token });
      if (!res.ok) return;
      const map = {};
      (await res.json()).forEach(r => { if (r && r.signedURL) map[r.path] = url + '/storage/v1' + (r.signedURL.startsWith('/') ? '' : '/') + r.signedURL; });
      withProof.forEach(p => { if (map[p.proof.path]) p.proof.dataUrl = map[p.proof.path]; });
    } catch (e) { /* screenshots just won't show; everything else still works */ }
  }

  async function loadSeller(opts) {
    const snap = await rpc('admin_snapshot', {}, { seller: true, ...opts });
    snap.clockOffsetMs = snap.now - Date.now();
    await signProofs(snap);
    S = snap; kind = 'seller'; loadedAt = Date.now();
  }

  /** Reload when the data is older than a few seconds. Many callers at once share one request. */
  L.refresh = async (force) => {
    if (!on) return;
    if (!force && kind !== 'none' && Date.now() - loadedAt < STALE_MS) return;
    if (!inflight) inflight = (kind === 'seller' ? loadSeller() : loadPublic()).finally(() => { inflight = null; });
    await inflight;
  };
  /** After a buyer action: stock changed, so reload the public numbers (never fails the action itself). */
  const touch = async () => { try { await L.refresh(true); } catch (e) { /* the next render will retry */ } };

  /* ---------- seller sign-in ---------- */
  L.restore = async () => {
    session = readSession();
    if (session) {
      try { await loadSeller({ quiet: true }); return true; }
      catch (e) { if (e.code !== 'network') saveSession(null); else throw e; }
    }
    await loadPublic();
    return false;
  };
  L.signIn = async (email, password) => {
    const res = await http('/auth/v1/token?grant_type=password', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: String(email || '').trim(), password: String(password || '') }) });
    if (res.status === 429) throw new Core.AppError('rate', 'Too many tries. Wait a minute and try again.');
    if (!res.ok) throw new Core.AppError('bad_login', 'That email and password didn’t match.');
    saveSession(fromToken(await res.json()));
    try { await loadSeller({ quiet: true }); }
    catch (e) {
      saveSession(null);
      try { await loadPublic(); } catch (e2) { /* ignore */ }
      throw e.code === 'auth' ? new Core.AppError('not_seller', 'You’re signed in, but this login isn’t set up as the seller yet (README, step 4).') : e;
    }
  };
  L.signOut = async () => {
    const s = session || readSession();
    saveSession(null); kind = 'none';
    if (s) { try { await fetch(url + '/auth/v1/logout', { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + s.access_token } }); } catch (e) { /* the local session is gone either way */ } }
    await loadPublic();
  };

  /* ---------- buyer calls ---------- */
  const unwrap = r => { if (r && r.ok === false) throw new Core.AppError(r.code || 'error', r.message || 'Something went wrong.'); return r; };
  const who = ({ username, passcode }) => ({ p_username: username, p_passcode: passcode });

  async function uploadProof(path, proof) {
    const blob = await (await fetch(proof.dataUrl)).blob();
    const target = '/storage/v1/object/payment-proofs/' + path.split('/').map(encodeURIComponent).join('/');
    let last = null;
    for (let i = 0; i < 3; i++) {
      const fd = new FormData(); fd.append('cacheControl', '3600'); fd.append('', blob);
      try {
        const res = await http(target, { body: fd });
        if (res.ok) return;
        if (res.status < 500 && res.status !== 429) { last = new Core.AppError('upload_failed', 'The screenshot couldn’t be uploaded (' + res.status + ').'); break; }
        last = new Core.AppError('upload_failed', 'The screenshot couldn’t be uploaded right now.');
      } catch (e) { last = e; }
      await new Promise(r => setTimeout(r, 600 * (i + 1)));
    }
    void last;
    throw new Core.AppError('upload_failed', 'Your payment details were sent, but the screenshot didn’t upload. Please message the seller on Instagram and send it there.');
  }

  const buyer = {
    buyerStatus: async username => rpc('buyer_status', { p_username: username }),
    login: async a => { const r = unwrap(await rpc('my_account', who(a))); return { ok: true, username: r.username }; },
    myAccount: async a => unwrap(await rpc('my_account', who(a))),
    placeOrder: async a => { const r = unwrap(await rpc('place_order', { ...who(a), p_lines: a.lines })); await touch(); return r; },
    submitPayment: async ({ username, passcode, proof, ...rest }) => {
      const body = { ...rest };
      if (proof) body.proof = { sha256: proof.sha256, name: proof.name, ext: 'jpg' };
      const r = unwrap(await rpc('submit_payment', { ...who({ username, passcode }), p_payment: body }));
      if (r.proofPath && proof) await uploadProof(r.proofPath, proof);
      return { paymentId: r.paymentId, no: r.no };
    },
    cancelMyOrder: async a => { const r = unwrap(await rpc('cancel_my_order', { ...who(a), p_order_id: a.orderId })); await touch(); return r; },
  };

  /* ---------- seller calls: one database function each, then reload what the screens show ---------- */
  const reload = async () => { try { await L.refresh(true); } catch (e) { if (e.code === 'auth') throw e; /* the write worked; the next screen load retries */ } };
  const S_ = (fn, args) => async arg => { const r = await rpc(fn, args(arg), { seller: true }); await reload(); return r === undefined ? null : r; };
  const seller = {
    confirmPayment: S_('admin_confirm_payment', a => ({ p_payment_id: a.paymentId, p_incoming_id: a.incomingId || null, p_amount_cents: a.amountCents == null || Number.isNaN(a.amountCents) ? null : a.amountCents, p_manual_verified: !!a.manualVerified, p_auto_apply: a.autoApply !== false })),
    rejectPayment: S_('admin_reject_payment', a => ({ p_payment_id: a.paymentId, p_reason: a.reason || '' })),
    assignIncoming: S_('admin_assign_incoming', a => ({ p_incoming_id: a.incomingId, p_username: a.username, p_order_ids: a.orderIds || [], p_auto_apply: a.autoApply !== false })),
    recordManualPayment: S_('admin_record_payment', a => ({ p_username: a.username, p_method: a.method, p_amount_cents: a.amountCents, p_note: a.note || '', p_order_ids: a.orderIds || [], p_auto_apply: a.autoApply !== false })),
    ignoreIncoming: S_('admin_ignore_incoming', a => ({ p_incoming_id: a.incomingId, p_ignore: a.ignore !== false })),
    cancelOrder: S_('admin_cancel_order', a => ({ p_order_id: a.orderId, p_reason: a.reason || '' })),
    setFulfillment: S_('admin_set_fulfillment', a => ({ p_order_id: a.orderId, p_to: a.to, p_tracking: a.tracking || '' })),
    setShippingFee: S_('admin_set_shipping_fee', a => ({ p_order_id: a.orderId, p_cents: a.cents })),
    extendHold: S_('admin_extend_hold', a => ({ p_order_id: a.orderId, p_hours: a.hours })),
    upsertGroup: S_('admin_save_group', g => ({ p_group: g })),
    upsertProduct: S_('admin_save_product', p => ({ p_product: p })),
    deleteProduct: S_('admin_delete_product', id => ({ p_product_id: id })),
    mergeBuyer: S_('admin_merge_buyer', a => ({ p_from: a.from, p_to: a.to })),
    addIncoming: S_('admin_import_incoming', items => ({ p_items: items })),
    setBlocked: S_('admin_set_blocked', a => ({ p_username: a.username, p_blocked: !!a.blocked })),
    resetPasscode: S_('admin_reset_passcode', u => ({ p_username: u })),
    saveSettings: S_('admin_save_settings', patch => ({ p_patch: patch })),
    releaseExpired: S_('release_expired_holds', () => ({})),
    /** A full backup: every order, however old (the screens only load the last 60 days of closed ones). */
    exportJson: async () => {
      const snap = await rpc('admin_snapshot', { p_closed_days: 36500 }, { seller: true });
      return JSON.stringify(snap, null, 2);
    },
  };

  L.api = buyer; L.adm = seller;
  return L;
})();

if (LIVE.on) {
  Object.assign(api, LIVE.api);
  ['timeTravel', 'resetDemo'].forEach(k => { delete adm[k]; });
  Object.assign(adm, LIVE.adm);
}
