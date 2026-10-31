# Shop Manager

A small shop for photocards, albums and merch, sold by group. Buyers claim with their **Instagram username**, pay however they like, and you match each payment to the money that really arrived.

- **Everyone** sees the shop, their own orders (with a passcode) and "How it works". Nothing else.
- **You** (the seller) sign in at a private address, `…/#/seller`. It is not linked from anywhere. Without your email and password nobody can do anything there, and the database enforces that too.
- The shop starts **empty**. You add groups and products from the seller desk.

| File | What it is |
|---|---|
| `index.html` | The whole shop (one file). Upload this. |
| `config.js` | Two lines that connect the page to your database. You fill these in (step 5). |
| `db/schema.sql` | The database. You paste it into Supabase once (step 2). |
| `DESIGN.md` | How claims, holds, payments and matching work, and why. |
| `src/`, `tests/`, `build.mjs` | The source and tests. Only needed if you want to change the code. |

## 1. Publish the page on GitHub

1. Make a repository named `shop-manager` (public) and upload everything from this folder (**Add file → Upload files**; drag the files in, keep the `db` and `src` folders).
2. **Settings → Pages**: Source *Deploy from a branch*, branch `main`, folder `/ (root)`. Save.
3. After a minute or two the shop is at `https://YOUR-GITHUB-USERNAME.github.io/shop-manager/`.

Until step 5 is done the page says **Preview only** at the top and keeps everything in your own browser: it is safe to look at, but nothing is shared with anyone. That is how you can tell it is not connected yet.

## 2. Make the database (Supabase, free)

Use a **new** Supabase project (not the one used by go-manager).

1. supabase.com → **New project**. Pick a strong database password and a region near you.
2. **SQL Editor → New query**: paste the whole of `db/schema.sql` → **Run**. (It is safe to run again later.)
3. **Authentication → Users → Add user**: your email and a strong password. Tick "Auto confirm".
4. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up". Turn on two-factor if you can.
5. Make that login the seller. **SQL Editor** → run (with your email):
   ```sql
   insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
   ```
6. **Settings → API** (or "API Keys"): leave **Exposed schemas** as it is (it must not list `private`).

## 3. Connect the page to the database

Open `config.js` on GitHub (click it, then the pencil icon) and fill in:

```js
window.SHOP_CONFIG = {
  supabaseUrl: 'https://abcdxyz.supabase.co',      // Project Settings → API → Project URL
  supabaseAnonKey: 'eyJ…',                         // the "anon" key (or the "publishable" key)
};
```

Commit. GitHub Pages can take up to 10 minutes to show the change. When it does, the **Preview only** bar is gone and the shop is live.

The anon/publishable key is **meant to be public**. **Never** paste the `service_role` or `secret` key anywhere in this repo. If you do by accident, the page refuses to run and tells you; then reset the key in Supabase.

## 4. Use it

- **Sign in:** open `https://YOUR-GITHUB-USERNAME.github.io/shop-manager/#/seller` (bookmark it) and use the email and password from step 2.3. Sign out with *Leave seller desk*.
- **First things to do** (the Overview tab lists them): **Settings** (shop name, tagline, colour, your PayPal / Venmo / Zelle details) → **Catalog** (add a group, then its products with prices and stock) → share the shop link.
- **Every day:** Reconcile (match payments to the money received) → Orders (pack and ship).
- **Change the look later:** Settings → *Look of the shop*: main colour (the default is sky blue; text colours adjust themselves so everything stays readable), a tagline under the shop name, and an announcement banner (for example "Orders close Sunday 9pm ET"). Changes show for everyone on the next page load.
- **Change the design itself** (fonts, spacing, layout): edit the variables at the top of `src/style.css` and run `npm run build`, or ask me.
- **Backup:** Settings → *Download backup*. The free plan has no automatic backups, so do this now and then.

## 5. Check it before real customers

Use a private browser window as a buyer, and your own window as the seller:

1. A visitor sees the shop and **no** seller link; `…/#/admin` just shows the shop.
2. As the seller, add a group and a product. In the private window it appears.
3. Claim it as a buyer, send payment details **with a screenshot**. In Supabase, **Storage → payment-proofs** shows the file.
4. As the seller, Reconcile shows the payment and the screenshot. Add the received transfer ("Add one transfer"), confirm, then pack and ship.
5. Open the shop in two windows and try to claim the last item in both at once (only one should win).
6. Supabase **Security Advisor** lists six "SECURITY DEFINER function executable by anon" warnings. That is expected: they are the six buyer functions (`buyer_status`, `shop_info`, `my_account`, `place_order`, `submit_payment`, `cancel_my_order`), and each checks the passcode itself. Anything else listed is worth a look.

## Things to know

- **Keep-alive.** The free Supabase plan pauses a project after a week without visitors. Repo **Settings → Secrets and variables → Actions**: add `SUPABASE_URL` and `SUPABASE_ANON_KEY`; `.github/workflows/keepalive.yml` then pings the project every 3 days. (GitHub switches scheduled jobs off after 60 days without a commit; re-enable it in the Actions tab if that happens.)
- **Screenshots** can show names, emails and card digits. Delete old ones in **Storage** (for example 90 days after an order ships); deleting database rows leaves the files behind.
- **Expired holds** are released whenever anyone opens the shop or the seller desk. For an exact schedule, enable `pg_cron` and uncomment the line at the bottom of `schema.sql`.
- **Two people claiming the last item** is handled with row locks and was reasoned through, but the test database has one user, so do check 5 above.
- **Custom domain, more payment methods, shipping addresses:** see the "next steps" in `DESIGN.md`.

## For developers

```
npm install          # once: a tiny in-memory Postgres used by the database tests
npm run build        # src/ → index.html   (npm run build:demo → demo.html: a sample shop with fake data, no database)
npm test             # rule tests + database tests (about 3 minutes);  npm run test:rules → rules only, 1 second
```

- `tests/core.test.mjs`: rules for money, stock, holds, matching, and the colour guarantees (runs against the code inside `index.html`).
- `tests/db.test.mjs`: loads `db/schema.sql` into a real Postgres; checks who can see and do what, every buyer and seller function, the screenshot upload rules, the storefront and appearance settings, and runs random action sequences through **both** the database and the browser rules, comparing every number. `FUZZ_SEEDS=30 FUZZ_STEPS=200 npm test` for a longer run.
- Page structure: `src/core.js` (rules), `src/api.js` (private preview), `src/live.js` (Supabase over `fetch`), `src/ui.js`, `src/style.css`, `src/head.html`.
