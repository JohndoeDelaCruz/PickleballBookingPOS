import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { centavos, cartTotal, collectionsCsv, dayKey, reportFor, type PosData } from "../src/lib/pos";
import { emptyMembershipDetails, isPublishedMembershipPlan, membershipDetailsSchema, publishedMembershipDetails } from "../src/lib/membership";
import { membershipStatus, type ActiveMembershipRow, type MembershipApplication, type MembershipReviewRow } from "../src/lib/membership-applications";
import { staffNotificationContent, staffNotificationFeedSchema } from "../src/lib/staff-notifications";
import type { CounterProduct } from "../src/lib/counter-products";
import { pickupOrderSchema } from "../src/lib/counter-orders";

const sampleMembership = {
  ...emptyMembershipDetails("annual"),
  price_cents: 48_000,
  heading: "Member information",
  introduction: "Join the venue’s membership program.",
  validity: "The term begins on the approval date.",
  redemption: "Ask staff about the benefits of your plan.",
  home_summary: "See the current membership plans.",
};
const sampleSixMonthMembership = { ...sampleMembership, plan_name: "Six-month plan", price_period: "6 months", price_cents: 31_500 };

test("centavo arithmetic and payment-date reports preserve deposits and refunds", () => {
  assert.equal(centavos("175.25"), 17525);
  assert.equal(centavos("0.01"), 1);
  for (const n of ["-1", "0.001", "NaN", "1e3", ""])
    assert.throws(() => centavos(n));
  assert.equal(
    cartTotal([
      { price_cents: 10, quantity: 3 },
      { price_cents: 20, quantity: 1 },
    ]),
    50,
  );
  assert.equal(dayKey("2026-11-03T20:00:00Z"), "2026-11-04");
  const data: PosData = {
    products: [], sales: [], bookings: [], shifts: [], movements: [], role: "manager", ready: true,
    payments: [
      { id: "deposit", sale_id: "court", amount_cents: 20000, method: "gcash", reference: null, shift_id: null, created_at: "2026-11-03T10:00:00Z" },
      { id: "balance", sale_id: "court", amount_cents: 20000, method: "cash", reference: null, shift_id: "shift", created_at: "2026-11-03T20:00:00Z" },
    ],
    refunds: [
      { id: "refund", sale_id: "court", amount_cents: 40000, method: "cash", reason: "Cancelled", shift_id: "shift", created_at: "2026-11-04T05:00:00Z" },
    ],
  };
  assert.equal(reportFor(data, "2026-11-03").collected, 20000);
  assert.equal(reportFor(data, "2026-11-04").collected, 20000);
  assert.equal(reportFor(data, "2026-11-04").net, -20000);
  const csv = collectionsCsv(data, "2026-11-04");
  assert.ok(csv.includes('"Payment","cash","","200"'));
  assert.ok(csv.includes('"Refund","cash","","-400"'));
  assert.ok(!csv.includes('"gcash"'));
});

test("the public court benefit shows saved terms and keeps custom membership benefits", () => {
  const custom = { icon: "gift" as const, title: "Welcome gift", description: "Pick up a welcome gift at the court." };
  const unpublished = { id: "annual" as const, revision: 0, details: emptyMembershipDetails("annual"), published: false, courtDiscount: null };
  assert.equal(isPublishedMembershipPlan(unpublished), false);
  assert.equal(unpublished.details.price_cents, 0);
  assert.deepEqual(unpublished.details.benefits, []);
  const displayed = publishedMembershipDetails({ id: "annual", revision: 1, published: true,
    details: { ...sampleMembership, benefits: [custom] },
    courtDiscount: { enabled: true, amountCents: 4550, minHours: 3, revision: 1 },
  });
  assert.equal(displayed.benefits[0].title, "₱45.50 off private court bookings");
  assert.match(displayed.benefits[0].description, /at least 3 hours/);
  assert.ok(!displayed.benefits.some((benefit) => benefit.title.includes("₱30")));
  assert.ok(displayed.benefits.includes(custom));
  const six = { id: "six-month" as const, revision: 1, details: sampleSixMonthMembership, published: true,
    courtDiscount: { enabled: true, amountCents: 2250, minHours: 2, revision: 1 } };
  const sixPublished = publishedMembershipDetails(six);
  assert.equal(sixPublished.benefits[0].title, "₱22.50 off private court bookings");
  assert.match(sixPublished.benefits[0].description, /at least 2 hours/);
  assert.ok(!sixPublished.benefits.some((benefit) => benefit.title.includes("evening")));
  const disabled = publishedMembershipDetails({ ...six, courtDiscount: { ...six.courtDiscount, enabled: false } });
  assert.ok(!disabled.benefits.some((benefit) => benefit.title.includes("court bookings")));
  assert.ok(!disabled.home_summary.includes("court bookings"));
  const legacy = publishedMembershipDetails({ ...six, courtDiscount: null, legacyCourtRates: { daytime: null, evening: 12550 } });
  assert.equal(legacy.benefits[0].title, "Up to ₱125.50 per evening court hour");
});

test("full database: atomic checkout, ledger integrity, permissions, booking deposits and shifts", async (t) => {
  const db = new PGlite({ extensions: { btree_gist } });
  const owner = randomUUID(),
    cashier = randomUUID(),
    player = randomUUID();
  async function as<T>(
    user: string,
    fn: () => Promise<T>,
    role = "authenticated",
  ) {
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      user,
    ]);
    await db.exec(`set role ${role}`);
    try {
      return await fn();
    } finally {
      await db.exec("reset role");
    }
  }
  const call = async <T>(user: string, fn: string, args: unknown[] = []) =>
    as(user, () =>
      db.query<{ value: T }>(
        `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`,
        args,
      ),
    ).then((r) => r.rows[0].value);
  try {
    await db.exec(
      `create role anon;create role authenticated;create schema auth;create schema storage;create schema extensions;set search_path=public,extensions;grant usage on schema public,auth,storage to anon,authenticated;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz default now());create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);alter table storage.objects enable row level security;grant select,insert,update on storage.objects to anon,authenticated;alter default privileges grant execute on functions to anon,authenticated;alter default privileges grant all on tables to anon,authenticated;`,
    );
    const files = (await readdir("supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files.filter((f) => f < "202611040013"))
      await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
    await db.query(
      "insert into auth.users values($1,'owner@test.example'),($2,'cashier@test.example'),($3,'player@test.example')",
      [owner, cashier, player],
    );
    await db.exec("alter table auth.users add column raw_user_meta_data jsonb");
    await db.query(
      "insert into public.staff_members(user_id) values($1)",
      [owner],
    );
    const today = dayKey();
    const blocks = [
      { id: "private-morning", days: [1, 2, 3, 4, 5, 6, 7], start: 6, end: 8, kind: "court", rate: 100, capacity: 8 },
      { id: "open-morning", days: [1, 2, 3, 4, 5, 6, 7], start: 8, end: 12, kind: "open_play", rate: 50, capacity: 24 },
      { id: "open-afternoon", days: [1, 2, 3, 4, 5, 6, 7], start: 12, end: 16, kind: "open_play", rate: 50, capacity: 24 },
      { id: "private-evening", days: [1, 2, 3, 4, 5, 6, 7], start: 16, end: 22, kind: "court", rate: 200, capacity: 8 },
    ];
    const schedule = { weekly: blocks, overrides: [{ id: "temporary", name: "Today’s schedule", start_date: today, end_date: today, blocks }] };
    await call(owner, "save_booking_schedule", [JSON.stringify(schedule), null]);
    const legacyPaid = randomUUID(), legacyDeposit = randomUUID(), savedBlock = randomUUID();
    await db.query(`insert into public.bookings(id,user_id,court_id,booking_date,start_hour,duration,total_amount,status,customer_name,customer_phone,payment_option,payment_reference)
      values($1,null,1,$4::date-1,6,1,100,'confirmed','Existing walk-in','09171234567','full',null),
      ($2,$5,1,$4::date-1,7,1,100,'confirmed','Existing deposit','09171234567','reservation_fee','LEGACY-123456'),
      ($3,null,2,$4::date,16,1,200,'blocked','Existing block','09171234567','full',null)`,
      [legacyPaid, legacyDeposit, savedBlock, today, player]);
    await call(owner, "staff_save_booking_finance", [legacyPaid, "cash", "Original notes"]);
    const readCurrentData = async () => ({
      settings: (await db.query("select * from public.venue_settings")).rows,
      bookings: (await db.query("select * from public.bookings order by id")).rows,
      finance: (await db.query("select * from public.booking_finance order by booking_id")).rows,
      schedule: await call<unknown>(player, "get_booking_schedule", [today]),
    });
    const previous = await readCurrentData();
    for (const file of files.filter((f) => f >= "202611040013" && f < "202611110018"))
      await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
    await t.test("cutover preserves today's published schedule, bookings, staff access, and finance records", async () => {
      assert.deepEqual(await readCurrentData(), previous);
      assert.equal(await call(owner, "club_role"), "manager");
      assert.equal((await db.query("select * from public.pos_payments")).rows.length, 0);
      await call(owner, "staff_save_booking_finance", [legacyPaid, "cash", "Updated notes"]);
      assert.equal((await db.query("select * from public.pos_sales")).rows.length, 0);
      await assert.rejects(
        () => call(owner, "pos_collect_balance", [legacyDeposit, "gcash", "legacy123456"]),
        /reference is already/,
      );
      await call(owner, "staff_record_balance", [legacyDeposit, "bank_transfer", ""]);
      const ledger = (await db.query("select s.paid_cents,p.amount_cents,p.method,p.shift_id from public.pos_sales s join public.pos_payments p on s.id=p.sale_id where s.booking_id=$1", [legacyDeposit])).rows;
      assert.deepEqual(ledger, [{ paid_cents: 10000, amount_cents: 5000, method: "bank_transfer", shift_id: null }]);
    });
    await db.exec("update public.venue_settings set schedule_config=null");
    await db.query("update public.staff_members set role='owner' where user_id=$1", [owner]);
    await db.query("insert into public.staff_members(user_id,role) values($1,'cashier')", [cashier]);
    const legacyReview = randomUUID();
    await db.query(
      `insert into public.bookings(id,user_id,court_id,booking_date,start_hour,duration,total_amount,
        status,customer_name,customer_phone,payment_reference,hold_expires_at)
       values($1,$2,1,current_date-3,18,1,200,'awaiting_verification','Legacy Review','09171234567',
        'OLD-REVIEW-123',now()-interval '2 hours')`,
      [legacyReview, player],
    );
    for (const file of files.filter((f) => f >= "202611110018" && f < "202611130020"))
      await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));

    await t.test("GCash review finds overdue bookings across dates and safely releases rejected court time and open-play capacity", async () => {
      const day = (await db.query<{ date: string }>(
        "select ((now() at time zone 'Asia/Manila')::date + 2)::text date",
      )).rows[0].date;
      await db.query(
        "update public.venue_settings set booking_enabled=true,gcash_name='Sample Venue',gcash_qr_url='https://example.com/qr.png',schedule_config=$1",
        [JSON.stringify({ weekly: blocks, overrides: [] })],
      );
      const request = (action: string, input: object) =>
        call<{ id?: string; success?: boolean; error?: string }>(player, "request_customer_booking_v2", [action, JSON.stringify(input)]);
      const court = { booking_date: day, court_id: 1, start_hour: 17, duration: 1, customer_name: "Review Player", customer_phone: "09171234567" };
      const reserved = await request("reserve_court", court);
      assert.ok(reserved.id, reserved.error);
      const reference = "REVIEW-123456";
      assert.deepEqual(await request("payment", { booking_id: reserved.id, reference }), { success: true });

      const queue = () => as(cashier, () => db.query<{
        id: string; overdue: boolean; payment_submitted_at: string | null;
      }>("select * from public.pos_payment_reviews()")).then((r) => r.rows);
      const pending = await queue();
      assert.deepEqual(pending.map(({ id, overdue }) => ({ id, overdue })), [
        { id: legacyReview, overdue: true }, { id: reserved.id, overdue: false },
      ]);
      assert.equal(pending[0].payment_submitted_at, null);
      assert.ok(pending[1].payment_submitted_at);
      assert.equal(Object.hasOwn(pending[0], "customer_phone"), false);
      await assert.rejects(() => call(player, "pos_payment_reviews"), /staff access/);
      await assert.rejects(() => as("", () => db.query("select * from public.pos_payment_reviews()"), "anon"), /permission denied/);
      await assert.rejects(() => call(player, "pos_reject_booking_payment", [reserved.id, "No matching payment"]), /staff access/);
      await assert.rejects(() => call(cashier, "pos_reject_booking_payment", [reserved.id, " "]), /rejection reason/);

      await db.query("update public.bookings set payment_submitted_at=now()-interval '31 minutes',hold_expires_at=now()-interval '30 minutes' where id=$1", [reserved.id]);
      await call(cashier, "expire_unpaid_holds");
      assert.equal((await queue()).find((b) => b.id === reserved.id)?.overdue, true);
      assert.ok((await request("reserve_court", court)).error, "Overdue reviews still hold the court");

      await call(cashier, "pos_reject_booking_payment", [reserved.id, "No matching incoming payment"]);
      assert.equal((await queue()).some((b) => b.id === reserved.id), false);
      await assert.rejects(() => call(cashier, "pos_verify_booking", [reserved.id]), /Only a submitted/);
      assert.deepEqual((await db.query(
        "select status,payment_reference,payment_rejected_at is not null as rejected,paid_amount::int from public.bookings where id=$1",
        [reserved.id],
      )).rows, [{ status: "cancelled", payment_reference: null, rejected: true, paid_amount: 0 }]);
      assert.equal((await db.query("select 1 from public.pos_sales where booking_id=$1", [reserved.id])).rows.length, 0);
      assert.deepEqual((await db.query(
        "select actor_id,detail->>'reason' reason,detail->>'reference' reference from public.pos_audit where entity_id=$1 and action='booking.payment.reject'",
        [reserved.id],
      )).rows, [{ actor_id: cashier, reason: "No matching incoming payment", reference }]);
      await call(cashier, "pos_reject_booking_payment", [legacyReview, "No matching incoming payment"]);

      const replacement = await request("reserve_court", court);
      assert.ok(replacement.id, replacement.error);
      assert.deepEqual(await request("payment", { booking_id: replacement.id, reference }), { success: true });
      await call(cashier, "pos_verify_booking", [replacement.id]);
      await assert.rejects(() => call(cashier, "pos_reject_booking_payment", [replacement.id, "Stale rejection"]), /Only an unpaid booking/);

      const remainingPasses = async () => (await db.query<{ remaining: number }>(
        "select remaining from public.get_open_play_sessions($1) where start_hour=8", [day],
      )).rows[0].remaining;
      const openPlay = await request("reserve_open_play", { ...court, start_hour: 8, participant_count: 3 });
      assert.ok(openPlay.id, openPlay.error);
      assert.deepEqual(await request("payment", { booking_id: openPlay.id, reference: "OPEN-REVIEW-123" }), { success: true });
      assert.equal(await remainingPasses(), 21);
      await call(cashier, "pos_reject_booking_payment", [openPlay.id, "Reference could not be matched"]);
      assert.equal(await remainingPasses(), 24);
      await db.exec("update public.venue_settings set schedule_config=null");
    });

    await t.test("cashier reservation view excludes private contact fields and rejects customers", async () => {
      await assert.rejects(() => call(player, "pos_reservations", [today]), /staff access/);
      const raw = await as(cashier, () => db.query("select id from public.bookings where id=$1", [savedBlock]));
      assert.equal(raw.rows.length, 0);
      const visible = await as(cashier, () => db.query("select * from public.pos_reservations($1) where id=$2", [today, savedBlock]));
      assert.equal(visible.rows.length, 1);
      assert.equal(Object.hasOwn(visible.rows[0] as object, "customer_phone"), false);
      assert.equal(Object.hasOwn(visible.rows[0] as object, "user_id"), false);
      assert.equal(Object.hasOwn(visible.rows[0] as object, "notes"), false);
    });
    let product: string = "",
      shift: string = "";
    const key = randomUUID();
    const request = {
      key,
      items: [] as {
        product_id: string;
        quantity: number;
        price_cents: number;
      }[],
      method: "cash",
      reference: "",
      tendered_cents: 10000,
      customer_name: "Test customer",
      verified: true,
    };
    await t.test(
      "anonymous and customer calls cannot mutate or read the POS ledger",
      async () => {
        assert.equal(await call(player, "is_club_staff"), false);
        await assert.rejects(
          () => call(player, "pos_open_shift", [0]),
          /staff access/,
        );
        await assert.rejects(
          () =>
            as("", () => db.query("select public.pos_open_shift(0)"), "anon"),
          /permission denied/,
        );
        const rows = await as(player, () =>
          db.query("select * from public.pos_products"),
        );
        assert.equal(rows.rows.length, 0);
        for (const name of [
          "pos_checkout(jsonb)",
          "pos_open_shift(integer)",
          "pos_refund(uuid,text,text,boolean)",
        ])
          assert.equal(
            (
              await db.query<{ allowed: boolean }>(
                "select has_function_privilege('anon',$1,'execute') allowed",
                [`public.${name}`],
              )
            ).rows[0].allowed,
            false,
          );
      },
    );
    await t.test(
      "manager product controls and a single open physical drawer",
      async () => {
        const p = {
          name: "Water",
          sku: "WTR-01",
          barcode: "48000001",
          category: "Drinks",
          price_cents: 3000,
          cost_cents: 1000,
          reorder_level: 2,
          active: true,
        };
        await assert.rejects(
          () => call(cashier, "pos_save_product", [p]),
          /Manager authorization/,
        );
        product = await call<string>(owner, "pos_save_product", [p]);
        await call(owner, "pos_adjust_stock", [product, 5, "Opening stock"]);
        await assert.rejects(
          () =>
            as(owner, () =>
              db.query("update public.pos_products set stock=999"),
            ),
          /permission denied/,
        );
        shift = await call<string>(owner, "pos_open_shift", [100000]);
        await assert.rejects(
          () => call(cashier, "pos_open_shift", [0]),
          /already has an open/,
        );
        request.items = [
          { product_id: product, quantity: 2, price_cents: 3000 },
        ];
      },
    );
    await t.test(
      "checkout retries return the original receipt and deduct stock once",
      async () => {
        const sale = await call<{ total_cents: number }>(
          owner,
          "pos_checkout",
          [request],
        );
        assert.equal(sale.total_cents, 6000);
        await call(owner, "pos_checkout", [request]);
        assert.equal(
          (
            await db.query<{ stock: number }>(
              "select stock from public.pos_products where id=$1",
              [product],
            )
          ).rows[0].stock,
          3,
        );
        assert.equal(
          (
            await db.query(
              "select * from public.pos_payments where sale_id=$1",
              [key],
            )
          ).rows.length,
          1,
        );
        await assert.rejects(
          () =>
            call(owner, "pos_checkout", [
              { ...request, customer_name: "Changed request" },
            ]),
          /checkout key was already used/,
        );
      },
    );
    await t.test(
      "overselling, stale prices, insufficient cash and duplicate lines roll back completely",
      async () => {
        for (const items of [
          [{ product_id: product, quantity: 4, price_cents: 3000 }],
          [{ product_id: product, quantity: 1, price_cents: 1 }],
          [
            { product_id: product, quantity: 1, price_cents: 3000 },
            { product_id: product, quantity: 1, price_cents: 3000 },
          ],
        ])
          await assert.rejects(
            () =>
              call(owner, "pos_checkout", [
                { ...request, key: randomUUID(), items },
              ]),
            /stock|price changed|Duplicate/,
          );
        await assert.rejects(
          () =>
            call(owner, "pos_checkout", [
              { ...request, key: randomUUID(), tendered_cents: 1 },
            ]),
          /Cash received/,
        );
        assert.equal(
          (await db.query("select * from public.pos_sales where kind='retail'")).rows.length,
          1,
        );
        assert.equal(
          (
            await db.query<{ stock: number }>(
              "select stock from public.pos_products where id=$1",
              [product],
            )
          ).rows[0].stock,
          3,
        );
      },
    );
    await t.test(
      "one GCash reference cannot pay for retail twice",
      async () => {
        const req = {
          ...request,
          key: randomUUID(),
          items: [{ product_id: product, quantity: 1, price_cents: 3000 }],
          method: "gcash",
          reference: "GC-123456",
        };
        await call(owner, "pos_checkout", [req]);
        await assert.rejects(
          () =>
            call(owner, "pos_checkout", [
              { ...req, key: randomUUID(), reference: "gc123456" },
            ]),
          /reference is already/,
        );
        assert.equal(
          (
            await db.query<{ stock: number }>(
              "select stock from public.pos_products where id=$1",
              [product],
            )
          ).rows[0].stock,
          2,
        );
      },
    );
    await t.test(
      "customer deposit stays uncollected until cashier verification; balance posts exactly once",
      async () => {
        const booking = randomUUID();
        await db.query(
          "insert into public.bookings(id,user_id,court_id,booking_date,start_hour,duration,total_amount,status,customer_name,customer_phone,payment_option,payment_reference) values($1,$2,1,current_date+1,18,2,400,'awaiting_verification','Deposit Player','09171234567','reservation_fee','BOOK-123456')",
          [booking, player],
        );
        assert.equal(
          (
            await db.query(
              "select * from public.pos_sales where booking_id=$1",
              [booking],
            )
          ).rows.length,
          0,
        );
        await call(cashier, "pos_verify_booking", [booking]);
        let s = (
          await db.query<{ id: string; paid_cents: number }>(
            "select * from public.pos_sales where booking_id=$1",
            [booking],
          )
        ).rows[0];
        assert.equal(s.paid_cents, 20000);
        await assert.rejects(
          () => call(cashier, "pos_verify_booking", [booking]),
          /Only a submitted/,
        );
        await call(owner, "pos_collect_balance", [booking, "cash", ""]);
        s = (
          await db.query<{ id: string; paid_cents: number }>(
            "select * from public.pos_sales where booking_id=$1",
            [booking],
          )
        ).rows[0];
        assert.equal(s.paid_cents, 40000);
        assert.equal(
          (
            await db.query(
              "select * from public.pos_payments where sale_id=$1",
              [s.id],
            )
          ).rows.length,
          2,
        );
        await assert.rejects(
          () => call(owner, "pos_collect_balance", [booking, "cash", ""]),
          /no collectible balance/,
        );
        assert.equal(
          Number(
            (
              await db.query<{ paid_amount: string }>(
                "select paid_amount from public.bookings where id=$1",
                [booking],
              )
            ).rows[0].paid_amount,
          ),
          400,
        );
      },
    );
    await t.test(
      "booking and retail share normalized reference protection",
      async () => {
        await assert.rejects(
          () =>
            db.query(
              "insert into public.bookings(user_id,court_id,booking_date,start_hour,duration,total_amount,status,customer_name,customer_phone,payment_reference) values($1,2,current_date+1,18,1,200,'awaiting_verification','Repeat Ref','09171234567','GC123456')",
              [player],
            ),
          /reference is already/,
        );
        await assert.rejects(
          () =>
            call(owner, "pos_checkout", [
              {
                ...request,
                key: randomUUID(),
                items: [
                  { product_id: product, quantity: 1, price_cents: 3000 },
                ],
                method: "gcash",
                reference: "book123456",
              },
            ]),
          /reference is already/,
        );
      },
    );
    await t.test("cash walk-ins post one payment for the final rental quantity; unreferenced GCash walk-ins roll back", async () => {
      const day = (await db.query<{booking_day:string}>("select (current_date+1)::text as booking_day")).rows[0].booking_day;
      await db.exec("update public.venue_settings set open_play_enabled=false,opening_hour=6,closing_hour=22,hourly_rate=100,equipment_rental_price=30");
      const booking = await call<string>(owner,"reserve_staff_equipment_booking",["court",day,"Walk-in Player","09171234567",2,6,1,1,true,false,"cash","","full",2]);
      const ledger = (await db.query(
        "select s.total_cents,s.paid_cents,p.amount_cents,p.method,p.shift_id,b.equipment_quantity from public.pos_sales s join public.pos_payments p on p.sale_id=s.id join public.bookings b on b.id=s.booking_id where b.id=$1",
        [booking],
      )).rows;
      assert.deepEqual(ledger, [{ total_cents: 16000, paid_cents: 16000, amount_cents: 16000, method: "cash", shift_id: shift, equipment_quantity: 2 }]);
      await assert.rejects(()=>call(owner,"reserve_staff_equipment_booking",["court",day,"Missing GCash Ref","09171234567",2,7,1,1,false,false,"gcash","","full",0]),/verified transaction reference/);
      assert.equal((await db.query("select * from public.bookings where customer_name='Missing GCash Ref'")).rows.length,0);
      await assert.rejects(()=>call(owner,"staff_save_booking_finance",[booking,"card","Reclassify"]),/cannot be edited/);
    });
    await t.test(
      "manager refunds preserve original sale, restore stock once and reconcile cash",
      async () => {
        await assert.rejects(
          () =>
            call(cashier, "pos_refund", [
              key,
              "cash",
              "Returned unopened",
              true,
            ]),
          /Manager authorization/,
        );
        await call(owner, "pos_refund", [
          key,
          "cash",
          "Returned unopened",
          true,
        ]);
        assert.equal(
          (
            await db.query<{ stock: number }>(
              "select stock from public.pos_products where id=$1",
              [product],
            )
          ).rows[0].stock,
          4,
        );
        assert.equal(
          (
            await db.query(
              "select * from public.pos_payments where sale_id=$1",
              [key],
            )
          ).rows.length,
          1,
        );
        await assert.rejects(
          () => call(owner, "pos_refund", [key, "cash", "Try duplicate", true]),
          /cannot be refunded again/,
        );
        const summary = await as(owner, () =>
          db.query<{ expected_cents: number }>(
            "select expected_cents from public.pos_shift_summary()",
          ),
        );
        assert.equal(Number(summary.rows[0].expected_cents), 136000);
        await assert.rejects(
          () => call(cashier, "pos_close_shift", [shift, 120000]),
          /Only your active/,
        );
        await call(owner, "pos_close_shift", [shift, 135500]);
        const s = (
          await db.query<{ counted_cents: number; expected_cents: string }>(
            "select * from public.pos_shifts where id=$1",
            [shift],
          )
        ).rows[0];
        assert.equal(s.counted_cents - Number(s.expected_cents), -500);
        await assert.rejects(
          () =>
            call(owner, "pos_checkout", [{ ...request, key: randomUUID() }]),
          /Open your cashier shift/,
        );
      },
    );
    await t.test(
      "stock and audit ledgers remain append-only to authenticated users",
      async () => {
        for (const table of [
          "pos_payments",
          "pos_sale_items",
          "pos_refunds",
          "pos_stock_movements",
          "pos_audit",
        ])
          await assert.rejects(
            () => as(owner, () => db.query(`delete from public.${table}`)),
            /permission denied/,
          );
        assert.ok(
          (await db.query("select * from public.pos_audit")).rows.length > 5,
        );
      },
    );
    await t.test("expense access, retries, monthly totals, and drawer reconciliation", async () => {
      const date = dayKey();
      const month = `${date.slice(0, 7)}-01`;
      const record = async (user: string, args: unknown[]) =>
        (await call<Date>(user, "pos_record_expense", args)).toISOString().slice(0, 10);
      type Report = { row_count: number; total_cents: number; drawer_cents: number; rows: { id: string; void_reason: string | null }[] };
      const report = (user: string, page = 1) => call<Report>(user, "pos_expense_report", [month, page]);
      const drawerShift = await call<string>(cashier, "pos_open_shift", [10000]);
      const drawer = [randomUUID(), null, "supplies", "Court supplies", 1225, "cash", drawerShift];
      const anotherDrawer = [randomUUID(), null, "maintenance", "Court repair", 2000, "cash", drawerShift];
      const bill = [randomUUID(), date, "utilities", "Electricity", 3500, "gcash", null];
      const expected = async () => Number((await as(cashier, () =>
        db.query<{ expected_cents: number }>("select expected_cents from public.pos_shift_summary() where id=$1", [drawerShift]),
      )).rows[0].expected_cents);

      const before = await readCurrentData();
      for (const file of files.filter((f) => f >= "202611130020" && f < "202611150032"))
        await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
      assert.deepEqual(await readCurrentData(), before);

      await assert.rejects(() => report(player), /Authorized staff/);
      await assert.rejects(() => as("", () => db.query("select * from public.pos_expenses"), "anon"), /permission denied/);
      await assert.rejects(() => record(player, drawer), /Authorized staff/);
      await assert.rejects(() => record(cashier, bill), /Manager authorization/);
      await assert.rejects(() => record(owner, drawer), /Open your cashier shift/);
      await assert.rejects(() => record(cashier, [...drawer.slice(0, 5), "gcash", drawerShift]), /valid expense/);
      await assert.rejects(() => record(owner, [randomUUID(), "2100-12-31", ...bill.slice(2)]), /today or an earlier date/);
      assert.equal(await record(cashier, drawer), date);
      assert.equal(await record(cashier, drawer), date);
      await assert.rejects(() => record(cashier, [...drawer.slice(0, 4), 100, ...drawer.slice(5)]), /different expense/);
      assert.equal(await expected(), 8775);
      assert.equal(await record(cashier, anotherDrawer), date);
      await record(owner, bill);
      assert.equal((await report(cashier)).row_count, 2);
      assert.equal((await report(owner)).total_cents, 6725);
      assert.equal((await report(owner)).drawer_cents, 3225);
      assert.equal((await as(player, () => db.query("select id from public.pos_expenses"))).rows.length, 0);
      await assert.rejects(() => as(owner, () => db.query("delete from public.pos_expenses")), /permission denied/);
      await assert.rejects(() => call(cashier, "pos_void_expense", [drawer[0], "Correction"]), /Manager authorization/);

      await call(owner, "pos_void_expense", [anotherDrawer[0], "Duplicate entry"]);
      assert.equal(await expected(), 8775);
      await call(cashier, "pos_close_shift", [drawerShift, 8775]);
      assert.equal(await record(cashier, drawer), date);
      await assert.rejects(() => record(cashier, [randomUUID(), ...drawer.slice(1)]), /Open your cashier shift/);
      await call(owner, "pos_void_expense", [drawer[0], "Entered in error"]);
      await call(owner, "pos_void_expense", [drawer[0], "Retry"]);
      assert.equal(await expected(), 8775);
      assert.equal((await report(owner)).total_cents, 3500);
      assert.equal((await report(owner)).rows.find((row) => row.id === drawer[0])?.void_reason, "Entered in error");
      const audit = await db.query<{ action: string }>("select action from public.pos_audit where entity_id=$1 order by created_at", [drawer[0]]);
      assert.deepEqual(audit.rows.map((row) => row.action), ["expense.record", "expense.void"]);

      for (let i = 0; i < 23; i++) await record(owner, [randomUUID(), ...bill.slice(1)]);
      const firstPage = await report(owner);
      const secondPage = await report(owner, 2);
      assert.equal(firstPage.rows.length, 25);
      assert.equal(secondPage.rows.length, 1);
      assert.equal(secondPage.total_cents, 84000);
      assert.ok(!firstPage.rows.some((row) => row.id === secondPage.rows[0].id));
    });

    await t.test("membership details are public, with revision-checked manager and owner writes", async () => {
      const manager = randomUUID();
      await db.query("insert into auth.users(id,email) values($1,'membership-manager@example.test')", [manager]);
      await db.query("insert into public.staff_members(user_id,role) values($1,'manager')", [manager]);
      const publicRead = () => as("", () => db.query("select details,revision from public.membership_settings"), "anon")
        .then((result) => result.rows[0]);
      const save = (user: string, details: unknown, revision: number | null = 0) =>
        call<number>(user, "save_membership_details", [JSON.stringify(details), revision]);
      const revision = { ...sampleMembership, price_cents: 35025 };
      const before = await readCurrentData();

      assert.deepEqual(await publicRead(), { details: null, revision: 0 });
      assert.equal(membershipDetailsSchema.safeParse(sampleMembership).success, true);
      await assert.rejects(() => save(cashier, revision), /Manager or owner access/);
      await assert.rejects(() => save(player, revision), /Manager or owner access/);
      await assert.rejects(() => as("", () => db.query("select public.save_membership_details('{}', 0)"), "anon"), /permission denied/);
      await assert.rejects(() => as(owner, () => db.query("update public.membership_settings set details = '{}'")), /permission denied/);
      await assert.rejects(() => save(owner, { ...revision, price_cents: -1 }), /valid membership details/);
      await assert.rejects(() => save(owner, { ...revision, benefits: {} }), /valid membership details/);
      await assert.rejects(() => save(owner, { ...revision, benefits: [{ icon: "unknown", title: "A perk", description: "A benefit" }] }), /valid membership benefits/);
      assert.deepEqual(await publicRead(), { details: null, revision: 0 });
      assert.equal(await save(manager, revision), 1);
      assert.equal(await save(manager, revision), 1);
      assert.deepEqual(await publicRead(), { details: revision, revision: 1 });

      const secondRevision = { ...revision, price_cents: 40000, benefits: [] };
      await assert.rejects(() => save(owner, secondRevision), /Someone updated the membership details/);
      assert.equal(await save(owner, secondRevision, 1), 2);
      assert.deepEqual(await publicRead(), { details: secondRevision, revision: 2 });
      assert.deepEqual(await readCurrentData(), before);
    });
    await t.test("adding or reapplying the six-month plan preserves published plans and keeps revisions independent", async () => {
      const readPlans = () => as("", () => db.query<{ id: boolean; details: unknown; revision: number }>(
        "select id, details, revision from public.membership_settings order by id desc",
      ), "anon").then((result) => result.rows);
      const [annual] = await readPlans();
      const before = await readCurrentData();
      const planMigration = await readFile("supabase/migrations/202611150032_membership_plans.sql", "utf8");
      await db.exec(planMigration);
      for (const file of files.filter((f) => f > "202611150032_membership_plans.sql" && f < "202611150034"))
        await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
      assert.deepEqual(await readPlans(), [annual, { id: false, details: null, revision: 0 }]);
      await assert.rejects(() => call(player, "start_membership_application", ["six-month", 0]), /plan is not available/);

      const details = { ...sampleSixMonthMembership, heading: "Six-month member information" };
      const savePlan = (user: string, plan: string, revision: number, input = details) =>
        call<number>(user, "save_membership_plan", [plan, JSON.stringify(input), revision]);
      await assert.rejects(() => savePlan(cashier, "six-month", 0), /Manager or owner access/);
      await assert.rejects(() => savePlan(player, "six-month", 0), /Manager or owner access/);
      await assert.rejects(() => as("", () => db.query("select public.save_membership_plan('six-month','{}',0)"), "anon"), /permission denied/);
      await assert.rejects(() => savePlan(owner, "weekly", 0), /Choose a membership plan/);
      await assert.rejects(() => savePlan(owner, "six-month", 0, { ...details, benefits: [{ icon: "gift", title: " ", description: "A perk" }] }), /valid membership benefits/);
      assert.equal(await savePlan(owner, "six-month", 0), 1);
      assert.equal(await savePlan(owner, "six-month", 0), 1);
      await assert.rejects(() => savePlan(owner, "six-month", 0, { ...details, price_cents: 35000 }), /updated this membership plan/);
      assert.deepEqual(await readPlans(), [annual, { id: false, details, revision: 1 }]);

      const updatedAnnual = sampleMembership;
      assert.equal(await call(owner, "save_membership_details", [JSON.stringify(updatedAnnual), annual.revision]), annual.revision + 1);
      await db.exec(planMigration);
      assert.deepEqual(await readPlans(), [
        { id: true, details: updatedAnnual, revision: annual.revision + 1 },
        { id: false, details, revision: 1 },
      ]);
      assert.equal(await savePlan(owner, "six-month", 1), 1);
      await assert.rejects(() => savePlan(player, "six-month", 1), /Manager or owner access/);
      assert.deepEqual(await readCurrentData(), before);
    });
    await t.test("cashier calendar and walk-ins reuse booking and register protections", async () => {
      const date = (await db.query<{ date: string }>(
        "select ((now() at time zone 'Asia/Manila')::date + 5)::text date",
      )).rows[0].date;
      await db.query("update public.venue_settings set booking_enabled=false,schedule_config=$1,equipment_rental_price=30",
        [JSON.stringify({ weekly: blocks, overrides: [] })]);
      const court = [randomUUID(), "court", date, "Cash walk-in", "09171234567", 1, 6, 1, 1, 2, "reservation_fee", "cash", "", true, 8000];
      const openPlay = [randomUUID(), "open_play", date, "GCash walk-in", "09171234567", null, 8, 1, 2, 0, "full", "gcash", "WALK-123456", true, 10000];
      const book = (args: unknown[], user = cashier) => call<string>(user, "pos_book_walk_in", args);
      const calendar = (user: string) => as(user, () => db.query<{ id: string; status: string }>(
        "select * from public.pos_calendar_reservations($1)", [date],
      )).then((r) => r.rows);
      const ledger = (id: string) => db.query(
        "select s.total_cents,p.amount_cents,p.method,p.reference,p.shift_id from public.pos_sales s join public.pos_payments p on p.sale_id=s.id where s.booking_id=$1",
        [id],
      ).then((r) => r.rows);

      await assert.rejects(() => calendar(player), /Authorized staff/);
      await assert.rejects(() => as("", () => db.query("select * from public.pos_calendar_reservations($1)", [date]), "anon"), /permission denied/);
      await assert.rejects(() => book(court, player), /Authorized staff/);
      await assert.rejects(() => call(cashier, "reserve_staff_equipment_booking",
        ["court", date, "Unauthorized block", "", 1, 6, 1, 1, false, true, "unspecified", "", "full", 0]), /staff authorization|staff access|manager/i);
      await assert.rejects(() => call(cashier, "save_booking_schedule", [JSON.stringify(schedule), null]), /staff authorization|staff access|manager/i);
      await assert.rejects(() => book(court), /Open your cashier shift/);
      assert.deepEqual(await calendar(cashier), []);

      const drawer = await call<string>(cashier, "pos_open_shift", [0]);
      await assert.rejects(() => book([...court.slice(0, 14), 7500]), /payment amount changed/);
      const courtId = await book(court);
      assert.equal(await book(court), courtId);
      await assert.rejects(() => book([...court.slice(0, 3), "Changed name", ...court.slice(4)]), /already recorded a different booking/);
      await assert.rejects(() => book([randomUUID(), ...court.slice(1)]), /conflicting key|already reserved/);
      assert.deepEqual(await ledger(courtId), [{ total_cents: 16000, amount_cents: 8000, method: "cash", reference: null, shift_id: drawer }]);

      await assert.rejects(() => book([...openPlay.slice(0, 13), false, 10000]), /confirm the received payment/);
      await assert.rejects(() => book([...openPlay.slice(0, 12), "", true, 10000]), /verified GCash transaction reference/);
      const openPlayId = await book(openPlay);
      assert.deepEqual(await ledger(openPlayId), [{ total_cents: 10000, amount_cents: 10000, method: "gcash", reference: "WALK-123456", shift_id: null }]);
      await assert.rejects(() => book([randomUUID(), ...openPlay.slice(1, 6), 12, ...openPlay.slice(7, 12), "walk123456", true, 10000]), /reference is already/);
      const rows = await calendar(cashier);
      assert.deepEqual(rows.map((row) => row.id).sort(), [courtId, openPlayId].sort());
      assert.ok(rows.every((row) => row.status === "confirmed"));
      for (const field of ["customer_phone", "user_id", "notes", "finance_notes"]) {
        assert.ok(rows.every((row) => !Object.hasOwn(row, field)));
      }
      assert.equal((await as(cashier, () => db.query("select id from public.bookings where id=$1", [courtId]))).rows.length, 0);
      const group = (people: number) => [randomUUID(), ...openPlay.slice(1, 8), people, ...openPlay.slice(9, 12), `WALK-GROUP-${people}`, true, people * 5000];
      await book(group(20));
      await assert.rejects(() => book(group(3)), /places|spots|capacity/i);
      await call(cashier, "pos_close_shift", [drawer, 8000]);
    });

    await t.test("account access separates owners, managers, cashiers, and players", async () => {
      const manager = randomUUID(), pending = randomUUID();
      await db.query("insert into auth.users (id,email,email_confirmed_at) values ($1,'manager@test.example',now()),($2,'pending@test.example',null)", [manager, pending]);
      type ListedAccount = { id: string; email: string; full_name: string | null; role: string; email_confirmed: boolean };
      const list = (actor: string, query = "", page = 1) =>
        call<{ row_count: number; page_size: number; rows: ListedAccount[] }>(actor, "admin_list_accounts", [query, page]);
      const change = (actor: string, user: string, from: string, to: string) =>
        call(actor, "admin_set_account_role", [user, from, to]);
      await assert.rejects(() => list(player), /authorization/);
      await assert.rejects(() => list(cashier), /authorization/);
      await assert.rejects(() => change(player, owner, "owner", "player"), /authorization/);
      await assert.rejects(() => change(cashier, player, "player", "cashier"), /authorization/);
      await assert.rejects(() => as("", () => db.query("select public.admin_list_accounts('',1)"), "anon"), /permission denied/);
      await assert.rejects(() => as(owner, () => db.query("update public.staff_members set role='owner' where user_id=$1", [cashier])), /permission denied/);
      await assert.rejects(() => change(owner, owner, "owner", "player"), /own role/);
      await assert.rejects(() => change(owner, pending, "player", "owner"), /confirm their email/);
      await db.query("update auth.users set raw_user_meta_data=$2 where id=$1", [player, JSON.stringify({ full_name: "  Ana\t  de la Cruz  ", role: "owner", private_note: "hidden" })]);
      const playerRow = { id: player, email: "player@test.example", full_name: "Ana de la Cruz", role: "player", email_confirmed: true };
      assert.deepEqual(await list(owner, "PlAyEr@"), {
        row_count: 1, page_size: 10, rows: [playerRow],
      });
      assert.deepEqual((await list(owner, "AnA  de La")).rows, [playerRow]);
      await db.query("update auth.users set raw_user_meta_data=$2 where id=$1", [pending, JSON.stringify({ full_name: " \t " })]);
      await db.query("update auth.users set raw_user_meta_data=$2 where id=$1", [cashier, JSON.stringify({ full_name: { name: "Do not show" } })]);
      assert.equal((await list(owner, "pending@")).rows[0].full_name, null);
      assert.equal((await list(owner, "cashier@")).rows[0].full_name, null);
      assert.equal((await list(owner, "owner@")).rows[0].full_name, null);
      assert.equal((await list(owner, "%")).row_count, 0);
      await db.query("insert into auth.users(id,email) select gen_random_uuid(), 'paging-' || n || '@test.example' from generate_series(1,26) n");
      const accountPages = [await list(owner, "paging-"), await list(owner, "paging-", 2), await list(owner, "paging-", 3)];
      assert.deepEqual(accountPages.map(({ rows }) => rows.length), [10, 10, 6]);
      assert.ok(accountPages.every(({ row_count, page_size }) => row_count === 26 && page_size === 10));
      const accountEmails = accountPages.flatMap(({ rows }) => rows.map(({ email }) => email));
      assert.deepEqual(accountEmails, Array.from({ length: 26 }, (_, i) => `paging-${i + 1}@test.example`).sort());

      await change(owner, manager, "player", "manager");
      assert.equal((await list(manager, "owner@")).rows[0].role, "owner");
      await assert.rejects(() => change(manager, owner, "owner", "cashier"), /Only an owner/);
      await assert.rejects(() => change(manager, cashier, "cashier", "manager"), /Only an owner/);
      await assert.rejects(() => change(manager, player, "player", "owner"), /Only an owner/);
      await change(manager, player, "player", "cashier");
      assert.equal(await call(player, "club_role"), "cashier");
      assert.equal(await call(player, "is_staff"), false);
      const shift = await call<string>(player, "pos_open_shift", [0]);
      await assert.rejects(() => change(manager, player, "cashier", "player"), /close their register shift/);
      await call(player, "pos_close_shift", [shift, 0]);
      const bookings = await db.query("select id,user_id from public.bookings where user_id=$1", [player]);
      assert.ok(bookings.rows.length);
      await change(manager, player, "cashier", "player");
      assert.equal(await call(player, "is_club_staff"), false);
      await assert.rejects(() => call(player, "pos_open_shift", [0]), /Authorized staff/);
      assert.deepEqual((await db.query("select id,user_id from public.bookings where user_id=$1", [player])).rows, bookings.rows);

      await assert.rejects(() => change(owner, manager, "cashier", "owner"), /role changed/);
      await change(owner, manager, "manager", "owner");
      await change(owner, manager, "manager", "owner");
      assert.equal(await call(manager, "club_role"), "owner");
      const audit = await db.query("select actor_id,detail from public.pos_audit where action='access.role_change' and entity_id=$1 order by created_at", [manager]);
      assert.deepEqual(audit.rows, [
        { actor_id: owner, detail: { from: "player", to: "manager" } },
        { actor_id: owner, detail: { from: "manager", to: "owner" } },
      ]);
      assert.equal((await as(cashier, () => db.query("select id from public.pos_audit where action='access.role_change'"))).rows.length, 0);
    });

    await t.test("daily cashier assignments preserve actual register operators and drawer totals", async () => {
      const substitute = randomUUID();
      await db.query("insert into auth.users (id,email,raw_user_meta_data) values($1,'relief@test.example',$2)",
        [substitute, JSON.stringify({ full_name: "  Pat  Reyes ", private_note: "hidden" })]);
      await call(owner, "admin_set_account_role", [substitute, "player", "cashier"]);
      const date = dayKey();
      const tomorrow = dayKey(new Date(Date.now() + 86400000));
      type RegisterDay = { assignment: { id: string; label: string; eligible: boolean; name: string | null } | null;
        cashiers: { id: string; label: string; name: string | null }[]; operators: string[];
        active: { own_shift: { expected_cents: number } | null } | null };
      const read = (actor: string, day = date) => call<RegisterDay>(actor, "pos_register_day", [day]);
      const assign = (actor: string, id: string | null, expected: string | null = null, day = date) =>
        call(actor, "pos_assign_cashier", [day, expected, id]);

      assert.equal((await read(owner)).assignment, null);
      await assert.rejects(() => read(player), /Authorized staff/);
      await assert.rejects(() => assign(cashier, cashier), /Manager authorization/);
      await assert.rejects(() => assign(owner, player), /confirmed account with the Cashier role/);
      await assert.rejects(() => assign(owner, owner), /confirmed account with the Cashier role/);
      await assert.rejects(() => as("", () => db.query("select public.pos_register_day(current_date)"), "anon"), /permission denied/);
      assert.deepEqual((await read(owner)).cashiers.find((row) => row.id === substitute),
        { id: substitute, label: "relief@test.example", name: "Pat Reyes" });
      const shift = await call<string>(substitute, "pos_open_shift", [10000]);
      const expense = [randomUUID(), null, "supplies", "Shift supplies", 1200, "cash", shift];
      await call(substitute, "pos_record_expense", expense);
      await assign(owner, cashier);
      await assign(owner, cashier);
      assert.equal(await call(cashier, "is_club_staff"), true);
      assert.equal(await call(substitute, "is_club_staff"), false);
      assert.equal(await call(substitute, "club_role"), "cashier");
      assert.equal(await call(owner, "is_club_staff"), true);
      await assert.rejects(() => read(substitute), /Authorized staff/);
      await assert.rejects(() => call(substitute, "pos_open_shift", [0]), /Another cashier/);
      await assert.rejects(() => call(substitute, "pos_calendar_reservations", [date]), /Authorized staff/);
      await assert.rejects(() => call(substitute, "pos_reservations", [tomorrow]), /Authorized staff/);
      await assert.rejects(() => call(substitute, "paddle_stack_sessions"), /Authorized staff/);
      assert.deepEqual((await as(substitute, () => db.query("select id from public.pos_shifts"))).rows, []);
      assert.deepEqual((await as(substitute, () => db.query("select id from public.pos_expenses"))).rows, []);
      type Closeout = { id: string; expected_cents: number };
      const drawer = (actor: string) => as(actor, () => db.query<Closeout>("select id, expected_cents from public.pos_own_open_shift()"));
      assert.deepEqual((await drawer(substitute)).rows, [{ id: shift, expected_cents: 8800 }]);
      assert.deepEqual((await drawer(cashier)).rows, []);
      await assert.rejects(() => call(cashier, "pos_close_shift", [shift, 8800]), /Only your active shift/);
      await call(substitute, "pos_close_shift", [shift, 8700]);
      assert.deepEqual((await drawer(substitute)).rows, []);
      const replacement = await call<string>(cashier, "pos_open_shift", [0]);
      await call(cashier, "pos_close_shift", [replacement, 0]);
      assert.deepEqual((await read(cashier)).assignment, { id: cashier, label: "cashier", name: null, eligible: true });
      assert.deepEqual((await read(cashier)).cashiers, []);
      assert.equal((await read(owner, tomorrow)).assignment, null);
      await assign(owner, substitute, null, tomorrow);
      assert.deepEqual((await read(cashier, tomorrow)).assignment,
        { id: substitute, label: "relief", name: "Pat Reyes", eligible: true });
      assert.equal((await read(owner)).assignment?.id, cashier);
      await assert.rejects(() => assign(owner, substitute), /assignment changed/);

      assert.ok((await read(owner)).operators.includes("relief@test.example"));
      assert.deepEqual((await read(owner, tomorrow)).operators, []);
      await assign(owner, substitute, cashier);
      assert.equal(await call(cashier, "is_club_staff"), false);
      assert.equal(await call(substitute, "is_club_staff"), true);
      assert.equal((await read(owner)).active, null);
      assert.ok((await read(owner)).operators.includes("relief@test.example"));
      await call(owner, "admin_set_account_role", [substitute, "cashier", "player"]);
      assert.equal((await read(owner)).assignment?.eligible, false);
      await assign(owner, null, substitute);
      assert.equal((await read(owner)).assignment, null);
      assert.equal(await call(cashier, "is_club_staff"), true);
      assert.equal((await db.query("select id from public.pos_audit where action='shift.assignment' and detail->>'date'=$1", [date])).rows.length, 3);
    });

    await t.test("overview trends use Philippine payment and play dates with a separate upcoming balances series", async () => {
      const sale = randomUUID();
      await db.query("insert into public.pos_sales(id, kind, customer_name, total_cents, created_at) values($1,'retail','Trend fixture',4500,'2035-05-20 15:59:59+00')", [sale]);
      await db.query(`insert into public.pos_payments(sale_id,amount_cents,method,reference,created_at) values
        ($1,4500,'gcash','TREND-123456','2035-05-20 15:59:59+00'),
        ($1,1200,'gcash','TREND-234567','2035-05-20 16:00:00+00')`, [sale]);
      await db.query(`insert into public.pos_refunds(sale_id,amount_cents,method,reason,restock,shift_id,actor_id,created_at)
        select $1,2000,'gcash','Trend fixture',false,id,$2,'2035-05-21 16:00:00+00' from public.pos_shifts limit 1`, [sale, owner]);
      await db.query(`insert into public.bookings (court_id,booking_date,start_hour,duration,total_amount,status,customer_name,customer_phone,payment_option) values
        (1,'2035-05-22',18,1,200,'confirmed','Trend fixture','09171234567','reservation_fee'),
        (1,'2035-06-21',18,1,200,'confirmed','Trend fixture','09171234567','reservation_fee'),
        (1,'2035-06-22',18,1,200,'confirmed','Trend fixture','09171234567','reservation_fee')`);
      type Trends = { net: number[]; retail: number[]; reservations: number[]; balances: number[] };
      const get = (actor: string) => call<Trends>(actor, "pos_overview_trends", ["2035-05-22"]);
      const trends = await get(cashier);
      assert.deepEqual(trends.net, [0, 0, 0, 0, 4500, 1200, -2000]);
      assert.deepEqual(trends.retail, [0, 0, 0, 0, 4500, 0, 0]);
      assert.deepEqual(trends.reservations, [0, 0, 0, 0, 0, 0, 1]);
      assert.equal(trends.balances.length, 31);
      assert.equal(trends.balances[0], 10000);
      assert.equal(trends.balances[30], 10000);
      assert.equal(trends.balances.reduce((a, b) => a + b, 0), 20000);
      await assert.rejects(() => get(player), /Authorized staff/);
    });

    await t.test("online membership quotes, GCash reviews, and expiry are account-bound", async () => {
      const applicant = randomUUID();
      await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,'member@test.example',$2)",
        [applicant, JSON.stringify({ full_name: "Sample Member" })]);
      const ref = "MEMBER-123456";
      const read = async (actor: string, id: string) => (await as(actor, () => db.query<MembershipApplication>(
        "select id, plan_id, plan_name, price_cents, status, gcash_name, gcash_number, payment_reference, starts_on::text, expires_on::text, review_note from public.membership_applications where id=$1",
        [id],
      ))).rows[0];
      const start = (actor: string, plan: string, revision: number) => call<string>(actor, "start_membership_application", [plan, revision]);
      const submit = (actor: string, id: string, reference: string) => call(actor, "submit_membership_payment", [id, reference]);
      const review = (actor: string, id: string, approve: boolean, reason = "") => call(actor, "review_membership_payment", [id, approve, reason]);
      const list = (actor: string, reviewed = false) => call<{ row_count: number; rows: MembershipReviewRow[] }>(actor, "list_membership_applications", [reviewed, 1]);
      const testBookingReference = (reference: string) => db.query(`insert into public.bookings
        (court_id, booking_date, start_hour, duration, total_amount, status, customer_name, customer_phone, payment_reference)
        values(1,current_date-30,6,1,100,'cancelled','Reference fixture','09171234567',$1)`, [reference]);
      const originalPlan = (await db.query<{ revision: number }>("select revision from public.membership_settings where not id")).rows[0];
      const annualPlan = (await db.query<{ revision: number }>("select revision from public.membership_settings where id")).rows[0];

      await assert.rejects(() => as("", () => db.query("select public.start_membership_application('six-month',0)"), "anon"), /permission denied/);
      await db.exec("update public.venue_settings set gcash_name='', gcash_number='', gcash_qr_url=''");
      await assert.rejects(() => start(applicant, "six-month", originalPlan.revision), /payment details are unavailable/);
      await db.exec("update public.venue_settings set gcash_name='Sample Venue', gcash_number='09171234567'");
      const saved = await readCurrentData();
      await assert.rejects(() => start(applicant, "six-month", originalPlan.revision - 1), /plan has changed/);
      const id = await start(applicant, "six-month", originalPlan.revision);
      assert.equal(await start(applicant, "annual", annualPlan.revision), id);
      assert.equal((await read(applicant, id)).price_cents, sampleSixMonthMembership.price_cents);
      assert.equal(await read(player, id), undefined);
      await assert.rejects(() => as(applicant, () => db.query("update public.membership_applications set status='approved'")), /permission denied/);
      await assert.rejects(() => submit(player, id, ref), /could not be found/);
      await assert.rejects(() => submit(applicant, id, "------"), /valid GCash reference/);
      assert.equal((await list(owner)).row_count, 0);
      assert.equal(await call(owner, "save_membership_plan", ["six-month", JSON.stringify({ ...sampleSixMonthMembership, price_cents: 32500 }), originalPlan.revision]), originalPlan.revision + 1);
      assert.equal((await read(applicant, id)).price_cents, sampleSixMonthMembership.price_cents);
      await submit(applicant, id, ref);
      await submit(applicant, id, "member123456");
      assert.equal(membershipStatus(await read(applicant, id)), "Pending verification");
      await assert.rejects(() => call(applicant, "cancel_membership_application", [id]), /already has a payment under review/);
      await assert.rejects(() => review(applicant, id, true), /Authorized staff/);
      await assert.rejects(() => list(applicant), /Authorized staff/);
      assert.equal((await list(cashier)).rows[0].full_name, "Sample Member");
      await call(owner, "pos_assign_cashier", [dayKey(), null, cashier]);
      const nextCashier = randomUUID();
      await db.query("insert into auth.users(id,email) values($1,'membership-relief@test.example')", [nextCashier]);
      await db.query("insert into public.staff_members(user_id,role) values($1,'cashier')", [nextCashier]);
      assert.equal((await list(cashier)).row_count, 1);
      await assert.rejects(() => list(nextCashier), /Authorized staff/);
      await assert.rejects(() => review(nextCashier, id, true), /Authorized staff/);
      await call(owner, "pos_assign_cashier", [dayKey(), cashier, null]);

      await review(cashier, id, true);
      const approved = await read(applicant, id);
      const dates = (await db.query<{ starts: string; expires: string }>(`
        select (now() at time zone 'Asia/Manila')::date::text starts,
          ((now() at time zone 'Asia/Manila')::date + interval '6 months')::date::text expires`,
      )).rows[0];
      assert.equal(approved.starts_on, dates.starts);
      assert.equal(approved.expires_on, dates.expires);
      assert.equal(membershipStatus(approved, dates.starts), "Active");
      assert.equal(membershipStatus(approved, dates.expires), "Expired");
      await review(cashier, id, true);
      assert.deepEqual(await read(applicant, id), approved);
      await assert.rejects(() => review(owner, id, false, "Wrong amount"), /no longer pending/);
      await assert.rejects(() => start(applicant, "annual", annualPlan.revision), /already have an active membership/);
      await assert.rejects(() => testBookingReference("member123456"), /already recorded or submitted/);
      assert.deepEqual(await readCurrentData(), saved);

      const unpaid = await start(player, "annual", annualPlan.revision);
      await call(player, "cancel_membership_application", [unpaid]);
      assert.equal(await read(player, unpaid), undefined);
      const pending = await start(player, "annual", annualPlan.revision);
      await submit(player, pending, "APP-BOOK-654321");
      await testBookingReference("appbook654321");
      await assert.rejects(() => review(owner, pending, true), /already recorded or submitted/);
      await review(owner, pending, false, "Reference belongs to a reservation.");
      assert.equal((await read(player, pending)).review_note, "Reference belongs to a reservation.");
      assert.equal((await list(owner, true)).row_count, 2);
      assert.equal((await list(owner)).row_count, 0);

      const annual = await start(player, "annual", annualPlan.revision);
      await submit(player, annual, "ANNUAL-123456");
      await review(owner, annual, true);
      const expiry = (await db.query<{ expires: string }>("select ((now() at time zone 'Asia/Manila')::date + interval '12 months')::date::text expires")).rows[0].expires;
      assert.equal((await read(player, annual)).expires_on, expiry);
    });

    await t.test("membership rate limits count failed attempts and protect every customer mutation", async () => {
      const membershipRows = () => db.query("select * from public.membership_applications order by id").then(({ rows }) => rows);
      const bookingCounters = () => db.query("select * from private.booking_request_limits order by user_id, action").then(({ rows }) => rows);
      const existingMemberships = await membershipRows();
      const existingBookingData = await readCurrentData();
      const existingBookingCounters = await bookingCounters();
      const migration = await readFile("supabase/migrations/202611150034_membership_rate_limits.sql", "utf8");
      await db.exec(migration);
      assert.deepEqual(await membershipRows(), existingMemberships);
      assert.deepEqual(await readCurrentData(), existingBookingData);

      const member = randomUUID(), other = randomUUID();
      await db.query("insert into auth.users(id,email) values($1,'limited@example.test'),($2,'other-member@example.test')", [member, other]);
      const request = (actor: string, action: string, input: unknown) =>
        call<{ success?: true; code?: string; error?: string; retry_after_seconds?: number }>(actor, "request_customer_membership", [action, JSON.stringify(input)]);
      const current = async (actor: string) => (await as(actor, () => db.query<{ id: string; status: string }>(
        "select id, status from public.membership_applications where status in ('awaiting_payment','pending')",
      ))).rows[0];
      const plan = (await db.query<{ revision: number }>("select revision from public.membership_settings where id")).rows[0];
      const start = { plan: "annual", revision: plan.revision };

      for (const signature of ["start_membership_application(text,integer)", "submit_membership_payment(uuid,text)", "cancel_membership_application(uuid)"]) {
        const grants = await db.query<{ anon: boolean; customer: boolean }>(`
          select has_function_privilege('anon',$1,'execute') anon,
            has_function_privilege('authenticated',$1,'execute') customer`, [`public.${signature}`]);
        assert.deepEqual(grants.rows[0], { anon: false, customer: false });
      }
      await assert.rejects(() => as("", () => db.query("select public.request_customer_membership('start',null)"), "anon"), /permission denied/);
      await assert.rejects(() => as(member, () => db.query("select * from private.membership_request_limits")), /permission denied/);

      assert.equal((await request(member, "start", { ...start, revision: plan.revision - 1 })).code, "REQUEST_REJECTED");
      for (let i = 0; i < 3; i++) {
        assert.deepEqual(await request(member, "start", start), { success: true });
        assert.deepEqual(await request(member, "cancel", { id: (await current(member)).id }), { success: true });
      }
      assert.deepEqual(await request(member, "start", start), { success: true });
      const blocked = await request(member, "start", start);
      assert.equal(blocked.code, "RATE_LIMITED");
      assert.ok(blocked.retry_after_seconds && blocked.retry_after_seconds <= 600);
      assert.match(blocked.error ?? "", /Please try again in \d+ minutes?\./);
      const { id } = await current(member);
      assert.deepEqual(await request(member, "submit", { id, reference: "LIMITED-123456" }), { success: true });
      assert.equal((await request(member, "cancel", { id })).code, "REQUEST_REJECTED");
      assert.equal((await request(member, "cancel", null)).code, "INVALID_INPUT");
      assert.equal((await request(member, "cancel", { id })).code, "RATE_LIMITED");
      assert.equal((await current(member)).status, "pending");
      await call(owner, "review_membership_payment", [id, true, ""]);

      assert.deepEqual(await request(other, "start", start), { success: true });
      const second = await current(other);
      assert.equal((await request(other, "submit", { id, reference: "OTHER-123456" })).error, "Application could not be found.");
      assert.equal((await request(other, "submit", { id: "bad-id" })).code, "INVALID_INPUT");
      for (let i = 0; i < 3; i++)
        assert.equal((await request(other, "submit", { id: second.id, reference: "-----" })).code, "REQUEST_REJECTED");
      const submit = { id: second.id, reference: "OTHER-123456" };
      assert.equal((await request(other, "submit", submit)).code, "RATE_LIMITED");
      assert.equal((await current(other)).status, "awaiting_payment");
      await db.query("update private.membership_request_limits set attempts[1] = clock_timestamp() - interval '11 minutes' where user_id=$1 and action='submit'", [other]);
      assert.deepEqual(await request(other, "submit", submit), { success: true });
      assert.equal((await current(other)).status, "pending");
      assert.equal((await request(other, "submit", submit)).code, "RATE_LIMITED");
      assert.deepEqual((await db.query("select cardinality(attempts) count from private.membership_request_limits where user_id=$1 and action='submit'", [other])).rows, [{ count: 5 }]);
      assert.deepEqual(await bookingCounters(), existingBookingCounters);
      assert.deepEqual(await readCurrentData(), existingBookingData);
    });

    await t.test("member pricing hooks preserve existing bookings and leave prices unchanged before discounts are configured", async () => {
      const before = await readCurrentData();
      await db.exec(await readFile("supabase/migrations/202611150035_private_booking_member_discounts.sql", "utf8"));
      assert.deepEqual(await readCurrentData(), {
        ...before,
        bookings: before.bookings.map((row) => ({ ...(row as object), membership_discount_amount: "0.00" })),
      });

      const date = dayKey(new Date(Date.now() + 25 * 86400000));
      const next = dayKey(new Date(Date.now() + 26 * 86400000));
      const days = [1, 2, 3, 4, 5, 6, 7];
      const blocksForTest = [
        { id: "member-day", days, start: 6, end: 16, kind: "court", rate: 100, capacity: 8 },
        { id: "member-evening", days, start: 16, end: 21, kind: "court", rate: 200, capacity: 8 },
        { id: "member-late", days, start: 21, end: 22, kind: "court", rate: 150, capacity: 8 },
        { id: "member-open", days, start: 22, end: 24, kind: "open_play", rate: 100, capacity: 24 },
      ];
      await db.query(`update public.venue_settings set booking_enabled=true, gcash_qr_url='https://example.com/qr.png',
        evening_start_hour=16, schedule_config=jsonb_set(schedule_config,'{overrides}',
          (schedule_config->'overrides') || $1::jsonb)`,
        [JSON.stringify([{ id: "member-test", name: "Member test hours", start_date: date, end_date: next, blocks: blocksForTest }])]);

      const six = randomUUID(), annual = randomUUID(), guest = randomUUID();
      await db.query("insert into auth.users(id,email) values($1,'six@test.example'),($2,'annual@test.example'),($3,'guest@test.example')", [six, annual, guest]);
      const membership = (actor: string, action: string, input: unknown) => call<{ success?: true }>(actor,
        "request_customer_membership", [action, JSON.stringify(input)]);
      async function apply(actor: string, plan: "annual" | "six-month", reference: string) {
        const { revision } = (await db.query<{ revision: number }>("select revision from public.membership_settings where id=$1", [plan === "annual"])).rows[0];
        assert.deepEqual(await membership(actor, "start", { plan, revision }), { success: true });
        const { id } = (await db.query<{ id: string }>("select id from public.membership_applications where user_id=$1", [actor])).rows[0];
        assert.deepEqual(await membership(actor, "submit", { id, reference }), { success: true });
        return id;
      }
      const quote = async (actor: string, start: number, duration: number, playDate = date) =>
        Number(await call(actor, "get_private_booking_member_discount", [playDate, start, duration]));
      const reserve = (actor: string, payload: Record<string, unknown>, action = "reserve_court") => call<{ id: string; error?: string }>(
        actor, "request_customer_booking_v2", [action, JSON.stringify({
          booking_date: date, customer_name: "Test Player", customer_phone: "09171234567", ...payload,
        })],
      );
      const getPrice = async (id: string) => (await db.query(
        "select membership_discount_amount, total_amount, initial_payment_amount, equipment_amount, paid_amount from public.bookings where id=$1", [id],
      )).rows[0];

      const sixId = await apply(six, "six-month", "DISCOUNT-SIX-123456");
      assert.equal(await quote(six, 16, 2), 0);
      await call(owner, "review_membership_payment", [sixId, true, ""]);
      assert.equal(await quote(six, 15, 3), 0);
      assert.equal(await quote(six, 6, 1), 0);
      assert.equal(await quote(six, 21, 1), 0);
      assert.equal(await quote(six, 22, 1), 0);
      assert.equal(await quote(guest, 16, 2), 0);
      await assert.rejects(() => as("", () => db.query("select public.get_private_booking_member_discount($1,16,2)", [date]), "anon"), /permission denied/);

      const rental = { court_id: 1, start_hour: 15, duration: 3, equipment_quantity: 2, payment_option: "reservation_fee" };
      assert.match((await reserve(six, { ...rental, expected_total_cents: 50000 })).error ?? "", /Your booking price changed/);
      assert.deepEqual((await db.query("select id from public.bookings where user_id=$1", [six])).rows, []);
      const reserved = await reserve(six, { ...rental, expected_total_cents: 56000 });
      assert.ok(reserved.id, reserved.error);
      assert.deepEqual(await getPrice(reserved.id), {
        membership_discount_amount: "0.00", total_amount: "560.00", initial_payment_amount: "280.00", equipment_amount: "60.00", paid_amount: "0.00",
      });
      await call(six, "request_customer_booking_v2", ["payment", JSON.stringify({ booking_id: reserved.id, reference: "MEMBER-BOOKING-REF-123456" })]);
      await call(owner, "pos_verify_booking", [reserved.id]);
      assert.deepEqual(await getPrice(reserved.id), {
        membership_discount_amount: "0.00", total_amount: "560.00", initial_payment_amount: "280.00", equipment_amount: "60.00", paid_amount: "280.00",
      });
      const open = await reserve(six, { start_hour: 22, participant_count: 2 }, "reserve_open_play");
      assert.ok(open.id, open.error);
      assert.deepEqual(await getPrice(open.id), {
        membership_discount_amount: "0.00", total_amount: "200.00", initial_payment_amount: "200.00", equipment_amount: "0.00", paid_amount: "0.00",
      });

      await db.query("update public.membership_applications set expires_on=$1 where id=$2", [next, sixId]);
      assert.equal(await quote(six, 16, 2, next), 0);
      const expired = await reserve(six, { booking_date: next, court_id: 1, start_hour: 16, duration: 1, expected_total_cents: 20000 });
      assert.ok(expired.id, expired.error);
      assert.deepEqual(await getPrice(expired.id), {
        membership_discount_amount: "0.00", total_amount: "200.00", initial_payment_amount: "200.00", equipment_amount: "0.00", paid_amount: "0.00",
      });

      const annualId = await apply(annual, "annual", "DISCOUNT-ANNUAL-123456");
      await call(owner, "review_membership_payment", [annualId, true, ""]);
      assert.equal(await quote(annual, 16, 1), 0);
      assert.equal(await quote(annual, 16, 3), 0);
      const annualCourt = await reserve(annual, { court_id: 2, start_hour: 16, duration: 3, expected_total_cents: 60000 });
      assert.ok(annualCourt.id, annualCourt.error);
      assert.deepEqual(await getPrice(annualCourt.id), {
        membership_discount_amount: "0.00", total_amount: "600.00", initial_payment_amount: "600.00", equipment_amount: "0.00", paid_amount: "0.00",
      });
      const regular = await reserve(guest, { court_id: 1, start_hour: 19, duration: 1, membership_discount_amount: 200 });
      assert.ok(regular.id, regular.error);
      assert.deepEqual(await getPrice(regular.id), {
        membership_discount_amount: "0.00", total_amount: "200.00", initial_payment_amount: "200.00", equipment_amount: "0.00", paid_amount: "0.00",
      });
    });

    await t.test("walk-in membership sales activate the existing account and reconcile cash, GCash, and refunds", async () => {
      const previous = await readCurrentData();
      const readMemberships = async () => (await db.query("select to_jsonb(a) - 'payment_method' - 'pos_sale_id' from public.membership_applications a order by id")).rows;
      const existing = await readMemberships();
      await db.exec(await readFile("supabase/migrations/202611150036_walk_in_membership_sales.sql", "utf8"));
      assert.deepEqual(await readCurrentData(), previous);
      assert.deepEqual(await readMemberships(), existing);

      const buyer = randomUUID(), onlinePending = randomUUID(), second = randomUUID(), unconfirmed = randomUUID();
      await db.query(`insert into auth.users (id,email,email_confirmed_at,raw_user_meta_data) values
        ($1,'walk-in-buyer@example.test',now(),'{"full_name":"Maya Tan"}'), ($2,'walk-in-pending@example.test',now(),null),
        ($3,'walk-in-second@example.test',now(),null), ($4,'walk-in-unconfirmed@example.test',null,null)`,
        [buyer, onlinePending, second, unconfirmed]);
      const manager = (await db.query<{ id: string }>("select id from auth.users where email='membership-manager@example.test'")).rows[0].id;
      const plans = (await db.query<{ id: boolean; revision: number; price: number }>(`select id,revision,
        (details->>'price_cents')::integer price from public.membership_settings order by id desc`)).rows;
      const [annual, sixMonth] = plans;
      const request = (actor: string, action: string, input: unknown) => call(actor, "request_customer_membership", [action, JSON.stringify(input)]);
      await request(buyer, "start", { plan: "six-month", revision: sixMonth.revision });
      await request(onlinePending, "start", { plan: "annual", revision: annual.revision });
      const applicationId = async (actor: string) => (await db.query<{ id: string }>("select id from public.membership_applications where user_id=$1", [actor])).rows[0].id;
      const draft = await applicationId(buyer);
      await request(onlinePending, "submit", { id: await applicationId(onlinePending), reference: "WALK-IN-PENDING-123456" });

      const find = (actor: string, query: string) => as(actor, () => db.query("select * from public.pos_find_membership_customers($1)", [query])).then((r) => r.rows);
      type Receipt = { receipt_number: string; price_cents: number; starts_on: string; expires_on: string; status: string };
      const sell = (actor: string, args: unknown[], role = "authenticated") => as(actor, () => db.query<Receipt>(
        `select receipt_number,price_cents,starts_on::text,expires_on::text,status from public.pos_sell_membership($1,$2,$3,$4,$5,$6,$7,$8)`, args), role
      ).then((r) => r.rows[0]);
      const cashKey = randomUUID();
      const cash = [cashKey, buyer, "six-month", sixMonth.revision, "cash", sixMonth.price + 5000, null, false];
      const gcashKey = randomUUID();
      const gcash = [gcashKey, second, "annual", annual.revision, "gcash", annual.price, "WALK-IN-GCASH-123456", true];
      const savedPlan = (await db.query<{ details: unknown }>("select details from public.membership_settings where id")).rows[0];
      await db.query("update public.membership_settings set details=null where id");
      try {
        await assert.rejects(() => sell(owner, gcash), /plan is not available for sale/);
      } finally {
        await db.query("update public.membership_settings set details=$1 where id", [JSON.stringify(savedPlan.details)]);
      }
      const paymentDate = dayKey();
      const playDate = dayKey(new Date(Date.now() + 25 * 86400000));
      const quote = (actor: string) => call(actor, "get_private_booking_member_discount", [playDate, 16, 2]).then(Number);

      assert.deepEqual(await find(owner, "maya TAN"), [{ id: buyer, full_name: "Maya Tan", email: "w•••@e•••", availability: "available" }]);
      assert.deepEqual(await find(owner, "walk-in-buyer@example.test"), [{ id: buyer, full_name: "Maya Tan", email: "walk-in-buyer@example.test", availability: "available" }]);
      assert.deepEqual(await find(owner, "walk-in-buyer@"), []);
      assert.deepEqual(await find(owner, "walk-in-unconfirmed@example.test"), []);
      assert.deepEqual(await find(manager, "walk-in-pending@example.test"), [{ id: onlinePending, full_name: null, email: "walk-in-pending@example.test", availability: "pending" }]);
      await assert.rejects(() => find(player, "walk-in"), /Authorized staff/);
      await assert.rejects(() => sell("", cash, "anon"), /permission denied/);
      await assert.rejects(() => sell(player, cash), /Authorized staff/);
      await call(owner, "pos_assign_cashier", [paymentDate, null, cashier]);
      const offDuty = (await db.query<{ id: string }>(`select id from auth.users where email='membership-relief@test.example'`)).rows[0].id;
      await assert.rejects(() => find(offDuty, "walk-in"), /Authorized staff/);
      await assert.rejects(() => sell(offDuty, cash), /Authorized staff/);
      await assert.rejects(() => sell(owner, [gcashKey, unconfirmed, ...gcash.slice(2)]), /confirmed email/);
      await assert.rejects(() => sell(owner, [gcashKey, onlinePending, ...gcash.slice(2)]), /online GCash payment/);
      await assert.rejects(() => sell(manager, [...gcash.slice(0, 3), annual.revision + 1, ...gcash.slice(4)]), /plan changed/);
      await assert.rejects(() => sell(manager, [...gcash.slice(0, 7), false]), /Verify the GCash payment/);
      await assert.rejects(() => sell(manager, [...gcash.slice(0, 6), "discountannual123456", true]), /reference is already/);
      await assert.rejects(() => sell(cashier, cash), /Open your/);
      assert.deepEqual((await db.query("select id from public.pos_sales where id in ($1,$2)", [cashKey, gcashKey])).rows, []);
      assert.equal(await quote(buyer), 0);

      const shift = await call<string>(cashier, "pos_open_shift", [10000]);
      await assert.rejects(() => sell(cashier, [...cash.slice(0, 5), sixMonth.price - 1, null, false]), /cover the full/);
      const receipt = await sell(cashier, cash);
      assert.equal(receipt.price_cents, sixMonth.price);
      assert.equal(receipt.starts_on, paymentDate);
      assert.equal(receipt.expires_on, (await db.query<{ date: string }>("select ($1::date + interval '6 months')::date::text date", [paymentDate])).rows[0].date);
      assert.match(receipt.receipt_number, /^RC-/);
      assert.deepEqual(await sell(cashier, cash), receipt);
      await assert.rejects(() => sell(owner, cash), /key was already used/);
      await assert.rejects(() => sell(cashier, [randomUUID(), ...cash.slice(1)]), /already has an active membership/);
      assert.equal(await applicationId(buyer), draft);
      assert.equal(await quote(buyer), 0);
      assert.deepEqual((await find(cashier, "maya tan")).map((row) => (row as { availability: string }).availability), ["active"]);
      assert.deepEqual((await db.query(`select p.shift_id,p.method,p.amount_cents,p.actor_id,s.paid_cents,s.kind,
        s.customer_name,i.product_id,i.quantity,a.payment_reference,a.payment_method,a.reviewed_by
        from public.pos_payments p join public.pos_sales s on s.id=p.sale_id join public.pos_sale_items i on i.sale_id=s.id
        join public.membership_applications a on a.pos_sale_id=s.id where s.id=$1`, [cashKey])).rows, [{
        shift_id: shift, method: "cash", amount_cents: sixMonth.price, actor_id: cashier, paid_cents: sixMonth.price,
        kind: "membership", customer_name: "Maya Tan", product_id: null, quantity: 1, payment_reference: null, payment_method: "cash", reviewed_by: cashier,
      }]);
      assert.equal(Number(await db.query<{ value: number }>("select private.pos_expected_cash($1,10000) value", [shift]).then((r) => r.rows[0].value)), 10000 + sixMonth.price);

      const digital = await sell(manager, gcash);
      assert.equal(digital.price_cents, annual.price);
      assert.equal(digital.expires_on, (await db.query<{ date: string }>("select ($1::date + interval '12 months')::date::text date", [paymentDate])).rows[0].date);
      assert.equal(await quote(second), 0);
      assert.deepEqual((await db.query("select method, reference, shift_id, actor_id from public.pos_payments where sale_id=$1", [gcashKey])).rows,
        [{ method: "gcash", reference: "WALK-IN-GCASH-123456", shift_id: null, actor_id: manager }]);
      await call(cashier, "pos_close_shift", [shift, 10000 + sixMonth.price]);
      const ownerShift = await call<string>(owner, "pos_open_shift", [sixMonth.price]);
      await call(owner, "pos_refund", [cashKey, "cash", "Customer returned at the counter", false]);
      assert.equal((await sell(cashier, cash)).status, "refunded");
      assert.equal(await quote(buyer), 0);
      const reviewed = await call<{ rows: MembershipReviewRow[] }>(owner, "list_membership_applications", [true, 1]);
      assert.ok(reviewed.rows.some((row) => row.receipt_number === receipt.receipt_number && row.payment_method === "cash" && membershipStatus(row) === "Refunded"));
      const frontDeskHistory = await call<{ rows: MembershipReviewRow[] }>(cashier, "list_membership_applications", [true, 1]);
      assert.equal(frontDeskHistory.rows.find((row) => row.receipt_number === receipt.receipt_number)?.email, "w•••@e•••");
      await assert.rejects(() => sell(owner, [randomUUID(), buyer, ...gcash.slice(2, 6), "walkingcash123456", true]), /reference is already/);
      const reactivated = await sell(owner, [randomUUID(), buyer, ...gcash.slice(2, 6), "WALK-IN-RENEW-123456", true]);
      assert.equal(reactivated.status, "approved");
      assert.equal(await quote(buyer), 0);
      await call(owner, "pos_close_shift", [ownerShift, 0]);
    });

    await t.test("the active members list is staff-only, paginated, and uses Philippine membership dates", async () => {
      await db.exec(await readFile("supabase/migrations/202611160037_active_memberships.sql", "utf8"));
      const list = (actor: string, page = 1) => call<{ row_count: number; rows: ActiveMembershipRow[] }>(actor, "list_active_memberships", [page]);
      const before = await list(owner);
      const walkIn = before.rows.find((row) => row.email === "walk-in-buyer@example.test");
      assert.ok(walkIn);
      assert.ok(before.rows.some((row) => row.email === "annual@test.example"));
      assert.equal((await list(cashier)).rows.find((row) => row.id === walkIn.id)?.email, "w•••@e•••");
      assert.ok(!before.rows.some((row) => row.email === "walk-in-pending@example.test"));

      const offDuty = (await db.query<{ id: string }>(`select id from auth.users where email='membership-relief@test.example'`)).rows[0].id;
      await assert.rejects(() => list(offDuty), /Authorized staff/);
      await assert.rejects(() => list(player), /Authorized staff/);
      await assert.rejects(() => as("", () => db.query("select public.list_active_memberships(1)"), "anon"), /permission denied/);
      await assert.rejects(() => list(owner, 0), /valid page/);

      await db.exec(`with seed as (
        select i, gen_random_uuid() as user_id, (now() at time zone 'Asia/Manila')::date as today
        from generate_series(0, 13) i
      ), accounts as (
        insert into auth.users(id,email)
        select user_id, 'active-test-' || i || '@example.test' from seed returning id
      )
      insert into public.membership_applications (user_id,plan_id,plan_name,price_cents,status,
        gcash_name,gcash_number,gcash_qr_url,payment_reference,submitted_at,reviewed_at,starts_on,expires_on)
      select case when i = 13 then null else user_id end,'annual','Annual Membership',50000,'approved',
        'Sample Venue','','','ACTIVE-LIST-TEST-' || i, now(), now(),
        today + case when i = 0 then -1 when i = 12 then 1 else 0 end, today + i
      from seed join accounts on accounts.id = seed.user_id;

      insert into public.membership_applications (user_id,plan_id,plan_name,price_cents,status,
        gcash_name,gcash_number,gcash_qr_url,payment_reference,submitted_at,reviewed_at,starts_on,expires_on)
      select user_id,plan_id,'Previous Plan',price_cents,status,
        gcash_name,gcash_number,gcash_qr_url,'ACTIVE-LIST-PREVIOUS',submitted_at,reviewed_at,starts_on - 1,expires_on + 1
      from public.membership_applications where payment_reference = 'ACTIVE-LIST-TEST-1';`);
      const first = await list(owner);
      const second = await list(owner, 2);
      const rows = [...first.rows, ...second.rows];
      assert.equal(first.row_count, before.row_count + 11);
      assert.equal(second.row_count, first.row_count);
      assert.equal(first.rows.length, 10);
      assert.equal(rows.length, first.row_count);
      assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
      assert.deepEqual(rows.map((row) => row.expires_on), rows.map((row) => row.expires_on).sort());
      assert.equal(rows.find((row) => row.email === "active-test-1@example.test")?.plan_name, "Annual Membership");
      assert.equal(rows.filter((row) => row.email?.startsWith("active-test-")).length, 11);
      assert.ok(!rows.some((row) => row.email === "active-test-0@example.test" || row.email === "active-test-12@example.test"));
      assert.deepEqual(Object.keys(first.rows[0]).sort(), ["email", "expires_on", "full_name", "id", "plan_name", "starts_on"]);
      assert.deepEqual((await list(owner, 99)).rows, []);

      const saleId = (await db.query<{ id: string }>("select pos_sale_id as id from public.membership_applications where id=$1", [walkIn.id])).rows[0].id;
      const shift = await call<string>(owner, "pos_open_shift", [0]);
      await call(owner, "pos_refund", [saleId, "gcash", "Membership refunded", false]);
      const afterRefund = await list(owner, 2);
      assert.equal(afterRefund.row_count, first.row_count - 1);
      assert.ok(!afterRefund.rows.some((row) => row.id === walkIn.id));
      await call(owner, "pos_close_shift", [shift, 0]);
    });

    await t.test("product photos save with inventory edits and are readable by authorized staff only", async () => {
      const oldProducts = "select to_jsonb(p) - 'photo_version' as product from public.pos_products p order by id";
      const before = (await db.query(oldProducts)).rows;
      await db.exec(await readFile("supabase/migrations/202611160038_inventory_product_photos.sql", "utf8"));
      assert.deepEqual((await db.query(oldProducts)).rows, before);
      assert.equal((await db.query("select id from public.pos_products where photo_version is not null")).rows.length, 0);

      // Distinct JPEG-framed payloads exercise storage, validation, and replacement.
      const photo = Buffer.from("ffd8ff0102ffd9", "hex").toString("base64");
      const replacement = Buffer.from("ffd8ff0304ffd9", "hex").toString("base64");
      const details = { name: "Photo test product", sku: "PHOTO-TEST", category: "Gear", price_cents: 5000, cost_cents: 2000,
        reorder_level: 3, active: true, revision: 0 };
      const save = (actor: string, product: unknown, image: string | null) =>
        call<string>(actor, "pos_save_product_with_photo", [JSON.stringify(product), image]);
      const getPhoto = (actor: string, version: string) => call<string | null>(actor, "pos_product_photo", [version]);
      await assert.rejects(() => save(cashier, details, photo), /Manager authorization/);
      await assert.rejects(() => save(owner, details, "data:image/svg+xml,example"), /valid product photo/);
      await assert.rejects(() => save(owner, details, Buffer.from("not a jpeg").toString("base64")), /valid product photo/);
      await assert.rejects(() => save(owner, details, Buffer.alloc(524289).toString("base64")), /valid product photo/);
      assert.equal((await db.query("select id from public.pos_products where sku='PHOTO-TEST'")).rows.length, 0);

      const id = await save(owner, details, photo);
      const read = async () => (await db.query<{ photo_version: string | null; name: string; stock: number; revision: number }>(
        "select photo_version,name,stock,revision from public.pos_products where id=$1", [id])).rows[0];
      const first = await read();
      assert.ok(first.photo_version);
      assert.equal((await getPhoto(cashier, first.photo_version))?.replace(/\s/g, ""), photo);
      await assert.rejects(() => getPhoto(player, first.photo_version!), /Authorized staff/);
      await assert.rejects(() => as("", () => db.query("select public.pos_product_photo($1)", [first.photo_version]), "anon"), /permission denied/);
      await assert.rejects(() => as(cashier, () => db.query("select content from private.pos_product_photos")), /permission denied/);
      assert.equal((await db.query("select id from public.pos_audit where entity_id=$1 and detail ? 'photo'", [id])).rows.length, 0);

      await call(owner, "pos_adjust_stock", [id, 4, "Initial stock"]);
      await call(owner, "pos_save_product", [JSON.stringify({ ...details, id, name: "Updated product" })]);
      assert.deepEqual(await read(), { ...first, name: "Updated product", revision: 1, stock: 4 });
      await assert.rejects(() => save(owner, { ...details, id }, replacement), /product changed/);
      assert.equal((await getPhoto(owner, first.photo_version))?.replace(/\s/g, ""), photo);

      const manager = (await db.query<{ id: string }>("select id from auth.users where email='membership-manager@example.test'")).rows[0].id;
      const edited = { ...details, id, name: "Updated product", revision: 1 };
      assert.equal(await save(manager, edited, replacement), id);
      const updated = await read();
      assert.ok(updated.photo_version && updated.photo_version !== first.photo_version);
      assert.equal(await getPhoto(owner, first.photo_version), null);
      assert.equal((await getPhoto(cashier, updated.photo_version))?.replace(/\s/g, ""), replacement);

      assert.equal(await save(manager, { ...edited, revision: 2 }, null), id);
      assert.deepEqual(await read(), { photo_version: null, name: "Updated product", stock: 4, revision: 3 });
      assert.equal(await getPhoto(cashier, updated.photo_version), null);
      assert.equal((await db.query("select id from public.pos_products where id=$1", [id])).rows.length, 1);
    });

    await t.test("configurable court discounts share one quote and booking rule", async () => {
      const previous = await readCurrentData();
      const plansSql = "select id,details,revision from public.membership_settings order by id";
      const previousPlans = (await db.query(plansSql)).rows;
      await db.exec(await readFile("supabase/migrations/202611160039_configurable_membership_discounts.sql", "utf8"));
      assert.deepEqual(await readCurrentData(), previous);
      assert.deepEqual((await db.query(plansSql)).rows, previousPlans);

      const userId = async (email: string) => (await db.query<{ id: string }>("select id from auth.users where email=$1", [email])).rows[0].id;
      const annual = await userId("annual@test.example"), six = await userId("six@test.example");
      const manager = await userId("membership-manager@example.test");
      const date = dayKey(new Date(Date.now() + 25 * 86400000));
      const quote = (actor: string, hour: number, duration: number) =>
        call(actor, "get_private_booking_member_discount", [date, hour, duration]).then(Number);
      const save = (actor: string, plan: string, enabled: boolean, cents: number, hours: number, revision: number) =>
        call<number>(actor, "save_membership_court_discount", [plan, enabled, cents, hours, revision]);

      assert.equal(await quote(annual, 16, 2), 0);
      assert.equal(await quote(six, 16, 2), 0);
      await assert.rejects(() => save(cashier, "annual", true, 4550, 3, 0), /Manager or owner access/);
      await assert.rejects(() => save(player, "annual", true, 4550, 3, 0), /Manager or owner access/);
      await assert.rejects(() => as("", () => db.query("select public.save_membership_court_discount('annual',true,4550,3,0)"), "anon"), /permission denied/);
      await assert.rejects(() => save(owner, "annual", true, 0, 2, 0), /valid court discount/);
      await assert.rejects(() => save(owner, "annual", true, 4550, 5, 0), /valid court discount/);
      await assert.rejects(() => save(owner, "six-month", true, 12550, 2, 0), /valid court discount/);

      assert.equal(await save(manager, "annual", true, 4550, 3, 0), 1);
      assert.equal(await save(manager, "annual", true, 4550, 3, 0), 1);
      await assert.rejects(() => save(owner, "annual", false, 4550, 3, 0), /Someone updated this discount/);
      assert.equal(await quote(annual, 16, 2), 0);
      assert.equal(await quote(annual, 16, 3), 45.5);
      assert.equal(await save(owner, "six-month", true, 12550, 1, 0), 1);
      assert.equal(await quote(six, 15, 3), 149);
      assert.equal(await quote(six, 21, 1), 24.5);
      assert.equal(await quote(six, 6, 1), 0);
      assert.equal(await quote(six, 22, 1), 0);
      assert.equal(await save(owner, "six-month", false, 12550, 1, 1), 2);
      assert.equal(await quote(six, 16, 2), 0);
      assert.equal(await quote(annual, 16, 3), 45.5);
      assert.equal(await save(owner, "annual", true, 4550, 1, 1), 2);
      assert.deepEqual(await readCurrentData(), previous);
      assert.deepEqual((await db.query(plansSql)).rows, previousPlans);

      const reserve = (expectedTotal: number) => call<{ id?: string; error?: string }>(annual, "request_customer_booking_v2", ["reserve_court", JSON.stringify({
        booking_date: date, customer_name: "Member pricing test", customer_phone: "09171234567",
        court_id: 2, start_hour: 19, duration: 1, equipment_quantity: 1, payment_option: "reservation_fee",
        expected_total_cents: expectedTotal,
      })]);
      assert.match((await reserve(23000)).error ?? "", /Your booking price changed/);
      const fresh = await reserve(18450);
      assert.ok(fresh.id, fresh.error);
      assert.deepEqual((await db.query(`select total_amount,initial_payment_amount,equipment_amount,membership_discount_amount
        from public.bookings where id=$1`, [fresh.id])).rows, [{
        total_amount: "184.50", initial_payment_amount: "92.25", equipment_amount: "30.00", membership_discount_amount: "45.50",
      }]);
    });

    await t.test("both plans use configurable flat discounts at any time of day", async () => {
      const readPlans = async () => (await db.query("select id,details,revision from public.membership_settings order by id")).rows;
      const beforePlans = await readPlans();
      const beforeBookings = await readCurrentData();
      const userId = async (email: string) => (await db.query<{ id: string }>("select id from auth.users where email=$1", [email])).rows[0].id;
      const annual = await userId("annual@test.example"), six = await userId("six@test.example");
      const manager = await userId("membership-manager@example.test");
      const date = dayKey(new Date(Date.now() + 25 * 86400000));
      const quote = (actor: string, hour: number, duration: number) =>
        call(actor, "get_private_booking_member_discount", [date, hour, duration]).then(Number);
      assert.equal(await call(owner, "save_membership_court_discount", ["six-month", true, 12550, 1, 2]), 3);
      assert.equal(await quote(six, 6, 1), 0);
      assert.equal(await quote(six, 16, 1), 74.5);

      await db.exec(await readFile("supabase/migrations/202611160041_flat_membership_booking_discounts.sql", "utf8"));
      assert.deepEqual(await readPlans(), beforePlans);
      assert.deepEqual(await readCurrentData(), beforeBookings);
      assert.deepEqual((await db.query(`select court_discount_enabled,court_booking_discount_cents,court_discount_min_hours,court_discount_revision
        from public.membership_settings where not id`)).rows, [{ court_discount_enabled: true,
        court_booking_discount_cents: 4550, court_discount_min_hours: 1, court_discount_revision: 4 }]);
      assert.equal(await quote(six, 6, 1), 45.5);
      assert.equal(await quote(six, 16, 1), 45.5);
      assert.equal(await quote(six, 15, 3), 45.5);

      const save = (actor: string, enabled: boolean, cents: number, hours: number, revision: number) =>
        call<number>(actor, "save_membership_booking_discount", ["six-month", enabled, cents, hours, revision]);
      await assert.rejects(() => save(cashier, true, 2250, 2, 4), /Manager or owner access/);
      await assert.rejects(() => save(player, true, 2250, 2, 4), /Manager or owner access/);
      await assert.rejects(() => as("", () => db.query("select public.save_membership_booking_discount('six-month',true,2250,2,4)"), "anon"), /permission denied/);
      await assert.rejects(() => save(owner, true, 2250, 5, 4), /valid court discount/);
      await assert.rejects(() => call(owner, "save_membership_court_discount", ["six-month", true, 17000, 1, 4]), /Reload to edit/);
      assert.equal(await call(owner, "save_membership_court_discount", ["annual", true, 4550, 1, 2]), 2);

      assert.equal(await save(manager, true, 2250, 2, 4), 5);
      assert.equal(await save(manager, true, 2250, 2, 4), 5);
      await assert.rejects(() => save(owner, false, 2250, 2, 4), /Someone updated this discount/);
      assert.equal(await quote(six, 6, 1), 0);
      assert.equal(await quote(six, 6, 2), 22.5);
      assert.equal(await quote(six, 16, 2), 22.5);
      assert.equal(await quote(six, 15, 3), 22.5);
      assert.equal(await quote(six, 22, 1), 0);
      assert.equal(await quote(annual, 6, 1), 45.5);
      assert.deepEqual(await readCurrentData(), beforeBookings);

      const newMember = randomUUID();
      await db.query("insert into auth.users(id,email) values($1,'daytime-rate@test.example')", [newMember]);
      const { revision } = (await db.query<{ revision: number }>("select revision from public.membership_settings where not id")).rows[0];
      assert.deepEqual(await call(newMember, "request_customer_membership", ["start", JSON.stringify({ plan: "six-month", revision })]), { success: true });
      const { id } = (await db.query<{ id: string }>("select id from public.membership_applications where user_id=$1", [newMember])).rows[0];
      assert.deepEqual(await call(newMember, "request_customer_membership", ["submit", JSON.stringify({ id, reference: "DAYTIME-TEST-123456" })]), { success: true });
      await call(manager, "review_membership_payment", [id, true, ""]);
      const reserve = (expectedTotal: number) => call<{ id?: string; error?: string }>(newMember, "request_customer_booking_v2", ["reserve_court", JSON.stringify({
        booking_date: date, customer_name: "Flat discount member", customer_phone: "09171234567",
        court_id: 2, start_hour: 6, duration: 2, expected_total_cents: expectedTotal,
      })]);
      assert.match((await reserve(20000)).error ?? "", /Your booking price changed/);
      const booking = await reserve(17750);
      assert.ok(booking.id, booking.error);
      assert.deepEqual((await db.query("select total_amount,membership_discount_amount from public.bookings where id=$1", [booking.id])).rows,
        [{ total_amount: "177.50", membership_discount_amount: "22.50" }]);
      assert.equal(await save(owner, false, 2250, 2, 5), 6);
      assert.equal(await quote(six, 6, 2), 0);
      assert.equal(await quote(six, 16, 2), 0);
      assert.equal(await quote(annual, 6, 2), 45.5);
    });

    await t.test("staff notifications follow verified activity, duty access, and per-account read status", async () => {
      const previous = await readCurrentData();
      await db.exec(await readFile("supabase/migrations/202611170042_staff_notifications.sql", "utf8"));
      assert.deepEqual(await readCurrentData(), previous);
      const read = async (actor: string, page = 1) => staffNotificationFeedSchema.parse(await call(actor, "staff_notification_feed", [page]));
      const mark = (actor: string, id: number | null) => call(actor, "mark_staff_notifications_read", [id]);
      const userId = async (email: string) => (await db.query<{ id: string }>("select id from auth.users where email=$1", [email])).rows[0].id;
      const manager = await userId("membership-manager@example.test");
      const offDuty = await userId("membership-relief@test.example");
      assert.deepEqual(await read(owner), { unread_count: 0, total_count: 0, rows: [] });
      await assert.rejects(() => read(player), /Authorized staff/);
      await assert.rejects(() => read(offDuty), /Authorized staff/);
      await assert.rejects(() => mark(player, null), /Authorized staff/);
      await assert.rejects(() => as("", () => db.query("select public.staff_notification_feed(1)"), "anon"), /permission denied/);
      await assert.rejects(() => as(cashier, () => db.query("select * from private.staff_notifications")), /permission denied/);

      const customer = randomUUID();
      await db.query("insert into auth.users (id,email,email_confirmed_at) values ($1,'notification-customer@test.example',null)", [customer]);
      assert.equal((await read(owner)).total_count, 0);
      await db.query("update auth.users set email_confirmed_at=now() where id=$1", [customer]);
      await db.query("update auth.users set email_confirmed_at=null where id=$1", [customer]);
      await db.query("update auth.users set email_confirmed_at=now() where id=$1", [customer]);
      const account = (await read(owner)).rows[0];
      assert.equal(account.kind, "account_verified");
      assert.equal(staffNotificationContent(account).href, "/admin/access?q=notification-customer%40test.example");
      assert.equal((await read(owner)).total_count, 1);
      assert.equal((await read(cashier)).total_count, 0);

      const date = dayKey(new Date(Date.now() + 25 * 86400000));
      const reservation = await call<{ id?: string; error?: string }>(customer, "request_customer_booking_v2", ["reserve_court", JSON.stringify({
        booking_date: date, customer_name: "Notification Customer", customer_phone: "09171234567",
        court_id: 2, start_hour: 9, duration: 1, expected_total_cents: 10000,
      })]);
      assert.ok(reservation.id, reservation.error);
      assert.equal((await read(owner)).total_count, 1);
      assert.deepEqual(await call(customer, "request_customer_booking_v2", ["payment", JSON.stringify({
        booking_id: reservation.id, reference: "NOTIFY-BOOKING-123456",
      })]), { success: true });
      const pending = (await read(cashier)).rows[0];
      assert.equal(pending.kind, "booking_payment");
      assert.equal(pending.priority, true);
      assert.match(staffNotificationContent(pending).href, /\/staff\?tab=bookings&date=\d{4}-\d\d-\d\d&q=AP-/);
      assert.ok(!JSON.stringify(pending).includes("NOTIFY-BOOKING-123456"));
      await call(cashier, "pos_verify_booking", [reservation.id]);
      await db.query("update public.bookings set status='confirmed' where id=$1", [reservation.id]);
      assert.equal((await read(cashier)).total_count, 2);
      assert.equal((await read(cashier)).rows.find((row) => row.id === pending.id)?.priority, false);
      await call(owner, "staff_update_booking", [reservation.id, "cancelled"]);
      const cancelled = (await read(cashier)).rows[0];
      assert.equal(cancelled.kind, "booking_cancelled");
      assert.equal(cancelled.priority, false);
      await db.query("update public.bookings set booking_date=(now() at time zone 'Asia/Manila')::date where id=$1", [reservation.id]);
      assert.equal((await read(cashier)).rows[0].priority, true);

      const { revision } = (await db.query<{ revision: number }>("select revision from public.membership_settings where id")).rows[0];
      const request = (action: string, input: unknown) => call(customer, "request_customer_membership", [action, JSON.stringify(input)]);
      assert.deepEqual(await request("start", { plan: "annual", revision }), { success: true });
      assert.equal((await read(owner)).total_count, 4);
      const { id } = (await db.query<{ id: string }>("select id from public.membership_applications where user_id=$1", [customer])).rows[0];
      assert.deepEqual(await request("submit", { id, reference: "NOTIFY-MEMBERSHIP-123456" }), { success: true });
      const membership = (await read(cashier)).rows.find((row) => row.kind === "membership_payment");
      assert.ok(membership?.priority);
      assert.equal(staffNotificationContent(membership).href, `/staff/memberships?application=${id}#pending-verification`);
      const focused = await call<{ row_count: number; rows: MembershipReviewRow[] }>(cashier, "list_membership_applications", [false, 1, id]);
      assert.equal(focused.row_count, 1);
      assert.equal(focused.rows[0].id, id);
      await call(cashier, "review_membership_payment", [id, true, ""]);
      const cashierFeed = await read(cashier);
      assert.equal(cashierFeed.total_count, 4);
      assert.equal((await read(manager)).total_count, 6);
      const reviewedNotice = cashierFeed.rows.find((row) => row.id === membership.id)!;
      assert.equal(reviewedNotice.priority, false);
      assert.equal(staffNotificationContent(reviewedNotice).href, `/staff/memberships?view=reviewed&application=${id}#review-history`);

      await mark(cashier, account.id);
      assert.equal((await db.query("select * from private.staff_notification_reads where user_id=$1", [cashier])).rows.length, 0);
      await mark(cashier, pending.id);
      await mark(cashier, pending.id);
      assert.equal((await read(cashier)).unread_count, 3);
      assert.equal((await read(owner)).unread_count, 6);
      await mark(owner, null);
      assert.equal((await read(owner)).unread_count, 0);
      assert.equal((await read(manager)).unread_count, 6);
      await db.query(`insert into private.staff_notifications(kind,subject_id)
        select 'booking_confirmed',$1 from generate_series(1,16)`, [reservation.id]);
      const first = await read(owner);
      const second = await read(owner, 2);
      assert.equal(first.unread_count,16);
      assert.equal(first.rows.length,15);
      assert.equal(second.rows.length,7);
      assert.equal(new Set([...first.rows,...second.rows].map((row)=>row.id)).size,22);
    });

    await t.test("the public counter catalog exposes current sale items and eligible photos only", async () => {
      const inventory = "select * from public.pos_products order by id";
      const before = (await db.query(inventory)).rows;
      await db.exec(await readFile("supabase/migrations/202611170043_public_counter_products.sql", "utf8"));
      assert.deepEqual((await db.query(inventory)).rows, before);

      const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 6, 74, 70, 73, 70, 0xff, 0xd9]).toString("base64");
      const product = { name: "Catalog paddle", sku: "CATALOG-PADDLE", barcode: "8039377", category: "Equipment",
        price_cents: 12900, cost_cents: 5000, reorder_level: 3, active: true, revision: 0 };
      const save = (details: typeof product, image: string | null) =>
        call<string>(owner, "pos_save_product_with_photo", [JSON.stringify(details), image]);
      const featured = await save(product, photo);
      const hidden = await save({ ...product, sku: "CATALOG-HIDDEN", barcode: "", name: "Hidden paddle", active: false }, photo);
      const plain = await save({ ...product, sku: "CATALOG-PLAIN", barcode: "", name: "Catalog ball" }, null);
      const version = async (id: string) => (await db.query<{ photo_version: string }>(
        "select photo_version from public.pos_products where id=$1", [id])).rows[0].photo_version;
      const photoVersion = await version(featured);
      const list = () => as("", () => db.query<CounterProduct>("select * from public.list_counter_products()"), "anon").then((r) => r.rows);
      const getPhoto = (version: string) => as("", () => db.query<{ data: string | null }>(
        "select public.counter_product_photo($1) as data", [version]), "anon").then((r) => r.rows[0].data?.replace(/\s/g, "") ?? null);

      assert.equal(await getPhoto(photoVersion), null);
      assert.ok(!(await list()).some((row) => row.name === product.name));
      for (const id of [featured, hidden, plain]) await call(owner, "pos_adjust_stock", [id, 1, "Catalog stock"]);
      const rows = await list();
      assert.deepEqual(rows[0], { name: product.name, category: "Equipment", price_cents: 12900, photo_version: photoVersion });
      assert.ok(rows.some((row) => row.name === "Catalog ball" && row.photo_version === null));
      assert.ok(!rows.some((row) => row.name === "Hidden paddle"));
      assert.equal(await getPhoto(photoVersion), photo);
      assert.equal(await getPhoto(await version(hidden)), null);
      await assert.rejects(() => as("", () => db.query(inventory), "anon"), /permission denied/);
      assert.deepEqual((await as(player, () => db.query(inventory))).rows, []);
      await assert.rejects(() => as("", () => db.query("select * from private.pos_product_photos"), "anon"), /permission denied/);

      await call(owner, "pos_adjust_stock", [featured, -1, "Sold out"]);
      assert.equal(await getPhoto(photoVersion), null);
      assert.ok(!(await list()).some((row) => row.name === product.name));
      const staffPhoto = await call<string>(cashier, "pos_product_photo", [photoVersion]);
      assert.equal(staffPhoto.replace(/\s/g, ""), photo);
    });

    await t.test("online pickup orders hold stock and settle once through the register", async () => {
      const before = await readCurrentData();
      await db.exec(await readFile("supabase/migrations/202611180044_counter_pickup_orders.sql", "utf8"));
      assert.deepEqual(await readCurrentData(), before);
      const product = await call<string>(owner, "pos_save_product", [JSON.stringify({
        name: "ALPRO Official Ball", sku: "PICKUP-BALL", category: "Equipment", price_cents: 14800,
        cost_cents: 4000, reorder_level: 2, active: true,
      })]);
      await call(owner, "pos_adjust_stock", [product, 2, "Pickup test stock"]);
      const buyer = randomUUID();
      await db.query("insert into auth.users(id,email) values($1,'pickup-buyer@example.test')", [buyer]);
      const id = randomUUID();
      const save = (actor: string, key: string, quantity: number, price = 14800) =>
        call<string>(actor, "place_counter_order", [key, product, quantity, price, "Test pickup"]);
      const order = async (key: string) => pickupOrderSchema.parse(await call(buyer, "get_counter_order", [key]));
      const stock = async () => (await db.query<{ stock: number }>("select stock from public.pos_products where id=$1", [product])).rows[0].stock;
      const availability = async () => (await as("", () => db.query<{ max_quantity: number }>(
        "select max_quantity from public.list_pickup_products($1)", [product]), "anon")).rows[0].max_quantity;
      const complete = (actor: string, key: string, verified = true) => call<{ id: string; paid_cents: number }>(
        actor, "complete_counter_order", [key, "cash", "", 30000, verified]);

      assert.equal(await availability(), 2);
      await assert.rejects(() => save(buyer, id, 2, 1), /price changed/);
      assert.equal(await save(buyer, id, 2), id);
      assert.equal(await save(buyer, id, 2), id);
      assert.equal((await order(id)).status, "pending");
      assert.equal(await call(player, "get_counter_order", [id]), null);
      await assert.rejects(() => call(player, "cancel_counter_order", [id]), /Order not found/);
      await assert.rejects(() => call(player, "list_counter_orders", [1, false]), /Authorized staff/);
      await assert.rejects(() => complete(player, id), /Authorized staff/);
      await assert.rejects(() => save(player, randomUUID(), 1), /no longer available/);
      assert.equal(await availability(), 0);
      assert.equal(await stock(), 2);
      assert.deepEqual(await call(owner, "list_counter_orders", [1, false]), { count: 1, rows: [await order(id)] });

      const shift = await call<string>(owner, "pos_open_shift", [0]);
      await assert.rejects(() => call(owner, "pos_checkout", [JSON.stringify({ key: randomUUID(), method: "cash",
        verified: true, tendered_cents: 14800, items: [{ product_id: product, quantity: 1, price_cents: 14800 }],
      })]), /reserved for pickup orders/);
      await assert.rejects(() => complete(owner, id, false), /confirm the received payment/);
      assert.equal((await order(id)).status, "pending");
      const sale = await complete(owner, id);
      assert.equal(sale.paid_cents, 29600);
      assert.deepEqual(await complete(owner, id), sale);
      assert.equal((await order(id)).status, "collected");
      assert.equal(await stock(), 0);
      assert.equal((await db.query("select * from public.pos_payments where sale_id=$1", [sale.id])).rows.length, 1);
      await call(owner, "pos_close_shift", [shift, 29600]);

      await call(owner, "pos_adjust_stock", [product, 1, "Pickup test restock"]);
      const cancelled = await save(buyer, randomUUID(), 1);
      await call(buyer, "cancel_counter_order", [cancelled]);
      assert.equal((await order(cancelled)).status, "cancelled");
      const expired = await save(buyer, randomUUID(), 1);
      await db.query("update private.counter_orders set expires_at=now() - interval '1 second' where id=$1", [expired]);
      assert.equal((await order(expired)).status, "expired");
      assert.equal(await availability(), 1);
      await assert.rejects(() => complete(owner, expired), /no longer awaiting pickup/);
      assert.equal((await call<{ count: number }>(owner, "list_counter_orders", [1, true])).count, 3);
      assert.ok((await as(buyer, () => db.query("select * from public.list_my_counter_orders()"))).rows.length === 3);
      await assert.rejects(() => as("", () => db.query("select * from private.counter_orders"), "anon"), /permission denied/);
    });

    await t.test("member walk-ins use the online plan price and record the counter payment once", async () => {
      const before = await readCurrentData();
      await db.exec(await readFile("supabase/migrations/202611180045_walk_in_membership_discounts.sql", "utf8"));
      assert.deepEqual(await readCurrentData(), {
        ...before,
        bookings: before.bookings.map((row) => ({ ...(row as object), account_linked_walk_in: false })),
      });

      const userId = async (email: string) => (await db.query<{ id: string }>("select id from auth.users where email=$1", [email])).rows[0].id;
      const annual = await userId("annual@test.example");
      const six = await userId("daytime-rate@test.example");
      const manager = await userId("membership-manager@example.test");
      const offDuty = await userId("membership-relief@test.example");
      const guest = randomUUID();
      await db.query("insert into auth.users(id,email) values($1,'member-walk-in-guest@example.test')", [guest]);
      const date = dayKey(new Date(Date.now() + 28 * 86400000));
      const quote = (actor: string, customer: string, start: number, duration: number, quantity = 0) =>
        call<{ regularCents: number; discountCents: number; totalCents: number }>(actor, "pos_quote_member_walk_in",
          [customer, date, start, duration, quantity]);
      await assert.rejects(() => quote(player, annual, 6, 2), /Authorized staff/);
      await assert.rejects(() => quote(offDuty, annual, 6, 2), /Authorized staff/);
      assert.deepEqual(await quote(cashier, annual, 6, 2, 2), { regularCents: 26000, discountCents: 4550, totalCents: 21450 });
      assert.deepEqual(await quote(manager, guest, 6, 2), { regularCents: 20000, discountCents: 0, totalCents: 20000 });
      assert.equal((await quote(manager, six, 16, 2)).discountCents, 0);
      const savedRevision = await call<number>(manager, "save_membership_booking_discount", ["six-month", true, 2250, 2, 6]);
      assert.equal(savedRevision, 7);
      assert.equal((await quote(manager, six, 16, 1)).discountCents, 0);
      assert.deepEqual(await quote(manager, six, 16, 2), { regularCents: 40000, discountCents: 2250, totalCents: 37750 });

      const key = randomUUID();
      const request = [key, annual, date, "Annual member at counter", "09171234567", 1, 6, 2, 2,
        "reservation_fee", "cash", "", true, 10725, 21450, ""];
      const book = (actor: string, args: unknown[]) => call<string>(actor, "pos_book_member_walk_in", args);
      await assert.rejects(() => book(player, request), /Authorized staff/);
      await assert.rejects(() => book(offDuty, request), /Authorized staff/);
      // A register or stale quote failure rolls back the slot along with the payment.
      await assert.rejects(() => book(cashier, request), /Open your cashier shift/);
      const shift = await call<string>(cashier, "pos_open_shift", [0]);
      const stale = [...request];
      stale[14] = 26000;
      await assert.rejects(() => book(cashier, stale), /price or membership changed/);
      stale[14] = 21450;
      stale[13] = 100;
      await assert.rejects(() => book(cashier, stale), /amount to collect changed/);
      const id = await book(cashier, request);
      assert.equal(await book(cashier, request), id);
      const changedCustomer = [...request];
      changedCustomer[1] = six;
      await assert.rejects(() => book(cashier, changedCustomer), /different booking/);

      const details = await as(annual, () => db.query(`select user_id, account_linked_walk_in, status,
        membership_discount_amount, equipment_amount, total_amount, initial_payment_amount, paid_amount
        from public.bookings where id=$1`, [id]));
      assert.deepEqual(details.rows, [{ user_id: annual, account_linked_walk_in: true, status: "confirmed",
        membership_discount_amount: "45.50", equipment_amount: "60.00", total_amount: "214.50",
        initial_payment_amount: "107.25", paid_amount: "107.25" }]);
      assert.deepEqual((await as(player, () => db.query("select id from public.bookings where id=$1", [id]))).rows, []);
      assert.deepEqual((await db.query(`select p.method,p.amount_cents,p.shift_id from public.pos_payments p
        join public.pos_sales s on s.id=p.sale_id where s.booking_id=$1`, [id])).rows,
      [{ method: "cash", amount_cents: 10725, shift_id: shift }]);
      await call(manager, "staff_save_booking_finance", [id, "cash", "Discount verified"]);
      await call(cashier, "pos_close_shift", [shift, 10725]);

      const managerRequest = [randomUUID(), six, date, "Six-month member at counter", "09171234567", 2, 16, 2, 0,
        "full", "bank_transfer", "", true, 37750, 37750, "Verified transfer"];
      await assert.rejects(() => book(cashier, managerRequest), /confirm the received payment/);
      const managerBooking = await book(manager, managerRequest);
      assert.deepEqual((await db.query(`select f.payment_method,f.notes,p.amount_cents from public.booking_finance f
        join public.pos_sales s on s.booking_id=f.booking_id join public.pos_payments p on p.sale_id=s.id
        where f.booking_id=$1`, [managerBooking])).rows,
      [{ payment_method: "bank_transfer", notes: "Verified transfer", amount_cents: 37750 }]);

      const guestBooking = await book(manager, [randomUUID(), guest, date, "Guest account at counter", "09171234567", 2, 6, 1, 0,
        "full", "gcash", "WALKIN-MEMBER-TEST-2026", true, 10000, 10000, ""]);
      assert.deepEqual((await db.query(`select b.membership_discount_amount,p.method,p.amount_cents from public.bookings b
        join public.pos_sales s on s.booking_id=b.id join public.pos_payments p on p.sale_id=s.id where b.id=$1`, [guestBooking])).rows,
      [{ membership_discount_amount: "0.00", method: "gcash", amount_cents: 10000 }]);
    });

    await t.test("configurable open-play discounts apply to one pass online or at the counter", async () => {
      const before = await readCurrentData();
      await db.exec(await readFile("supabase/migrations/202611180046_open_play_membership_discounts.sql", "utf8"));
      assert.deepEqual(await readCurrentData(), before);

      const date = dayKey(new Date(Date.now() + 28 * 86400000));
      const updated = blocks.map((block) => block.id === "open-afternoon" ? { ...block, rate: 100 } : block);
      await db.query("update public.venue_settings set schedule_config=jsonb_set(schedule_config,'{weekly}',$1::jsonb)", [JSON.stringify(updated)]);
      const manager = (await db.query<{ id: string }>("select id from auth.users where email='membership-manager@example.test'")).rows[0].id;
      const six = (await db.query<{ id: string }>("select id from auth.users where email='daytime-rate@test.example'")).rows[0].id;
      const annual = randomUUID(), guest = randomUUID();
      await db.query("insert into auth.users(id,email) values($1,'open-play-annual@example.test'),($2,'open-play-guest@example.test')", [annual, guest]);
      const { revision } = (await db.query<{ revision: number }>("select revision from public.membership_settings where id")).rows[0];
      assert.deepEqual(await call(annual, "request_customer_membership", ["start", JSON.stringify({ plan: "annual", revision })]), { success: true });
      const application = (await db.query<{ id: string }>("select id from public.membership_applications where user_id=$1", [annual])).rows[0].id;
      assert.deepEqual(await call(annual, "request_customer_membership", ["submit", JSON.stringify({ id: application, reference: "MEMBER-OPEN-PLAY-2026" })]), { success: true });
      await call(manager, "review_membership_payment", [application, true, ""]);

      const edit = (actor: string, enabled: boolean, amount: number, floor: number, version: number) =>
        call<number>(actor, "save_membership_open_play_discount", ["annual", enabled, amount, floor, version]);
      const onlineQuote = (actor: string, start = 12) =>
        call<number>(actor, "get_open_play_member_discount", [date, start]);
      const walkInQuote = (actor: string, customer: string, start = 12) =>
        call(actor, "pos_quote_member_open_play_walk_in", [customer, date, start, 3, 1]);
      await assert.rejects(() => edit(cashier, true, 3500, 6000, 0), /Manager or owner access/);
      await assert.rejects(() => walkInQuote(guest, annual), /Authorized staff/);
      await assert.rejects(() => as("", () => db.query("select public.get_open_play_member_discount($1,12)", [date]), "anon"), /permission denied/);
      assert.equal(await onlineQuote(annual), 0);
      assert.equal(await onlineQuote(six), 0);
      assert.deepEqual(await walkInQuote(cashier, six), { regularCents: 33000, discountCents: 0, totalCents: 33000 });
      assert.equal(await edit(manager, true, 3000, 7000, 0), 1);
      assert.equal(await call(owner, "save_membership_open_play_discount", ["six-month", true, 3000, 7000, 0]), 1);
      assert.equal(await onlineQuote(annual, 8), 0);
      assert.equal(await onlineQuote(annual), 3000);
      assert.equal(await onlineQuote(six), 3000);
      assert.equal(await onlineQuote(guest), 0);
      assert.deepEqual(await walkInQuote(cashier, six), { regularCents: 33000, discountCents: 3000, totalCents: 30000 });

      assert.equal(await edit(manager, true, 3550, 6000, 1), 2);
      await assert.rejects(() => edit(owner, false, 3550, 6000, 1), /Someone updated this discount/);
      assert.equal(await onlineQuote(annual), 3550);
      assert.equal(await onlineQuote(six), 3000);
      assert.equal(await onlineQuote(annual, 8), 0);

      const reserve = (actor: string, expectedTotal: number) =>
        call<{ id?: string; error?: string }>(actor, "request_customer_booking_v2", ["reserve_open_play", JSON.stringify({
          booking_date: date, start_hour: 12, participant_count: 3,
          customer_name: "Open-play member", customer_phone: "09171234567", equipment_quantity: 1,
          payment_option: "reservation_fee", expected_total_cents: expectedTotal,
        })]);
      assert.match((await reserve(annual, 30000)).error ?? "", /booking price changed/);
      const reserved = await reserve(annual, 29450);
      assert.ok(reserved.id, reserved.error);
      assert.deepEqual((await db.query(`select participant_count,membership_discount_amount,total_amount,initial_payment_amount,equipment_amount
        from public.bookings where id=$1`, [reserved.id])).rows,
      [{ participant_count: 3, membership_discount_amount: "35.50", total_amount: "294.50", initial_payment_amount: "147.25", equipment_amount: "30.00" }]);
      assert.equal(await onlineQuote(annual), 0);
      assert.deepEqual(await walkInQuote(cashier, annual), { regularCents: 33000, discountCents: 0, totalCents: 33000 });

      const key = randomUUID();
      const counter = () => call<string>(cashier, "pos_book_member_open_play_walk_in", [key, six, date, "Member and guests",
        "09171234567", 12, 3, 1, "full", "gcash", "MEMBER-OPEN-PLAY-WALK-IN", true, 30000, 30000, ""]);
      const walkIn = await counter();
      assert.equal(await counter(), walkIn);
      assert.equal(await onlineQuote(six), 0);
      assert.deepEqual((await as(six, () => db.query(`select booking_type,account_linked_walk_in,participant_count,paid_amount
        from public.bookings where id=$1`, [walkIn]))).rows,
      [{ booking_type: "open_play", account_linked_walk_in: true, participant_count: 3, paid_amount: "300.00" }]);
      assert.deepEqual((await db.query(`select p.amount_cents,p.method from public.pos_payments p
        join public.pos_sales s on s.id=p.sale_id where s.booking_id=$1`, [walkIn])).rows,
      [{ amount_cents: 30000, method: "gcash" }]);
      assert.equal(await edit(owner, false, 3550, 6000, 2), 3);
      assert.equal(await onlineQuote(annual), 0);
    });

    await t.test("walk-in account lookup filters active members and saves verified account details", async () => {
      const before = await readCurrentData();
      await db.exec("alter table auth.users add column phone text, add column phone_confirmed_at timestamptz");
      await db.exec(await readFile("supabase/migrations/202611180047_account_first_walk_ins.sql", "utf8"));
      assert.deepEqual(await readCurrentData(), before);

      const date = dayKey(new Date(Date.now() + 29 * 86400000));
      const active = (await db.query<{ id: string }>("select id from auth.users where email='daytime-rate@test.example'")).rows[0].id;
      const existingAccount = randomUUID();
      await db.query(`update auth.users set raw_user_meta_data='{"full_name":"Jules Member"}',
        phone='639171234567' where id=$1`, [active]);
      await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data,phone,phone_confirmed_at) values
        ($1,'jules-player@example.test',now(),'{"full_name":"Jules Player"}','639178765432',now()),
        ($2,'jules-unconfirmed@example.test',null,'{"full_name":"Jules Unconfirmed"}',null,null)`, [existingAccount, randomUUID()]);

      const find = (actor: string, query: string, activeOnly?: boolean) => as(actor, () =>
        db.query("select * from public.pos_find_walk_in_customers($1,$2" + (activeOnly === undefined ? ")" : ",$3)"),
          activeOnly === undefined ? [query, date] : [query, date, activeOnly])).then(({ rows }) => rows);
      const foundMember = { id: active, full_name: "Jules Member", email: "d•••@t•••", active_membership: true };
      assert.deepEqual(await find(cashier, "Jules"), [foundMember]);
      assert.deepEqual(await find(cashier, "Jules", false), [foundMember, {
        id: existingAccount, full_name: "Jules Player", email: "j•••@e•••", active_membership: false,
      }]);
      assert.deepEqual(await find(owner, "daytime-rate@test.example"), [{ ...foundMember, email: "daytime-rate@test.example" }]);
      await assert.rejects(() => find(player, "Jules"), /Authorized staff/);
      await assert.rejects(() => find("", "Jules", true), /Authorized staff/);

      const walkIn = [randomUUID(), active, "open_play", date, null, 12, 1, 2, 0,
        "full", "gcash", "ACCOUNT-WALK-IN-REFERENCE", true, 17000, 17000, ""];
      const book = (actor: string, input: unknown[]) => call<string>(actor, "pos_book_account_walk_in", input);
      await assert.rejects(() => book(player, walkIn), /Authorized staff/);
      const booked = await book(cashier, walkIn);
      await db.query("update auth.users set raw_user_meta_data='{\"full_name\":\"Updated profile\"}' where id=$1", [active]);
      assert.equal(await book(cashier, walkIn), booked);
      const read = (actor: string, id: string) => as(actor, () => db.query(`select customer_name,customer_phone,
        total_amount,membership_discount_amount,account_linked_walk_in from public.bookings where id=$1`, [id]));
      assert.deepEqual((await read(active, booked)).rows, [{ customer_name: "Jules Member", customer_phone: "",
        total_amount: "170.00", membership_discount_amount: "30.00", account_linked_walk_in: true }]);

      const court = await book(owner, [randomUUID(), existingAccount, "court", date, 1, 6, 1, 1, 0,
        "full", "bank_transfer", "", true, 10000, 10000, ""]);
      assert.deepEqual((await read(existingAccount, court)).rows, [{ customer_name: "Jules Player", customer_phone: "+639178765432",
        total_amount: "100.00", membership_discount_amount: "0.00", account_linked_walk_in: true }]);
      await assert.rejects(() => call(cashier, "pos_book_walk_in", [randomUUID(), "court", date, "Walk-in Guest", null,
        2, 6, 1, 1, 0, "full", "gcash", "GUEST-WALK-IN-REFERENCE", true, 10000]), /valid Philippine mobile/);
    });

    await t.test("a shared membership discount save rolls back both rules on validation or revision conflicts", async () => {
      const read = async () => (await db.query<{
        court_booking_discount_cents: number; court_discount_revision: number;
        open_play_discount_cents: number; open_play_discount_revision: number; open_play_member_floor_cents: number;
      }>(`select court_booking_discount_cents,court_discount_revision,open_play_discount_cents,
        open_play_discount_revision,open_play_member_floor_cents from public.membership_settings where id`)).rows[0];
      const before = await read();
      await db.exec(await readFile("supabase/migrations/202611190048_save_membership_discounts_together.sql", "utf8"));
      assert.deepEqual(await read(), before);

      const args = ["annual", true, 5000, 2, before.court_discount_revision, true, 4000, 7500, before.open_play_discount_revision];
      const save = (actor: string, input = args) =>
        call<{ courtRevision: number; openPlayRevision: number }>(actor, "save_membership_discounts", input);
      await assert.rejects(() => save(cashier), /Manager or owner access/);
      await assert.rejects(() => as("", () => db.query(
        "select public.save_membership_discounts('annual',true,5000,2,0,true,4000,7500,0)"), "anon"), /permission denied/);
      await assert.rejects(() => save(owner, [...args.slice(0, 7), 0, args[8]]), /valid open-play discount/);
      assert.deepEqual(await read(), before);

      await call(owner, "save_membership_open_play_discount", ["annual", true, 3100, 7000, before.open_play_discount_revision]);
      const changed = await read();
      await assert.rejects(() => save(owner), /Someone updated this discount/);
      assert.deepEqual(await read(), changed);

      const fresh = [...args.slice(0, -1), changed.open_play_discount_revision];
      const revisions = { courtRevision: changed.court_discount_revision + 1, openPlayRevision: changed.open_play_discount_revision + 1 };
      assert.deepEqual(await save(owner, fresh), revisions);
      assert.deepEqual(await save(owner, fresh), revisions);
      assert.deepEqual(await read(), { court_booking_discount_cents: 5000, court_discount_revision: revisions.courtRevision,
        open_play_discount_cents: 4000, open_play_discount_revision: revisions.openPlayRevision, open_play_member_floor_cents: 7500 });
    });
  } finally {
    await db.close();
  }
});
