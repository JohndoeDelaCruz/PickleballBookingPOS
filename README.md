# Rally Club — Pickleball booking + POS

First client-presentation build. **Rally Club is placeholder branding.** Built with Next.js 16, TypeScript, Supabase Postgres/Auth/Storage, GSAP, and responsive CSS. The intended deployment target is Vercel.

The public site now has its own editorial layout and visual identity: Manrope, Archivo Black and DM Serif Display typography, charcoal/orange accents, a direct session launcher, interactive play modes, and original generated concept photography. See `docs/DESIGN-SOURCES.md` for inspected references, local image paths and generation prompts. Ascent's photographs and old homepage layout are not used.

## Run and present

```powershell
npm ci
npm run dev -- --port 3001
```

- `http://localhost:3001` — animated public landing page.
- `http://localhost:3001/demo` — interactive client presentation; no sign-in or database setup required. All customers, products, payments, and reservations here are sample data held in memory. Reload or use **Reset sample data** to restart.
- `/book` — real customer court/open-play calendar. Browsing remains available as a labeled preview until the database is configured; live reservations fail closed.
- `/staff` — authenticated club management, cashier, inventory, payment reviews, transactions, and reports.
- `/admin` — manager court calendar and walk-ins; `/admin/settings` — venue details, rates, schedule, GCash QR, and booking toggle.

All management pages, including staff account settings, share the dashboard's sidebar, cards, forms, and responsive layout. A compact Menu button opens the sidebar on phones. Sidebar links can open a dashboard section directly, for example `/staff?tab=inventory`. Venue preferences and booking schedules keep separate save controls.

Management routes share a persistent workspace layout and one skeleton system. Initial page loads and server-backed date/report refreshes show placeholders matched to overview, POS, reservations, inventory, transactions, reports, calendar, venue settings (including courts), or account settings. Local tab switches use data already loaded and remain immediate. Skeleton animation respects reduced-motion preferences; route URLs and access checks are unchanged.

The provided public Supabase connection is in the Git-ignored `.env.local`. `.env.example` contains placeholders. No service-role credential is used. This is a new project and does not connect to the Ascent database.

## Supabase setup — fresh client database

The publishable key cannot create tables or assign privileged users. A project owner must perform these setup steps in the new Supabase project:

1. Open **SQL Editor** for project `glipsgajkrlbcngtkstt` and run **`supabase/setup.sql` once on a fresh database**. This file bundles migrations 001–014. Do not run it on Ascent or rerun it after setup. For subsequent updates, apply only new migration files in order.
2. In **Authentication → URL Configuration**, use `http://localhost:3001` for local Site URL and allow `http://localhost:3001/auth/callback**`. Add the actual production origin/callback before deployment. The app uses PKCE and supports verified email signup, sign-in, recovery, and password changes.
3. Create and verify the owner's account through `/login`. Edit the email placeholder in **`supabase/bootstrap-owner.sql`**, then run that script in SQL Editor. Never assign staff roles from the browser.
4. Sign in and visit `/admin/settings`. Set the venue details, final rates and hours, GCash recipient name, QR image, hold duration, and cancellation policy. Enable online reservations only after these details are correct.
5. Visit `/staff`. Add real products, record stock-in with reasons, and open the cashier shift before accepting counter sales or cash booking balances.

If the Data API does not automatically expose new tables, explicitly expose the `public` schema and retain the grants/RLS created by the migrations. All POS tables deny direct client writes. Checkout, inventory adjustments, refunds, and cashier operations use permission-checked database functions.

Cloudflare Turnstile is optional configuration for this new project. It does not reuse Ascent's widget. To enable it, set this project's public `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, put the matching secret directly in Supabase Auth's CAPTCHA settings, and redeploy. The app sends tokens only when configured; Supabase enforces enabled CAPTCHA independently. Configure SMTP for public email delivery.

## Payment and accounting behavior

- Online bookings use manual GCash. Customers choose full payment or a 50% reservation fee, pay the displayed QR, and submit a reference. The booking stays under review until staff checks the actual incoming payment.
- Reservation fees cover half the entire saved booking total, including any equipment rental charges. Remaining balances are collected separately before play.
- Cashier checkout supports cash and manually verified GCash. It snapshots item names/prices/costs, records payment and cashier, deducts stock, and appends stock/audit entries in one transaction.
- The legacy manager calendar supports cash walk-ins with an open shift. For a GCash court reservation, use the online reservation/reference flow and verify it in `/staff`; an unreferenced GCash walk-in is rejected rather than marked paid.
- One checkout key represents one request. Retrying the identical request returns its original receipt. Changed payloads with the same key are rejected. Always review Transactions after a connection loss before clearing a cart or starting another checkout.
- GCash references are normalized and protected across retail, booking deposits, and booking balances. A reference submission alone never counts as collected money.
- The shared sales ledger contains retail and verified bookings. Reports recognize **collections on the payment date**; deposit and later balance are distinct payments, rather than duplicate sales.
- Cash drawer reconciliation uses opening cash + cash collections − cash refunds. GCash stays separate. The first release has one physical front-desk register and one open shift per register/cashier.
- Manager-authorized **full collected-amount refunds** are recorded after money has actually been returned outside the app. Retail returns can restore stock. Original payments and sales remain in the ledger; a booking refund cancels its reservation. Partial refunds and split-tender retail checkout are later work.
- Transaction slips print with an 80 mm layout and are explicitly labeled **not a tax invoice**. Printer hardware and jurisdiction-specific invoicing remain to be configured and tested with the client.

## Access and operation

- **Owner / manager:** products, stock adjustments, refunds, cashier operations, payment reviews, venue settings and court administration.
- **Cashier:** selling, own shifts, booking payment verification/balance collection, and ledger/report viewing. Manager actions are rejected in Postgres even when invoked directly.
- **Customer:** own bookings; aggregate availability only. Customers cannot access the POS ledger or assign themselves staff.

Online-only. If connectivity is lost, do not treat an unconfirmed write as a completed sale. Recheck Transactions and retry the original checkout where appropriate. There is no offline sale queue or automated transfer/refund integration.

Court count is configurable through **Venue settings → Courts**. Owners/managers can add named courts and activate/deactivate them (up to 100 court records). Existing IDs, booking history, and saved receipts are preserved. Upcoming court reservations, blocks, and shared open-play reservations must be resolved before deactivation; the last active court cannot be deactivated while online reservations are enabled. Open-play player limits remain separately configured and do not multiply when courts are added. Calendars, dashboard timelines, booking labels, per-court finance summaries and CSV exports use the court list, including inactive courts in historical reports. Court changes, venue preferences, and schedules have separate save controls.

For an existing database at migration 013, run only **`supabase/migrations/202611050014_court_management.sql`** once in that client's Supabase SQL Editor. It upgrades the existing courts without replacing them. Until applied, the two existing courts remain available and court editing is disabled.

Whole-hour booking slots remain in this release. Rental fees are supported; tracking individual paddle assets/returns and memberships is outside this first release. Product catalogue and booking queries have explicit safety limits; high-volume reporting requires paginated server reports.

## Checks

```powershell
npm run typecheck
npm test
npm run build
```

Tests execute against isolated PGlite databases, never the hosted Supabase project. Original booking regression fixtures are pinned to migrations 001–012; the integrated POS tests apply **all** migrations, including 013, and exercise transaction rollback, permissions, payment-reference reuse, deposit/balance accounting, full refunds, stock restoration and drawer reconciliation.

Manual browser QA covers landing, phone layouts, a retail cash checkout/receipt, GCash payment verification, and booking balance collection in presentation mode. Live authentication, hosted RLS behavior, actual transfers, printer hardware, and restore procedures still need a staging acceptance run after Supabase setup.

## Deployment

Import this repository into the client's Vercel project. Configure the values from `.env.example` using this client's Supabase project and set `NEXT_PUBLIC_SITE_URL` to the final HTTPS origin. Keep production and test databases separate. Apply migrations before deploying code that depends on them; configure backup/restore and monitoring before live operations. Hosting has not been published by this local build.
