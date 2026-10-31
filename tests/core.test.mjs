// Tests for the money/stock/matching rules.
// Runs against whatever is between the <core> markers of index.html, so it tests what ships.
//   node --test tests/core.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = process.env.CORE_SRC || join(here, '..', 'index.html');
const html = readFileSync(srcPath, 'utf8');
const m = html.match(/\/\* <core> \*\/([\s\S]*?)\/\* <\/core> \*\//);
assert.ok(m, 'core markers not found in ' + srcPath);
const Core = new Function(m[1] + '\nreturn Core;')();
const { fmt, parseMoney, normUser } = Core;
const H = Core.HOUR, D = Core.DAY;
const T0 = Date.UTC(2026, 9, 30, 16, 0, 0);

/** Small catalog: 1 group, 3 products. */
function mk() {
  const s = Core.emptyState(T0);
  s.settings.methods.forEach(x => (x.enabled = true));
  const g = Core.upsertGroup(s, { name: 'NOVA9', members: ['Hana', 'Jiwoo'] }, T0);
  const album = Core.upsertProduct(s, { groupId: g.id, name: 'Album', category: 'album', priceCents: 1800, variants: [{ name: 'A', stock: 3 }, { name: 'B', stock: 1 }] }, T0);
  const card = Core.upsertProduct(s, { groupId: g.id, name: 'Card', category: 'photocard', priceCents: 350, maxPerUser: 4, variants: [{ name: 'Hana', stock: 10 }, { name: 'Jiwoo', stock: 0 }] }, T0);
  const pre = Core.upsertProduct(s, { groupId: g.id, name: 'Greetings', category: 'merch', priceCents: 2400, availability: 'incoming', payBy: T0 + 9 * D, variants: [{ name: '', stock: 5 }] }, T0);
  const v = (p, n) => s.variants.find(x => x.productId === p.id && x.name === n);
  return { s, g, album, card, pre, vA: v(album, 'A'), vB: v(album, 'B'), vHana: v(card, 'Hana'), vJiwoo: v(card, 'Jiwoo'), vPre: v(pre, '') };
}
const claim = (s, u, lines, now = T0) => Core.placeOrder(s, { username: u, lines }, now);
const proof = (n = 'a') => ({ dataUrl: 'data:image/jpeg;base64,AAAA', sha256: 'sha-' + n, name: n + '.jpg' });
const pay = (s, u, o) => Core.submitPayment(s, { username: u, method: 'paypal', ...o }, o.now || T0);
const feed = (s, items, now = T0) => Core.addIncoming(s, items.map(i => ({ method: 'paypal', ...i })), now);

test('money parsing and formatting', () => {
  assert.equal(parseMoney('$1,234.50'), 123450);
  assert.equal(parseMoney('12.5'), 1250);
  assert.equal(parseMoney('+ $23.00'), 2300);
  assert.equal(parseMoney('- $5.00'), -500);
  assert.equal(parseMoney('(4.00)'), -400);
  assert.equal(parseMoney(19.99), 1999);
  assert.ok(Number.isNaN(parseMoney('abc')));
  assert.ok(Number.isNaN(parseMoney('1.234')));
  assert.equal(fmt(123450), '$1,234.50');
  assert.equal(fmt(5), '$0.05');
  assert.equal(fmt(-250), '-$2.50');
});

test('usernames and passcodes are validated', () => {
  assert.equal(normUser('  @Hee.Bunny_ '), 'hee.bunny_');
  assert.throws(() => normUser('has space'), { code: 'bad_username' });
  assert.throws(() => normUser(''), { code: 'bad_username' });
  assert.throws(() => normUser('x'.repeat(31)), { code: 'bad_username' });
  assert.equal(Core.validPasscode(' ab12! '), 'ab12!');
  assert.throws(() => Core.validPasscode('abc'), { code: 'bad_passcode' });
  assert.throws(() => Core.validPasscode('ab cd'), { code: 'bad_passcode' });
});

test('sha256 matches the standard test vectors', () => {
  assert.equal(Core.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(Core.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('claim: reserves stock, snapshots price, starts the hold', () => {
  const { s, vA, album } = mk();
  const { orders } = claim(s, 'bunny', [{ variantId: vA.id, qty: 2 }]);
  assert.equal(orders.length, 1);
  assert.equal(vA.stock, 1);
  assert.equal(Core.orderTotal(orders[0]), 3600);
  assert.equal(orders[0].holdExpiresAt, T0 + 48 * H);
  album.priceCents = 9999;                       // later price change must not touch existing orders
  assert.equal(Core.orderTotal(orders[0]), 3600);
  assert.deepEqual(Core.checkInvariants(s), []);
});

test('claim: oversell is refused and changes nothing', () => {
  const { s, vB, vA } = mk();
  claim(s, 'first', [{ variantId: vB.id, qty: 1 }]);
  const before = JSON.stringify(s);
  assert.throws(() => claim(s, 'second', [{ variantId: vA.id, qty: 1 }, { variantId: vB.id, qty: 1 }]), { code: 'oversold' });
  assert.equal(JSON.stringify(s), before, 'a failed claim must not touch stock or orders');
});

test('claim: sold-out variant, hidden product, closed shop, blocked buyer, per-person limit', () => {
  const { s, vJiwoo, vHana, card } = mk();
  assert.throws(() => claim(s, 'a', [{ variantId: vJiwoo.id, qty: 1 }]), { code: 'oversold' });
  assert.throws(() => claim(s, 'a', [{ variantId: vHana.id, qty: 5 }]), { code: 'limit' });
  claim(s, 'a', [{ variantId: vHana.id, qty: 3 }]);
  assert.throws(() => claim(s, 'a', [{ variantId: vHana.id, qty: 2 }]), { code: 'limit' }, 'limit counts what they already hold');
  card.status = 'hidden';
  assert.throws(() => claim(s, 'b', [{ variantId: vHana.id, qty: 1 }]), { code: 'unavailable' });
  card.status = 'active';
  s.settings.shopOpen = false;
  assert.throws(() => claim(s, 'b', [{ variantId: vHana.id, qty: 1 }]), { code: 'closed' });
  s.settings.shopOpen = true;
  Core.ensureBuyer(s, 'b', 'h', 's', T0).blocked = true;
  assert.throws(() => claim(s, 'b', [{ variantId: vHana.id, qty: 1 }]), { code: 'blocked' });
});

test('claim: product that opens later cannot be claimed early', () => {
  const { s, vHana, card } = mk();
  card.opensAt = T0 + 30 * H;
  assert.throws(() => claim(s, 'a', [{ variantId: vHana.id, qty: 1 }]), { code: 'not_open' });
  assert.equal(Core.productState(s, card, T0).kind, 'soon');
  claim(s, 'a', [{ variantId: vHana.id, qty: 1 }], T0 + 31 * H);
});

test('pre-claim lines get their own order and deadline', () => {
  const { s, vA, vPre } = mk();
  const { orders } = claim(s, 'sora', [{ variantId: vA.id, qty: 1 }, { variantId: vPre.id, qty: 1 }]);
  assert.equal(orders.length, 2);
  const pre = orders.find(o => o.lines[0].productId === vPre.productId);
  const std = orders.find(o => o !== pre);
  assert.equal(std.holdExpiresAt, T0 + 48 * H);
  assert.equal(pre.holdExpiresAt, T0 + 9 * D);
});

test('payment: submit proposes allocations, nothing counts until confirmed', () => {
  const { s, vA } = mk();
  const [o] = claim(s, 'bunny', [{ variantId: vA.id, qty: 1 }]).orders;
  const p = pay(s, 'bunny', { amountCents: 1800, proof: proof(), orderIds: [o.id] });
  assert.equal(p.status, 'submitted');
  assert.equal(Core.orderPaid(s, o.id), 0);
  assert.equal(Core.orderPending(s, o.id), 1800);
  assert.equal(Core.orderPayState(s, o), 'unpaid');
});

test('payment: needs a screenshot when required, valid amount, right owner', () => {
  const { s, vA } = mk();
  const [o] = claim(s, 'bunny', [{ variantId: vA.id, qty: 1 }]).orders;
  assert.throws(() => pay(s, 'bunny', { amountCents: 1800, orderIds: [o.id] }), { code: 'need_proof' });
  assert.throws(() => pay(s, 'bunny', { amountCents: 0, proof: proof(), orderIds: [o.id] }), { code: 'bad_amount' });
  assert.throws(() => pay(s, 'bunny', { amountCents: 1800.5, proof: proof(), orderIds: [o.id] }), { code: 'bad_amount' });
  assert.throws(() => pay(s, 'someone', { amountCents: 1800, proof: proof(), orderIds: [o.id] }), { code: 'bad_order' });
  assert.throws(() => pay(s, 'bunny', { amountCents: 1800, proof: proof(), orderIds: [o.id], paidAt: T0 + D }), { code: 'bad_time' });
  s.settings.requireProof = false;
  pay(s, 'bunny', { amountCents: 1800, orderIds: [o.id] });
});

test('confirm: exact payment pays the order in full', () => {
  const { s, vA } = mk();
  const [o] = claim(s, 'bunny', [{ variantId: vA.id, qty: 1 }]).orders;
  const p = pay(s, 'bunny', { amountCents: 1800, txnId: '5AB77201CD', proof: proof(), orderIds: [o.id] });
  feed(s, [{ extId: '5AB77201CD', amountCents: 1800, senderName: 'Hee Bunny', occurredAt: T0 }]);
  const t = s.incoming[0];
  const r = Core.confirmPayment(s, { paymentId: p.id, incomingId: t.id }, T0 + H);
  assert.equal(r.creditCents, 0);
  assert.equal(Core.orderPayState(s, o), 'paid');
  assert.equal(Core.orderDue(s, o), 0);
  assert.equal(t.status, 'matched');
  assert.deepEqual(Core.checkInvariants(s), []);
});

test('confirm: needs real money or an explicit "I checked"', () => {
  const { s, vA } = mk();
  const [o] = claim(s, 'bunny', [{ variantId: vA.id, qty: 1 }]).orders;
  const p = pay(s, 'bunny', { amountCents: 1800, proof: proof(), orderIds: [o.id] });
  assert.throws(() => Core.confirmPayment(s, { paymentId: p.id }, T0), { code: 'verify_required' });
  Core.confirmPayment(s, { paymentId: p.id, manualVerified: true }, T0);
  assert.equal(p.verifiedManually, true);
  assert.equal(Core.orderPayState(s, o), 'paid');
});

test('confirm: the seller’s feed amount wins over what the buyer typed', () => {
  const { s, vA } = mk();
  const [o] = claim(s, 'bunny', [{ variantId: vA.id, qty: 1 }]).orders;
  const p = pay(s, 'bunny', { amountCents: 1800, proof: proof(), orderIds: [o.id] });
  feed(s, [{ extId: 'ZZ99887766', amountCents: 1750, senderName: 'x', occurredAt: T0 }]);
  Core.confirmPayment(s, { paymentId: p.id, incomingId: s.incoming[0].id }, T0);
  assert.equal(p.amountCents, 1750);
  assert.equal(Core.orderPayState(s, o), 'partial');
  assert.equal(Core.orderDue(s, o), 50);
});

test('confirm: overpayment becomes credit, and credit pays the next claim automatically', () => {
  const { s, vA, vHana } = mk();
  const [o] = claim(s, 'bunny', [{ variantId: vA.id, qty: 1 }]).orders;
  const p = pay(s, 'bunny', { amountCents: 2500, proof: proof(), orderIds: [o.id] });
  const r = Core.confirmPayment(s, { paymentId: p.id, manualVerified: true, autoApply: true }, T0);
  assert.equal(r.creditCents, 700);
  assert.equal(Core.buyerCredit(s, 'bunny'), 700);
  const { orders, creditAppliedCents } = claim(s, 'bunny', [{ variantId: vHana.id, qty: 1 }], T0 + H);   // $3.50
  assert.equal(creditAppliedCents, 350);
  assert.equal(Core.orderPayState(s, orders[0]), 'paid');
  assert.equal(Core.buyerCredit(s, 'bunny'), 350);
  assert.deepEqual(Core.checkInvariants(s), []);
});

test('confirm: leftover goes to the buyer’s other unpaid orders (oldest first) unless told not to', () => {
  const { s, vA, vHana } = mk();
  const [o1] = claim(s, 'bunny', [{ variantId: vA.id, qty: 1 }], T0).orders;
  const [o2] = claim(s, 'bunny', [{ variantId: vHana.id, qty: 2 }], T0 + H).orders;   // $7.00
  const p = pay(s, 'bunny', { amountCents: 2500, proof: proof(), orderIds: [o1.id] });
  const r = Core.confirmPayment(s, { paymentId: p.id, manualVerified: true }, T0 + 2 * H);
  assert.equal(r.creditCents, 0);
  assert.equal(Core.orderPayState(s, o1), 'paid');
  assert.equal(Core.orderPayState(s, o2), 'paid');
  const p2 = pay(s, 'bunny', { amountCents: 1000, proof: proof('b'), orderIds: [] }, T0 + 3 * H);
  const r2 = Core.confirmPayment(s, { paymentId: p2.id, manualVerified: true, autoApply: false }, T0 + 4 * H);
  assert.equal(r2.creditCents, 1000);
});

test('pay ahead: money before any claim is held as credit', () => {
  const { s } = mk();
  Core.ensureBuyer(s, 'early', 'h', 's', T0);
  const p = pay(s, 'early', { amountCents: 2000, proof: proof(), orderIds: [] });
  Core.confirmPayment(s, { paymentId: p.id, manualVerified: true }, T0);
  assert.equal(Core.buyerCredit(s, 'early'), 2000);
});

test('reuse of a confirmed transaction ID is blocked; duplicate screenshots are flagged', () => {
  const { s, vA, vHana } = mk();
  const [o1] = claim(s, 'a', [{ variantId: vA.id, qty: 1 }]).orders;
  const [o2] = claim(s, 'b', [{ variantId: vHana.id, qty: 1 }]).orders;
  const p1 = pay(s, 'a', { amountCents: 1800, txnId: 'TX-1234567', proof: proof('same'), orderIds: [o1.id] });
  Core.confirmPayment(s, { paymentId: p1.id, manualVerified: true }, T0);
  assert.throws(() => pay(s, 'b', { amountCents: 350, txnId: 'tx 1234567', proof: proof('x'), orderIds: [o2.id] }), { code: 'txn_used' });
  const p2 = pay(s, 'b', { amountCents: 350, txnId: '', proof: proof('same'), orderIds: [o2.id] });
  assert.ok(Core.paymentFlags(s, p2).some(f => f.code === 'dup_image'));
});

test('short and over payments are flagged for the seller', () => {
  const { s, vA } = mk();
  const [o] = claim(s, 'a', [{ variantId: vA.id, qty: 1 }]).orders;
  const lo = pay(s, 'a', { amountCents: 1500, proof: proof('1'), orderIds: [o.id] });
  const hi = pay(s, 'a', { amountCents: 2000, proof: proof('2'), orderIds: [o.id] });
  assert.ok(Core.paymentFlags(s, lo).some(f => f.code === 'short'));
  assert.ok(Core.paymentFlags(s, hi).some(f => f.code === 'over'));
});

test('reject: removes proposed money and gives the buyer time to fix it', () => {
  const { s, vA } = mk();
  const [o] = claim(s, 'a', [{ variantId: vA.id, qty: 1 }]).orders;
  const p = pay(s, 'a', { amountCents: 1800, proof: proof(), orderIds: [o.id] }, T0);
  const later = T0 + 47 * H;
  Core.rejectPayment(s, { paymentId: p.id, reason: 'Blurry' }, later);
  assert.equal(Core.orderPending(s, o.id), 0);
  assert.ok(o.holdExpiresAt >= later + Core.REJECT_GRACE_H * H, 'grace period applied');
  assert.equal(p.rejectReason, 'Blurry');
});

test('expiry: only untouched holds are released, and stock comes back', () => {
  const { s, vA, vHana } = mk();
  const [unpaid] = claim(s, 'a', [{ variantId: vA.id, qty: 2 }]).orders;
  const [inReview] = claim(s, 'b', [{ variantId: vHana.id, qty: 1 }]).orders;
  const [part] = claim(s, 'c', [{ variantId: vA.id, qty: 1 }]).orders;
  pay(s, 'b', { amountCents: 350, proof: proof('b'), orderIds: [inReview.id] });
  const pc = pay(s, 'c', { amountCents: 500, proof: proof('c'), orderIds: [part.id] });
  Core.confirmPayment(s, { paymentId: pc.id, manualVerified: true }, T0 + H);
  const out = Core.expireHolds(s, T0 + 49 * H);
  assert.deepEqual(out.map(o => o.id), [unpaid.id]);
  assert.equal(unpaid.status, 'expired');
  assert.equal(inReview.status, 'open', 'a payment in review protects the hold');
  assert.equal(part.status, 'open', 'an order with money on it never auto-expires');
  assert.equal(vA.stock, 2, '3 - 1(c) = 2 after a’s 2 came back');
  assert.deepEqual(Core.checkInvariants(s), []);
});

test('cancel: buyer can cancel unpaid; paid orders return money to credit when the seller cancels', () => {
  const { s, vA, vHana } = mk();
  const [o] = claim(s, 'a', [{ variantId: vA.id, qty: 1 }]).orders;
  Core.cancelOrder(s, { orderId: o.id, actor: 'buyer' }, T0);
  assert.equal(vA.stock, 3);
  const [o2] = claim(s, 'a', [{ variantId: vA.id, qty: 1 }]).orders;
  const p = pay(s, 'a', { amountCents: 1800, proof: proof(), orderIds: [o2.id] });
  assert.throws(() => Core.cancelOrder(s, { orderId: o2.id, actor: 'buyer' }, T0), { code: 'has_money' });
  Core.confirmPayment(s, { paymentId: p.id, manualVerified: true }, T0);
  const r = Core.cancelOrder(s, { orderId: o2.id, actor: 'admin' }, T0);
  assert.equal(r.refundedToCreditCents, 1800);
  assert.equal(Core.buyerCredit(s, 'a'), 1800);
  assert.equal(vA.stock, 3);
  const [o3] = claim(s, 'a', [{ variantId: vHana.id, qty: 1 }]).orders;   // credit is spent on it
  assert.equal(Core.orderPayState(s, o3), 'paid');
  assert.deepEqual(Core.checkInvariants(s), []);
});

test('lowering a shipping fee after payment returns the difference to credit', () => {
  const { s, vA } = mk();
  const [o] = claim(s, 'a', [{ variantId: vA.id, qty: 1 }]).orders;
  Core.setShippingFee(s, { orderId: o.id, cents: 500 }, T0);
  const p = pay(s, 'a', { amountCents: 2300, proof: proof(), orderIds: [o.id] });
  Core.confirmPayment(s, { paymentId: p.id, manualVerified: true }, T0);
  assert.equal(Core.orderPayState(s, o), 'paid');
  const r = Core.setShippingFee(s, { orderId: o.id, cents: 100 }, T0);
  assert.equal(r.returnedToCreditCents, 400);
  assert.equal(Core.orderDue(s, o), 0);
  assert.equal(Core.buyerCredit(s, 'a'), 400);
  assert.deepEqual(Core.checkInvariants(s), []);
});

test('fulfilment: can’t pack an unpaid order; shipping fee reopens a balance', () => {
  const { s, vA } = mk();
  const [o] = claim(s, 'a', [{ variantId: vA.id, qty: 1 }]).orders;
  assert.throws(() => Core.setFulfillment(s, { orderId: o.id, to: 'packed' }, T0), { code: 'unpaid' });
  const p = pay(s, 'a', { amountCents: 1800, proof: proof(), orderIds: [o.id] });
  Core.confirmPayment(s, { paymentId: p.id, manualVerified: true }, T0);
  Core.setFulfillment(s, { orderId: o.id, to: 'packed' }, T0);
  Core.setShippingFee(s, { orderId: o.id, cents: 380 }, T0);
  assert.equal(Core.orderDue(s, o), 380);
  assert.equal(Core.orderPayState(s, o), 'partial');
  assert.throws(() => Core.setFulfillment(s, { orderId: o.id, to: 'shipped' }, T0), { code: 'unpaid' });
});

test('fulfilment: a tracking number typed before "Packed" is kept; shipping without one is allowed', () => {
  const { s, vA, vB } = mk();
  const [o] = claim(s, 'a', [{ variantId: vA.id, qty: 1 }]).orders;
  Core.confirmPayment(s, { paymentId: pay(s, 'a', { amountCents: 1800, proof: proof(), orderIds: [o.id] }).id, manualVerified: true }, T0);
  Core.setFulfillment(s, { orderId: o.id, to: 'packed', tracking: ' 9400 1000 ' }, T0);
  assert.equal(o.tracking, '9400 1000');
  Core.setFulfillment(s, { orderId: o.id, to: 'shipped', tracking: '9400 1000' }, T0);
  assert.equal(o.tracking, '9400 1000');
  // plain-envelope orders ship with no tracking at all
  const [o2] = claim(s, 'b', [{ variantId: vB.id, qty: 1 }]).orders;
  Core.confirmPayment(s, { paymentId: pay(s, 'b', { amountCents: 1800, proof: proof('b'), orderIds: [o2.id] }).id, manualVerified: true }, T0);
  Core.setFulfillment(s, { orderId: o2.id, to: 'shipped' }, T0);
  assert.equal(o2.fulfillment, 'shipped');
  assert.equal(o2.tracking, '');
});

test('account view: "still to send" ignores money that is already in review', () => {
  const { s, vA, vB } = mk();
  const [o1] = claim(s, 'a', [{ variantId: vA.id, qty: 1 }]).orders;      // $18
  const [o2] = claim(s, 'a', [{ variantId: vB.id, qty: 1 }]).orders;      // $18
  let v = Core.accountView(s, 'a', T0);
  assert.equal(v.dueCents, 3600);
  assert.equal(v.toSendCents, 3600);
  pay(s, 'a', { amountCents: 1800, proof: proof(), orderIds: [o1.id] });
  v = Core.accountView(s, 'a', T0);
  assert.equal(v.dueCents, 3600, 'nothing is confirmed yet, so the full amount is still due');
  assert.equal(v.pendingCents, 1800);
  assert.equal(v.toSendCents, 1800, 'but the buyer only needs to send the rest');
  assert.equal(v.orders.find(x => x.id === o1.id).toSend, 0);
  assert.equal(v.orders.find(x => x.id === o2.id).toSend, 1800);
});

/* ---------------- matching ---------------- */
test('matching: transaction ID + amount = exact', () => {
  const { s, vA } = mk();
  const [o] = claim(s, 'bunny', [{ variantId: vA.id, qty: 1 }]).orders;
  const p = pay(s, 'bunny', { amountCents: 1800, txnId: '5AB77201CD', senderName: 'Hee Bunny', proof: proof(), orderIds: [o.id], paidAt: T0 });
  feed(s, [{ extId: '5ab7-7201 cd', amountCents: 1800, senderName: 'Heebunny Kim', occurredAt: T0 + H }, { extId: 'OTHER99999', amountCents: 1800, occurredAt: T0 - 10 * D }]);
  const r = Core.suggestMatches(s, T0)[p.id];
  assert.equal(r.level, 'exact');
  assert.equal(r.incomingId, s.incoming[0].id);
});

test('matching: Zelle with no transaction ID uses amount + time + name', () => {
  const { s, vA } = mk();
  const [o] = claim(s, 'yuna', [{ variantId: vA.id, qty: 1 }]).orders;
  const p = pay(s, 'yuna', { method: 'zelle', amountCents: 1800, senderName: 'Yuna Park', proof: proof(), orderIds: [o.id], paidAt: T0 });
  feed(s, [{ method: 'zelle', extId: '', amountCents: 1800, senderName: 'YUNA PARK', occurredAt: T0 + 2 * H }]);
  const r = Core.suggestMatches(s, T0)[p.id];
  assert.equal(r.level, 'likely');
});

test('matching: two identical amounts and no names = possible, never likely', () => {
  const { s, vA } = mk();
  const [o1] = claim(s, 'one', [{ variantId: vA.id, qty: 1 }]).orders;
  const [o2] = claim(s, 'two', [{ variantId: vA.id, qty: 1 }]).orders;
  const p1 = pay(s, 'one', { method: 'zelle', amountCents: 1800, proof: proof('1'), orderIds: [o1.id], paidAt: T0, now: T0 + 2 * H });
  const p2 = pay(s, 'two', { method: 'zelle', amountCents: 1800, proof: proof('2'), orderIds: [o2.id], paidAt: T0 + H, now: T0 + 2 * H });
  feed(s, [{ method: 'zelle', amountCents: 1800, senderName: 'A Person', occurredAt: T0 }, { method: 'zelle', amountCents: 1800, senderName: 'B Person', occurredAt: T0 + H }]);
  const r = Core.suggestMatches(s, T0);
  assert.equal(r[p1.id].level, 'possible');
  assert.equal(r[p2.id].level, 'possible');
  assert.notEqual(r[p1.id].incomingId, r[p2.id].incomingId, 'one incoming transfer can only back one payment');
});

test('matching: names break the tie between look-alike amounts', () => {
  const { s, vA } = mk();
  const [o1] = claim(s, 'one', [{ variantId: vA.id, qty: 1 }]).orders;
  const [o2] = claim(s, 'two', [{ variantId: vA.id, qty: 1 }]).orders;
  const p1 = pay(s, 'one', { method: 'zelle', amountCents: 1800, senderName: 'Yuna Park', proof: proof('1'), orderIds: [o1.id], paidAt: T0 });
  const p2 = pay(s, 'two', { method: 'zelle', amountCents: 1800, senderName: 'Dohyun Seo', proof: proof('2'), orderIds: [o2.id], paidAt: T0 });
  feed(s, [{ method: 'zelle', amountCents: 1800, senderName: 'Dohyun Seo', occurredAt: T0 }, { method: 'zelle', amountCents: 1800, senderName: 'Yuna Park', occurredAt: T0 }]);
  const r = Core.suggestMatches(s, T0);
  assert.equal(s.incoming.find(t => t.id === r[p1.id].incomingId).senderName, 'Yuna Park');
  assert.equal(s.incoming.find(t => t.id === r[p2.id].incomingId).senderName, 'Dohyun Seo');
  assert.equal(r[p1.id].level, 'likely', 'a full name match settles the tie');
  assert.equal(r[p2.id].level, 'likely');
});

test('matching: one side with a name and one without stays "possible" for the nameless one', () => {
  const { s, vA } = mk();
  const [o1] = claim(s, 'one', [{ variantId: vA.id, qty: 1 }]).orders;
  const [o2] = claim(s, 'two', [{ variantId: vA.id, qty: 1 }]).orders;
  const p1 = pay(s, 'one', { method: 'zelle', amountCents: 1800, senderName: 'Yuna Park', proof: proof('1'), orderIds: [o1.id], paidAt: T0 });
  const p2 = pay(s, 'two', { method: 'zelle', amountCents: 1800, senderName: '', proof: proof('2'), orderIds: [o2.id], paidAt: T0 });
  feed(s, [{ method: 'zelle', amountCents: 1800, senderName: 'YUNA PARK', occurredAt: T0 }, { method: 'zelle', amountCents: 1800, senderName: 'D SEO', occurredAt: T0 }]);
  const r = Core.suggestMatches(s, T0);
  assert.equal(r[p1.id].level, 'likely');
  assert.equal(r[p2.id].level, 'possible');
  assert.equal(s.incoming.find(t => t.id === r[p2.id].incomingId).senderName, 'D SEO');
});

test('matching: other method, tiny amount drift, nothing in the feed', () => {
  const { s, vA } = mk();
  const [o] = claim(s, 'a', [{ variantId: vA.id, qty: 1 }]).orders;
  const p = pay(s, 'a', { method: 'paypal', amountCents: 1800, proof: proof(), orderIds: [o.id], paidAt: T0 });
  assert.equal(Core.suggestMatches(s, T0)[p.id].level, 'none');
  feed(s, [{ method: 'venmo', amountCents: 1800, occurredAt: T0 }]);
  assert.equal(Core.suggestMatches(s, T0)[p.id].level, 'none', 'a Venmo transfer can’t back a PayPal claim');
  feed(s, [{ method: 'paypal', amountCents: 1750, occurredAt: T0 }]);
  const r = Core.suggestMatches(s, T0)[p.id];
  assert.equal(r.level, 'possible');
  assert.ok(r.reasons.some(x => /off/.test(x)));
  feed(s, [{ method: 'paypal', amountCents: 900, occurredAt: T0 }]);
  assert.equal(s.incoming.length, 3);
});

test('matching: matched or ignored transfers are never suggested again', () => {
  const { s, vA } = mk();
  const [o] = claim(s, 'a', [{ variantId: vA.id, qty: 1 }]).orders;
  const p = pay(s, 'a', { amountCents: 1800, txnId: 'AAAA111122', proof: proof(), orderIds: [o.id] });
  feed(s, [{ extId: 'AAAA111122', amountCents: 1800 }]);
  Core.ignoreIncoming(s, { incomingId: s.incoming[0].id }, T0);
  assert.equal(Core.suggestMatches(s, T0)[p.id].level, 'none');
});

test('assign incoming money to a buyer who never submitted proof', () => {
  const { s, vA } = mk();
  const [o] = claim(s, 'chloe_p', [{ variantId: vA.id, qty: 1 }]).orders;
  feed(s, [{ method: 'venmo', extId: 'VN-3381-ZQ', amountCents: 1800, senderName: 'Chloe Park' }]);
  const sug = Core.suggestBuyersForIncoming(s, s.incoming[0]);
  assert.equal(sug[0].username, 'chloe_p');
  Core.assignIncoming(s, { incomingId: s.incoming[0].id, username: 'chloe_p', orderIds: sug[0].orderIds }, T0);
  assert.equal(Core.orderPayState(s, o), 'paid');
  assert.equal(s.incoming[0].status, 'matched');
  assert.deepEqual(Core.checkInvariants(s), []);
});

test('feed import: duplicates and junk rows are skipped, not fatal', () => {
  const { s } = mk();
  const csv = [
    'Date,Time,TimeZone,Name,Type,Status,Currency,Gross,Fee,Net,Transaction ID',
    '10/29/2026,14:03:11,PDT,Hee Bunny,Payment Received,Completed,USD,"1,023.00",0.00,"1,023.00",5AB77201CD',
    '10/29/2026,15:00:00,PDT,Someone,Payment Sent,Completed,USD,-5.00,0.00,-5.00,SENT0000001',
    '10/29/2026,16:00:00,PDT,Bad Date,Payment Received,Pending,USD,5.00,0,5.00,PEND0000001',
    '10/29/2026,17:00:00,PDT,Yuna Park,Payment Received,Completed,USD,12.00,0.00,12.00,YP12000001',
  ].join('\n');
  const { items, errors } = Core.parseFeed(csv, { defaultMethod: 'paypal', now: T0 });
  assert.equal(items.length, 2);
  assert.equal(items[0].amountCents, 102300);
  assert.equal(items[0].extId, '5AB77201CD');
  assert.equal(errors.length, 2);
  assert.deepEqual(Core.addIncoming(s, items, T0), { added: 2, skipped: 0 });
  assert.deepEqual(Core.addIncoming(s, items, T0), { added: 0, skipped: 2 }, 're-importing the same file adds nothing');
});

test('feed import: Venmo-style signs and a bare "date, name, amount, id" list', () => {
  const venmo = 'ID,Datetime,Type,Status,Note,From,To,Amount (total)\n3961234567,2026-10-29T18:22:10,Payment,Complete,x,Chloe Park,Me,+ $30.00\n3961234568,2026-10-29T19:00:00,Payment,Complete,x,Me,Bob,- $4.00';
  const a = Core.parseFeed(venmo, { defaultMethod: 'venmo', now: T0 });
  assert.equal(a.items.length, 1);
  assert.equal(a.items[0].amountCents, 3000);
  assert.equal(a.items[0].senderName, 'Chloe Park');
  const b = Core.parseFeed('2026-10-29 10:00, D Seo, $12.00, ZL-0001-ABC\n2026-10-29 11:00, Ann, nope', { defaultMethod: 'zelle', now: T0 });
  assert.equal(b.items.length, 1);
  assert.equal(b.items[0].method, 'zelle');
  assert.equal(b.errors.length, 1);
});

test('catalog: removing a variant that has orders archives it instead of deleting', () => {
  const { s, album, g, vA } = mk();
  claim(s, 'a', [{ variantId: vA.id, qty: 1 }]);
  Core.upsertProduct(s, { id: album.id, groupId: g.id, name: 'Album', category: 'album', priceCents: 1800, variants: [{ id: s.variants.find(v => v.name === 'B').id, name: 'B', stock: 1 }] }, T0);
  assert.equal(s.variants.find(v => v.id === vA.id).archived, true);
  assert.throws(() => Core.deleteProduct(s, album.id), { code: 'in_use' });
  assert.throws(() => claim(s, 'z', [{ variantId: vA.id, qty: 1 }]), { code: 'unavailable' });
});

test('merge a typo’d username into the real one', () => {
  const { s, vA } = mk();
  Core.ensureBuyer(s, 'bunny', 'h', 's', T0);
  Core.ensureBuyer(s, 'bunnny', 'h', 's', T0);
  const [o] = claim(s, 'bunnny', [{ variantId: vA.id, qty: 1 }]).orders;
  Core.mergeBuyer(s, { from: 'bunnny', to: 'bunny' }, T0);
  assert.equal(o.username, 'bunny');
  assert.equal(s.buyers.bunnny, undefined);
});

/* ---------------- randomized stress: no sequence of actions may break the books ---------------- */
test('fuzz: 4000 random operations never over-allocate money or oversell stock', () => {
  let seed = 12345;
  const rnd = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  const { s } = mk();
  const users = ['u1', 'u2', 'u3', 'u4'];
  users.forEach(u => Core.ensureBuyer(s, u, 'h', 's', T0));
  let now = T0;
  const initialStock = Core.sumBy(s.variants, v => v.stock);
  for (let i = 0; i < 4000; i++) {
    now += rnd(3) * H;
    const u = users[rnd(users.length)];
    try {
      switch (rnd(9)) {
        case 0: case 1: { const vs = s.variants.filter(v => !v.archived); claim(s, u, [{ variantId: vs[rnd(vs.length)].id, qty: 1 + rnd(3) }], now); break; }
        case 2: case 3: { const mine = s.orders.filter(o => o.username === u && o.status === 'open'); const pick = mine.filter(() => rnd(2)).map(o => o.id);
          pay(s, u, { amountCents: 100 + rnd(6000), proof: proof('f' + i), txnId: rnd(2) ? 'TX' + rnd(50) + 'ABCDE' : '', orderIds: pick, now, paidAt: now }); break; }
        case 4: { const sub = s.payments.filter(p => p.status === 'submitted'); if (sub.length) Core.confirmPayment(s, { paymentId: sub[rnd(sub.length)].id, manualVerified: true, autoApply: !!rnd(2) }, now); break; }
        case 5: { const sub = s.payments.filter(p => p.status === 'submitted'); if (sub.length) Core.rejectPayment(s, { paymentId: sub[rnd(sub.length)].id, reason: 'no' }, now); break; }
        case 6: { const op = s.orders.filter(o => o.status === 'open'); if (op.length) Core.cancelOrder(s, { orderId: op[rnd(op.length)].id, actor: rnd(2) ? 'admin' : 'buyer' }, now); break; }
        case 7: Core.expireHolds(s, now); break;
        case 8: { const op = s.orders.filter(o => o.status === 'open'); if (op.length) Core.setShippingFee(s, { orderId: op[rnd(op.length)].id, cents: rnd(900) }, now); break; }
      }
    } catch (e) { if (!(e instanceof Core.AppError)) throw e; }
    const bad = Core.checkInvariants(s);
    assert.deepEqual(bad, [], 'books broke at step ' + i + ': ' + bad.join('; '));
  }
  // conservation: every confirmed dollar is either on an order or sitting as credit
  const confirmed = Core.sumBy(s.payments.filter(p => p.status === 'confirmed'), p => p.amountCents);
  const onOrders = Core.sumBy(s.allocations.filter(a => Core.byId(s.payments, a.paymentId).status === 'confirmed'), a => a.amountCents);
  const credit = Core.sumBy(users, u => Core.buyerCredit(s, u));
  assert.equal(confirmed, onOrders + credit);
  // stock conservation: stock + units in open orders = what we started with
  const held = Core.sumBy(s.orders.filter(o => o.status === 'open'), o => Core.sumBy(o.lines, l => l.qty));
  assert.equal(Core.sumBy(s.variants, v => v.stock) + held, initialStock);
});

/* ---------- appearance: whatever colour the seller picks stays readable ---------- */
test('theme: sky blue is the default and every derived colour passes WCAG AA', () => {
  const t = Core.themeFrom(Core.DEFAULT_ACCENT);
  assert.equal(t.accent, '#96d6f0');
  assert.ok(Core.contrast(t.ink, t.accent) >= 7, 'dark text on the sky-blue fill is very legible');
  assert.ok(Core.contrast(t.dark, '#ffffff') >= 4.5 && Core.contrast(t.dark, t.light) >= 4.5);
  assert.deepEqual(Core.themeFrom('not a colour'), t, 'garbage falls back to the default look');
  assert.deepEqual(Core.themeFrom(''), t);
  assert.deepEqual(Core.themeFrom('#96D6F0'), t, 'upper or lower case is the same colour');
});

test('theme: 3000 random colours plus the extremes: text on the colour, links and hover are always readable', () => {
  let x = 12345; const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const hex = n => '#' + n.toString(16).padStart(6, '0');
  const colours = ['#000000', '#ffffff', '#808080', '#777777', '#7f7f7f', '#ffff00', '#00ff00', '#ff0000', '#0000ff', '#00ffff', '#ff00ff'];
  for (let i = 0; i < 3000; i++) colours.push(hex(Math.floor(rnd() * 0x1000000)));
  for (const c of colours) {
    const t = Core.themeFrom(c);
    assert.ok(Core.contrast(t.ink, t.accent) >= 4.5, `${c}: text on the colour ${Core.contrast(t.ink, t.accent).toFixed(2)}`);
    assert.ok(Core.contrast(t.ink, t.hover) >= 4.5, `${c}: text on hover`);
    assert.ok(Core.contrast(t.dark, t.light) >= 4.5, `${c}: link on the pale tint`);
    assert.ok(Core.contrast(t.dark, '#ffffff') >= 4.5, `${c}: link on white`);
    for (const bgc of [t.bg, t.soft, t.light]) { assert.ok(Core.contrast('#6b6a65', bgc) >= 4.5, `${c}: secondary text on the page tint ${bgc}`); assert.ok(Core.contrast(t.dark, bgc) >= 4.5, `${c}: link on the page tint ${bgc}`); }
    for (const k of Object.keys(t)) assert.match(t[k], /^#[0-9a-f]{6}$/, `${c}.${k}`);
  }
});
