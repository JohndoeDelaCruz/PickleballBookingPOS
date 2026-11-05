import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { centavos, cartTotal, dayKey, reportFor } from "../src/lib/pos";
import { demoData } from "../src/lib/demo";
import { applyDemoCommand } from "../src/lib/demo-command";

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
  const d = demoData();
  const b = d.bookings[0];
  const result = applyDemoCommand(d, {
    op: "balance",
    id: b.id,
    method: "cash",
    reference: "",
    verified: true,
  });
  assert.equal(result.data.bookings[0].paid_amount, 400);
  assert.equal(
    reportFor(result.data, dayKey()).collected,
    reportFor(d, dayKey()).collected + 20000,
  );
  assert.throws(
    () =>
      applyDemoCommand(result.data, {
        op: "balance",
        id: b.id,
        method: "cash",
        reference: "",
        verified: true,
      }),
    /no collectible/,
  );
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
      `create role anon;create role authenticated;create schema auth;create schema storage;create schema extensions;set search_path=public,extensions;grant usage on schema public,auth,storage to anon,authenticated;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);alter table storage.objects enable row level security;grant select,insert,update on storage.objects to anon,authenticated;alter default privileges grant execute on functions to anon,authenticated;alter default privileges grant all on tables to anon,authenticated;`,
    );
    for (const file of (await readdir("supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
    await db.query(
      "insert into auth.users values($1,'owner@test.example'),($2,'cashier@test.example'),($3,'player@test.example')",
      [owner, cashier, player],
    );
    await db.query(
      "insert into public.staff_members(user_id,role) values($1,'owner'),($2,'cashier')",
      [owner, cashier],
    );
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
          (await db.query("select * from public.pos_sales")).rows.length,
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
    await t.test("cash walk-ins post one payment; unreferenced GCash walk-ins roll back", async () => {
      const day = (await db.query<{booking_day:string}>("select (current_date+1)::text as booking_day")).rows[0].booking_day;
      await db.exec("update public.venue_settings set open_play_enabled=false,opening_hour=6,closing_hour=22,hourly_rate=100");
      const booking = await call<string>(owner,"reserve_staff_equipment_booking",["court",day,"Walk-in Player","09171234567",2,6,1,1,false,false,"cash","","full",0]);
      const sale = (await db.query<{id:string;paid_cents:number}>("select * from public.pos_sales where booking_id=$1",[booking])).rows[0];
      assert.equal(sale.paid_cents,10000);
      assert.equal((await db.query("select * from public.pos_payments where sale_id=$1",[sale.id])).rows.length,1);
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
        assert.equal(Number(summary.rows[0].expected_cents), 130000);
        await assert.rejects(
          () => call(cashier, "pos_close_shift", [shift, 120000]),
          /Only your active/,
        );
        await call(owner, "pos_close_shift", [shift, 129500]);
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
  } finally {
    await db.close();
  }
});
