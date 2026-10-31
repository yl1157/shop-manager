-- =============================================================================
-- SHOP MANAGER: database schema for Supabase (Postgres 15+)
--
-- Run this once in the Supabase SQL editor on a NEW project (not go-manager's).
-- It is safe to run again: tables, functions and policies are re-created in place.
--
-- How the pieces fit (full write-up in DESIGN.md):
--   * Buyers have no Supabase login. They are an Instagram username + a passcode.
--     They can read the public catalog directly and do everything else through
--     the SECURITY DEFINER functions in section 6, which check the passcode.
--   * The seller logs in with Supabase Auth (email + password). Everything the
--     seller does is a table read/write or an admin_* function, protected by
--     row level security that only lets rows through for users in public.admins.
--   * Money is a ledger: payments -> payment_allocations -> orders. An order's
--     "paid" amount is the sum of its allocations from CONFIRMED payments.
--     Nothing is ever marked paid by a column someone can edit.
--   * Payment screenshots live in a private Storage bucket and are only evidence.
--     Matching them to the seller's real PayPal / Venmo / Zelle feed happens in
--     the seller's browser (see the matcher in index.html); the database only
--     records the result.
--
-- Rules that must never break are enforced here, not in the browser:
--   stock can't go below zero, one transaction ID can't be confirmed twice,
--   wrong-passcode attempts lock the account, money moves only inside functions.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;      -- helpers; not exposed through the API

-- ------------------------------------------------------------------ 1. types --
do $$
declare t record;
begin
  for t in select * from (values
    ('product_category',     $e$('photocard', 'album', 'merch', 'other')$e$),
    ('product_availability', $e$('in_stock', 'incoming')$e$),
    ('product_status',       $e$('active', 'hidden')$e$),
    ('order_status',         $e$('open', 'cancelled', 'expired')$e$),
    ('fulfillment_status',   $e$('pending', 'packed', 'shipped')$e$),
    ('payment_status',       $e$('submitted', 'confirmed', 'rejected')$e$),
    ('payment_source',       $e$('buyer', 'admin')$e$),
    ('incoming_status',      $e$('unmatched', 'matched', 'ignored')$e$)
  ) v (name, vals)
  loop
    if not exists (select 1 from pg_type ty join pg_namespace n on n.oid = ty.typnamespace
                   where n.nspname = 'public' and ty.typname = t.name) then
      execute format('create type public.%I as enum %s', t.name, t.vals);
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------- 2. tables --
-- Who is the seller. Add yourself once after creating your Auth user (see README).
create table if not exists public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- One row of shop-wide settings.
create table if not exists public.settings (
  id                     boolean primary key default true check (id),
  shop_name              text    not null default 'Shop Manager' check (char_length(btrim(shop_name)) between 1 and 40),
  shop_open              boolean not null default true,
  hold_hours             int     not null default 48  check (hold_hours between 1 and 720),
  near_tol_cents         int     not null default 100 check (near_tol_cents between 0 and 1000),
  require_proof          boolean not null default true,
  max_open_unpaid_orders int     not null default 8   check (max_open_unpaid_orders between 1 and 50),
  max_pending_payments   int     not null default 3   check (max_pending_payments between 1 and 50),
  accent_color           text    not null default '#96D6F0' check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  tagline                text    not null default '' check (char_length(tagline) <= 80),
  notice                 text    not null default '' check (char_length(notice) <= 200),
  methods                jsonb   not null default '[
    {"key":"paypal","label":"PayPal","handle":"@your-paypal","enabled":true,"hint":"Send as Friends & Family, no note."},
    {"key":"venmo","label":"Venmo","handle":"@your-venmo","enabled":true,"hint":"No note needed."},
    {"key":"zelle","label":"Zelle","handle":"you@example.com","enabled":true,"hint":"Zelle has no transaction ID — we match by amount, time and your name."},
    {"key":"wise","label":"Wise","handle":"@your-wise","enabled":false,"hint":"Send in USD. Fees are on you."},
    {"key":"other","label":"Other","handle":"","enabled":false,"hint":"Cash / other — only when the seller agreed."}
  ]'::jsonb check (jsonb_typeof(methods) = 'array')
);
-- Added after the first release: harmless when the columns already exist.
alter table public.settings add column if not exists accent_color text not null default '#96D6F0' check (accent_color ~ '^#[0-9A-Fa-f]{6}$');
alter table public.settings add column if not exists tagline text not null default '' check (char_length(tagline) <= 80);
alter table public.settings add column if not exists notice text not null default '' check (char_length(notice) <= 200);
insert into public.settings (id) values (true) on conflict do nothing;

-- A group = an artist / band / theme that products belong to.
create table if not exists public.groups (
  id         uuid primary key default gen_random_uuid(),
  name       text    not null unique check (char_length(btrim(name)) between 1 and 60),
  color      text    not null default '#C2406F' check (color ~ '^#[0-9a-fA-F]{6}$'),
  members    text[]  not null default '{}',
  active     boolean not null default true,
  position   int     not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references public.groups (id) on delete restrict,
  name         text not null check (char_length(btrim(name)) between 1 and 100),
  category     public.product_category     not null default 'other',
  price_cents  int  not null check (price_cents between 0 and 500000),
  availability public.product_availability not null default 'in_stock',
  pay_by       timestamptz,                 -- pre-claim ("incoming") items: pay by this date
  opens_at     timestamptz,                 -- claims open at this moment (null = now)
  max_per_user int check (max_per_user is null or max_per_user >= 1),
  status       public.product_status not null default 'active',
  image_url    text not null default '' check (image_url = '' or image_url ~ '^https://'),
  description  text not null default '' check (char_length(description) <= 500),
  position     int  not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists products_group_idx on public.products (group_id);

-- A variant = the thing that has stock: a member's photocard, an album version, a size.
-- A product with no real variants has exactly one variant named ''.
create table if not exists public.variants (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products (id) on delete cascade,
  name        text not null default '' check (char_length(name) <= 60),
  stock       int  not null default 0 check (stock >= 0),          -- the oversell guard
  price_cents int  check (price_cents is null or price_cents between 0 and 500000),
  archived    boolean not null default false,                      -- removed but still referenced by old orders
  position    int  not null default 0
);
create unique index if not exists variants_product_name_uq on public.variants (product_id, name) where not archived;

-- Buyers: an Instagram username plus a passcode (bcrypt). No Supabase login.
create table if not exists public.buyers (
  username   text primary key check (username ~ '^[a-z0-9._]{1,30}$'),
  pass_hash  text,                                  -- null until their first claim, or after the seller resets it
  has_pass   boolean generated always as (pass_hash is not null) stored,
  fails      int  not null default 0,
  lock_until timestamptz,
  blocked    boolean not null default false,
  note       text not null default '' check (char_length(note) <= 300),
  created_at timestamptz not null default now()
);

create sequence if not exists public.order_no_seq    start 1001;
create sequence if not exists public.payment_no_seq  start 501;
create sequence if not exists public.incoming_no_seq start 101;

create table if not exists public.orders (
  id                 uuid primary key default gen_random_uuid(),
  no                 int  not null unique default nextval('public.order_no_seq'),
  username           text not null references public.buyers (username) on update cascade,
  status             public.order_status       not null default 'open',
  fulfillment        public.fulfillment_status not null default 'pending',
  tracking           text not null default '' check (char_length(tracking) <= 80),
  shipping_fee_cents int  not null default 0 check (shipping_fee_cents between 0 and 50000),
  note               text not null default '',
  hold_expires_at    timestamptz not null,
  cancel_reason      text,
  cancelled_at       timestamptz,
  created_at         timestamptz not null default now(),
  ship_to            jsonb check (ship_to is null or jsonb_typeof(ship_to) = 'object')   -- shipping address, filled in after payment is confirmed
);
alter table public.orders add column if not exists ship_to jsonb check (ship_to is null or jsonb_typeof(ship_to) = 'object');
create index if not exists orders_user_idx   on public.orders (username);
create index if not exists orders_status_idx on public.orders (status, hold_expires_at);

-- Lines copy the name and price at the moment of the claim, so later catalog edits never change an order.
create table if not exists public.order_lines (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.orders (id) on delete cascade,
  variant_id   uuid not null references public.variants (id),
  product_id   uuid not null references public.products (id),
  name         text not null,
  variant_name text not null default '',
  qty          int  not null check (qty between 1 and 99),
  unit_cents   int  not null check (unit_cents >= 0),
  position     int  not null default 0
);
create index if not exists order_lines_order_idx on public.order_lines (order_id);

-- What the buyer says they paid. status 'submitted' = waiting for the seller to match it to real money.
create table if not exists public.payments (
  id                 uuid primary key default gen_random_uuid(),
  no                 int  not null unique default nextval('public.payment_no_seq'),
  username           text not null references public.buyers (username) on update cascade,
  method             text not null check (method ~ '^[a-z0-9_]{1,20}$'),
  amount_cents       int  not null check (amount_cents > 0),
  txn_id             text not null default '' check (char_length(txn_id) <= 64),
  sender_name        text not null default '' check (char_length(sender_name) <= 80),
  paid_at            timestamptz not null,
  status             public.payment_status not null default 'submitted',
  source             public.payment_source not null default 'buyer',
  proof_path         text,                           -- Storage path in the private payment-proofs bucket
  proof_sha256       text,                           -- hash of the original image, to spot re-used screenshots
  proof_name         text,
  reject_reason      text not null default '' check (char_length(reject_reason) <= 200),
  confirmed_at       timestamptz,
  verified_manually  boolean not null default false, -- confirmed without a matching feed row ("I checked my account")
  intended_order_ids uuid[] not null default '{}',
  note               text not null default '' check (char_length(note) <= 120),
  created_at         timestamptz not null default now()
);
create index if not exists payments_user_idx   on public.payments (username);
create index if not exists payments_status_idx on public.payments (status);

-- Money the seller really received (pasted from a PayPal / Venmo / bank export, or typed in).
create table if not exists public.incoming_transactions (
  id          uuid primary key default gen_random_uuid(),
  no          int  not null unique default nextval('public.incoming_no_seq'),
  method      text not null check (method ~ '^[a-z0-9_]{1,20}$'),
  ext_id      text not null default '' check (char_length(ext_id) <= 64),
  occurred_at timestamptz not null,
  amount_cents int not null check (amount_cents > 0),
  sender_name text not null default '' check (char_length(sender_name) <= 80),
  note        text not null default '' check (char_length(note) <= 120),
  status      public.incoming_status not null default 'unmatched',
  payment_id  uuid references public.payments (id) on delete set null,
  source      text not null default 'import',
  created_at  timestamptz not null default now()
);
create index if not exists incoming_status_idx on public.incoming_transactions (status);

-- The ledger rows. A payment can pay several orders; an order can be paid by several payments.
create table if not exists public.payment_allocations (
  id           uuid primary key default gen_random_uuid(),
  payment_id   uuid not null references public.payments (id) on delete cascade,
  order_id     uuid not null references public.orders (id) on delete cascade,
  amount_cents int  not null check (amount_cents > 0),
  unique (payment_id, order_id)
);
create index if not exists alloc_order_idx   on public.payment_allocations (order_id);
create index if not exists alloc_payment_idx on public.payment_allocations (payment_id);

create table if not exists public.activity_log (
  id    bigint generated always as identity primary key,
  at    timestamptz not null default now(),
  actor text not null,
  msg   text not null
);

-- --------------------------------------------------------- 3. small helpers --
-- (The clock is a function so tests can control time. In production it is just now().)
create or replace function private.now_() returns timestamptz language sql stable as $$ select now() $$;
create or replace function private.ms(t timestamptz) returns bigint language sql immutable as $$ select (extract(epoch from t) * 1000)::bigint $$;
create or replace function private.ts(ms numeric) returns timestamptz language sql immutable as $$ select to_timestamp(ms / 1000.0) $$;
create or replace function private.fmt(cents int) returns text language sql immutable as $$ select '$' || to_char(cents / 100.0, 'FM999,999,990.00') $$;

-- Business-rule errors carry a stable code in HINT so the app can react to them.
create or replace function private.fail(code text, msg text) returns void language plpgsql as $$
begin
  raise exception '%', msg using errcode = 'P0001', hint = code;
end $$;

create or replace function private.norm_user(raw text) returns text language plpgsql stable as $$
declare u text := lower(regexp_replace(btrim(coalesce(raw, '')), '^@', ''));
begin
  if u !~ '^[a-z0-9._]{1,30}$' then
    perform private.fail('bad_username', 'Enter your Instagram username (letters, numbers, . and _ only).');
  end if;
  return u;
end $$;

create or replace function private.valid_passcode(raw text) returns text language plpgsql stable as $$
declare c text := btrim(coalesce(raw, ''));
begin
  if char_length(c) < 4 or char_length(c) > 20 then
    perform private.fail('bad_passcode', 'Passcode must be 4 to 20 characters.');
  end if;
  if c !~ '^[!-~]+$' then
    perform private.fail('bad_passcode', 'Passcode: letters, numbers and symbols only — no spaces or emoji.');
  end if;
  return c;
end $$;

-- Shipping addresses. One cleaner for the buyer and the seller: collapses spaces, checks lengths, and for a US address needs a
-- state and a ZIP code. The page applies the same rules, so the messages read the same everywhere.
create or replace function private.squash(s text) returns text language sql immutable as
$$ select btrim(regexp_replace(coalesce(s, ''), '\s+', ' ', 'g')) $$;

create or replace function private.clean_address(p jsonb) returns jsonb language plpgsql stable as $$
declare nm text; l1 text; l2 text; ct text; rg text; zp text; co text; us boolean;
begin
  if p is null or jsonb_typeof(p) <> 'object' then perform private.fail('bad_address', 'Enter the shipping address.'); end if;
  nm := private.squash(p ->> 'name');   l1 := private.squash(p ->> 'line1');  l2 := private.squash(p ->> 'line2');
  ct := private.squash(p ->> 'city');   rg := private.squash(p ->> 'region'); zp := private.squash(p ->> 'postal');
  co := private.squash(p ->> 'country');
  if co = '' then co := 'United States'; end if;
  us := lower(co) in ('us', 'usa', 'u.s.', 'u.s.a.', 'united states', 'united states of america');
  if us then
    co := 'United States';
    if rg ~ '^[A-Za-z]{2}$' then rg := upper(rg); end if;
  end if;
  if nm = '' then perform private.fail('bad_address', 'Enter the full name for the parcel.'); end if;
  if l1 = '' then perform private.fail('bad_address', 'Enter the street address.'); end if;
  if ct = '' then perform private.fail('bad_address', 'Enter the city.'); end if;
  if us and rg = '' then perform private.fail('bad_address', 'Enter the state.'); end if;
  if zp = '' then perform private.fail('bad_address', 'Enter the ZIP or postal code.'); end if;
  if us and zp !~ '^[0-9]{5}(-[0-9]{4})?$' then perform private.fail('bad_address', 'Enter a 5-digit ZIP code, like 07030.'); end if;
  if char_length(nm) > 80  then perform private.fail('bad_address', 'The name is too long (80 characters at most).'); end if;
  if char_length(l1) > 120 then perform private.fail('bad_address', 'The street address is too long (120 characters at most).'); end if;
  if char_length(l2) > 120 then perform private.fail('bad_address', 'The second address line is too long (120 characters at most).'); end if;
  if char_length(ct) > 60  then perform private.fail('bad_address', 'The city is too long (60 characters at most).'); end if;
  if char_length(rg) > 60  then perform private.fail('bad_address', 'The state or region is too long (60 characters at most).'); end if;
  if char_length(zp) > 20  then perform private.fail('bad_address', 'The ZIP or postal code is too long (20 characters at most).'); end if;
  if char_length(co) > 60  then perform private.fail('bad_address', 'The country is too long (60 characters at most).'); end if;
  return jsonb_build_object('name', nm, 'line1', l1, 'line2', l2, 'city', ct, 'region', rg, 'postal', zp, 'country', co);
end $$;

create or replace function private.norm_txn(s text) returns text language sql immutable as
$$ select upper(regexp_replace(coalesce(s, ''), '[^A-Za-z0-9]', '', 'g')) $$;
create or replace function private.meaningful_txn(s text) returns boolean language sql immutable as
$$ select char_length(private.norm_txn(s)) >= 6 $$;

-- Database-level guards for transaction IDs (the functions below check first and give a friendly message).
create unique index if not exists payments_confirmed_txn_uq
  on public.payments (method, private.norm_txn(txn_id))
  where status = 'confirmed' and char_length(private.norm_txn(txn_id)) >= 6;
create unique index if not exists incoming_txn_uq
  on public.incoming_transactions (method, private.norm_txn(ext_id))
  where char_length(private.norm_txn(ext_id)) >= 6;

create or replace function private.is_admin() returns boolean language sql stable security definer
set search_path = public, pg_temp as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid())
$$;

create or replace function private.require_admin() returns void language plpgsql stable as $$
begin
  if not private.is_admin() then
    perform private.fail('forbidden', 'Seller login required.');
  end if;
end $$;

create or replace function private.log_event(p_actor text, p_msg text) returns void language sql as
$$ insert into public.activity_log (at, actor, msg) values (private.now_(), p_actor, left(p_msg, 300)) $$;

-- ------------------------------------------------------ 4. row level security --
alter table public.admins                enable row level security;
alter table public.settings              enable row level security;
alter table public.groups                enable row level security;
alter table public.products              enable row level security;
alter table public.variants              enable row level security;
alter table public.buyers                enable row level security;
alter table public.orders                enable row level security;
alter table public.order_lines           enable row level security;
alter table public.payments              enable row level security;
alter table public.incoming_transactions enable row level security;
alter table public.payment_allocations   enable row level security;
alter table public.activity_log          enable row level security;

-- Anyone (including logged-out visitors) can read what is for sale. Nothing else.
drop policy if exists catalog_read on public.groups;
create policy catalog_read on public.groups for select to anon, authenticated using (active);
drop policy if exists catalog_read on public.products;
create policy catalog_read on public.products for select to anon, authenticated using (status = 'active');
drop policy if exists catalog_read on public.variants;
create policy catalog_read on public.variants for select to anon, authenticated
  using (not archived and exists (select 1 from public.products p where p.id = product_id and p.status = 'active'));

-- The seller can do everything; nobody else can touch these tables at all.
do $$
declare t text;
begin
  foreach t in array array['admins', 'settings', 'groups', 'products', 'variants', 'buyers', 'orders', 'order_lines',
                           'payments', 'incoming_transactions', 'payment_allocations', 'activity_log']
  loop
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('create policy admin_all on public.%I for all to authenticated using (private.is_admin()) with check (private.is_admin())', t);
  end loop;
end $$;

-- ------------------------------------------------- 5. ledger and order helpers --
create or replace function private.order_subtotal(p_order uuid) returns int language sql stable as
$$ select coalesce(sum(l.qty * l.unit_cents), 0)::int from public.order_lines l where l.order_id = p_order $$;

create or replace function private.order_total(p_order uuid) returns int language sql stable as
$$ select private.order_subtotal(p_order) + coalesce((select o.shipping_fee_cents from public.orders o where o.id = p_order), 0) $$;

create or replace function private.order_paid(p_order uuid) returns int language sql stable as $$
  select coalesce(sum(a.amount_cents), 0)::int
  from public.payment_allocations a join public.payments p on p.id = a.payment_id
  where a.order_id = p_order and p.status = 'confirmed'
$$;

create or replace function private.order_pending(p_order uuid) returns int language sql stable as $$
  select coalesce(sum(a.amount_cents), 0)::int
  from public.payment_allocations a join public.payments p on p.id = a.payment_id
  where a.order_id = p_order and p.status = 'submitted'
$$;

create or replace function private.order_due(p_order uuid) returns int language sql stable as $$
  select coalesce((select case when o.status = 'open'
                               then greatest(0, private.order_total(o.id) - private.order_paid(o.id)) else 0 end
                   from public.orders o where o.id = p_order), 0)
$$;

create or replace function private.pay_state(p_order uuid) returns text language sql stable as $$
  select case when private.order_total(p_order) > 0 and private.order_paid(p_order) >= private.order_total(p_order) then 'paid'
              when private.order_paid(p_order) > 0 then 'partial' else 'unpaid' end
$$;

create or replace function private.payment_allocated(p_payment uuid) returns int language sql stable as
$$ select coalesce(sum(a.amount_cents), 0)::int from public.payment_allocations a where a.payment_id = p_payment $$;

create or replace function private.payment_remaining(p_payment uuid) returns int language sql stable as $$
  select coalesce((select case when p.status = 'confirmed' then p.amount_cents - private.payment_allocated(p.id) else 0 end
                   from public.payments p where p.id = p_payment), 0)
$$;

create or replace function private.buyer_credit(u text) returns int language sql stable as
$$ select coalesce(sum(private.payment_remaining(p.id)), 0)::int from public.payments p where p.username = u and p.status = 'confirmed' $$;
create or replace function private.buyer_due(u text) returns int language sql stable as
$$ select coalesce(sum(private.order_due(o.id)), 0)::int from public.orders o where o.username = u $$;
create or replace function private.buyer_pending(u text) returns int language sql stable as
$$ select coalesce(sum(p.amount_cents), 0)::int from public.payments p where p.username = u and p.status = 'submitted' $$;

create or replace function private.add_alloc(p_payment uuid, p_order uuid, p_cents int) returns void language plpgsql as $$
begin
  if p_cents <= 0 then return; end if;
  insert into public.payment_allocations (payment_id, order_id, amount_cents) values (p_payment, p_order, p_cents)
  on conflict (payment_id, order_id) do update set amount_cents = public.payment_allocations.amount_cents + excluded.amount_cents;
end $$;

-- Spend a buyer's credit (confirmed money not yet on any order) on their oldest unpaid orders.
create or replace function private.auto_apply_credit(u text) returns int language plpgsql as $$
declare applied int := 0; o record; p record; due int; rem int; c int;
begin
  for o in select id from public.orders where username = u and status = 'open' order by created_at, no loop
    if private.order_due(o.id) <= 0 then continue; end if;
    for p in select id from public.payments where username = u and status = 'confirmed' order by confirmed_at, no loop
      due := private.order_due(o.id);
      exit when due <= 0;
      rem := private.payment_remaining(p.id);
      continue when rem <= 0;
      c := least(due, rem);
      perform private.add_alloc(p.id, o.id, c);
      applied := applied + c;
    end loop;
  end loop;
  return applied;
end $$;

-- Decide which orders a payment of p_amount pays: the buyer's chosen orders first,
-- then (optionally) their oldest unpaid orders. Whatever is left over is credit.
create or replace function private.plan_allocation(p_payment uuid, p_amount int, p_auto_apply boolean)
returns table (o_id uuid, o_cents int) language plpgsql as $$
declare
  pay_user text; intended uuid[]; rem int := p_amount; ord record; oid uuid;
  taken jsonb := '{}'::jsonb; seen uuid[] := '{}'; prev int; due int; c int;
begin
  select p.username, p.intended_order_ids into pay_user, intended from public.payments p where p.id = p_payment;
  foreach oid in array coalesce(intended, '{}') loop
    exit when rem <= 0;
    select o.id, o.status, o.username into ord from public.orders o where o.id = oid;
    if not found or ord.status <> 'open' or ord.username <> pay_user then continue; end if;
    prev := coalesce((taken ->> oid::text)::int, 0);
    due := private.order_due(oid) - prev;
    if due <= 0 then continue; end if;
    c := least(due, rem); rem := rem - c;
    taken := taken || jsonb_build_object(oid::text, prev + c);
    if not (oid = any(seen)) then seen := seen || oid; end if;
  end loop;
  if p_auto_apply and rem > 0 then
    for ord in select o.id from public.orders o where o.username = pay_user and o.status = 'open' order by o.created_at, o.no loop
      exit when rem <= 0;
      prev := coalesce((taken ->> ord.id::text)::int, 0);
      due := private.order_due(ord.id) - prev;
      if due <= 0 then continue; end if;
      c := least(due, rem); rem := rem - c;
      taken := taken || jsonb_build_object(ord.id::text, prev + c);
      if not (ord.id = any(seen)) then seen := seen || ord.id; end if;
    end loop;
  end if;
  foreach oid in array seen loop
    o_id := oid; o_cents := (taken ->> oid::text)::int; return next;
  end loop;
end $$;

-- Write the plan into the ledger. Returns {allocated: [{orderId, cents}], creditCents}.
create or replace function private.apply_plan(p_payment uuid, p_amount int, p_auto_apply boolean) returns jsonb language plpgsql as $$
declare r record; total int := 0; allocated jsonb := '[]'::jsonb;
begin
  for r in select * from private.plan_allocation(p_payment, p_amount, p_auto_apply) loop
    perform private.add_alloc(p_payment, r.o_id, r.o_cents);
    total := total + r.o_cents;
    allocated := allocated || jsonb_build_object('orderId', r.o_id, 'cents', r.o_cents);
  end loop;
  return jsonb_build_object('allocated', allocated, 'creditCents', p_amount - total);
end $$;

-- If an order is now worth less than what was paid on it (shipping fee lowered), push the excess back to credit.
create or replace function private.trim_overpayment(p_order uuid) returns int language plpgsql as $$
declare excess int := private.order_paid(p_order) - private.order_total(p_order); freed int := 0; a record; c int;
begin
  if excess <= 0 then return 0; end if;
  for a in
    select al.id, al.amount_cents from public.payment_allocations al join public.payments p on p.id = al.payment_id
    where al.order_id = p_order and p.status = 'confirmed' order by p.confirmed_at desc, p.no desc
  loop
    exit when excess <= 0;
    c := least(a.amount_cents, excess);
    if c = a.amount_cents then delete from public.payment_allocations where id = a.id;
    else update public.payment_allocations set amount_cents = amount_cents - c where id = a.id; end if;
    excess := excess - c; freed := freed + c;
  end loop;
  return freed;
end $$;

create or replace function private.restock_order(p_order uuid) returns void language sql as $$
  update public.variants v set stock = v.stock + l.qty
  from (select variant_id, sum(qty)::int as qty from public.order_lines where order_id = p_order group by variant_id) l
  where v.id = l.variant_id
$$;

-- Release unpaid holds that ran out. An order with money on it, or a payment in review, is never auto-expired.
create or replace function private.expire_holds() returns int language plpgsql as $$
declare o record; n int := 0; nos text[] := '{}'; t timestamptz := private.now_();
begin
  for o in select id, no from public.orders where status = 'open' and hold_expires_at <= t order by no for update skip locked loop
    if private.order_paid(o.id) > 0 or private.order_pending(o.id) > 0 then continue; end if;
    perform private.restock_order(o.id);
    update public.orders set status = 'expired', cancelled_at = t, cancel_reason = 'Hold expired — not paid in time' where id = o.id;
    n := n + 1; nos := nos || ('#' || o.no);
  end loop;
  if n > 0 then
    perform private.log_event('system', format('released %s unpaid hold%s: %s', n, case when n = 1 then '' else 's' end, array_to_string(nos, ', ')));
  end if;
  return n;
end $$;

-- Cancel an open order, put its stock back, and return any confirmed money to the buyer's credit.
create or replace function private.cancel_order(p_order uuid, p_actor text, p_reason text) returns jsonb language plpgsql as $$
declare o record; refundable int; reapplied int; t timestamptz := private.now_();
begin
  select id, no, username, status, fulfillment into o from public.orders where id = p_order for update;
  if not found then perform private.fail('not_found', 'Order not found.'); end if;
  if o.status <> 'open' then perform private.fail('bad_state', 'That order is already ' || o.status || '.'); end if;
  if o.fulfillment = 'shipped' then perform private.fail('shipped', 'A shipped order can’t be cancelled.'); end if;
  if p_actor <> 'admin' and (private.order_paid(o.id) > 0 or private.order_pending(o.id) > 0) then
    perform private.fail('has_money', 'This order has a payment on it — message the seller to cancel it.');
  end if;
  refundable := private.order_paid(o.id);
  delete from public.payment_allocations where order_id = o.id;
  perform private.restock_order(o.id);
  update public.orders set status = 'cancelled', cancelled_at = t,
         cancel_reason = coalesce(nullif(btrim(p_reason), ''), case when p_actor = 'admin' then 'Cancelled by seller' else 'Cancelled by buyer' end)
   where id = o.id;
  reapplied := private.auto_apply_credit(o.username);
  perform private.log_event(case when p_actor = 'admin' then 'admin' else '@' || o.username end,
    format('cancelled #%s', o.no) || case when refundable > 0 then format(' (%s returned to credit)', private.fmt(refundable)) else '' end);
  return jsonb_build_object('refundedToCreditCents', refundable, 'reappliedCents', reapplied);
end $$;

-- Passcode check. Returns NULL when the passcode is right, or an {ok:false,...} object when it is not.
-- It RETURNS instead of raising so the wrong-try counter is saved (an exception would roll it back).
create or replace function private.check_pass(p_username text, p_passcode text) returns jsonb language plpgsql as $$
declare b record; t timestamptz := private.now_();
begin
  select username, pass_hash, fails, lock_until into b from public.buyers where username = p_username for update;
  if not found or b.pass_hash is null then
    return jsonb_build_object('ok', false, 'code', 'no_passcode',
      'message', 'No account for @' || p_username || ' yet — your passcode is created with your first claim.');
  end if;
  if b.lock_until is not null and b.lock_until > t then
    return jsonb_build_object('ok', false, 'code', 'locked',
      'message', format('Too many wrong tries. Try again in %s min, or ask the seller to reset it.', ceil(extract(epoch from (b.lock_until - t)) / 60)::int));
  end if;
  if extensions.crypt(btrim(coalesce(p_passcode, '')), b.pass_hash) <> b.pass_hash then
    if b.fails + 1 >= 5 then
      update public.buyers set fails = 0, lock_until = t + interval '15 minutes' where username = p_username;
      return jsonb_build_object('ok', false, 'code', 'wrong_passcode', 'message', 'Too many wrong tries — locked for 15 minutes.');
    end if;
    update public.buyers set fails = fails + 1 where username = p_username;
    return jsonb_build_object('ok', false, 'code', 'wrong_passcode', 'message', 'That passcode doesn’t match.');
  end if;
  if b.fails > 0 then update public.buyers set fails = 0 where username = p_username; end if;
  return null;
end $$;

-- JSON for one order, shaped like the prototype's accountView.orders[].
create or replace function private.order_json(p_order uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', o.id, 'no', o.no, 'username', o.username, 'status', o.status, 'fulfillment', o.fulfillment,
    'tracking', o.tracking, 'createdAt', private.ms(o.created_at), 'holdExpiresAt', private.ms(o.hold_expires_at),
    'shippingFeeCents', o.shipping_fee_cents, 'note', o.note, 'cancelReason', o.cancel_reason, 'shipTo', o.ship_to,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('variantId', l.variant_id, 'productId', l.product_id, 'name', l.name,
                       'variantName', l.variant_name, 'qty', l.qty, 'unitCents', l.unit_cents) order by l.position)
                       from public.order_lines l where l.order_id = o.id), '[]'::jsonb),
    'subtotal', private.order_subtotal(o.id), 'total', private.order_total(o.id), 'paid', private.order_paid(o.id),
    'due', private.order_due(o.id), 'pending', private.order_pending(o.id),
    'toSend', greatest(0, private.order_due(o.id) - private.order_pending(o.id)),
    'payState', private.pay_state(o.id),
    'leftMs', private.ms(o.hold_expires_at) - private.ms(private.now_()))
  from public.orders o where o.id = p_order
$$;

-- ------------------------------------------- 6. buyer functions (no login) --
-- All of these are SECURITY DEFINER: they run with the owner's rights, so the tables stay closed to
-- the public. They verify the passcode themselves. Passcode problems come back as {ok:false, code, message};
-- every other problem is a normal error whose HINT is the code ('oversold', 'closed', ...).

create or replace function public.buyer_status(p_username text) returns jsonb language plpgsql security definer
set search_path = public, private, extensions, pg_temp as $$
declare u text := private.norm_user(p_username); v_has boolean; v_blocked boolean;
begin
  select b.has_pass, b.blocked into v_has, v_blocked from public.buyers b where b.username = u;
  return jsonb_build_object('exists', coalesce(v_has, false), 'blocked', coalesce(v_blocked, false));
end $$;

-- Everything the public storefront needs in one call: shop name and look, open/closed, payment methods, and the
-- catalog (active groups, their active products, and the variants still on sale). Releasing expired holds first
-- means the "left" counts are right even when nobody has touched the shop for a while.
create or replace function public.shop_info() returns jsonb language plpgsql security definer
set search_path = public, private, pg_temp as $$
begin
  perform private.expire_holds();
  return (select jsonb_build_object(
    'now', private.ms(private.now_()),
    'shopName', s.shop_name, 'shopOpen', s.shop_open, 'holdHours', s.hold_hours, 'requireProof', s.require_proof,
    'accentColor', s.accent_color, 'tagline', s.tagline, 'notice', s.notice,
    'methods', coalesce((select jsonb_agg(m) from jsonb_array_elements(s.methods) m where (m ->> 'enabled')::boolean), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'color', g.color, 'members', to_jsonb(g.members),
        'active', g.active, 'position', g.position) order by g.position, g.created_at)
        from public.groups g where g.active), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'groupId', p.group_id, 'name', p.name, 'category', p.category,
        'description', p.description, 'priceCents', p.price_cents, 'availability', p.availability,
        'payBy', private.ms(p.pay_by), 'opensAt', private.ms(p.opens_at), 'maxPerUser', p.max_per_user, 'status', p.status,
        'imageUrl', p.image_url, 'position', p.position) order by p.position, p.created_at)
        from public.products p join public.groups g on g.id = p.group_id and g.active where p.status = 'active'), '[]'::jsonb),
    'variants', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'productId', v.product_id, 'name', v.name, 'stock', v.stock,
        'priceCents', v.price_cents, 'archived', v.archived, 'position', v.position) order by v.position)
        from public.variants v join public.products p on p.id = v.product_id and p.status = 'active'
        join public.groups g on g.id = p.group_id and g.active where not v.archived), '[]'::jsonb))
  from public.settings s where s.id);
end $$;

create or replace function public.my_account(p_username text, p_passcode text) returns jsonb language plpgsql security definer
set search_path = public, private, extensions, pg_temp as $$
declare u text := private.norm_user(p_username); err jsonb;
begin
  perform private.expire_holds();
  err := private.check_pass(u, p_passcode);
  if err is not null then return err; end if;
  return jsonb_build_object(
    'username', u,
    'orders', coalesce((select jsonb_agg(private.order_json(o.id) order by o.created_at desc, o.no desc)
                        from public.orders o where o.username = u), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'no', p.no, 'method', p.method, 'amountCents', p.amount_cents, 'status', p.status,
        'createdAt', private.ms(p.created_at), 'rejectReason', p.reject_reason, 'hasProof', p.proof_path is not null,
        'covers', coalesce((select jsonb_agg(jsonb_build_object('orderNo', o.no, 'cents', a.amount_cents) order by o.no)
                            from public.payment_allocations a join public.orders o on o.id = a.order_id where a.payment_id = p.id), '[]'::jsonb),
        'remaining', private.payment_remaining(p.id)) order by p.created_at desc, p.no desc)
        from public.payments p where p.username = u), '[]'::jsonb),
    'creditCents', private.buyer_credit(u), 'dueCents', private.buyer_due(u), 'pendingCents', private.buyer_pending(u),
    'lastShipTo', (select o.ship_to from public.orders o where o.username = u and o.ship_to is not null order by o.created_at desc, o.no desc limit 1),
    'toSendCents', coalesce((select sum(greatest(0, private.order_due(o.id) - private.order_pending(o.id)))::int
                             from public.orders o where o.username = u and o.status = 'open'), 0));
end $$;

-- Claim items. The first claim under a username also creates the passcode.
-- p_lines = [{variantId, qty}, ...]. Returns {orderIds, creditAppliedCents}.
create or replace function public.place_order(p_username text, p_passcode text, p_lines jsonb) returns jsonb
language plpgsql security definer set search_path = public, private, extensions, pg_temp as $$
declare
  u text := private.norm_user(p_username);
  t timestamptz := private.now_();
  s public.settings%rowtype;
  v_has boolean; v_blocked boolean; err jsonb;
  l jsonb; vid uuid; q int;
  want jsonb := '{}'::jsonb; order_ uuid[] := '{}';
  r record; qty int; held int;
  r_vid uuid[] := '{}'; r_pid uuid[] := '{}'; r_name text[] := '{}'; r_vname text[] := '{}';
  r_qty int[] := '{}'; r_unit int[] := '{}'; r_dl timestamptz[] := '{}';
  perprod jsonb := '{}'::jsonb; pid text; cap int; pname text;
  dl timestamptz; buckets timestamptz[] := '{}';
  open_unpaid int; new_id uuid; new_no int; pos int; i int;
  order_ids uuid[] := '{}'; nos text[] := '{}'; total int := 0; applied int;
begin
  perform private.expire_holds();
  select * into s from public.settings where id;

  -- passcode: verify, or create on the first claim
  select b.has_pass, b.blocked into v_has, v_blocked from public.buyers b where b.username = u for update;
  if coalesce(v_has, false) then
    err := private.check_pass(u, p_passcode);
    if err is not null then return err; end if;
  else
    insert into public.buyers (username, pass_hash)
    values (u, extensions.crypt(private.valid_passcode(p_passcode), extensions.gen_salt('bf', 8)))
    on conflict (username) do update set pass_hash = excluded.pass_hash, fails = 0, lock_until = null;
  end if;

  if not s.shop_open then perform private.fail('closed', 'The shop is closed right now — check back soon.'); end if;
  if coalesce(v_blocked, false) then perform private.fail('blocked', 'This username can’t place new claims. Please DM the seller.'); end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    perform private.fail('empty', 'Your claim list is empty.');
  end if;
  if jsonb_array_length(p_lines) > 60 then perform private.fail('bad_qty', 'That’s too many items in one claim.'); end if;

  -- add up quantities per variant, keeping the buyer's order
  for l in select e from jsonb_array_elements(p_lines) e loop
    begin
      vid := (l ->> 'variantId')::uuid;
      q := floor((l ->> 'qty')::numeric)::int;
    exception when others then
      perform private.fail('bad_qty', 'Quantity must be at least 1.');
    end;
    if not (q >= 1) then perform private.fail('bad_qty', 'Quantity must be at least 1.'); end if;
    if want ? vid::text then
      want := jsonb_set(want, array[vid::text], to_jsonb((want ->> vid::text)::int + q));
    else
      want := want || jsonb_build_object(vid::text, q);
      order_ := order_ || vid;
    end if;
  end loop;

  foreach vid in array order_ loop
    if (want ->> vid::text)::int > 99 then perform private.fail('bad_qty', 'You can claim at most 99 of one item.'); end if;
  end loop;

  -- lock the variants in a fixed order so two claims can't deadlock, then check each one
  perform 1 from public.variants where id = any (order_) order by id for update;
  foreach vid in array order_ loop
    qty := (want ->> vid::text)::int;
    select v.id as vid, v.name as vname, v.stock, v.archived, v.price_cents as vprice,
           p.id as pid, p.name as pname, p.status as pstatus, p.opens_at, p.price_cents as pprice,
           p.availability, p.pay_by, p.max_per_user
      into r
      from public.variants v join public.products p on p.id = v.product_id where v.id = vid;
    if not found or r.archived or r.pstatus <> 'active' then
      perform private.fail('unavailable', 'One of those items is no longer available.');
    end if;
    if r.opens_at is not null and r.opens_at > t then
      perform private.fail('not_open', r.pname || ' isn’t open for claims yet.');
    end if;
    if r.stock < qty then
      perform private.fail('oversold', case when r.stock > 0
        then format('Only %s left of %s%s.', r.stock, r.pname, case when r.vname <> '' then ' – ' || r.vname else '' end)
        else format('%s%s just sold out.', r.pname, case when r.vname <> '' then ' – ' || r.vname else '' end) end);
    end if;
    perprod := jsonb_set(perprod, array[r.pid::text], to_jsonb(coalesce((perprod ->> r.pid::text)::int, 0) + qty));
    r_vid := r_vid || vid; r_pid := r_pid || r.pid; r_name := r_name || r.pname; r_vname := r_vname || r.vname;
    r_qty := r_qty || qty; r_unit := r_unit || coalesce(r.vprice, r.pprice);
    r_dl := r_dl || case when r.availability = 'incoming' and r.pay_by is not null and r.pay_by > t
                         then r.pay_by else t + make_interval(hours => s.hold_hours) end;
  end loop;

  -- per-person limits count what they already hold
  for pid in select k from jsonb_object_keys(perprod) k loop
    select p.max_per_user, p.name into cap, pname from public.products p where p.id = pid::uuid;
    if cap is not null then
      select coalesce(sum(l2.qty), 0)::int into held
        from public.order_lines l2 join public.orders o2 on o2.id = l2.order_id
       where o2.username = u and o2.status = 'open' and l2.product_id = pid::uuid;
      if held + (perprod ->> pid)::int > cap then
        perform private.fail('limit', format('Limit %s per person for %s%s.', cap, pname,
          case when held > 0 then format(' (you already have %s)', held) else '' end));
      end if;
    end if;
  end loop;

  -- one order per distinct pay-by deadline (pre-claim items get their own)
  foreach dl in array r_dl loop
    if not (dl = any (buckets)) then buckets := buckets || dl; end if;
  end loop;
  select count(*)::int into open_unpaid from public.orders o
   where o.username = u and o.status = 'open' and private.pay_state(o.id) <> 'paid';
  if open_unpaid + array_length(buckets, 1) > s.max_open_unpaid_orders then
    perform private.fail('too_many', format('You already have %s unpaid claims — please pay or cancel some first.', open_unpaid));
  end if;

  foreach dl in array buckets loop
    insert into public.orders (username, hold_expires_at, created_at) values (u, dl, t) returning id, no into new_id, new_no;
    pos := 0;
    for i in 1 .. array_length(r_vid, 1) loop
      continue when r_dl[i] <> dl;
      insert into public.order_lines (order_id, variant_id, product_id, name, variant_name, qty, unit_cents, position)
      values (new_id, r_vid[i], r_pid[i], r_name[i], r_vname[i], r_qty[i], r_unit[i], pos);
      update public.variants set stock = stock - r_qty[i] where id = r_vid[i];
      pos := pos + 1;
    end loop;
    order_ids := order_ids || new_id; nos := nos || ('#' || new_no);
    total := total + private.order_total(new_id);
  end loop;

  applied := private.auto_apply_credit(u);
  perform private.log_event('@' || u, format('claimed %s (%s)', array_to_string(nos, ', '), private.fmt(total)));
  return jsonb_build_object('orderIds', to_jsonb(order_ids), 'creditAppliedCents', applied);
end $$;

-- "I paid." Nothing counts until the seller matches it to real money.
-- p_payment = {method, amountCents, txnId?, senderName?, paidAt? (epoch ms), orderIds?: [uuid], proof?: {sha256, name, ext}}
-- Returns {paymentId, no, proofPath}. When proofPath is not null, the browser then uploads the image to that path
-- in the payment-proofs bucket (the path contains a random token, and only that exact path can be written once).
create or replace function public.submit_payment(p_username text, p_passcode text, p_payment jsonb) returns jsonb
language plpgsql security definer set search_path = public, private, extensions, pg_temp as $$
declare
  u text := private.norm_user(p_username); t timestamptz := private.now_();
  s public.settings%rowtype; err jsonb; v_method text := p_payment ->> 'method'; m jsonb;
  amt int; when_ timestamptz; ids uuid[]; clean_txn text; proof jsonb := p_payment -> 'proof';
  pid uuid := gen_random_uuid(); pno int; path text; ext text; raw_amt text := p_payment ->> 'amountCents';
begin
  perform private.expire_holds();
  err := private.check_pass(u, p_passcode);
  if err is not null then return err; end if;
  select * into s from public.settings where id;

  select e into m from jsonb_array_elements(s.methods) e
   where e ->> 'key' = v_method and (e ->> 'enabled')::boolean limit 1;
  if m is null then perform private.fail('bad_method', 'Pick one of the payment methods shown.'); end if;
  if raw_amt is null or raw_amt !~ '^[0-9]{1,9}$' then perform private.fail('bad_amount', 'Enter the amount you sent.'); end if;
  amt := raw_amt::int;
  if amt <= 0 then perform private.fail('bad_amount', 'Enter the amount you sent.'); end if;
  if amt > 200000 then perform private.fail('bad_amount', 'That amount looks too large — message the seller instead.'); end if;
  if s.require_proof and (proof is null or jsonb_typeof(proof) <> 'object') then
    perform private.fail('need_proof', 'Please attach a screenshot of your payment.');
  end if;
  when_ := case when coalesce(p_payment ->> 'paidAt', '') ~ '^[0-9]{10,14}$' then private.ts((p_payment ->> 'paidAt')::numeric) else t end;
  if when_ > t + interval '10 minutes' then perform private.fail('bad_time', 'The payment time can’t be in the future.'); end if;
  if when_ < t - interval '60 days' then perform private.fail('bad_time', 'That payment time is too far in the past.'); end if;
  if (select count(*) from public.payments x where x.username = u and x.status = 'submitted') >= s.max_pending_payments then
    perform private.fail('too_many_pending', 'You already have payments waiting for confirmation — please wait for those first.');
  end if;

  begin
    ids := array(select z.x::uuid from (select x, min(ord) as mo from jsonb_array_elements_text(coalesce(p_payment -> 'orderIds', '[]'::jsonb)) with ordinality t2 (x, ord) group by x) z order by z.mo);
  exception when others then
    perform private.fail('bad_order', 'One of the selected orders can’t be paid right now.');
  end;
  perform 1 from public.orders where id = any (ids) order by no for update;
  if exists (select 1 from unnest(ids) i where not exists
             (select 1 from public.orders o where o.id = i and o.username = u and o.status = 'open')) then
    perform private.fail('bad_order', 'One of the selected orders can’t be paid right now.');
  end if;

  clean_txn := left(btrim(coalesce(p_payment ->> 'txnId', '')), 64);
  if private.meaningful_txn(clean_txn) and exists (select 1 from public.payments q where q.status = 'confirmed'
       and q.method = v_method and private.norm_txn(q.txn_id) = private.norm_txn(clean_txn)) then
    perform private.fail('txn_used', 'That transaction ID was already confirmed on another payment.');
  end if;

  if proof is not null and jsonb_typeof(proof) = 'object' then
    ext := case lower(coalesce(proof ->> 'ext', 'jpg')) when 'png' then 'png' when 'webp' then 'webp' else 'jpg' end;
    path := pid::text || '/' || gen_random_uuid()::text || '.' || ext;
  end if;

  insert into public.payments (id, username, method, amount_cents, txn_id, sender_name, paid_at, status, source,
                               proof_path, proof_sha256, proof_name, intended_order_ids, created_at)
  values (pid, u, v_method, amt, clean_txn, left(btrim(coalesce(p_payment ->> 'senderName', '')), 60), when_, 'submitted', 'buyer',
          path, left(proof ->> 'sha256', 64), left(proof ->> 'name', 60), ids, t)
  returning no into pno;

  perform private.apply_plan(pid, amt, false);      -- proposed allocations, shown to the seller as "for order #..."
  perform private.log_event('@' || u, format('submitted payment #%s (%s %s)', pno, private.fmt(amt), v_method));
  return jsonb_build_object('paymentId', pid, 'no', pno, 'proofPath', path);
end $$;

create or replace function public.cancel_my_order(p_username text, p_passcode text, p_order_id uuid) returns jsonb
language plpgsql security definer set search_path = public, private, extensions, pg_temp as $$
declare u text := private.norm_user(p_username); err jsonb;
begin
  perform private.expire_holds();
  err := private.check_pass(u, p_passcode);
  if err is not null then return err; end if;
  if not exists (select 1 from public.orders o where o.id = p_order_id and o.username = u) then
    perform private.fail('not_found', 'Order not found.');
  end if;
  return private.cancel_order(p_order_id, 'buyer', 'Cancelled by buyer');
end $$;

-- Once a payment is confirmed the buyer says where to send the parcel. The address goes on every paid order of theirs that has
-- not shipped yet; it can be changed until the seller marks an order Shipped, and shipped orders keep the address they went to.
create or replace function public.save_address(p_username text, p_passcode text, p_address jsonb) returns jsonb
language plpgsql security definer set search_path = public, private, extensions, pg_temp as $$
declare u text := private.norm_user(p_username); err jsonb; a jsonb; nos int[];
begin
  perform private.expire_holds();
  err := private.check_pass(u, p_passcode);
  if err is not null then return err; end if;
  a := private.clean_address(p_address) || jsonb_build_object('savedAt', private.ms(private.now_()), 'by', 'buyer');
  with changed as (
    update public.orders o set ship_to = a
     where o.username = u and o.status = 'open' and o.fulfillment <> 'shipped' and private.order_due(o.id) = 0
    returning o.no)
  select coalesce(array_agg(no order by no), '{}') into nos from changed;
  if cardinality(nos) = 0 then
    perform private.fail('nothing_to_ship', 'There is nothing to ship yet. You can add an address once the seller has confirmed your payment.');
  end if;
  perform private.log_event('@' || u, format('added a shipping address for %s', (select string_agg('#' || n, ', ' order by n) from unnest(nos) n)));
  return jsonb_build_object('orderNos', to_jsonb(nos));
end $$;

-- Lets the upload policy (section 8) check that a path was issued by submit_payment and is still fresh.
create or replace function private.can_upload_proof(obj_name text) returns boolean language sql stable security definer
set search_path = public, pg_temp as $$
  select exists (select 1 from public.payments p
                  where p.proof_path = obj_name and p.status = 'submitted' and p.source = 'buyer'
                    and p.created_at > private.now_() - interval '30 minutes')
$$;

-- ----------------------------------------------------- 7. seller functions --
-- SECURITY INVOKER: they run as the logged-in seller, so row level security applies too (belt and braces).

-- Everything the seller screens need, in the same shape as the prototype's in-memory state.
create or replace function public.admin_snapshot(p_closed_days int default 60) returns jsonb language plpgsql
set search_path = public, private, extensions, pg_temp as $$
declare since timestamptz := private.now_() - make_interval(days => greatest(p_closed_days, 1));
begin
  perform private.require_admin();
  perform private.expire_holds();
  return jsonb_build_object(
    'v', 1, 'clockOffsetMs', 0, 'now', private.ms(private.now_()),
    'settings', (select jsonb_build_object('shopName', s.shop_name, 'shopOpen', s.shop_open, 'holdHours', s.hold_hours,
        'nearTolCents', s.near_tol_cents, 'requireProof', s.require_proof, 'maxOpenUnpaidOrders', s.max_open_unpaid_orders,
        'maxPendingPayments', s.max_pending_payments, 'accentColor', s.accent_color, 'tagline', s.tagline, 'notice', s.notice,
        'methods', s.methods) from public.settings s where s.id),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'color', g.color, 'members', to_jsonb(g.members),
        'active', g.active, 'position', g.position) order by g.position, g.created_at) from public.groups g), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'groupId', p.group_id, 'name', p.name, 'category', p.category,
        'description', p.description, 'priceCents', p.price_cents, 'availability', p.availability,
        'payBy', private.ms(p.pay_by), 'opensAt', private.ms(p.opens_at), 'maxPerUser', p.max_per_user, 'status', p.status,
        'imageUrl', p.image_url, 'position', p.position) order by p.position, p.created_at) from public.products p), '[]'::jsonb),
    'variants', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'productId', v.product_id, 'name', v.name, 'stock', v.stock,
        'priceCents', v.price_cents, 'archived', v.archived, 'position', v.position) order by v.position) from public.variants v), '[]'::jsonb),
    'buyers', coalesce((select jsonb_object_agg(b.username, jsonb_build_object('username', b.username, 'createdAt', private.ms(b.created_at),
        'blocked', b.blocked, 'note', b.note, 'fails', b.fails, 'lockUntil', coalesce(private.ms(b.lock_until), 0),
        'passHash', case when b.has_pass then 'set' end)) from public.buyers b), '{}'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'no', o.no, 'username', o.username, 'status', o.status,
        'fulfillment', o.fulfillment, 'tracking', o.tracking, 'createdAt', private.ms(o.created_at),
        'holdExpiresAt', private.ms(o.hold_expires_at), 'shippingFeeCents', o.shipping_fee_cents, 'note', o.note,
        'cancelledAt', private.ms(o.cancelled_at), 'cancelReason', o.cancel_reason, 'shipTo', o.ship_to,
        'lines', coalesce((select jsonb_agg(jsonb_build_object('variantId', l.variant_id, 'productId', l.product_id, 'name', l.name,
                  'variantName', l.variant_name, 'qty', l.qty, 'unitCents', l.unit_cents) order by l.position)
                  from public.order_lines l where l.order_id = o.id), '[]'::jsonb)) order by o.no)
        from public.orders o where o.status = 'open' or coalesce(o.cancelled_at, o.created_at) >= since), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'no', p.no, 'username', p.username, 'method', p.method,
        'amountCents', p.amount_cents, 'txnId', p.txn_id, 'senderName', p.sender_name, 'paidAt', private.ms(p.paid_at),
        'createdAt', private.ms(p.created_at), 'status', p.status, 'source', p.source,
        'proof', case when p.proof_path is null then null else jsonb_build_object('path', p.proof_path, 'sha256', p.proof_sha256, 'name', p.proof_name) end,
        'rejectReason', p.reject_reason, 'confirmedAt', private.ms(p.confirmed_at), 'verifiedManually', p.verified_manually,
        'incomingId', (select t.id from public.incoming_transactions t where t.payment_id = p.id limit 1),
        'intendedOrderIds', to_jsonb(p.intended_order_ids), 'note', p.note) order by p.no) from public.payments p), '[]'::jsonb),
    'allocations', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'paymentId', a.payment_id, 'orderId', a.order_id,
        'amountCents', a.amount_cents)) from public.payment_allocations a), '[]'::jsonb),
    'incoming', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'no', t.no, 'method', t.method, 'extId', t.ext_id,
        'occurredAt', private.ms(t.occurred_at), 'amountCents', t.amount_cents, 'senderName', t.sender_name, 'note', t.note,
        'status', t.status, 'paymentId', t.payment_id, 'source', t.source) order by t.no) from public.incoming_transactions t), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(jsonb_build_object('at', private.ms(x.at), 'actor', x.actor, 'msg', x.msg) order by x.id)
                     from (select * from public.activity_log order by id desc limit 100) x), '[]'::jsonb));
end $$;

create or replace function public.release_expired_holds() returns int language plpgsql
set search_path = public, private, extensions, pg_temp as $$
begin
  perform private.require_admin();
  return private.expire_holds();
end $$;

-- Save any subset of the shop settings. Same limits and messages as the prototype. Unknown keys are ignored.
-- p_patch keys: shopName, shopOpen, holdHours, requireProof, nearTolCents, maxOpenUnpaidOrders, maxPendingPayments,
-- accentColor ("#rrggbb"), tagline, notice, methods ([{key, enabled, handle, hint}]).
create or replace function public.admin_save_settings(p_patch jsonb) returns void language plpgsql
set search_path = public, private, extensions, pg_temp as $$
declare
  s public.settings%rowtype; n numeric; new_methods jsonb;
begin
  perform private.require_admin();
  perform private.expire_holds();
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then perform private.fail('bad_input', 'Nothing to save.'); end if;
  select * into s from public.settings where id for update;

  if p_patch ? 'holdHours' then
    n := case when jsonb_typeof(p_patch -> 'holdHours') = 'number' then (p_patch ->> 'holdHours')::numeric end;
    if n is null or n < 1 or n > 720 then perform private.fail('bad_input', 'Hold time must be between 1 hour and 30 days.'); end if;
    s.hold_hours := round(n)::int;
  end if;
  if p_patch ? 'nearTolCents' then
    n := case when jsonb_typeof(p_patch -> 'nearTolCents') = 'number' then (p_patch ->> 'nearTolCents')::numeric end;
    if n is null or n < 0 or n > 1000 then perform private.fail('bad_input', 'Amount tolerance must be between $0 and $10.'); end if;
    s.near_tol_cents := round(n)::int;
  end if;
  if p_patch ? 'maxOpenUnpaidOrders' then
    n := case when jsonb_typeof(p_patch -> 'maxOpenUnpaidOrders') = 'number' then (p_patch ->> 'maxOpenUnpaidOrders')::numeric end;
    if n is null or n < 1 or n > 50 then perform private.fail('bad_input', 'Limits must be between 1 and 50.'); end if;
    s.max_open_unpaid_orders := round(n)::int;
  end if;
  if p_patch ? 'maxPendingPayments' then
    n := case when jsonb_typeof(p_patch -> 'maxPendingPayments') = 'number' then (p_patch ->> 'maxPendingPayments')::numeric end;
    if n is null or n < 1 or n > 50 then perform private.fail('bad_input', 'Limits must be between 1 and 50.'); end if;
    s.max_pending_payments := round(n)::int;
  end if;
  if p_patch ? 'shopOpen' then s.shop_open := coalesce((p_patch ->> 'shopOpen') = 'true', false); end if;
  if p_patch ? 'requireProof' then s.require_proof := coalesce((p_patch ->> 'requireProof') = 'true', false); end if;
  if p_patch ? 'shopName' then
    s.shop_name := coalesce(nullif(left(btrim(coalesce(p_patch ->> 'shopName', '')), 40), ''), 'Shop Manager');
  end if;
  if p_patch ? 'accentColor' then
    if coalesce(p_patch ->> 'accentColor', '') !~ '^#[0-9A-Fa-f]{6}$' then
      perform private.fail('bad_input', 'Pick a colour like #96D6F0.');
    end if;
    s.accent_color := lower(p_patch ->> 'accentColor');
  end if;
  if p_patch ? 'tagline' then s.tagline := left(btrim(coalesce(p_patch ->> 'tagline', '')), 80); end if;
  if p_patch ? 'notice' then s.notice := left(btrim(coalesce(p_patch ->> 'notice', '')), 200); end if;

  if p_patch ? 'methods' and jsonb_typeof(p_patch -> 'methods') = 'array' then
    select jsonb_agg(
             case when pm.value is null then cur.value
                  else cur.value || jsonb_build_object(
                         'enabled', coalesce((pm.value ->> 'enabled') = 'true', false),
                         'handle', left(btrim(coalesce(pm.value ->> 'handle', '')), 80),
                         'hint', left(btrim(coalesce(pm.value ->> 'hint', '')), 140)) end
             order by cur.ord)
      into new_methods
      from jsonb_array_elements(s.methods) with ordinality as cur(value, ord)
      left join lateral (select x.value from jsonb_array_elements(p_patch -> 'methods') x
                          where x.value ->> 'key' = cur.value ->> 'key' limit 1) pm on true;
    s.methods := coalesce(new_methods, s.methods);
  end if;

  update public.settings set shop_name = s.shop_name, shop_open = s.shop_open, hold_hours = s.hold_hours,
         near_tol_cents = s.near_tol_cents, require_proof = s.require_proof, max_open_unpaid_orders = s.max_open_unpaid_orders,
         max_pending_payments = s.max_pending_payments, accent_color = s.accent_color, tagline = s.tagline,
         notice = s.notice, methods = s.methods
   where id;
  perform private.log_event('admin', 'changed settings');
end $$;

-- Confirm a buyer's payment against real money. Either pass the matching feed row (p_incoming_id), or set
-- p_manual_verified = true to say "I looked at my own account". p_amount_cents is what you actually received.
-- Returns {allocated: [{orderId, cents}], creditCents, amountCents}.
create or replace function public.admin_confirm_payment(p_payment_id uuid, p_incoming_id uuid default null,
  p_amount_cents int default null, p_manual_verified boolean default false, p_auto_apply boolean default true) returns jsonb
language plpgsql set search_path = public, private, extensions, pg_temp as $$
declare
  p record; t_id uuid; t_status public.incoming_status; t_method text; t_ext text; t_amount int;
  amt int; v_method text; v_txn text; plan jsonb; t timestamptz := private.now_();
begin
  perform private.require_admin();
  perform private.expire_holds();
  select id, no, username, status, method, amount_cents, txn_id into p from public.payments where id = p_payment_id for update;
  if not found then perform private.fail('not_found', 'Payment not found.'); end if;
  if p.status <> 'submitted' then perform private.fail('bad_state', 'Only payments awaiting confirmation can be confirmed.'); end if;
  perform 1 from public.buyers where username = p.username for update;          -- one money move per buyer at a time
  if p_incoming_id is not null then
    select x.id, x.status, x.method, x.ext_id, x.amount_cents into t_id, t_status, t_method, t_ext, t_amount
      from public.incoming_transactions x where x.id = p_incoming_id for update;
    if t_id is null then perform private.fail('not_found', 'Incoming transfer not found.'); end if;
    if t_status <> 'unmatched' then perform private.fail('incoming_taken', 'That incoming transfer is already matched to another payment.'); end if;
  end if;
  if t_id is null and not coalesce(p_manual_verified, false) then
    perform private.fail('verify_required', 'Pick the incoming transfer, or tick “I checked my account” to confirm without one.');
  end if;
  amt := coalesce(p_amount_cents, case when t_id is not null then t_amount else p.amount_cents end);
  if amt is null or amt <= 0 then perform private.fail('bad_amount', 'Enter a valid amount.'); end if;
  v_method := coalesce(t_method, p.method);
  v_txn := coalesce(nullif(p.txn_id, ''), t_ext, '');
  if private.meaningful_txn(v_txn) and exists (select 1 from public.payments q where q.id <> p.id and q.status = 'confirmed'
       and q.method = v_method and private.norm_txn(q.txn_id) = private.norm_txn(v_txn)) then
    perform private.fail('txn_used', 'This transaction ID was already confirmed on another payment.');
  end if;
  update public.payments set amount_cents = amt, method = v_method, txn_id = v_txn, status = 'confirmed', confirmed_at = t,
         verified_manually = (t_id is null) where id = p.id;
  if t_id is not null then update public.incoming_transactions set status = 'matched', payment_id = p.id where id = t_id; end if;
  delete from public.payment_allocations where payment_id = p.id;
  plan := private.apply_plan(p.id, amt, coalesce(p_auto_apply, true));
  perform private.log_event('admin', format('confirmed payment #%s %s from @%s', p.no, private.fmt(amt), p.username)
    || case when (plan ->> 'creditCents')::int > 0 then format(' (%s held as credit)', private.fmt((plan ->> 'creditCents')::int)) else '' end);
  return plan || jsonb_build_object('amountCents', amt);
end $$;

create or replace function public.admin_reject_payment(p_payment_id uuid, p_reason text default '') returns void
language plpgsql set search_path = public, private, extensions, pg_temp as $$
declare p record; t timestamptz := private.now_(); why text := left(btrim(coalesce(p_reason, '')), 200);
begin
  perform private.require_admin();
  perform private.expire_holds();
  select id, no, status, intended_order_ids into p from public.payments where id = p_payment_id for update;
  if not found then perform private.fail('not_found', 'Payment not found.'); end if;
  if p.status <> 'submitted' then perform private.fail('bad_state', 'Only payments awaiting confirmation can be rejected.'); end if;
  update public.payments set status = 'rejected', reject_reason = why where id = p.id;
  delete from public.payment_allocations where payment_id = p.id;
  -- give the buyer time to fix it: keep their holds alive for 12 more hours
  update public.orders set hold_expires_at = greatest(hold_expires_at, t + interval '12 hours')
   where id = any (p.intended_order_ids) and status = 'open';
  perform private.log_event('admin', format('rejected payment #%s', p.no) || case when why <> '' then ' — ' || why else '' end);
end $$;

create or replace function public.admin_cancel_order(p_order_id uuid, p_reason text default '') returns jsonb
language plpgsql set search_path = public, private, extensions, pg_temp as $$
begin
  perform private.require_admin();
  perform private.expire_holds();
  return private.cancel_order(p_order_id, 'admin', p_reason);
end $$;

create or replace function public.admin_set_fulfillment(p_order_id uuid, p_to text, p_tracking text default '') returns void
language plpgsql set search_path = public, private, extensions, pg_temp as $$
declare o record; tr text := left(btrim(coalesce(p_tracking, '')), 80);
begin
  perform private.require_admin();
  perform private.expire_holds();
  select id, no, status into o from public.orders where id = p_order_id for update;
  if not found or o.status <> 'open' then perform private.fail('bad_state', 'Only open orders can be updated.'); end if;
  if p_to not in ('pending', 'packed', 'shipped') then perform private.fail('bad_state', 'Unknown status.'); end if;
  if p_to <> 'pending' and private.order_due(o.id) > 0 then perform private.fail('unpaid', 'This order isn’t fully paid yet.'); end if;
  update public.orders set fulfillment = p_to::public.fulfillment_status,
         tracking = case when p_to = 'shipped' or tr <> '' then tr else tracking end
   where id = o.id;
  perform private.log_event('admin', format('#%s → %s', o.no, p_to));
end $$;

-- The seller can type or fix an address too (for example one the buyer sent by message), or clear it with null.
create or replace function public.admin_set_address(p_order_id uuid, p_address jsonb) returns void
language plpgsql set search_path = public, private, extensions, pg_temp as $$
declare o record;
begin
  perform private.require_admin();
  select id, no, status into o from public.orders where id = p_order_id for update;
  if not found or o.status <> 'open' then perform private.fail('bad_state', 'Only open orders can be updated.'); end if;
  if p_address is null or p_address = 'null'::jsonb or p_address = '{}'::jsonb then
    update public.orders set ship_to = null where id = o.id;
    perform private.log_event('admin', format('#%s address removed', o.no));
  else
    update public.orders set ship_to = private.clean_address(p_address) || jsonb_build_object('savedAt', private.ms(private.now_()), 'by', 'seller')
     where id = o.id;
    perform private.log_event('admin', format('#%s address saved', o.no));
  end if;
end $$;

-- Set (not add) the shipping fee on an order. Lowering it below what is already paid returns the difference to credit.
create or replace function public.admin_set_shipping_fee(p_order_id uuid, p_cents int) returns jsonb
language plpgsql set search_path = public, private, extensions, pg_temp as $$
declare o record; freed int; applied int;
begin
  perform private.require_admin();
  perform private.expire_holds();
  select id, no, username, status into o from public.orders where id = p_order_id for update;
  if not found or o.status <> 'open' then perform private.fail('bad_state', 'Only open orders can take a shipping fee.'); end if;
  if p_cents is null or p_cents < 0 or p_cents > 50000 then perform private.fail('bad_amount', 'Enter a shipping fee between $0 and $500.'); end if;
  perform 1 from public.buyers where username = o.username for update;
  update public.orders set shipping_fee_cents = p_cents where id = o.id;
  freed := private.trim_overpayment(o.id);
  applied := private.auto_apply_credit(o.username);
  perform private.log_event('admin', format('#%s shipping fee %s', o.no, private.fmt(p_cents))
    || case when freed > 0 then format(' (%s returned to credit)', private.fmt(freed)) else '' end
    || case when applied > 0 then format(' (credit %s applied)', private.fmt(applied)) else '' end);
  return jsonb_build_object('creditAppliedCents', applied, 'returnedToCreditCents', freed);
end $$;

create or replace function public.admin_extend_hold(p_order_id uuid, p_hours int) returns void
language plpgsql set search_path = public, private, extensions, pg_temp as $$
declare o record; t timestamptz := private.now_();
begin
  perform private.require_admin();
  perform private.expire_holds();
  if p_hours is null or p_hours < 1 or p_hours > 720 then perform private.fail('bad_input', 'Pick between 1 hour and 30 days.'); end if;
  select id, no, status into o from public.orders where id = p_order_id for update;
  if not found or o.status <> 'open' then perform private.fail('bad_state', 'Only open orders can be extended.'); end if;
  update public.orders set hold_expires_at = greatest(hold_expires_at, t) + make_interval(hours => p_hours) where id = o.id;
  perform private.log_event('admin', format('#%s hold +%sh', o.no, p_hours));
end $$;

-- Add rows to the money-received feed. p_items = [{method, amountCents, extId?, occurredAt? (epoch ms), senderName?, note?, source?}].
-- Rows with a transaction ID that is already in the feed are skipped. Returns {added, skipped}.
create or replace function public.admin_import_incoming(p_items jsonb) returns jsonb
language plpgsql set search_path = public, private, extensions, pg_temp as $$
declare it jsonb; added int := 0; skipped int := 0; amt int; ext text; meth text; occurred timestamptz; t timestamptz := private.now_();
begin
  perform private.require_admin();
  perform private.expire_holds();
  if p_items is null or jsonb_typeof(p_items) <> 'array' then perform private.fail('bad_input', 'Nothing to import.'); end if;
  if jsonb_array_length(p_items) > 2000 then perform private.fail('bad_input', 'Import at most 2,000 rows at a time.'); end if;
  for it in select e from jsonb_array_elements(p_items) e loop
    meth := lower(coalesce(it ->> 'method', ''));
    if coalesce(it ->> 'amountCents', '') !~ '^[0-9]{1,9}$' or meth !~ '^[a-z0-9_]{1,20}$' then skipped := skipped + 1; continue; end if;
    amt := (it ->> 'amountCents')::int;
    if amt <= 0 then skipped := skipped + 1; continue; end if;
    ext := left(btrim(coalesce(it ->> 'extId', '')), 64);
    if private.meaningful_txn(ext) and exists (select 1 from public.incoming_transactions x
         where x.method = meth and private.norm_txn(x.ext_id) = private.norm_txn(ext)) then
      skipped := skipped + 1; continue;
    end if;
    occurred := case when coalesce(it ->> 'occurredAt', '') ~ '^[0-9]{10,14}$' then private.ts((it ->> 'occurredAt')::numeric) else t end;
    insert into public.incoming_transactions (method, ext_id, occurred_at, amount_cents, sender_name, note, source)
    values (meth, ext, occurred, amt, left(btrim(coalesce(it ->> 'senderName', '')), 80), left(coalesce(it ->> 'note', ''), 120),
            left(coalesce(nullif(it ->> 'source', ''), 'manual'), 20));
    added := added + 1;
  end loop;
  if added > 0 then
    perform private.log_event('admin', format('added %s transfer%s to the feed', added, case when added = 1 then '' else 's' end)
      || case when skipped > 0 then format(' (%s skipped)', skipped) else '' end);
  end if;
  return jsonb_build_object('added', added, 'skipped', skipped);
end $$;

create or replace function public.admin_ignore_incoming(p_incoming_id uuid, p_ignore boolean default true) returns void
language plpgsql set search_path = public, private, extensions, pg_temp as $$
declare st public.incoming_status;
begin
  perform private.require_admin();
  perform private.expire_holds();
  select status into st from public.incoming_transactions where id = p_incoming_id for update;
  if not found then perform private.fail('not_found', 'Incoming transfer not found.'); end if;
  if st = 'matched' then perform private.fail('bad_state', 'That transfer is already matched.'); end if;
  update public.incoming_transactions set status = case when p_ignore then 'ignored' else 'unmatched' end::public.incoming_status
   where id = p_incoming_id;
end $$;

-- Money that arrived with no submission from the buyer: assign it to a buyer (and optionally to orders).
create or replace function public.admin_assign_incoming(p_incoming_id uuid, p_username text, p_order_ids uuid[] default '{}',
  p_auto_apply boolean default true) returns jsonb
language plpgsql set search_path = public, private, extensions, pg_temp as $$
declare tr record; u text; pid uuid := gen_random_uuid(); pno int; plan jsonb; t timestamptz := private.now_();
begin
  perform private.require_admin();
  perform private.expire_holds();
  u := private.norm_user(p_username);
  select id, status, method, ext_id, amount_cents, sender_name, occurred_at into tr from public.incoming_transactions where id = p_incoming_id for update;
  if not found then perform private.fail('not_found', 'Incoming transfer not found.'); end if;
  if tr.status <> 'unmatched' then perform private.fail('incoming_taken', 'That transfer is already matched or ignored.'); end if;
  insert into public.buyers (username) values (u) on conflict do nothing;
  perform 1 from public.buyers where username = u for update;
  if private.meaningful_txn(tr.ext_id) and exists (select 1 from public.payments q where q.status = 'confirmed'
       and q.method = tr.method and private.norm_txn(q.txn_id) = private.norm_txn(tr.ext_id)) then
    perform private.fail('txn_used', 'This transaction ID was already confirmed on another payment.');
  end if;
  insert into public.payments (id, username, method, amount_cents, txn_id, sender_name, paid_at, status, source,
                               confirmed_at, intended_order_ids, note, created_at)
  values (pid, u, tr.method, tr.amount_cents, tr.ext_id, tr.sender_name, tr.occurred_at, 'confirmed', 'admin',
          t, coalesce(p_order_ids, '{}'), 'Assigned from feed', t)
  returning no into pno;
  update public.incoming_transactions set status = 'matched', payment_id = pid where id = tr.id;
  plan := private.apply_plan(pid, tr.amount_cents, coalesce(p_auto_apply, true));
  perform private.log_event('admin', format('assigned %s %s to @%s', private.fmt(tr.amount_cents), tr.method, u)
    || case when (plan ->> 'creditCents')::int > 0 then format(' (%s credit)', private.fmt((plan ->> 'creditCents')::int)) else '' end);
  return plan;
end $$;

-- Cash, or anything that never shows up in a feed.
create or replace function public.admin_record_payment(p_username text, p_method text, p_amount_cents int,
  p_note text default '', p_order_ids uuid[] default '{}', p_auto_apply boolean default true) returns jsonb
language plpgsql set search_path = public, private, extensions, pg_temp as $$
declare u text; pid uuid := gen_random_uuid(); pno int; plan jsonb; t timestamptz := private.now_();
begin
  perform private.require_admin();
  perform private.expire_holds();
  u := private.norm_user(p_username);
  if p_amount_cents is null or p_amount_cents <= 0 or p_amount_cents > 200000 then perform private.fail('bad_amount', 'Enter a valid amount.'); end if;
  if coalesce(p_method, 'other') !~ '^[a-z0-9_]{1,20}$' then perform private.fail('bad_method', 'Pick a payment method.'); end if;
  insert into public.buyers (username) values (u) on conflict do nothing;
  perform 1 from public.buyers where username = u for update;
  insert into public.payments (id, username, method, amount_cents, paid_at, status, source, confirmed_at, verified_manually,
                               intended_order_ids, note, created_at)
  values (pid, u, coalesce(p_method, 'other'), p_amount_cents, t, 'confirmed', 'admin', t, true, coalesce(p_order_ids, '{}'),
          left(coalesce(p_note, ''), 120), t)
  returning no into pno;
  plan := private.apply_plan(pid, p_amount_cents, coalesce(p_auto_apply, true));
  perform private.log_event('admin', format('recorded %s %s for @%s', private.fmt(p_amount_cents), coalesce(p_method, 'other'), u));
  return plan;
end $$;

-- Typed the wrong handle? Move everything from p_from onto p_to.
create or replace function public.admin_merge_buyer(p_from text, p_to text) returns void
language plpgsql set search_path = public, private, extensions, pg_temp as $$
declare a text; b text; applied int;
begin
  perform private.require_admin();
  perform private.expire_holds();
  a := private.norm_user(p_from); b := private.norm_user(p_to);
  if a = b then perform private.fail('bad_input', 'Those are the same username.'); end if;
  perform 1 from public.buyers where username in (a, b) order by username for update;
  if not exists (select 1 from public.buyers where username = a) then perform private.fail('not_found', 'No such buyer: @' || a); end if;
  if exists (select 1 from public.buyers where username = b) then
    update public.orders   set username = b where username = a;
    update public.payments set username = b where username = a;
    delete from public.buyers where username = a;
  else
    update public.buyers set username = b where username = a;         -- cascades to orders and payments
  end if;
  applied := private.auto_apply_credit(b);
  perform private.log_event('admin', format('merged @%s into @%s', a, b) || case when applied > 0 then format(' (credit %s applied)', private.fmt(applied)) else '' end);
end $$;

-- Catalog editing. Group: {id?, name, color?, members?: [text], active?}
create or replace function public.admin_save_group(p_group jsonb) returns uuid
language plpgsql set search_path = public, private, extensions, pg_temp as $$
declare nm text := btrim(coalesce(p_group ->> 'name', '')); gid uuid := nullif(p_group ->> 'id', '')::uuid;
        mem text[]; col text := coalesce(nullif(p_group ->> 'color', ''), '#C2406F');
begin
  perform private.require_admin();
  perform private.expire_holds();
  if nm = '' then perform private.fail('bad_input', 'Give the group a name.'); end if;
  if col !~ '^#[0-9a-fA-F]{6}$' then perform private.fail('bad_input', 'Pick a colour.'); end if;
  mem := array(select btrim(x) from jsonb_array_elements_text(coalesce(p_group -> 'members', '[]'::jsonb)) x where btrim(x) <> '');
  if gid is not null and exists (select 1 from public.groups where id = gid) then
    update public.groups set name = nm, color = col, members = mem, active = coalesce((p_group ->> 'active')::boolean, true) where id = gid;
  else
    insert into public.groups (name, color, members, active, position)
    values (nm, col, mem, coalesce((p_group ->> 'active')::boolean, true), (select count(*) from public.groups))
    returning id into gid;
  end if;
  return gid;
end $$;

-- Product: {id?, groupId, name, category?, description?, priceCents, availability?, payBy? (ms), opensAt? (ms),
--           maxPerUser?, status?, imageUrl?, variants: [{id?, name, stock, priceCents?}]}
-- Variants that are no longer listed are deleted, or archived when old orders still point at them.
create or replace function public.admin_save_product(p_product jsonb) returns uuid
language plpgsql set search_path = public, private, extensions, pg_temp as $$
declare
  nm text := btrim(coalesce(p_product ->> 'name', '')); pid uuid := nullif(p_product ->> 'id', '')::uuid;
  gid uuid := nullif(p_product ->> 'groupId', '')::uuid; price int; avail public.product_availability;
  vs jsonb := coalesce(p_product -> 'variants', '[]'::jsonb); v jsonb; vname text; vstock int; vprice int; vid uuid; i int := 0;
  keep uuid[] := '{}'; n int; stk text; vp text;
begin
  perform private.require_admin();
  perform private.expire_holds();
  if nm = '' then perform private.fail('bad_input', 'Give the product a name.'); end if;
  if gid is null or not exists (select 1 from public.groups where id = gid) then perform private.fail('bad_input', 'Pick a group.'); end if;
  if not (case when coalesce(p_product ->> 'priceCents', '') ~ '^[0-9]{1,7}$' then (p_product ->> 'priceCents')::int <= 500000 else false end) then
    perform private.fail('bad_input', 'Enter a valid price (up to ' || private.fmt(500000) || ').');
  end if;
  price := (p_product ->> 'priceCents')::int;
  avail := case when p_product ->> 'availability' = 'incoming' then 'incoming' else 'in_stock' end;
  n := jsonb_array_length(vs);
  if n = 0 then perform private.fail('bad_input', 'Add at least one variant (or one line with the stock count).'); end if;

  if pid is not null and exists (select 1 from public.products where id = pid) then
    update public.products set group_id = gid, name = nm, category = coalesce(nullif(p_product ->> 'category', ''), 'other')::public.product_category,
      description = left(btrim(coalesce(p_product ->> 'description', '')), 500), price_cents = price, availability = avail,
      pay_by = case when avail = 'incoming' and coalesce(p_product ->> 'payBy', '') ~ '^[0-9]{10,14}$' then private.ts((p_product ->> 'payBy')::numeric) end,
      opens_at = case when coalesce(p_product ->> 'opensAt', '') ~ '^[0-9]{10,14}$' then private.ts((p_product ->> 'opensAt')::numeric) end,
      max_per_user = case when coalesce(p_product ->> 'maxPerUser', '') ~ '^[1-9][0-9]*$' then (p_product ->> 'maxPerUser')::int end,
      status = case when p_product ->> 'status' = 'hidden' then 'hidden' else 'active' end::public.product_status,
      image_url = coalesce(p_product ->> 'imageUrl', '')
    where id = pid;
  else
    insert into public.products (group_id, name, category, description, price_cents, availability, pay_by, opens_at, max_per_user, status, image_url, position)
    values (gid, nm, coalesce(nullif(p_product ->> 'category', ''), 'other')::public.product_category,
      left(btrim(coalesce(p_product ->> 'description', '')), 500), price, avail,
      case when avail = 'incoming' and coalesce(p_product ->> 'payBy', '') ~ '^[0-9]{10,14}$' then private.ts((p_product ->> 'payBy')::numeric) end,
      case when coalesce(p_product ->> 'opensAt', '') ~ '^[0-9]{10,14}$' then private.ts((p_product ->> 'opensAt')::numeric) end,
      case when coalesce(p_product ->> 'maxPerUser', '') ~ '^[1-9][0-9]*$' then (p_product ->> 'maxPerUser')::int end,
      case when p_product ->> 'status' = 'hidden' then 'hidden' else 'active' end::public.product_status,
      coalesce(p_product ->> 'imageUrl', ''), (select count(*) from public.products))
    returning id into pid;
  end if;

  for v in select e from jsonb_array_elements(vs) e loop
    vname := btrim(coalesce(v ->> 'name', ''));
    if vname = '' and n > 1 then continue; end if;                 -- blank lines are ignored unless it is the only one
    stk := v ->> 'stock'; vp := v ->> 'priceCents';
    if stk is null or stk !~ '^[0-9]{1,6}$' then perform private.fail('bad_input', format('Stock must be 0 or more for “%s”.', coalesce(nullif(vname, ''), 'default'))); end if;
    if vp is not null and not (case when vp ~ '^[0-9]{1,7}$' then vp::int <= 500000 else false end) then perform private.fail('bad_input', 'Variant price must be a valid amount.'); end if;
    vstock := stk::int; vprice := vp::int;
    vid := nullif(v ->> 'id', '')::uuid;
    if vid is not null and exists (select 1 from public.variants where id = vid and product_id = pid) then
      update public.variants set name = vname, stock = vstock, price_cents = vprice, position = i, archived = false where id = vid;
    else
      insert into public.variants (product_id, name, stock, price_cents, position) values (pid, vname, vstock, vprice, i) returning id into vid;
    end if;
    keep := keep || vid; i := i + 1;
  end loop;
  if i = 0 then perform private.fail('bad_input', 'Add at least one variant (or one line with the stock count).'); end if;

  update public.variants set archived = true, stock = 0
   where product_id = pid and not (id = any (keep)) and exists (select 1 from public.order_lines l where l.variant_id = variants.id);
  delete from public.variants
   where product_id = pid and not (id = any (keep)) and not exists (select 1 from public.order_lines l where l.variant_id = variants.id);
  return pid;
end $$;

create or replace function public.admin_delete_product(p_product_id uuid) returns void
language plpgsql set search_path = public, private, extensions, pg_temp as $$
begin
  perform private.require_admin();
  perform private.expire_holds();
  if exists (select 1 from public.order_lines l where l.product_id = p_product_id) then
    perform private.fail('in_use', 'This product has orders — hide it instead of deleting.');
  end if;
  delete from public.variants where product_id = p_product_id;
  delete from public.products where id = p_product_id;
end $$;

-- Wipe a buyer's passcode so they can set a new one on their next claim.
create or replace function public.admin_reset_passcode(p_username text) returns void
language plpgsql set search_path = public, private, extensions, pg_temp as $$
declare u text;
begin
  perform private.require_admin();
  perform private.expire_holds();
  u := private.norm_user(p_username);
  update public.buyers set pass_hash = null, fails = 0, lock_until = null where username = u;
  if not found then perform private.fail('not_found', 'No such buyer.'); end if;
  perform private.log_event('admin', 'reset passcode for @' || u);
end $$;

create or replace function public.admin_set_blocked(p_username text, p_blocked boolean) returns void
language plpgsql set search_path = public, private, extensions, pg_temp as $$
declare u text;
begin
  perform private.require_admin();
  perform private.expire_holds();
  u := private.norm_user(p_username);
  update public.buyers set blocked = coalesce(p_blocked, false) where username = u;
  if not found then perform private.fail('not_found', 'No such buyer.'); end if;
  perform private.log_event('admin', (case when p_blocked then 'blocked @' else 'unblocked @' end) || u);
end $$;

-- Self-check: money must balance and stock can't be negative. Returns a list of problems (empty = all good).
create or replace function public.admin_check_books() returns jsonb language plpgsql stable
set search_path = public, private, extensions, pg_temp as $$
declare problems jsonb := '[]'::jsonb; r record;
begin
  perform private.require_admin();
  for r in select p.no from public.payments p where private.payment_allocated(p.id) > p.amount_cents loop
    problems := problems || to_jsonb(format('payment #%s is over-allocated', r.no));
  end loop;
  for r in select o.no from public.orders o where private.order_paid(o.id) > private.order_total(o.id) loop
    problems := problems || to_jsonb(format('order #%s is overpaid', r.no));
  end loop;
  for r in select o.no from public.orders o where o.status in ('cancelled', 'expired')
           and exists (select 1 from public.payment_allocations a where a.order_id = o.id) loop
    problems := problems || to_jsonb(format('closed order #%s still holds money', r.no));
  end loop;
  for r in select v.id from public.variants v where v.stock < 0 loop
    problems := problems || to_jsonb('negative stock on variant ' || r.id);
  end loop;
  for r in select t.no from public.incoming_transactions t where t.status = 'matched' and t.payment_id is null loop
    problems := problems || to_jsonb(format('incoming #%s matched to nothing', r.no));
  end loop;
  return problems;
end $$;

-- ---------------------------------------------------------- 8. screenshots --
-- Private bucket: 2 MB per file, images only. Buyers can add one file at the exact path submit_payment gave them.
-- Only the seller can read or delete. (Create the bucket in the dashboard instead if this insert is blocked.)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-proofs', 'payment-proofs', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = 2097152, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "proofs: upload to an issued path" on storage.objects;
create policy "proofs: upload to an issued path" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'payment-proofs' and private.can_upload_proof(name));
drop policy if exists "proofs: seller reads" on storage.objects;
create policy "proofs: seller reads" on storage.objects for select to authenticated
  using (bucket_id = 'payment-proofs' and private.is_admin());
drop policy if exists "proofs: seller deletes" on storage.objects;
create policy "proofs: seller deletes" on storage.objects for delete to authenticated
  using (bucket_id = 'payment-proofs' and private.is_admin());

-- ------------------------------------------------------------- 9. privileges --
-- Start from nothing, then grant exactly what each role needs.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

grant usage on schema public  to anon, authenticated;
grant usage on schema private to anon, authenticated;                 -- the API does not expose this schema; this is for policies

-- the public catalog (rows are filtered by the policies above)
grant select on public.groups, public.products, public.variants to anon, authenticated;

-- seller tables: row level security lets only users listed in public.admins through
grant select, insert, update, delete on public.admins, public.settings, public.groups, public.products, public.variants,
  public.orders, public.order_lines, public.payments, public.incoming_transactions, public.payment_allocations to authenticated;
grant select on public.activity_log to authenticated;
-- buyers: the seller can never read pass_hash
grant select (username, has_pass, fails, lock_until, blocked, note, created_at) on public.buyers to authenticated;
grant insert (username), update (blocked, note, fails, lock_until, pass_hash, username), delete on public.buyers to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant insert on public.activity_log to authenticated;

-- buyer-facing functions: open to everyone, each one checks the passcode itself
grant execute on function public.buyer_status(text), public.shop_info(), public.my_account(text, text),
  public.place_order(text, text, jsonb), public.submit_payment(text, text, jsonb),
  public.cancel_my_order(text, text, uuid), public.save_address(text, text, jsonb) to anon, authenticated;

-- seller functions: signed-in users only (and each one re-checks public.admins)
grant execute on function public.admin_snapshot(int), public.release_expired_holds(), public.admin_save_settings(jsonb),
  public.admin_confirm_payment(uuid, uuid, int, boolean, boolean), public.admin_reject_payment(uuid, text),
  public.admin_cancel_order(uuid, text), public.admin_set_fulfillment(uuid, text, text),
  public.admin_set_address(uuid, jsonb), public.admin_set_shipping_fee(uuid, int), public.admin_extend_hold(uuid, int), public.admin_import_incoming(jsonb),
  public.admin_ignore_incoming(uuid, boolean), public.admin_assign_incoming(uuid, text, uuid[], boolean),
  public.admin_record_payment(text, text, int, text, uuid[], boolean), public.admin_merge_buyer(text, text),
  public.admin_save_group(jsonb), public.admin_save_product(jsonb), public.admin_delete_product(uuid),
  public.admin_reset_passcode(text), public.admin_set_blocked(text, boolean), public.admin_check_books() to authenticated;

-- helpers: the seller's functions run as the seller and call them; the upload policy calls can_upload_proof.
-- (The two that only the buyer-facing functions use stay closed: those run as the table owner.)
grant execute on all functions in schema private to authenticated;
revoke execute on function private.check_pass(text, text), private.order_json(uuid) from authenticated;
grant execute on function private.can_upload_proof(text) to anon;

-- Optional but recommended: release expired holds even when nobody is on the site.
-- Needs the pg_cron extension (Database > Extensions). Uncomment to enable.
-- select cron.schedule('release-expired-holds', '*/10 * * * *', $$ select private.expire_holds() $$);

-- First seller: create your login under Authentication > Users (disable sign-ups afterwards), then run:
--   insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
