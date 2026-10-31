// Tests for db/schema.sql, run on a real in-process Postgres (PGlite): no Docker, no network, no Supabase account.
//
//   npm install                      (once: installs @electric-sql/pglite)
//   node --test tests/db.test.mjs
//
//   1. access rules  - what a logged-out visitor, a stranger with an account and the seller can and can't do
//   2. buyer flows   - claim, pay, cancel, expire, and the wrong-passcode lockout
//   3. seller flows  - confirm, reject, credit, shipping fee, catalog edits
//   4. screenshots   - the upload rules on the private storage bucket
//   5. same answers  - random sequences of actions are run through BOTH this SQL and the prototype's rules
//                      (the <core> block of index.html) and every number is compared after every step.
//
// The clock is a setting (app.now_ms), so "48 hours later" is instant. Supabase itself (auth, storage) is replaced by
// the small stand-in in tests/supabase-stub.sql.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let PGlite = null, pgcrypto = null;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto'));
} catch { /* reported through SKIP below */ }
const SKIP = PGlite ? false : 'needs @electric-sql/pglite: run `npm install` first';

const srcPath = process.env.CORE_SRC || join(root, 'index.html');
const coreSrc = readFileSync(srcPath, 'utf8').match(/\/\* <core> \*\/([\s\S]*?)\/\* <\/core> \*\//);
assert.ok(coreSrc, 'core markers not found in ' + srcPath);
const Core = new Function(coreSrc[1] + '\nreturn Core;')();

const H = 3600e3, D = 24 * H;
const T0 = Date.UTC(2026, 9, 30, 16, 0, 0);
const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const STRANGER = '00000000-0000-4000-8000-0000000000b2';
const PASS = 'pass1234';
const J = JSON.stringify;

/* ------------------------------------------------------------------ harness -- */
class Db {
  static async create() {
    const d = new Db();
    d.pg = new PGlite({ extensions: { pgcrypto } });
    await d.pg.exec(readFileSync(join(here, 'supabase-stub.sql'), 'utf8'));
    await d.pg.exec(readFileSync(process.env.SCHEMA_SQL || join(root, 'db', 'schema.sql'), 'utf8'));
    // the tests own the clock
    await d.pg.exec(`create or replace function private.now_() returns timestamptz language sql stable as
      $$ select to_timestamp(current_setting('app.now_ms')::numeric / 1000.0) $$`);
    await d.setNow(T0);
    await d.pg.query(`insert into auth.users (id, email) values ($1, 'seller@example.com'), ($2, 'stranger@example.com')`, [ADMIN, STRANGER]);
    await d.pg.query('insert into public.admins (user_id) values ($1)', [ADMIN]);
    return d;
  }
  async setNow(ms) { this.now = ms; await this.pg.query(`select set_config('app.now_ms', $1, false)`, [String(ms)]); }
  tick(ms) { return this.setNow(this.now + ms); }
  /** Act as: 'postgres' (the owner, sees everything), 'anon' (logged out), or 'authenticated' with a user id. */
  async as(role, sub = '') {
    await this.pg.exec('reset role');
    await this.pg.query(`select set_config('request.jwt.claim.sub', $1, false)`, [sub]);
    if (role !== 'postgres') await this.pg.exec('set role ' + role);
  }
  async q(sql, params = []) { return (await this.pg.query(sql, params)).rows; }
  async one(sql, params = []) { const r = (await this.q(sql, params))[0]; return r && r[Object.keys(r)[0]]; }
  /** Run something that must fail; returns what the error says. */
  async fails(sql, params = []) {
    try { await this.pg.query(sql, params); } catch (e) { return { code: e.code, hint: e.hint, message: e.message }; }
    return assert.fail('expected an error from: ' + sql);
  }
}

// logged-out visitor
const anon = async d => d.as('anon');
const buyer = {
  async claim(d, user, lines, pass = PASS) { await anon(d); return d.one('select public.place_order($1,$2,$3::jsonb)', [user, pass, J(lines)]); },
  async claimFails(d, user, lines, pass = PASS) { await anon(d); return d.fails('select public.place_order($1,$2,$3::jsonb)', [user, pass, J(lines)]); },
  async account(d, user, pass = PASS) { await anon(d); return d.one('select public.my_account($1,$2)', [user, pass]); },
  async status(d, user) { await anon(d); return d.one('select public.buyer_status($1)', [user]); },
  async pay(d, user, body, pass = PASS) { await anon(d); return d.one('select public.submit_payment($1,$2,$3::jsonb)', [user, pass, J(body)]); },
  async payFails(d, user, body, pass = PASS) { await anon(d); return d.fails('select public.submit_payment($1,$2,$3::jsonb)', [user, pass, J(body)]); },
  async cancel(d, user, orderId, pass = PASS) { await anon(d); return d.one('select public.cancel_my_order($1,$2,$3::uuid)', [user, pass, orderId]); },
  async cancelFails(d, user, orderId, pass = PASS) { await anon(d); return d.fails('select public.cancel_my_order($1,$2,$3::uuid)', [user, pass, orderId]); },
};
// the seller, logged in
const seller = {
  async one(d, sql, params = []) { await d.as('authenticated', ADMIN); return d.one(sql, params); },
  async fails(d, sql, params = []) { await d.as('authenticated', ADMIN); return d.fails(sql, params); },
  confirm(d, paymentId, o = {}) {
    return seller.one(d, 'select public.admin_confirm_payment($1::uuid,$2::uuid,$3::int,$4::boolean,$5::boolean)',
      [paymentId, o.incomingId ?? null, o.amount ?? null, o.manual ?? false, o.autoApply ?? true]);
  },
  confirmFails(d, paymentId, o = {}) {
    return seller.fails(d, 'select public.admin_confirm_payment($1::uuid,$2::uuid,$3::int,$4::boolean,$5::boolean)',
      [paymentId, o.incomingId ?? null, o.amount ?? null, o.manual ?? false, o.autoApply ?? true]);
  },
  reject: (d, id, why = '') => seller.one(d, 'select public.admin_reject_payment($1::uuid,$2)', [id, why]),
  importFeed: (d, items) => seller.one(d, 'select public.admin_import_incoming($1::jsonb)', [J(items)]),
  assign: (d, incomingId, user, orderIds = [], autoApply = true) =>
    seller.one(d, 'select public.admin_assign_incoming($1::uuid,$2,$3::uuid[],$4::boolean)', [incomingId, user, orderIds, autoApply]),
  record: (d, user, method, cents, orderIds = [], autoApply = true, note = '') =>
    seller.one(d, 'select public.admin_record_payment($1,$2,$3::int,$4,$5::uuid[],$6::boolean)', [user, method, cents, note, orderIds, autoApply]),
  cancel: (d, id, why = '') => seller.one(d, 'select public.admin_cancel_order($1::uuid,$2)', [id, why]),
  fee: (d, id, cents) => seller.one(d, 'select public.admin_set_shipping_fee($1::uuid,$2::int)', [id, cents]),
  fulfil: (d, id, to, tracking = '') => seller.one(d, 'select public.admin_set_fulfillment($1::uuid,$2,$3)', [id, to, tracking]),
  snapshot: d => seller.one(d, 'select public.admin_snapshot()'),
  books: d => seller.one(d, 'select public.admin_check_books()'),
};
// the database owner: used to read the truth directly
const raw = async (d, sql, params = []) => { await d.as('postgres'); return d.q(sql, params); };

/** One group, three products: an album (A:3, B:1), photocards (Hana:10, Jiwoo:0, max 4 each) and a pre-claim item (5). */
async function seedShop(d) {
  const save = async p => seller.one(d, 'select public.admin_save_product($1::jsonb)', [J(p)]);
  const g = await seller.one(d, 'select public.admin_save_group($1::jsonb)', [J({ name: 'NOVA9', color: '#C2406F', members: ['Hana', 'Jiwoo'] })]);
  await save({ groupId: g, name: 'Album', category: 'album', priceCents: 1800, variants: [{ name: 'A', stock: 3 }, { name: 'B', stock: 1 }] });
  await save({ groupId: g, name: 'Card', category: 'photocard', priceCents: 350, maxPerUser: 4, variants: [{ name: 'Hana', stock: 10 }, { name: 'Jiwoo', stock: 0 }] });
  await save({ groupId: g, name: 'Greetings', category: 'merch', priceCents: 2400, availability: 'incoming', payBy: T0 + 9 * D, variants: [{ name: '', stock: 5 }] });
  const v = {};
  for (const r of await raw(d, `select v.id, p.name pname, v.name vname from public.variants v join public.products p on p.id = v.product_id`)) {
    v[r.pname === 'Greetings' ? 'Pre' : r.vname] = r.id;
  }
  return { g, v };
}
const stockOf = async (d, id) => (await raw(d, 'select stock from public.variants where id = $1::uuid', [id]))[0].stock;
const orderNo = async (d, no) => (await raw(d, 'select id from public.orders where no = $1::int', [no]))[0].id;
const proofOf = (n = 1) => ({ sha256: 'sha-' + n, name: 'shot' + n + '.jpg', ext: 'jpg' });
const payBody = (o = {}) => ({ method: 'paypal', amountCents: 1800, txnId: '', senderName: 'Hee Bunny', paidAt: null, proof: proofOf(), orderIds: [], ...o });

/* ============================================================= 1. access rules == */
describe('access rules', { skip: SKIP }, () => {
  let d, shop;
  test('setup', async () => {
    d = await Db.create();
    shop = await seedShop(d);
    // things the public must NOT see: an inactive group, a hidden product, an archived variant
    const g2 = await seller.one(d, 'select public.admin_save_group($1::jsonb)', [J({ name: 'Backstage', active: false })]);
    await seller.one(d, 'select public.admin_save_product($1::jsonb)', [J({ groupId: shop.g, name: 'Secret', priceCents: 100, status: 'hidden', variants: [{ name: '', stock: 1 }] })]);
    await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }]);
    assert.ok(g2);
  });

  test('a logged-out visitor can read the catalog, only what is on sale', async () => {
    await anon(d);
    assert.deepEqual((await d.q('select name from public.groups order by name')).map(r => r.name), ['NOVA9']);
    assert.deepEqual((await d.q('select name from public.products order by name')).map(r => r.name), ['Album', 'Card', 'Greetings']);
    assert.equal((await d.q('select 1 from public.variants')).length, 5);
  });

  test('a logged-out visitor can not read or write anything else', async () => {
    for (const t of ['buyers', 'orders', 'order_lines', 'payments', 'payment_allocations', 'incoming_transactions', 'settings', 'activity_log', 'admins']) {
      await anon(d);
      assert.equal((await d.fails(`select * from public.${t}`)).code, '42501', 'read ' + t);
    }
    for (const sql of [`insert into public.groups (name) values ('x')`, `update public.products set price_cents = 1`, `delete from public.variants`,
      `update public.settings set shop_open = false`, `insert into public.buyers (username) values ('x')`]) {
      await anon(d);
      assert.equal((await d.fails(sql)).code, '42501', sql);
    }
  });

  test('a logged-out visitor can not run seller functions or the internal helpers', async () => {
    for (const sql of ['select public.admin_snapshot()', 'select public.release_expired_holds()', 'select public.admin_check_books()',
      `select private.check_pass('hee.bunny','x')`, 'select private.expire_holds()', 'select private.is_admin()']) {
      await anon(d);
      assert.equal((await d.fails(sql)).code, '42501', sql);
    }
  });

  test('the public shop info lists only payment methods that are switched on', async () => {
    await anon(d);
    const info = await d.one('select public.shop_info()');
    assert.deepEqual(info.methods.map(m => m.key), ['paypal', 'venmo', 'zelle']);
    assert.equal(info.shopOpen, true);
    assert.equal(info.holdHours, 48);
  });

  test('a stranger with an account (not on the admins list) can read the catalog and nothing else', async () => {
    await d.as('authenticated', STRANGER);
    assert.equal((await d.q('select 1 from public.orders')).length, 0);
    assert.equal((await d.q('select 1 from public.payments')).length, 0);
    assert.equal((await d.q('select username from public.buyers')).length, 0);
    assert.equal((await d.q('select 1 from public.products')).length, 3);
    assert.equal((await d.fails(`insert into public.groups (name) values ('x')`)).code, '42501');
    assert.equal((await d.fails('select public.admin_snapshot()')).hint, 'forbidden');
    assert.equal((await d.fails(`select public.admin_confirm_payment(gen_random_uuid())`)).hint, 'forbidden');
    assert.equal((await d.fails(`select public.admin_save_product('{}'::jsonb)`)).hint, 'forbidden');
    assert.equal((await d.fails('select public.admin_check_books()')).hint, 'forbidden');
  });

  test('the seller can read the tables, but never the passcode hashes', async () => {
    await d.as('authenticated', ADMIN);
    assert.equal((await d.q('select username, has_pass from public.buyers'))[0].has_pass, true);
    assert.equal((await d.fails('select pass_hash from public.buyers')).code, '42501');
    assert.equal((await d.fails('select * from public.buyers')).code, '42501');
    const snap = JSON.stringify(await seller.snapshot(d));
    assert.ok(!snap.includes('$2a$') && !snap.includes('$2b$'), 'snapshot must not contain a bcrypt hash');
  });

  test('the proof bucket is private, small and images-only', async () => {
    const b = (await raw(d, `select * from storage.buckets where id = 'payment-proofs'`))[0];
    assert.equal(b.public, false);
    assert.equal(Number(b.file_size_limit), 2 * 1024 * 1024);
    assert.deepEqual(b.allowed_mime_types, ['image/jpeg', 'image/png', 'image/webp']);
  });

  test('the schema can be run twice without errors or duplicated data', async () => {
    await d.as('postgres');
    await d.pg.exec(readFileSync(join(root, 'db', 'schema.sql'), 'utf8'));
    // the test clock override was replaced by the real one; put it back
    await d.pg.exec(`create or replace function private.now_() returns timestamptz language sql stable as $$ select to_timestamp(current_setting('app.now_ms')::numeric / 1000.0) $$`);
    assert.equal((await raw(d, 'select count(*)::int c from public.settings'))[0].c, 1);
    assert.equal((await raw(d, 'select count(*)::int c from public.groups'))[0].c, 2);
  });
});

/* ============================================================== 2. buyer flows == */
describe('buyer flows', { skip: SKIP }, () => {
  let d, shop;
  const fresh = async () => { d = await Db.create(); shop = await seedShop(d); };

  test('the first claim creates the passcode; totals and stock are right', async () => {
    await fresh();
    assert.deepEqual(await buyer.status(d, '@Hee.Bunny'), { exists: false, blocked: false });
    const r = await buyer.claim(d, '@Hee.Bunny', [{ variantId: shop.v.A, qty: 2 }, { variantId: shop.v.Hana, qty: 1 }]);
    assert.equal(r.orderIds.length, 1);
    assert.equal(r.creditAppliedCents, 0);
    assert.deepEqual(await buyer.status(d, 'hee.bunny'), { exists: true, blocked: false });
    const a = await buyer.account(d, 'hee.bunny');
    assert.equal(a.orders.length, 1);
    const o = a.orders[0];
    assert.equal(o.no, 1001);
    assert.equal(o.total, 2 * 1800 + 350);
    assert.equal(o.due, 3950); assert.equal(o.toSend, 3950); assert.equal(o.paid, 0); assert.equal(o.payState, 'unpaid');
    assert.equal(o.leftMs, 48 * H);
    assert.equal(a.dueCents, 3950); assert.equal(a.creditCents, 0);
    assert.equal(await stockOf(d, shop.v.A), 1);
    assert.equal(await stockOf(d, shop.v.Hana), 9);
    // the passcode is stored hashed
    const h = (await raw(d, 'select pass_hash from public.buyers'))[0].pass_hash;
    assert.ok(h.startsWith('$2') && !h.includes(PASS));
  });

  test('later claims need the passcode; an unknown username has no account', async () => {
    await fresh();
    await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }]);
    const bad = await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }], 'wrong-pass');
    assert.equal(bad.ok, false); assert.equal(bad.code, 'wrong_passcode');
    assert.equal(await stockOf(d, shop.v.A), 2, 'a refused claim holds nothing');
    const ghost = await buyer.account(d, 'nobody.here', PASS);
    assert.equal(ghost.ok, false); assert.equal(ghost.code, 'no_passcode');
    assert.equal((await buyer.account(d, 'hee.bunny', 'x')).ok, false);
  });

  test('five wrong passcodes lock the account for 15 minutes, and the count survives the failed calls', async () => {
    await fresh();
    await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }]);
    for (let i = 1; i <= 4; i++) {
      const r = await buyer.account(d, 'hee.bunny', 'nope' + i);
      assert.equal(r.code, 'wrong_passcode');
      assert.equal((await raw(d, 'select fails from public.buyers'))[0].fails, i, 'try ' + i + ' must be remembered');
    }
    const fifth = await buyer.account(d, 'hee.bunny', 'nope5');
    assert.match(fifth.message, /locked for 15 minutes/);
    assert.ok((await raw(d, 'select lock_until from public.buyers'))[0].lock_until, 'lock must be saved');
    const right = await buyer.account(d, 'hee.bunny', PASS);
    assert.equal(right.code, 'locked', 'even the right passcode is refused while locked');
    await d.tick(14 * 60e3);
    assert.equal((await buyer.account(d, 'hee.bunny', PASS)).code, 'locked');
    await d.tick(2 * 60e3);
    const ok = await buyer.account(d, 'hee.bunny', PASS);
    assert.equal(ok.username, 'hee.bunny');
    assert.equal((await raw(d, 'select fails from public.buyers'))[0].fails, 0);
  });

  test('a right passcode clears earlier wrong tries', async () => {
    await fresh();
    await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }]);
    await buyer.account(d, 'hee.bunny', 'nope'); await buyer.account(d, 'hee.bunny', 'nope');
    assert.equal((await raw(d, 'select fails from public.buyers'))[0].fails, 2);
    await buyer.account(d, 'hee.bunny', PASS);
    assert.equal((await raw(d, 'select fails from public.buyers'))[0].fails, 0);
  });

  test('claims that break a rule fail whole, with a code, and change nothing', async () => {
    await fresh();
    const A = shop.v.A, B = shop.v.B, Hana = shop.v.Hana;
    const expect = async (user, lines, hint, pass = PASS) => {
      const e = await buyer.claimFails(d, user, lines, pass);
      assert.equal(e.hint, hint, `${hint}: ${e.message}`);
      return e;
    };
    await expect('newbie', [{ variantId: B, qty: 2 }], 'oversold');                       // only 1 left
    assert.deepEqual(await buyer.status(d, 'newbie'), { exists: false, blocked: false }, 'a failed first claim must not create the account');
    await expect('newbie', [{ variantId: shop.v.Jiwoo, qty: 1 }], 'oversold');             // 0 left
    await expect('newbie', [{ variantId: Hana, qty: 5 }], 'limit');                        // max 4 per person
    await expect('newbie', [{ variantId: A, qty: 0 }], 'bad_qty');
    await expect('newbie', [{ variantId: A, qty: 100 }], 'bad_qty');
    await expect('newbie', [], 'empty');
    await expect('newbie', [{ variantId: crypto.randomUUID(), qty: 1 }], 'unavailable');
    await expect('has space', [{ variantId: A, qty: 1 }], 'bad_username');
    await expect('newbie', [{ variantId: A, qty: 1 }], 'bad_passcode', 'abc');
    // one bad line spoils the whole claim: A is fine, B is oversold
    await expect('newbie', [{ variantId: A, qty: 1 }, { variantId: B, qty: 5 }], 'oversold');
    assert.equal(await stockOf(d, A), 3); assert.equal(await stockOf(d, B), 1);
    // the same variant listed twice adds up: 2 + 3 > 3 in stock
    await expect('newbie', [{ variantId: A, qty: 2 }, { variantId: A, qty: 2 }], 'oversold');
    // a limit counts what they already hold
    await buyer.claim(d, 'hee.bunny', [{ variantId: Hana, qty: 3 }]);
    const e = await expect('hee.bunny', [{ variantId: Hana, qty: 2 }], 'limit');
    assert.match(e.message, /you already have 3/);
    // closed shop, blocked buyer
    await seller.one(d, 'update public.settings set shop_open = false returning 1');
    await expect('hee.bunny', [{ variantId: A, qty: 1 }], 'closed');
    await seller.one(d, 'update public.settings set shop_open = true returning 1');
    await seller.one(d, 'select public.admin_set_blocked($1, true)', ['hee.bunny']);
    await expect('hee.bunny', [{ variantId: A, qty: 1 }], 'blocked');
    await seller.one(d, 'select public.admin_set_blocked($1, false)', ['hee.bunny']);
    assert.ok(await buyer.claim(d, 'hee.bunny', [{ variantId: A, qty: 1 }]));
  });

  test('two buyers can not both get the last one', async () => {
    await fresh();
    await buyer.claim(d, 'first.buyer', [{ variantId: shop.v.B, qty: 1 }]);
    const e = await buyer.claimFails(d, 'second.buyer', [{ variantId: shop.v.B, qty: 1 }]);
    assert.equal(e.hint, 'oversold'); assert.match(e.message, /just sold out/);
    assert.equal(await stockOf(d, shop.v.B), 0);
  });

  test('items not open yet can not be claimed until they open', async () => {
    await fresh();
    const album = (await raw(d, `select id from public.products where name = 'Album'`))[0].id;
    const vars = (await raw(d, `select id, name, stock from public.variants where product_id = $1::uuid order by position`, [album]));
    await seller.one(d, 'select public.admin_save_product($1::jsonb)', [J({ id: album, groupId: shop.g, name: 'Album', priceCents: 1800, opensAt: T0 + 2 * H, variants: vars.map(v => ({ id: v.id, name: v.name, stock: v.stock })) })]);
    assert.equal((await buyer.claimFails(d, 'early.bird', [{ variantId: shop.v.A, qty: 1 }])).hint, 'not_open');
    await d.tick(3 * H);
    assert.ok(await buyer.claim(d, 'early.bird', [{ variantId: shop.v.A, qty: 1 }]));
  });

  test('pre-claim items get their own order, held until the pay-by date', async () => {
    await fresh();
    const r = await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }, { variantId: shop.v.Pre, qty: 1 }, { variantId: shop.v.Hana, qty: 1 }]);
    assert.equal(r.orderIds.length, 2);
    const a = await buyer.account(d, 'hee.bunny');
    const byNo = Object.fromEntries(a.orders.map(o => [o.no, o]));
    assert.equal(byNo[1001].total, 1800 + 350); assert.equal(byNo[1001].leftMs, 48 * H);
    assert.equal(byNo[1002].total, 2400); assert.equal(byNo[1002].leftMs, 9 * D);
  });

  test('a buyer can only hold so many unpaid orders at once', async () => {
    await fresh();
    await seller.one(d, 'update public.settings set max_open_unpaid_orders = 2 returning 1');
    await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.Hana, qty: 1 }]);
    await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.Hana, qty: 1 }]);
    assert.equal((await buyer.claimFails(d, 'hee.bunny', [{ variantId: shop.v.Hana, qty: 1 }])).hint, 'too_many');
  });

  test('"I paid" rules: screenshot, method, amount, time, how many at once', async () => {
    await fresh();
    const r = await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }]);
    const oid = r.orderIds[0];
    const bad = async (body, hint) => assert.equal((await buyer.payFails(d, 'hee.bunny', payBody(body))).hint, hint, hint + ' ' + J(body));
    await bad({ proof: null }, 'need_proof');
    await bad({ method: 'wise' }, 'bad_method');            // switched off
    await bad({ method: 'bitcoin' }, 'bad_method');
    await bad({ amountCents: 0 }, 'bad_amount');
    await bad({ amountCents: -5 }, 'bad_amount');
    await bad({ amountCents: 'lots' }, 'bad_amount');
    await bad({ amountCents: 200001 }, 'bad_amount');
    await bad({ paidAt: T0 + 20 * 60e3 }, 'bad_time');          // future
    await bad({ paidAt: T0 - 61 * D }, 'bad_time');             // too old
    await bad({ orderIds: [crypto.randomUUID()] }, 'bad_order');
    await buyer.claim(d, 'someone.else', [{ variantId: shop.v.Hana, qty: 1 }]);
    const theirs = await orderNo(d, 1002);
    await bad({ orderIds: [theirs] }, 'bad_order');         // not their order
    const ok = await buyer.pay(d, 'hee.bunny', payBody({ orderIds: [oid] }));
    assert.equal(ok.no, 501); assert.ok(ok.proofPath.endsWith('.jpg'));
    await buyer.pay(d, 'hee.bunny', payBody({ amountCents: 500 }));
    await buyer.pay(d, 'hee.bunny', payBody({ amountCents: 600 }));
    await bad({ amountCents: 700 }, 'too_many_pending');
    // the shop can run without screenshots
    await seller.one(d, 'update public.settings set require_proof = false returning 1');
    await d.as('postgres'); await d.q(`update public.payments set status = 'rejected' where no > 501`);
    assert.ok((await buyer.pay(d, 'hee.bunny', payBody({ amountCents: 700, proof: null }))).paymentId);
  });

  test('a submitted payment waits for review; the buyer sees what is left to send, never the screenshot path', async () => {
    await fresh();
    const r = await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }]);
    const p = await buyer.pay(d, 'hee.bunny', payBody({ amountCents: 1000, orderIds: [r.orderIds[0]], txnId: 'ABC123XYZ' }));
    const a = await buyer.account(d, 'hee.bunny');
    const o = a.orders[0];
    assert.equal(o.paid, 0, 'nothing counts until the seller confirms');
    assert.equal(o.pending, 1000); assert.equal(o.due, 1800); assert.equal(o.toSend, 800);
    assert.equal(a.pendingCents, 1000); assert.equal(a.toSendCents, 800);
    assert.deepEqual(a.payments[0].covers, [{ orderNo: 1001, cents: 1000 }]);
    assert.equal(a.payments[0].hasProof, true);
    assert.ok(!('proofPath' in a.payments[0]) && !('proof' in a.payments[0]) && !J(a).includes(p.proofPath));
  });

  test('a buyer can cancel an unpaid claim (stock comes back), but not one with money on it', async () => {
    await fresh();
    const r = await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 2 }]);
    const r2 = await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.B, qty: 1 }]);
    await buyer.pay(d, 'hee.bunny', payBody({ amountCents: 1800, orderIds: [r2.orderIds[0]] }));
    assert.equal((await buyer.cancelFails(d, 'hee.bunny', r2.orderIds[0])).hint, 'has_money');
    await buyer.claim(d, 'someone.else', [{ variantId: shop.v.Hana, qty: 1 }]);
    assert.equal((await buyer.cancelFails(d, 'hee.bunny', await orderNo(d, 1003))).hint, 'not_found', 'not their order');
    const c = await buyer.cancel(d, 'hee.bunny', r.orderIds[0]);
    assert.equal(c.refundedToCreditCents, 0);
    assert.equal(await stockOf(d, shop.v.A), 3);
    assert.equal((await buyer.cancelFails(d, 'hee.bunny', r.orderIds[0])).hint, 'bad_state', 'already cancelled');
    assert.equal((await buyer.cancel(d, 'hee.bunny', r2.orderIds[0], 'wrong')).code, 'wrong_passcode');
  });

  test('unpaid claims are released when the hold runs out; ones with a payment in review are not', async () => {
    await fresh();
    const a = await buyer.claim(d, 'ann', [{ variantId: shop.v.A, qty: 1 }]);
    const b = await buyer.claim(d, 'bo', [{ variantId: shop.v.A, qty: 1 }]);
    await buyer.pay(d, 'bo', payBody({ amountCents: 1800, orderIds: [b.orderIds[0]] }));
    await d.tick(47 * H);
    assert.equal((await buyer.account(d, 'ann')).orders[0].status, 'open');
    await d.tick(2 * H);
    const ann = await buyer.account(d, 'ann');
    assert.equal(ann.orders[0].status, 'expired');
    assert.equal(ann.orders[0].due, 0);
    assert.equal(ann.orders[0].cancelReason, 'Hold expired — not paid in time');
    assert.equal((await buyer.account(d, 'bo')).orders[0].status, 'open', 'a payment in review keeps the hold');
    assert.equal(await stockOf(d, shop.v.A), 3 - 1, 'only ann’s stock came back');
    void a;
  });

  test('a lapsed hold is released even if nobody touches the site, as soon as anything runs', async () => {
    await fresh();
    await buyer.claim(d, 'ann', [{ variantId: shop.v.A, qty: 3 }]);
    assert.equal((await buyer.claimFails(d, 'bo', [{ variantId: shop.v.A, qty: 1 }])).hint, 'oversold');
    await d.tick(49 * H);
    assert.ok(await buyer.claim(d, 'bo', [{ variantId: shop.v.A, qty: 3 }]), 'the lapsed hold must be released before checking stock');
  });
});

/* ============================================================== 3. seller flows == */
describe('seller flows', { skip: SKIP }, () => {
  let d, shop;
  const fresh = async () => { d = await Db.create(); shop = await seedShop(d); };
  const feedRow = (o = {}) => ({ method: 'paypal', extId: 'PP-7XK31982', occurredAt: T0, amountCents: 2500, senderName: 'Hee Bunny', ...o });
  const incomingId = async no => (await raw(d, 'select id from public.incoming_transactions where no = $1::int', [no]))[0].id;
  const books = async () => assert.deepEqual(await seller.books(d), [], 'the books must balance');

  test('the whole story: claim, pay with a screenshot, match to the real transfer, confirm, ship', async () => {
    await fresh();
    const c = await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }, { variantId: shop.v.Hana, qty: 2 }]);   // 1800 + 700 = 2500
    const pay = await buyer.pay(d, 'hee.bunny', payBody({ amountCents: 2500, txnId: 'PP-7XK31982', orderIds: c.orderIds }));
    const feed = await seller.importFeed(d, [feedRow()]);
    assert.deepEqual(feed, { added: 1, skipped: 0 });
    const r = await seller.confirm(d, pay.paymentId, { incomingId: await incomingId(101) });
    assert.equal(r.creditCents, 0); assert.equal(r.amountCents, 2500);
    assert.deepEqual(r.allocated, [{ orderId: c.orderIds[0], cents: 2500 }]);
    const a = await buyer.account(d, 'hee.bunny');
    assert.equal(a.orders[0].payState, 'paid'); assert.equal(a.orders[0].paid, 2500); assert.equal(a.orders[0].due, 0);
    assert.equal(a.payments[0].status, 'confirmed'); assert.equal(a.toSendCents, 0);
    const snap = await seller.snapshot(d);
    assert.equal(snap.incoming[0].status, 'matched'); assert.equal(snap.incoming[0].paymentId, pay.paymentId);
    assert.equal(snap.payments[0].incomingId, snap.incoming[0].id);
    // packing needs the order to be paid; a tracking number typed before "Packed" is kept
    await seller.fulfil(d, c.orderIds[0], 'packed', 'TRK-99');
    assert.equal((await raw(d, 'select tracking from public.orders'))[0].tracking, 'TRK-99');
    await seller.fulfil(d, c.orderIds[0], 'shipped', 'TRK-100');
    assert.equal((await buyer.account(d, 'hee.bunny')).orders[0].tracking, 'TRK-100');
    assert.equal((await buyer.cancelFails(d, 'hee.bunny', c.orderIds[0])).hint, 'shipped');
    assert.equal((await seller.fails(d, 'select public.admin_cancel_order($1::uuid, $2)', [c.orderIds[0], ''])).hint, 'shipped');
    await books();
  });

  test('confirming needs a real transfer, or an explicit "I checked my account"', async () => {
    await fresh();
    const c = await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }]);
    const p = await buyer.pay(d, 'hee.bunny', payBody({ amountCents: 1800, orderIds: c.orderIds }));
    assert.equal((await seller.confirmFails(d, p.paymentId)).hint, 'verify_required');
    const r = await seller.confirm(d, p.paymentId, { manual: true });
    assert.equal(r.allocated[0].cents, 1800);
    const row = (await raw(d, 'select status, verified_manually from public.payments'))[0];
    assert.equal(row.status, 'confirmed'); assert.equal(row.verified_manually, true);
    assert.equal((await seller.confirmFails(d, p.paymentId, { manual: true })).hint, 'bad_state', 'only once');
    await books();
  });

  test('the money in the seller’s own feed wins over what the buyer typed', async () => {
    await fresh();
    const c = await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }]);
    const p = await buyer.pay(d, 'hee.bunny', payBody({ amountCents: 1800, orderIds: c.orderIds, txnId: 'PP-7XK31982' }));
    await seller.importFeed(d, [feedRow({ amountCents: 1500 })]);                 // only $15.00 really arrived
    const r = await seller.confirm(d, p.paymentId, { incomingId: await incomingId(101) });
    assert.equal(r.amountCents, 1500);
    const a = await buyer.account(d, 'hee.bunny');
    assert.equal(a.orders[0].paid, 1500); assert.equal(a.orders[0].due, 300); assert.equal(a.orders[0].payState, 'partial');
    // the seller can also override the amount by hand
    const c2 = await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.B, qty: 1 }]);
    const p2 = await buyer.pay(d, 'hee.bunny', payBody({ amountCents: 1800, orderIds: c2.orderIds }));
    const r2 = await seller.confirm(d, p2.paymentId, { manual: true, amount: 1700 });
    assert.equal(r2.amountCents, 1700);
    await books();
  });

  test('extra money becomes credit, and credit pays the next claim by itself', async () => {
    await fresh();
    const c = await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }]);
    const p = await buyer.pay(d, 'hee.bunny', payBody({ amountCents: 5000, orderIds: c.orderIds }));
    const r = await seller.confirm(d, p.paymentId, { manual: true });
    assert.equal(r.creditCents, 3200);
    assert.equal((await buyer.account(d, 'hee.bunny')).creditCents, 3200);
    const next = await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }, { variantId: shop.v.Hana, qty: 1 }]);   // 2150
    assert.equal(next.creditAppliedCents, 2150);
    const a = await buyer.account(d, 'hee.bunny');
    assert.equal(a.creditCents, 1050); assert.equal(a.dueCents, 0);
    assert.ok(a.orders.every(o => o.payState === 'paid'));
    await books();
  });

  test('paying ahead (no order yet) is kept as credit', async () => {
    await fresh();
    await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.Hana, qty: 1 }]);
    await seller.one(d, 'update public.settings set max_pending_payments = 5 returning 1');
    const p = await buyer.pay(d, 'hee.bunny', payBody({ amountCents: 4000 }));
    assert.equal((await buyer.account(d, 'hee.bunny')).pendingCents, 4000);
    const r = await seller.confirm(d, p.paymentId, { manual: true, autoApply: false });
    assert.equal(r.creditCents, 4000, 'auto-apply off: all of it stays as credit');
    const a = await buyer.account(d, 'hee.bunny');
    assert.equal(a.creditCents, 4000); assert.equal(a.dueCents, 350);
    await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.Hana, qty: 1 }]);    // any claim spends the credit on the oldest unpaid orders
    const b = await buyer.account(d, 'hee.bunny');
    assert.equal(b.dueCents, 0); assert.equal(b.creditCents, 4000 - 700);
    await books();
  });

  test('a payment can be split over several orders, oldest first after the ones the buyer chose', async () => {
    await fresh();
    const o1 = (await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }])).orderIds[0];       // 1800
    const o2 = (await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.Hana, qty: 2 }])).orderIds[0];    // 700
    const o3 = (await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.B, qty: 1 }])).orderIds[0];       // 1800
    const p = await buyer.pay(d, 'hee.bunny', payBody({ amountCents: 3000, orderIds: [o3] }));
    const r = await seller.confirm(d, p.paymentId, { manual: true });
    assert.deepEqual(r.allocated, [{ orderId: o3, cents: 1800 }, { orderId: o1, cents: 1200 }]);
    const a = await buyer.account(d, 'hee.bunny');
    const by = Object.fromEntries(a.orders.map(o => [o.id, o]));
    assert.equal(by[o3].payState, 'paid'); assert.equal(by[o1].paid, 1200); assert.equal(by[o2].paid, 0);
    await books();
  });

  test('the same transaction ID can not be confirmed twice', async () => {
    await fresh();
    const c1 = await buyer.claim(d, 'ann', [{ variantId: shop.v.A, qty: 1 }]);
    const c2 = await buyer.claim(d, 'bo', [{ variantId: shop.v.B, qty: 1 }]);
    const p1 = await buyer.pay(d, 'ann', payBody({ amountCents: 1800, txnId: 'PP-7XK31982', orderIds: c1.orderIds }));
    const p2 = await buyer.pay(d, 'bo', payBody({ amountCents: 1800, txnId: 'pp 7xk31982', orderIds: c2.orderIds, proof: proofOf(2) }));
    await seller.confirm(d, p1.paymentId, { manual: true });
    assert.equal((await seller.confirmFails(d, p2.paymentId, { manual: true })).hint, 'txn_used');
    assert.equal((await buyer.payFails(d, 'ann', payBody({ amountCents: 100, txnId: 'PP-7XK31982' }))).hint, 'txn_used');
    // a different method is a different ID space
    const p3 = await buyer.pay(d, 'bo', payBody({ amountCents: 100, txnId: 'PP-7XK31982', method: 'venmo', proof: proofOf(3) }));
    assert.ok(p3.paymentId);
    // short IDs (Zelle has none) are never treated as unique
    const p4 = await buyer.pay(d, 'bo', payBody({ amountCents: 100, txnId: '123', method: 'zelle', proof: proofOf(4) }));
    await seller.confirm(d, p4.paymentId, { manual: true });
    const p5 = await buyer.pay(d, 'ann', payBody({ amountCents: 100, txnId: '123', method: 'zelle', proof: proofOf(5) }));
    await seller.confirm(d, p5.paymentId, { manual: true });
    await books();
  });

  test('one incoming transfer can only be matched once', async () => {
    await fresh();
    const c1 = await buyer.claim(d, 'ann', [{ variantId: shop.v.A, qty: 1 }]);
    const c2 = await buyer.claim(d, 'bo', [{ variantId: shop.v.B, qty: 1 }]);
    const p1 = await buyer.pay(d, 'ann', payBody({ amountCents: 1800, orderIds: c1.orderIds }));
    const p2 = await buyer.pay(d, 'bo', payBody({ amountCents: 1800, orderIds: c2.orderIds, proof: proofOf(2) }));
    await seller.importFeed(d, [feedRow({ extId: '', amountCents: 1800 })]);
    const t = await incomingId(101);
    await seller.confirm(d, p1.paymentId, { incomingId: t });
    assert.equal((await seller.confirmFails(d, p2.paymentId, { incomingId: t })).hint, 'incoming_taken');
    assert.equal((await seller.fails(d, 'select public.admin_ignore_incoming($1::uuid, true)', [t])).hint, 'bad_state');
  });

  test('importing a feed skips transfers already in it', async () => {
    await fresh();
    const rows = [feedRow(), feedRow({ extId: 'PP-OTHER-1', amountCents: 900 }), feedRow({ extId: '', amountCents: 300 })];
    assert.deepEqual(await seller.importFeed(d, rows), { added: 3, skipped: 0 });
    assert.deepEqual(await seller.importFeed(d, rows), { added: 1, skipped: 2 }, 'only the one with no ID can repeat');
    assert.deepEqual(await seller.importFeed(d, [{ method: 'paypal', amountCents: 0 }, { method: 'bad method', amountCents: 5 }, { amountCents: 'x' }]), { added: 0, skipped: 3 });
    const t = await incomingId(101);
    await seller.one(d, 'select public.admin_ignore_incoming($1::uuid, true)', [t]);
    assert.equal((await raw(d, 'select status from public.incoming_transactions where no = 101'))[0].status, 'ignored');
    await seller.one(d, 'select public.admin_ignore_incoming($1::uuid, false)', [t]);
    assert.equal((await raw(d, 'select status from public.incoming_transactions where no = 101'))[0].status, 'unmatched');
  });

  test('rejecting a payment frees the order and gives the buyer 12 more hours', async () => {
    await fresh();
    const c = await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }]);
    const p = await buyer.pay(d, 'hee.bunny', payBody({ amountCents: 1800, orderIds: c.orderIds }));
    await d.tick(40 * H);                                                           // hold would end in 8h
    await seller.reject(d, p.paymentId, 'Screenshot is from a different payment');
    const a = await buyer.account(d, 'hee.bunny');
    assert.equal(a.orders[0].pending, 0); assert.equal(a.orders[0].toSend, 1800);
    assert.equal(a.orders[0].leftMs, 12 * H, '12 hours from now beats the 8 hours left');
    assert.equal(a.payments[0].status, 'rejected'); assert.equal(a.payments[0].rejectReason, 'Screenshot is from a different payment');
    assert.equal((await seller.confirmFails(d, p.paymentId, { manual: true })).hint, 'bad_state');
    await d.tick(13 * H);
    assert.equal((await buyer.account(d, 'hee.bunny')).orders[0].status, 'expired');
    await books();
  });

  test('money that arrived with no submission can be assigned to a buyer, even one with no account yet', async () => {
    await fresh();
    await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }]);
    await seller.importFeed(d, [feedRow({ extId: 'ZZ-111-AAA', amountCents: 2000 }), feedRow({ extId: 'ZZ-222-BBB', amountCents: 700, method: 'venmo' })]);
    const r = await seller.assign(d, await incomingId(101), 'hee.bunny');
    assert.equal(r.creditCents, 200);
    assert.equal((await buyer.account(d, 'hee.bunny')).orders[0].payState, 'paid');
    await seller.assign(d, await incomingId(102), 'brand.new');
    assert.equal((await raw(d, `select has_pass from public.buyers where username = 'brand.new'`))[0].has_pass, false);
    // when they first claim they choose a passcode, and the credit is there waiting
    const first = await buyer.claim(d, 'brand.new', [{ variantId: shop.v.Hana, qty: 1 }], 'my-new-pass');
    assert.equal(first.creditAppliedCents, 350);
    assert.equal((await buyer.account(d, 'brand.new', 'my-new-pass')).creditCents, 350);
    assert.equal((await seller.fails(d, 'select public.admin_assign_incoming($1::uuid,$2,$3::uuid[],true)', [await incomingId(101), 'ann', []])).hint, 'incoming_taken');
    await books();
  });

  test('cash or anything outside the feed can be recorded by hand', async () => {
    await fresh();
    await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }]);
    const r = await seller.record(d, 'Hee.Bunny', 'other', 1800, [], true, 'cash at the meetup');
    assert.deepEqual(r.allocated.map(x => x.cents), [1800]);
    assert.equal((await raw(d, 'select verified_manually, source, note from public.payments'))[0].note, 'cash at the meetup');
    assert.equal((await seller.fails(d, 'select public.admin_record_payment($1,$2,$3::int)', ['x', 'other', 0])).hint, 'bad_amount');
    await books();
  });

  test('lowering a shipping fee below what was paid returns the difference as credit, and credit goes to other orders', async () => {
    await fresh();
    const o1 = (await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }])).orderIds[0];        // 1800
    const o2 = (await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.Hana, qty: 1 }])).orderIds[0];     // 350
    assert.deepEqual(await seller.fee(d, o1, 500), { creditAppliedCents: 0, returnedToCreditCents: 0 });
    await seller.record(d, 'hee.bunny', 'other', 2300, [o1], false);                                        // pays o1 fully
    assert.equal((await buyer.account(d, 'hee.bunny')).orders.find(o => o.id === o1).payState, 'paid');
    const r = await seller.fee(d, o1, 200);                                                                  // total now 2000: 300 too much
    assert.deepEqual(r, { creditAppliedCents: 300, returnedToCreditCents: 300 });
    const a = await buyer.account(d, 'hee.bunny');
    assert.equal(a.orders.find(o => o.id === o1).paid, 2000);
    assert.equal(a.orders.find(o => o.id === o2).paid, 300, 'the freed 300 went to the other unpaid order');
    assert.equal((await seller.fails(d, 'select public.admin_set_shipping_fee($1::uuid, 50001)', [o1])).hint, 'bad_amount');
    await books();
  });

  test('cancelling a paid order puts the money back as credit, which pays the buyer’s other order', async () => {
    await fresh();
    const o1 = (await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }])).orderIds[0];
    const o2 = (await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.Hana, qty: 2 }])).orderIds[0];
    await seller.record(d, 'hee.bunny', 'other', 1800, [o1], false);
    const r = await seller.cancel(d, o1, 'Out of stock after all');
    assert.deepEqual(r, { refundedToCreditCents: 1800, reappliedCents: 700 });
    const a = await buyer.account(d, 'hee.bunny');
    assert.equal(a.orders.find(o => o.id === o2).payState, 'paid');
    assert.equal(a.creditCents, 1100);
    assert.equal(a.orders.find(o => o.id === o1).status, 'cancelled');
    assert.equal(await stockOf(d, shop.v.A), 3, 'stock is back');
    await books();
  });

  test('packing and shipping need a fully paid order', async () => {
    await fresh();
    const o = (await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }])).orderIds[0];
    assert.equal((await seller.fails(d, 'select public.admin_set_fulfillment($1::uuid,$2,$3)', [o, 'packed', ''])).hint, 'unpaid');
    assert.equal((await seller.fails(d, 'select public.admin_set_fulfillment($1::uuid,$2,$3)', [o, 'teleported', ''])).hint, 'bad_state');
    await seller.record(d, 'hee.bunny', 'other', 1800, [o]);
    await seller.fulfil(d, o, 'packed');
    await seller.fulfil(d, o, 'shipped', '1Z999');
    await seller.fulfil(d, o, 'pending');
    assert.equal((await raw(d, 'select fulfillment, tracking from public.orders'))[0].fulfillment, 'pending');
  });

  test('extending a hold, merging a mistyped username, resetting a passcode, blocking', async () => {
    await fresh();
    const o = (await buyer.claim(d, 'hee.bunnyy', [{ variantId: shop.v.A, qty: 1 }])).orderIds[0];            // typo
    await seller.one(d, 'select public.admin_extend_hold($1::uuid, 24)', [o]);
    assert.equal((await buyer.account(d, 'hee.bunnyy')).orders[0].leftMs, 72 * H);
    assert.equal((await seller.fails(d, 'select public.admin_extend_hold($1::uuid, 0)', [o])).hint, 'bad_input');
    await seller.record(d, 'hee.bunnyy', 'other', 500, [], false);
    await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.Hana, qty: 1 }], 'real-pass');
    await seller.one(d, 'select public.admin_merge_buyer($1,$2)', ['hee.bunnyy', 'hee.bunny']);
    const a = await buyer.account(d, 'hee.bunny', 'real-pass');
    assert.equal(a.orders.length, 2); assert.equal(a.creditCents, 0, 'the $5 credit was spent on the oldest unpaid order');
    assert.equal((await raw(d, `select count(*)::int c from public.buyers where username = 'hee.bunnyy'`))[0].c, 0);
    assert.equal((await seller.fails(d, 'select public.admin_merge_buyer($1,$2)', ['nobody', 'hee.bunny'])).hint, 'not_found');
    assert.equal((await seller.fails(d, 'select public.admin_merge_buyer($1,$2)', ['hee.bunny', 'hee.bunny'])).hint, 'bad_input');
    // merging into a name with no account moves the account (and its passcode) over
    await seller.one(d, 'select public.admin_merge_buyer($1,$2)', ['hee.bunny', 'bunny.final']);
    assert.equal((await buyer.account(d, 'bunny.final', 'real-pass')).orders.length, 2);
    // reset passcode: the old one stops working; the next claim sets a new one
    await seller.one(d, 'select public.admin_reset_passcode($1)', ['bunny.final']);
    assert.equal((await buyer.account(d, 'bunny.final', 'real-pass')).code, 'no_passcode');
    await buyer.claim(d, 'bunny.final', [{ variantId: shop.v.Hana, qty: 1 }], 'newer-pass');
    assert.equal((await buyer.account(d, 'bunny.final', 'newer-pass')).orders.length, 3);
    await books();
  });

  test('catalog edits: variants that were sold are archived, others deleted; products with orders can only be hidden', async () => {
    await fresh();
    const pid = (await raw(d, `select id from public.products where name = 'Album'`))[0].id;
    await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }]);
    const vs = await raw(d, 'select id, name, stock from public.variants where product_id = $1::uuid order by position', [pid]);
    // drop A (has an order) and B (never ordered), add C
    await seller.one(d, 'select public.admin_save_product($1::jsonb)', [J({ id: pid, groupId: shop.g, name: 'Album', priceCents: 2000, variants: [{ name: 'C', stock: 7 }] })]);
    const after = await raw(d, 'select name, stock, archived from public.variants where product_id = $1::uuid order by name', [pid]);
    assert.deepEqual(after.map(v => [v.name, v.stock, v.archived]), [['A', 0, true], ['C', 7, false]]);
    assert.equal((await buyer.claimFails(d, 'x.y', [{ variantId: shop.v.A, qty: 1 }])).hint, 'unavailable');
    assert.equal((await seller.fails(d, 'select public.admin_delete_product($1::uuid)', [pid])).hint, 'in_use');
    const open = await seller.one(d, 'select public.admin_save_product($1::jsonb)', [J({ groupId: shop.g, name: 'Temp', priceCents: 100, variants: [{ name: '', stock: 1 }] })]);
    await seller.one(d, 'select public.admin_delete_product($1::uuid)', [open]);
    assert.equal((await raw(d, 'select count(*)::int c from public.products where id = $1::uuid', [open]))[0].c, 0);
    assert.equal(vs.length, 2);
    // old orders keep the price and name they were claimed at
    const a = await buyer.account(d, 'hee.bunny');
    assert.equal(a.orders[0].lines[0].unitCents, 1800); assert.equal(a.orders[0].total, 1800);
  });

  test('catalog edits are checked', async () => {
    await fresh();
    const save = p => seller.fails(d, 'select public.admin_save_product($1::jsonb)', [J({ groupId: shop.g, name: 'X', priceCents: 100, variants: [{ name: '', stock: 1 }], ...p })]);
    assert.equal((await save({ name: '  ' })).hint, 'bad_input');
    assert.equal((await save({ groupId: crypto.randomUUID() })).hint, 'bad_input');
    assert.equal((await save({ priceCents: -1 })).hint, 'bad_input');
    assert.equal((await save({ priceCents: 500001 })).hint, 'bad_input');
    assert.equal((await save({ priceCents: 'free' })).hint, 'bad_input');
    assert.equal((await save({ variants: [] })).hint, 'bad_input');
    assert.equal((await save({ variants: [{ name: 'A', stock: -1 }] })).hint, 'bad_input');
    assert.equal((await save({ variants: [{ name: 'A', stock: 1000000 }] })).hint, 'bad_input');
    assert.equal((await save({ variants: [{ name: 'A', stock: 1, priceCents: 500001 }] })).hint, 'bad_input');
    assert.equal((await seller.fails(d, `select public.admin_save_group('{"name":""}'::jsonb)`)).hint, 'bad_input');
  });

  test('the snapshot has everything the seller screens need, shaped like the prototype’s state', async () => {
    await fresh();
    const c = await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }]);
    await buyer.pay(d, 'hee.bunny', payBody({ amountCents: 1800, orderIds: c.orderIds }));
    await seller.importFeed(d, [feedRow()]);
    const s = await seller.snapshot(d);
    for (const k of ['settings', 'groups', 'products', 'variants', 'buyers', 'orders', 'payments', 'allocations', 'incoming', 'log']) assert.ok(k in s, k);
    assert.equal(s.buyers['hee.bunny'].passHash, 'set');
    assert.equal(s.payments[0].proof.sha256, 'sha-1');
    assert.equal(s.payments[0].status, 'submitted');
    assert.deepEqual(s.payments[0].intendedOrderIds, c.orderIds);
    assert.equal(s.allocations.length, 1);
    assert.equal(s.variants.length, 5);
    assert.ok(s.log.length >= 2);
  });

  test('every seller action is refused for a stranger', async () => {
    await fresh();
    const c = await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }]);
    const p = await buyer.pay(d, 'hee.bunny', payBody({ amountCents: 1800, orderIds: c.orderIds }));
    await d.as('authenticated', STRANGER);
    const o = c.orderIds[0], u = crypto.randomUUID();
    for (const sql of [
      [`select public.admin_confirm_payment($1::uuid,null,null,true,true)`, [p.paymentId]], [`select public.admin_reject_payment($1::uuid,'')`, [p.paymentId]],
      [`select public.admin_cancel_order($1::uuid,'')`, [o]], [`select public.admin_set_fulfillment($1::uuid,'packed','')`, [o]],
      [`select public.admin_set_shipping_fee($1::uuid,0)`, [o]], [`select public.admin_extend_hold($1::uuid,5)`, [o]],
      [`select public.admin_import_incoming('[]'::jsonb)`, []], [`select public.admin_ignore_incoming($1::uuid,true)`, [u]],
      [`select public.admin_assign_incoming($1::uuid,'x','{}'::uuid[],true)`, [u]], [`select public.admin_record_payment('x','other',100)`, []],
      [`select public.admin_merge_buyer('a','b')`, []], [`select public.admin_save_group('{"name":"x"}'::jsonb)`, []],
      [`select public.admin_delete_product($1::uuid)`, [u]], [`select public.admin_reset_passcode('hee.bunny')`, []],
      [`select public.admin_set_blocked('hee.bunny', true)`, []], [`select public.release_expired_holds()`, []],
    ]) {
      await d.as('authenticated', STRANGER);
      assert.equal((await d.fails(sql[0], sql[1])).hint, 'forbidden', sql[0]);
    }
  });
});

/* =============================================================== 4. screenshots == */
describe('screenshots', { skip: SKIP }, () => {
  let d, shop;
  const setup = async () => { d = await Db.create(); shop = await seedShop(d); };
  const submit = async (user = 'hee.bunny') => {
    const c = await buyer.claim(d, user, [{ variantId: shop.v.A, qty: 1 }]);
    return buyer.pay(d, user, payBody({ amountCents: 1800, orderIds: c.orderIds }));
  };
  // (no RETURNING: Storage's own upload only needs the INSERT permission, and RETURNING would also need SELECT)
  const upload = async path => { await anon(d); await d.pg.query(`insert into storage.objects (bucket_id, name) values ('payment-proofs', $1)`, [path]); };
  const stored = async () => (await raw(d, `select name from storage.objects order by name`)).map(r => r.name);

  test('the buyer can upload once, to exactly the path the payment gave them', async () => {
    await setup();
    const p = await submit();
    assert.match(p.proofPath, /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/);
    await upload(p.proofPath);
    assert.deepEqual(await stored(), [p.proofPath]);
    await anon(d);
    assert.equal((await d.fails(`insert into storage.objects (bucket_id, name) values ('payment-proofs', $1)`, [p.proofPath])).code, '23505', 'write once');
  });

  test('no other path is accepted, in this bucket or any other', async () => {
    await setup();
    const p = await submit();
    const q = await submit('other.buyer');
    await upload(q.proofPath);                         // control: a valid upload does work
    await anon(d);
    for (const [bucket, name] of [['payment-proofs', crypto.randomUUID() + '/x.jpg'], ['payment-proofs', p.proofPath.replace('.jpg', '.png')],
      ['payment-proofs', p.proofPath.split('/')[0] + '/other.jpg'], ['payment-proofs', 'x/../' + p.proofPath]]) {
      await anon(d);
      assert.equal((await d.fails(`insert into storage.objects (bucket_id, name) values ($1, $2)`, [bucket, name])).code, '42501', name);
    }
    await d.pg.exec(`reset role`);
    await d.pg.exec(`insert into storage.buckets (id, name, public) values ('other', 'other', true)`);
    await anon(d);
    assert.equal((await d.fails(`insert into storage.objects (bucket_id, name) values ('other', $1)`, [p.proofPath])).code, '42501');
  });

  test('the upload window closes after 30 minutes, and once the seller has decided', async () => {
    await setup();
    const slow = await submit('slow.poke');
    const prompt = await submit('prompt.person');
    await upload(prompt.proofPath);                    // control: inside the window it works
    await d.tick(31 * 60e3);
    await anon(d);
    assert.equal((await d.fails(`insert into storage.objects (bucket_id, name) values ('payment-proofs', $1)`, [slow.proofPath])).code, '42501');
    const quick = await submit('quick.draw');
    await seller.reject(d, quick.paymentId, 'no');
    await anon(d);
    assert.equal((await d.fails(`insert into storage.objects (bucket_id, name) values ('payment-proofs', $1)`, [quick.proofPath])).code, '42501');
  });

  test('only the seller can see or remove the screenshots', async () => {
    await setup();
    const p = await submit();
    await upload(p.proofPath);
    await anon(d);
    assert.equal((await d.q(`select 1 from storage.objects`)).length, 0, 'logged-out: nothing visible');
    assert.equal((await d.q(`delete from storage.objects returning 1`)).length, 0, 'logged-out: nothing deleted');
    await d.as('authenticated', STRANGER);
    assert.equal((await d.q(`select 1 from storage.objects`)).length, 0, 'a stranger sees nothing');
    await d.as('authenticated', ADMIN);
    assert.equal((await d.q(`select name from storage.objects`)).length, 1);
    assert.equal((await d.q(`delete from storage.objects returning 1`)).length, 1);
  });
});

/* ========================================================= 5. same answers as the prototype == */
/*
   Random sequences of actions are run through two implementations at once:
     - JsWorld  : the prototype's rules (Core, from index.html), the way api.js drives them
     - SqlWorld : the database functions, called the way the app will call them
   After every action both must agree on: whether it worked (and the error code), and on all state -
   orders, payments, who paid what, the feed, stock, credit. At the end every buyer's account view is compared too.
*/
const CATALOG = [
  { group: 'NOVA9', products: [
    { key: 'album', name: 'Album', category: 'album', priceCents: 1800, variants: [['A', 4], ['B', 2]] },
    { key: 'card', name: 'Card', category: 'photocard', priceCents: 350, maxPerUser: 4, variants: [['Hana', 8], ['Jiwoo', 3]] },
    { key: 'pre1', name: 'Greetings', category: 'merch', priceCents: 2400, availability: 'incoming', payBy: T0 + 9 * D, variants: [['', 5]] }] },
  { group: 'LUNA', products: [
    { key: 'stick', name: 'Lightstick', category: 'merch', priceCents: 4500, maxPerUser: 1, variants: [['S', 3]] },
    { key: 'poster', name: 'Poster', category: 'other', priceCents: 1200, variants: [['P1', 6], ['P2', 6, 1500]] },
    { key: 'pre2', name: 'Fanmeeting', category: 'merch', priceCents: 3000, availability: 'incoming', payBy: T0 + 14 * D, variants: [['', 4]] },
    { key: 'drop', name: 'Drop', category: 'other', priceCents: 999, opensAt: T0 + 3 * D, variants: [['', 20]] }] },
];
const VKEYS = CATALOG.flatMap(g => g.products.flatMap(p => p.variants.map(([n]) => p.key + ':' + n)));
const USERS = ['ann', 'bo', 'cy', 'di', 'ed'];
const byNo = (a, b) => a.no - b.no;
const sortedBy = (arr, f) => arr.slice().sort((a, b) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0));

class JsWorld {
  constructor() { this.now = T0; this.s = Core.emptyState(T0); this.var = {}; this.prod = {}; }
  async init() {
    Object.assign(this.s.settings, { maxOpenUnpaidOrders: 4, maxPendingPayments: 2 });
    for (const g of CATALOG) {
      const grp = Core.upsertGroup(this.s, { name: g.group, members: [] }, this.now);
      for (const p of g.products) {
        const pr = Core.upsertProduct(this.s, { groupId: grp.id, name: p.name, category: p.category, priceCents: p.priceCents, availability: p.availability,
          payBy: p.payBy, opensAt: p.opensAt, maxPerUser: p.maxPerUser, variants: p.variants.map(([name, stock, priceCents]) => ({ name, stock, priceCents: priceCents ?? null })) }, this.now);
        this.prod[p.key] = pr.id;
        for (const [name] of p.variants) this.var[p.key + ':' + name] = this.s.variants.find(v => v.productId === pr.id && v.name === name).id;
      }
    }
  }
  setNow(ms) { this.now = ms; }
  orderId(no) { const o = this.s.orders.find(x => x.no === no); return o ? o.id : 'missing-' + no; }
  payId(no) { return (this.s.payments.find(x => x.no === no) || {}).id; }
  incId(no) { return no == null ? null : (this.s.incoming.find(x => x.no === no) || {}).id; }
  /** like api.js: release lapsed holds, run on a clone, keep it only if nothing threw */
  tx(fn) { Core.expireHolds(this.s, this.now); const draft = structuredClone(this.s); const out = fn(draft, this.now); this.s = draft; return out; }
  run(f) { try { return { ok: true, out: f() }; } catch (e) { if (e instanceof Core.AppError) return { ok: false, code: e.code }; throw e; } }
  /** the API layer's passcode gate: buyers must have an account (the passcode itself is always right in these runs) */
  needAccount(user) { Core.expireHolds(this.s, this.now); const b = this.s.buyers[user]; if (!b || !b.passHash) throw new Core.AppError('passcode:no_passcode'); }
  /** a refused action leaves no trace (a database rolls back), except a passcode refusal, which still releases lapsed holds first */
  async apply(op) {
    const before = structuredClone(this.s);
    const r = await this.applyInner(op);
    if (!r.ok && !String(r.code).startsWith('passcode:')) this.s = before;
    return r;
  }
  async applyInner(op) {
    const W = this;
    return this.run(() => {
      switch (op.t) {
        case 'claim': return W.tx((d, now) => {
          const b = d.buyers[op.user];
          if (!b || !b.passHash) Core.ensureBuyer(d, op.user, 'hash', 'salt', now);
          const r = Core.placeOrder(d, { username: op.user, lines: op.lines.map(l => ({ variantId: W.var[l.key] ?? 'nope', qty: l.qty })) }, now);
          return { orders: r.orders.map(o => o.no), credit: r.creditAppliedCents };
        });
        case 'pay': W.needAccount(op.user); return W.tx((d, now) => {
          const p = Core.submitPayment(d, { username: op.user, method: op.method, amountCents: op.amountCents, txnId: op.txnId, senderName: op.senderName,
            paidAt: op.paidAt, proof: op.proof ? { sha256: op.proof.sha256, name: op.proof.name, dataUrl: 'data:,' } : null, orderIds: op.orderNos.map(n => W.orderId(n)) }, now);
          return { no: p.no };
        });
        case 'confirm': return W.tx((d, now) => {
          const r = Core.confirmPayment(d, { paymentId: W.payId(op.payNo), incomingId: W.incId(op.incNo), amountCents: op.amountCents, manualVerified: op.manual, autoApply: op.autoApply }, now);
          return { credit: r.creditCents, allocated: r.allocated.map(x => [d.orders.find(o => o.id === x.orderId).no, x.cents]) };
        });
        case 'reject': return W.tx((d, now) => { Core.rejectPayment(d, { paymentId: W.payId(op.payNo), reason: op.reason }, now); return null; });
        case 'import': return W.tx((d, now) => Core.addIncoming(d, op.items, now));
        case 'ignore': return W.tx((d, now) => { Core.ignoreIncoming(d, { incomingId: W.incId(op.incNo), ignore: op.ignore }, now); return null; });
        case 'assign': return W.tx((d, now) => {
          const r = Core.assignIncoming(d, { incomingId: W.incId(op.incNo), username: op.user, orderIds: op.orderNos.map(n => W.orderId(n)), autoApply: op.autoApply }, now);
          return { credit: r.creditCents, allocated: r.allocated.map(x => [d.orders.find(o => o.id === x.orderId).no, x.cents]) };
        });
        case 'record': return W.tx((d, now) => {
          const r = Core.recordManualPayment(d, { username: op.user, method: op.method, amountCents: op.amountCents, note: op.note, orderIds: op.orderNos.map(n => W.orderId(n)), autoApply: op.autoApply }, now);
          return { credit: r.creditCents, allocated: r.allocated.map(x => [d.orders.find(o => o.id === x.orderId).no, x.cents]) };
        });
        case 'cancel': return W.tx((d, now) => Core.cancelOrder(d, { orderId: W.orderId(op.orderNo), actor: 'admin', reason: op.reason }, now));
        case 'buyerCancel': W.needAccount(op.user); return W.tx((d, now) => {
          const o = d.orders.find(x => x.no === op.orderNo);
          if (!o || o.username !== op.user) throw new Core.AppError('not_found', 'Order not found.');
          return Core.cancelOrder(d, { orderId: o.id, actor: 'buyer' }, now);
        });
        case 'fee': return W.tx((d, now) => Core.setShippingFee(d, { orderId: W.orderId(op.orderNo), cents: op.cents }, now));
        case 'fulfil': return W.tx((d, now) => { Core.setFulfillment(d, { orderId: W.orderId(op.orderNo), to: op.to, tracking: op.tracking }, now); return null; });
        case 'extend': return W.tx((d, now) => { Core.extendHold(d, { orderId: W.orderId(op.orderNo), hours: op.hours }, now); return null; });
        case 'block': return W.tx((d, now) => {
          if (!d.buyers[op.user]) throw new Core.AppError('not_found', 'No such buyer.');
          d.buyers[op.user].blocked = op.blocked; return null;
        });
        case 'reset': return W.tx((d, now) => {
          if (!d.buyers[op.user]) throw new Core.AppError('not_found', 'No such buyer.');
          Object.assign(d.buyers[op.user], { passHash: null, salt: null, fails: 0, lockUntil: 0 }); return null;
        });
        case 'merge': return W.tx((d, now) => { Core.mergeBuyer(d, { from: op.from, to: op.to }, now); return null; });
        case 'restock': return W.tx((d, now) => {
          const pr = d.products.find(p => p.id === W.prod[op.product]);
          const vs = d.variants.filter(v => v.productId === pr.id && !v.archived).sort((a, b) => a.position - b.position);
          Core.upsertProduct(d, { ...pr, variants: vs.map(v => ({ id: v.id, name: v.name, priceCents: v.priceCents, stock: W.var[op.product + ':' + v.name] === v.id ? op.stock : v.stock })) }, now);
          return null;
        });
        case 'expire': return Core.expireHolds(W.s, W.now).length;
        case 'shop': W.s.settings.shopOpen = op.open; return null;
        default: throw new Error('unknown op ' + op.t);
      }
    });
  }
  state() {
    const s = this.s, ord = id => s.orders.find(o => o.id === id), pay = id => s.payments.find(p => p.id === id);
    const prodName = id => s.products.find(p => p.id === id).name;
    return {
      orders: s.orders.map(o => ({ no: o.no, user: o.username, status: o.status, ful: o.fulfillment, trk: o.tracking, fee: o.shippingFeeCents, hold: o.holdExpiresAt,
        closedAt: o.cancelledAt ?? null, why: o.cancelReason ?? null, lines: o.lines.map(l => [l.name, l.variantName, l.qty, l.unitCents].join('|')) })).sort(byNo),
      payments: s.payments.map(p => ({ no: p.no, user: p.username, method: p.method, amount: p.amountCents, txn: p.txnId, name: p.senderName, status: p.status, source: p.source,
        paidAt: p.paidAt, confirmedAt: p.confirmedAt, manual: p.verifiedManually, reject: p.rejectReason, note: p.note, proof: !!p.proof,
        intended: p.intendedOrderIds.map(id => ord(id).no), incNo: p.incomingId ? s.incoming.find(t => t.id === p.incomingId).no : null })).sort(byNo),
      allocs: s.allocations.map(a => `${pay(a.paymentId).no}:${ord(a.orderId).no}:${a.amountCents}`).sort(),
      incoming: s.incoming.map(t => ({ no: t.no, method: t.method, ext: t.extId, at: t.occurredAt, amount: t.amountCents, name: t.senderName, status: t.status,
        payNo: t.paymentId ? pay(t.paymentId).no : null, source: t.source })).sort(byNo),
      stock: Object.fromEntries(s.variants.map(v => [prodName(v.productId) + ':' + v.name, v.stock])),
      buyers: Object.fromEntries(Object.values(s.buyers).map(b => [b.username, { pass: !!b.passHash, blocked: !!b.blocked }])),
    };
  }
  async account(user) { Core.expireHolds(this.s, this.now); return Core.accountView(this.s, user, this.now); }
  async hasAccount(user) { const b = this.s.buyers[user]; return !!(b && b.passHash); }
}

class SqlWorld {
  constructor(d) { this.d = d; this.now = T0; this.maps = { order: {}, pay: {}, inc: {}, var: {}, prod: {} }; }
  async init() {
    const d = this.d;
    await seller.one(d, 'update public.settings set max_open_unpaid_orders = 4, max_pending_payments = 2 returning 1');
    for (const g of CATALOG) {
      const gid = await seller.one(d, 'select public.admin_save_group($1::jsonb)', [J({ name: g.group })]);
      for (const p of g.products) {
        const pid = await seller.one(d, 'select public.admin_save_product($1::jsonb)', [J({ groupId: gid, name: p.name, category: p.category, priceCents: p.priceCents,
          availability: p.availability, payBy: p.payBy, opensAt: p.opensAt, maxPerUser: p.maxPerUser, variants: p.variants.map(([name, stock, priceCents]) => ({ name, stock, priceCents: priceCents ?? null })) })]);
        this.maps.prod[p.key] = pid;
      }
    }
    await this.refreshMaps();
  }
  async setNow(ms) { this.now = ms; await this.d.setNow(ms); }
  async refreshMaps() {
    const m = this.maps;
    m.order = Object.fromEntries((await raw(this.d, 'select no, id from public.orders')).map(r => [r.no, r.id]));
    m.pay = Object.fromEntries((await raw(this.d, 'select no, id from public.payments')).map(r => [r.no, r.id]));
    m.inc = Object.fromEntries((await raw(this.d, 'select no, id from public.incoming_transactions')).map(r => [r.no, r.id]));
    for (const r of await raw(this.d, `select v.id, v.name vname, p.id pid from public.variants v join public.products p on p.id = v.product_id`)) {
      const key = Object.entries(m.prod).find(([, id]) => id === r.pid)[0];
      m.var[key + ':' + r.vname] = r.id;
    }
  }
  oid(no) { return this.maps.order[no] ?? crypto.randomUUID(); }
  async call(fn, sql, params, role = 'admin') {
    try {
      const out = role === 'admin' ? await seller.one(this.d, sql, params) : (await anon(this.d), await this.d.one(sql, params));
      if (out && out.ok === false) return { ok: false, code: 'passcode:' + out.code };
      return { ok: true, out };
    } catch (e) {
      if (e.code === 'P0001' && e.hint) return { ok: false, code: e.hint };
      throw e;
    }
  }
  async apply(op) {
    const M = this.maps;
    const alloc = r => ({ credit: r.creditCents, allocated: r.allocated.map(x => [Number(Object.entries(M.order).find(([, id]) => id === x.orderId)[0]), x.cents]) });
    let r;
    switch (op.t) {
      case 'claim': r = await this.call('claim', 'select public.place_order($1,$2,$3::jsonb)', [op.user, PASS, J(op.lines.map(l => ({ variantId: M.var[l.key] ?? crypto.randomUUID(), qty: l.qty })))], 'anon');
        if (r.ok) await this.refreshMaps();
        if (r.ok) { const nos = r.out.orderIds.map(id => null); r.out = { orders: (await raw(this.d, 'select no from public.orders where id = any($1::uuid[]) order by no', [r.out.orderIds])).map(x => x.no), credit: r.out.creditAppliedCents }; void nos; }
        return r;
      case 'pay': r = await this.call('pay', 'select public.submit_payment($1,$2,$3::jsonb)', [op.user, PASS, J({ method: op.method, amountCents: op.amountCents, txnId: op.txnId,
        senderName: op.senderName, paidAt: op.paidAt, proof: op.proof ? { sha256: op.proof.sha256, name: op.proof.name, ext: 'jpg' } : null, orderIds: op.orderNos.map(n => this.oid(n)) })], 'anon');
        if (r.ok) { await this.refreshMaps(); r.out = { no: r.out.no }; }
        return r;
      case 'confirm': r = await this.call('confirm', 'select public.admin_confirm_payment($1::uuid,$2::uuid,$3::int,$4::boolean,$5::boolean)', [M.pay[op.payNo], op.incNo == null ? null : M.inc[op.incNo], op.amountCents, op.manual, op.autoApply]);
        if (r.ok) r.out = alloc(r.out);
        return r;
      case 'reject': return this.call('reject', 'select public.admin_reject_payment($1::uuid,$2)', [M.pay[op.payNo], op.reason]).then(x => x.ok ? { ok: true, out: null } : x);
      case 'import': r = await this.call('import', 'select public.admin_import_incoming($1::jsonb)', [J(op.items)]);
        if (r.ok) await this.refreshMaps();
        return r;
      case 'ignore': return this.call('ignore', 'select public.admin_ignore_incoming($1::uuid,$2::boolean)', [M.inc[op.incNo], op.ignore]).then(x => x.ok ? { ok: true, out: null } : x);
      case 'assign': r = await this.call('assign', 'select public.admin_assign_incoming($1::uuid,$2,$3::uuid[],$4::boolean)', [M.inc[op.incNo], op.user, op.orderNos.map(n => this.oid(n)), op.autoApply]);
        if (r.ok) { await this.refreshMaps(); r.out = alloc(r.out); }
        return r;
      case 'record': r = await this.call('record', 'select public.admin_record_payment($1,$2,$3::int,$4,$5::uuid[],$6::boolean)', [op.user, op.method, op.amountCents, op.note, op.orderNos.map(n => this.oid(n)), op.autoApply]);
        if (r.ok) { await this.refreshMaps(); r.out = alloc(r.out); }
        return r;
      case 'cancel': return this.call('cancel', 'select public.admin_cancel_order($1::uuid,$2)', [this.oid(op.orderNo), op.reason]);
      case 'buyerCancel': return this.call('buyerCancel', 'select public.cancel_my_order($1,$2,$3::uuid)', [op.user, PASS, this.oid(op.orderNo)], 'anon');
      case 'fee': return this.call('fee', 'select public.admin_set_shipping_fee($1::uuid,$2::int)', [this.oid(op.orderNo), op.cents]);
      case 'fulfil': return this.call('fulfil', 'select public.admin_set_fulfillment($1::uuid,$2,$3)', [this.oid(op.orderNo), op.to, op.tracking]).then(x => x.ok ? { ok: true, out: null } : x);
      case 'extend': return this.call('extend', 'select public.admin_extend_hold($1::uuid,$2::int)', [this.oid(op.orderNo), op.hours]).then(x => x.ok ? { ok: true, out: null } : x);
      case 'block': return this.call('block', 'select public.admin_set_blocked($1,$2::boolean)', [op.user, op.blocked]).then(x => x.ok ? { ok: true, out: null } : x);
      case 'reset': return this.call('reset', 'select public.admin_reset_passcode($1)', [op.user]).then(x => x.ok ? { ok: true, out: null } : x);
      case 'merge': return this.call('merge', 'select public.admin_merge_buyer($1,$2)', [op.from, op.to]).then(x => x.ok ? { ok: true, out: null } : x);
      case 'restock': {
        const pid = M.prod[op.product];
        const p = (await raw(this.d, `select id, group_id, name, category, description, price_cents, availability, private.ms(pay_by) pay_by, private.ms(opens_at) opens_at,
          max_per_user, status, image_url from public.products where id = $1::uuid`, [pid]))[0];
        const vs = await raw(this.d, 'select id, name, stock, price_cents from public.variants where product_id = $1::uuid and not archived order by position', [pid]);
        return this.call('restock', 'select public.admin_save_product($1::jsonb)', [J({ id: p.id, groupId: p.group_id, name: p.name, category: p.category, description: p.description,
          priceCents: p.price_cents, availability: p.availability, payBy: p.pay_by, opensAt: p.opens_at, maxPerUser: p.max_per_user, status: p.status, imageUrl: p.image_url,
          variants: vs.map(v => ({ id: v.id, name: v.name, priceCents: v.price_cents, stock: M.var[op.product + ':' + v.name] === v.id ? op.stock : v.stock })) })]).then(x => x.ok ? { ok: true, out: null } : x);
      }
      case 'expire': return this.call('expire', 'select public.release_expired_holds()', []);
      case 'shop': await seller.one(this.d, 'update public.settings set shop_open = $1::boolean returning 1', [op.open]); return { ok: true, out: null };
      default: throw new Error('unknown op ' + op.t);
    }
  }
  async state() {
    const [row] = await raw(this.d, `select jsonb_build_object(
      'orders', (select coalesce(jsonb_agg(jsonb_build_object('no', o.no, 'user', o.username, 'status', o.status, 'ful', o.fulfillment, 'trk', o.tracking, 'fee', o.shipping_fee_cents,
         'hold', private.ms(o.hold_expires_at), 'closedAt', private.ms(o.cancelled_at), 'why', o.cancel_reason,
         'lines', (select coalesce(jsonb_agg(l.name || '|' || l.variant_name || '|' || l.qty || '|' || l.unit_cents order by l.position), '[]') from public.order_lines l where l.order_id = o.id)) order by o.no), '[]') from public.orders o),
      'payments', (select coalesce(jsonb_agg(jsonb_build_object('no', p.no, 'user', p.username, 'method', p.method, 'amount', p.amount_cents, 'txn', p.txn_id, 'name', p.sender_name,
         'status', p.status, 'source', p.source, 'paidAt', private.ms(p.paid_at), 'confirmedAt', private.ms(p.confirmed_at), 'manual', p.verified_manually, 'reject', p.reject_reason,
         'note', p.note, 'proof', p.proof_path is not null,
         'intended', (select coalesce(jsonb_agg(o.no order by array_position(p.intended_order_ids, o.id)), '[]') from public.orders o where o.id = any(p.intended_order_ids)),
         'incNo', (select t.no from public.incoming_transactions t where t.payment_id = p.id)) order by p.no), '[]') from public.payments p),
      'allocs', (select coalesce(jsonb_agg(p.no || ':' || o.no || ':' || a.amount_cents order by p.no, o.no), '[]') from public.payment_allocations a join public.payments p on p.id = a.payment_id join public.orders o on o.id = a.order_id),
      'incoming', (select coalesce(jsonb_agg(jsonb_build_object('no', t.no, 'method', t.method, 'ext', t.ext_id, 'at', private.ms(t.occurred_at), 'amount', t.amount_cents, 'name', t.sender_name,
         'status', t.status, 'payNo', (select p.no from public.payments p where p.id = t.payment_id), 'source', t.source) order by t.no), '[]') from public.incoming_transactions t),
      'stock', (select coalesce(jsonb_object_agg(p.name || ':' || v.name, v.stock), '{}') from public.variants v join public.products p on p.id = v.product_id),
      'buyers', (select coalesce(jsonb_object_agg(b.username, jsonb_build_object('pass', b.has_pass, 'blocked', b.blocked)), '{}') from public.buyers b)
    ) as s`);
    const s = row.s;
    s.allocs = sortedBy(s.allocs, x => x);
    // JSON keeps nulls as null; the prototype uses null too
    return s;
  }
  async account(user) { await anon(this.d); const a = await this.d.one('select public.my_account($1,$2)', [user, PASS]); assert.equal(a.ok, undefined, 'my_account refused ' + user + ': ' + J(a)); return a; }
  async hasAccount(user) { return (await buyer.status(this.d, user)).exists; }
}

function normAccount(a) {
  return {
    credit: a.creditCents, due: a.dueCents, pending: a.pendingCents, toSend: a.toSendCents,
    orders: a.orders.map(o => ({ no: o.no, status: o.status, ful: o.fulfillment, trk: o.tracking, fee: o.shippingFeeCents, total: o.total, paid: o.paid, due: o.due, pending: o.pending,
      toSend: o.toSend, payState: o.payState, leftMs: o.leftMs, lines: o.lines.map(l => [l.name, l.variantName, l.qty, l.unitCents].join('|')) })).sort(byNo),
    payments: a.payments.map(p => ({ no: p.no, status: p.status, amount: p.amountCents, method: p.method, remaining: p.remaining,
      covers: p.covers.map(c => c.orderNo + ':' + c.cents).sort() })).sort(byNo),
  };
}

/** JSON with object keys sorted, so two equal values always print the same. */
const canon = x => J(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([p], [q]) => (p < q ? -1 : 1))) : v));
/** First place two values differ, as a readable path. */
function firstDiff(a, b, path = '') {
  if (canon(a) === canon(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) { const r = firstDiff(a[k], b[k], path + (Array.isArray(a) ? `[${k}]` : '.' + k)); if (r) return r; }
  }
  return `${path}: prototype=${J(a)} sql=${J(b)}`;
}

function lcg(seed) { let x = seed >>> 0; return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32; }

/** Pick the next action from what currently exists in the prototype's world. */
function genOp(rnd, w) {
  const s = w.s;
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = arr => (arr.length ? arr[Math.floor(rnd() * arr.length)] : null);
  const chance = p => rnd() < p;
  const openOrders = s.orders.filter(o => o.status === 'open');
  const withAcct = USERS.filter(u => s.buyers[u] && s.buyers[u].passHash);
  const buyerWho = () => (withAcct.length && chance(0.93) ? pick(withAcct) : pick(USERS));
  const stockOf = k => s.variants.find(v => v.id === w.var[k]).stock;
  const inStock = VKEYS.filter(k => stockOf(k) > 0);
  const paidUp = o => Core.orderDue(s, o) === 0, noMoney = o => Core.orderPaid(s, o.id) === 0 && Core.orderPending(s, o.id) === 0;
  const subs = s.payments.filter(p => p.status === 'submitted');
  const unmatched = s.incoming.filter(t => t.status === 'unmatched');
  const ignored = s.incoming.filter(t => t.status === 'ignored');
  const orderNos = (u, n) => { const mine = openOrders.filter(o => o.username === u); const out = []; while (out.length < n && mine.length) { const o = pick(mine); if (!out.includes(o.no)) out.push(o.no); if (out.length >= mine.length) break; } return out; };
  const method = () => pick(['paypal', 'paypal', 'venmo', 'zelle', 'zelle', 'other']);
  const txn = () => (chance(0.6) ? 'TXN' + int(100, 135) : '');
  const money = () => pick([150, 350, 700, 1000, 1800, 1800, 2150, 2500, 3600, 4200, 6000]);
  const table = [
    [22, () => ({ t: 'claim', user: pick(USERS), lines: Array.from({ length: int(1, 3) }, () => ({ key: chance(0.9) && inStock.length ? pick(inStock) : pick(VKEYS), qty: chance(0.85) ? int(1, 2) : int(3, 6) })) })],
    [20, () => {
      const u = buyerWho(), nos = chance(0.85) ? orderNos(u, int(1, 2)) : [];
      const due = nos.reduce((t, no) => t + Core.orderDue(s, s.orders.find(o => o.no === no)), 0);
      const amount = nos.length && chance(0.5) ? due : Math.max(50, (nos.length ? due : money()) + pick([0, 0, 300, -300, 800, -150]));
      return { t: 'pay', user: u, method: method(), amountCents: chance(0.03) ? 0 : amount, txnId: txn(), senderName: pick(['Hee Bunny', 'Ann Lee', '', 'A. Kim']), orderNos: nos,
        paidAt: chance(0.3) ? null : w.now - int(0, 30 * 60) * 60e3, proof: chance(0.9) ? { sha256: 'h' + int(1, 25), name: 'shot.jpg' } : null };
    }],
    [16, () => { const p = pick(subs); if (!p) return null;
      const twin = unmatched.find(x => x.amountCents === p.amountCents && x.method === p.method);
      const t = chance(0.6) ? (twin && chance(0.8) ? twin : pick(unmatched)) : null;
      return { t: 'confirm', payNo: p.no, incNo: t ? t.no : null, amountCents: chance(0.12) ? int(100, 5000) : null, manual: chance(0.6), autoApply: chance(0.85) }; }],
    [3, () => { const p = pick(subs); return p && { t: 'reject', payNo: p.no, reason: pick(['', 'wrong amount', 'blurry']) }; }],
    [9, () => ({ t: 'import', items: Array.from({ length: int(1, 3) }, () => ({ method: method(), extId: chance(0.7) ? 'TXN' + int(100, 135) : '', occurredAt: w.now - int(0, 40 * 60) * 60e3,
      amountCents: chance(0.5) && subs.length ? pick(subs).amountCents : money(), senderName: pick(['Hee Bunny', 'Ann Lee', '', 'A. Kim']), note: '', source: 'import' })) })],
    [2, () => { const t = pick(unmatched); return t && { t: 'ignore', incNo: t.no, ignore: true }; }],
    [1, () => { const t = pick(ignored); return t && { t: 'ignore', incNo: t.no, ignore: false }; }],
    [4, () => { const t = pick(unmatched); if (!t) return null; const u = pick(USERS); return { t: 'assign', incNo: t.no, user: u, orderNos: chance(0.6) ? orderNos(u, int(0, 2)) : [], autoApply: chance(0.8) }; }],
    [4, () => { const u = pick(USERS); return { t: 'record', user: u, method: pick(['other', 'paypal']), amountCents: money(), note: pick(['', 'cash']), orderNos: chance(0.5) ? orderNos(u, int(0, 2)) : [], autoApply: chance(0.8) }; }],
    [4, () => { const o = pick(openOrders); return o && { t: 'cancel', orderNo: o.no, reason: pick(['', 'sorry']) }; }],
    [4, () => { const o = (chance(0.7) && pick(openOrders.filter(noMoney))) || pick(openOrders); return o && { t: 'buyerCancel', user: chance(0.9) ? o.username : pick(USERS), orderNo: o.no }; }],
    [5, () => { const o = pick(openOrders); return o && { t: 'fee', orderNo: o.no, cents: pick([0, 0, 200, 500, 800, 1500]) }; }],
    [8, () => { const o = (chance(0.85) && pick(openOrders.filter(paidUp))) || pick(openOrders); return o && { t: 'fulfil', orderNo: o.no, to: pick(['packed', 'packed', 'shipped', 'pending']), tracking: pick(['', '', 'TRK1']) }; }],
    [2, () => { const o = pick(openOrders); return o && { t: 'extend', orderNo: o.no, hours: int(1, 48) }; }],
    [1, () => ({ t: 'block', user: pick(USERS), blocked: chance(0.5) })],
    [1, () => ({ t: 'reset', user: pick(USERS) })],
    [1, () => ({ t: 'merge', from: pick(USERS), to: pick([...USERS, 'zed']) })],
    [6, () => ({ t: 'restock', product: pick(CATALOG.flatMap(g => g.products.map(p => p.key))), stock: int(0, 9) })],
    [3, () => ({ t: 'expire' })],
    [1, () => ({ t: 'shop', open: chance(0.7) })],
  ];
  const total = table.reduce((t, [wgt]) => t + wgt, 0);
  if (!s.settings.shopOpen && chance(0.3)) return { t: 'shop', open: true, dt: 60e3 };      // a closed shop reopens soon
  for (let tries = 0; tries < 20; tries++) {
    let r = rnd() * total, op = null;
    for (const [wgt, f] of table) { if ((r -= wgt) < 0) { op = f(); break; } }
    if (op) {
      // time moves on between actions; sometimes a lot (holds lapse, pay-by dates pass, drops open)
      op.dt = (chance(0.06) ? int(6 * 3600, 70 * 3600) : int(60, 90 * 60)) * 1000;
      return op;
    }
  }
  return { t: 'expire', dt: 60e3 };
}

describe('storefront and appearance', { skip: SKIP }, () => {
  let d, shop;
  test('setup', async () => {
    d = await Db.create();
    shop = await seedShop(d);
    const g2 = await seller.one(d, 'select public.admin_save_group($1::jsonb)', [J({ name: 'Backstage', active: false })]);
    await seller.one(d, 'select public.admin_save_product($1::jsonb)', [J({ groupId: g2, name: 'In a hidden group', priceCents: 100, variants: [{ name: '', stock: 4 }] })]);
    await seller.one(d, 'select public.admin_save_product($1::jsonb)', [J({ groupId: shop.g, name: 'Secret', priceCents: 100, status: 'hidden', variants: [{ name: '', stock: 1 }] })]);
  });

  test('the public shop info is the whole storefront: catalog, live stock, and the look of the shop', async () => {
    await buyer.claim(d, 'hee.bunny', [{ variantId: shop.v.A, qty: 1 }]);
    await anon(d);
    const info = await d.one('select public.shop_info()');
    assert.deepEqual(info.groups.map(g => g.name), ['NOVA9']);
    assert.deepEqual(info.products.map(p => p.name).sort(), ['Album', 'Card', 'Greetings']);
    const album = info.products.find(p => p.name === 'Album');
    assert.deepEqual(info.variants.filter(v => v.productId === album.id).map(v => [v.name, v.stock]), [['A', 2], ['B', 1]]);   // one A is held
    assert.equal(info.variants.length, 5);                                  // nothing from hidden products or hidden groups
    assert.equal(info.accentColor, '#96D6F0');
    assert.equal(info.tagline, ''); assert.equal(info.notice, '');
    assert.equal(info.now, d.now);
    const txt = JSON.stringify(info);
    assert.ok(!txt.includes('hee.bunny') && !txt.includes('username'), 'no buyer data in the public feed');
  });

  test('asking for the shop info also lets lapsed holds go, so the counts are right', async () => {
    await d.tick(49 * H);
    await anon(d);
    const info = await d.one('select public.shop_info()');
    const album = info.products.find(p => p.name === 'Album');
    assert.deepEqual(info.variants.filter(v => v.productId === album.id).map(v => v.stock), [3, 1]);
    assert.equal((await raw(d, `select status from public.orders where no = 1001`))[0].status, 'expired');
  });

  test('the seller can change the colour, tagline and announcement, and visitors see it at once', async () => {
    await seller.one(d, 'select public.admin_save_settings($1::jsonb)', [J({ accentColor: '#A7D8F0', tagline: 'Photocards & albums, shipped from NJ', notice: 'Orders close Sunday 9pm ET' })]);
    await anon(d);
    const info = await d.one('select public.shop_info()');
    assert.equal(info.accentColor, '#a7d8f0');
    assert.equal(info.tagline, 'Photocards & albums, shipped from NJ');
    assert.equal(info.notice, 'Orders close Sunday 9pm ET');
    const snap = await seller.snapshot(d);
    assert.equal(snap.settings.accentColor, '#a7d8f0');
    assert.equal(snap.settings.tagline, 'Photocards & albums, shipped from NJ');
    assert.equal(typeof snap.now, 'number');
  });

  test('a bad colour or an out-of-range number is refused and nothing is half-saved', async () => {
    const before_ = JSON.stringify((await seller.snapshot(d)).settings);
    for (const [patch, hint] of [
      [{ accentColor: 'sky blue' }, 'bad_input'], [{ accentColor: '#12345' }, 'bad_input'], [{ accentColor: null }, 'bad_input'],
      [{ holdHours: 0 }, 'bad_input'], [{ holdHours: 721 }, 'bad_input'], [{ holdHours: '48' }, 'bad_input'], [{ holdHours: null }, 'bad_input'],
      [{ nearTolCents: -1 }, 'bad_input'], [{ nearTolCents: 1001 }, 'bad_input'],
      [{ maxOpenUnpaidOrders: 0 }, 'bad_input'], [{ maxPendingPayments: 51 }, 'bad_input'],
      // a valid field next to an invalid one: the whole save fails
      [{ shopName: 'Changed', holdHours: 0 }, 'bad_input'],
    ]) {
      const e = await seller.fails(d, 'select public.admin_save_settings($1::jsonb)', [J(patch)]);
      assert.equal(e.hint, hint, J(patch));
    }
    assert.equal((await seller.fails(d, `select public.admin_save_settings('[]'::jsonb)`)).hint, 'bad_input');
    assert.equal(J((await seller.snapshot(d)).settings), before_);
  });

  test('names, texts and payment methods are trimmed and cut to length; the rest of the methods stay as they were', async () => {
    await seller.one(d, 'select public.admin_save_settings($1::jsonb)', [J({
      shopName: '   ' + 'N'.repeat(60) + '  ', tagline: 'T'.repeat(120), notice: ' hello ',
      methods: [{ key: 'venmo', enabled: false, handle: '  @my-venmo ', hint: 'Friends and family' }, { key: 'nope', enabled: true, handle: 'x', hint: '' }] })]);
    const s = (await seller.snapshot(d)).settings;
    assert.equal(s.shopName, 'N'.repeat(40));
    assert.equal(s.tagline.length, 80);
    assert.equal(s.notice, 'hello');
    assert.deepEqual(s.methods.map(m => m.key), ['paypal', 'venmo', 'zelle', 'wise', 'other']);
    const v = s.methods.find(m => m.key === 'venmo');
    assert.deepEqual([v.enabled, v.handle, v.hint], [false, '@my-venmo', 'Friends and family']);
    assert.equal(s.methods.find(m => m.key === 'paypal').handle, '@your-paypal');
    await seller.one(d, 'select public.admin_save_settings($1::jsonb)', [J({ shopName: '   ' })]);
    assert.equal((await seller.snapshot(d)).settings.shopName, 'Shop Manager');         // blank falls back, like the prototype
    await anon(d);
    assert.deepEqual((await d.one('select public.shop_info()')).methods.map(m => m.key), ['paypal', 'zelle']);   // venmo is now off
  });

  test('only the seller can change settings; the table itself also refuses a bad colour', async () => {
    await anon(d);
    assert.equal((await d.fails(`select public.admin_save_settings('{"notice":"hi"}'::jsonb)`)).code, '42501');
    await d.as('authenticated', STRANGER);
    assert.equal((await d.fails(`select public.admin_save_settings('{"notice":"hi"}'::jsonb)`)).hint, 'forbidden');
    assert.equal((await d.q(`select 1 from public.settings`)).length, 0);
    await d.as('authenticated', ADMIN);
    assert.equal((await d.fails(`update public.settings set accent_color = 'red'`)).code, '23514');
    assert.equal((await d.fails(`update public.settings set tagline = repeat('x', 81)`)).code, '23514');
  });
});

describe('the database gives the same answers as the prototype', { skip: SKIP }, () => {
  const FROM = Number(process.env.FUZZ_FROM || 1), SEEDS = Number(process.env.FUZZ_SEEDS || 12), STEPS = Number(process.env.FUZZ_STEPS || 160);
  for (let seed = FROM; seed < FROM + SEEDS; seed++) {
    test(`random shop #${seed}: ${STEPS} actions, compared after every one`, async () => {
      const js = new JsWorld(), sql = new SqlWorld(await Db.create());
      await js.init(); await sql.init();
      assert.equal(firstDiff(js.state().stock, (await sql.state()).stock), null, 'catalogs differ at the start');
      const rnd = lcg(seed * 7919);
      const stats = {};
      const trail = [];
      for (let i = 0; i < STEPS; i++) {
        const op = genOp(rnd, js);
        js.setNow(js.now + op.dt); await sql.setNow(sql.now + op.dt);
        const a = await js.apply(op), b = await sql.apply(op);
        trail.push(op);
        const ctx = `seed ${seed}, step ${i}, ${J(op)}`;
        stats[op.t + (a.ok ? '' : ':' + a.code)] = (stats[op.t + (a.ok ? '' : ':' + a.code)] || 0) + 1;
        assert.equal(b.ok, a.ok, `${ctx}: prototype ${a.ok ? 'worked' : 'refused (' + a.code + ')'}, sql ${b.ok ? 'worked' : 'refused (' + b.code + ')'}`);
        if (!a.ok) assert.equal(b.code, a.code, `${ctx}: different error`);
        else if (op.t !== 'expire' || true) {
          const norm = r => (r && r.allocated ? { credit: r.credit, allocated: r.allocated } : r);
          const d1 = firstDiff(norm(a.out), norm(b.out));
          // results of cancel/fee/etc. are small objects; claim returns order numbers; expire returns a count
          assert.equal(d1, null, `${ctx}: results differ at ${d1}`);
        }
        const diff = firstDiff(js.state(), await sql.state());
        assert.equal(diff, null, `${ctx}: state differs at ${diff}`);
      }
      // what each buyer sees must match too, and the books must balance
      for (const u of USERS) {
        const ja = await js.hasAccount(u), sa = await sql.hasAccount(u);
        assert.equal(sa, ja, 'account exists for ' + u);
        if (!ja) continue;
        const diff = firstDiff(normAccount(await js.account(u)), normAccount(await sql.account(u)));
        assert.equal(diff, null, `seed ${seed}: account view of ${u} differs at ${diff}`);
      }
      assert.deepEqual(Core.checkInvariants(js.s), []);
      assert.deepEqual(await seller.books(sql.d), []);
      // the seller snapshot agrees with the prototype's state on the things the screens read
      const snap = await seller.snapshot(sql.d);
      assert.equal(snap.orders.length, js.s.orders.filter(o => o.status === 'open' || (js.now - (o.cancelledAt ?? o.createdAt)) < 60 * D).length);
      assert.equal(snap.payments.length, js.s.payments.length);
      assert.equal(snap.allocations.length, js.s.allocations.length);
      assert.equal(snap.incoming.length, js.s.incoming.length);
      assert.ok(Object.keys(stats).length > 6, 'the run should exercise a variety of actions: ' + J(stats));
      if (process.env.FUZZ_STATS) console.log(`seed ${seed}`, J(Object.fromEntries(Object.entries(stats).sort())), 'orders', js.s.orders.length, 'payments', js.s.payments.length,
        'confirmed', js.s.payments.filter(p => p.status === 'confirmed').length, 'expired', js.s.orders.filter(o => o.status === 'expired').length,
        'cancelled', js.s.orders.filter(o => o.status === 'cancelled').length, 'shipped', js.s.orders.filter(o => o.fulfillment === 'shipped').length);
      void trail;
    });
  }
});
