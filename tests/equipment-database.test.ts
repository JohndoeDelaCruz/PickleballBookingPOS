import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { dayCsv, type FinanceBooking } from "../src/lib/finance";

test("multiple equipment sets retain prices, payments, access controls, and request limits", async (t) => {
  const db = new PGlite({ extensions: { btree_gist } });
  const alice = "00000000-0000-4000-a000-000000000001",
    bob = "00000000-0000-4000-a000-000000000002",
    staff = "00000000-0000-4000-a000-000000000003";
  type Reply = {
    id?: string;
    error?: string;
    code?: string;
    success?: boolean;
  };
  try {
    await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;create schema extensions;
      set search_path=public,extensions;grant usage on schema public,auth,storage to anon,authenticated;
      create table auth.users(id uuid primary key,email text);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);alter table storage.objects enable row level security;
      grant select,insert,update on storage.objects to anon,authenticated;
      insert into auth.users values('${alice}','alice@example.com'),('${bob}','bob@example.com'),('${staff}','staff@example.com');
      alter default privileges grant execute on functions to anon,authenticated;`);
    const files = (await readdir("supabase/migrations"))
      .filter((f) => f.endsWith(".sql") && f < "202611040013")
      .sort();
    for (const file of files.filter((f) => f < "202610270012"))
      await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
    await db.query("insert into public.staff_members values($1)", [staff]);
    const day = (
      await db.query<{ day: string }>(
        "select ((now() at time zone 'Asia/Manila')::date+1)::text as day",
      )
    ).rows[0].day;
    const config = {
      weekly: [
        {
          id: "morning",
          days: [1, 2, 3, 4, 5, 6, 7],
          kind: "court",
          start: 6,
          end: 9,
          rate: 100,
          capacity: 8,
        },
        {
          id: "open",
          days: [1, 2, 3, 4, 5, 6, 7],
          kind: "open_play",
          start: 9,
          end: 17,
          rate: 50,
          capacity: 24,
        },
      ],
      overrides: [],
    };
    await db.query(
      "update public.venue_settings set schedule_config=$1,booking_enabled=true,gcash_name='Rally',gcash_qr_url='https://example.com/qr.png'",
      [JSON.stringify(config)],
    );
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
    const old = (
      await as(staff, () =>
        db.query<{ id: string }>(
          "select public.reserve_scheduled_booking('court',$1,'Existing Player','09171234567',1,6,1,1,true,true) id",
          [day],
        ),
      )
    ).rows[0].id;
    const oldRecord = (
      await db.query<{ b: unknown }>(
        "select to_jsonb(b) b from public.bookings b where id=$1",
        [old],
      )
    ).rows[0].b;
    await db.exec(
      "update public.venue_settings set equipment_rental_price=45,equipment_ball_count=3",
    );
    for (const file of files.filter((f) => f >= "202610270012"))
      await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
    assert.deepEqual(
      (
        await db.query<{ b: unknown }>(
          "select to_jsonb(b)-'equipment_quantity'-'equipment_unit_price' b from public.bookings b where id=$1",
          [old],
        )
      ).rows[0].b,
      oldRecord,
    );
    const legacy = (
      await db.query<FinanceBooking>(
        "select * from public.bookings where id=$1",
        [old],
      )
    ).rows[0];
    assert.equal(legacy.equipment_quantity, 1);
    assert.equal(Number(legacy.equipment_unit_price), 30);
    assert.equal(legacy.equipment_ball_count, 1);
    const court = (quantity = 3) => ({
      booking_date: day,
      court_id: 1,
      start_hour: 6,
      duration: 1,
      customer_name: "Test Player",
      customer_phone: "09171234567",
      equipment_quantity: quantity,
      payment_option: "reservation_fee",
    });
    async function request(
      input: unknown,
      action = "reserve_court",
      user = alice,
      rpc = "request_customer_booking_v2",
    ) {
      return as(
        user,
        async () =>
          (
            await db.query<{ result: Reply }>(
              `select public.${rpc}($1,$2) result`,
              [action, JSON.stringify(input)],
            )
          ).rows[0].result,
      );
    }
    async function reset() {
      await db.exec(
        "truncate public.bookings,public.booking_finance,private.booking_request_limits;update public.venue_settings set equipment_rental_price=30,equipment_ball_count=1",
      );
    }

    await t.test(
      "three sets update both deposit and remaining balance; changes to venue prices do not alter the saved rental",
      async () => {
        await reset();
        const result = await request({
          ...court(),
          equipment_amount: 1,
          equipment_unit_price: 1,
        });
        assert.ok(result.id, result.error);
        const saved = (
          await db.query<FinanceBooking>(
            "select * from public.bookings where id=$1",
            [result.id],
          )
        ).rows[0];
        assert.equal(Number(saved.total_amount), 190);
        assert.equal(Number(saved.initial_payment_amount), 95);
        assert.equal(saved.equipment_quantity, 3);
        assert.equal(Number(saved.equipment_amount), 90);
        assert.equal(Number(saved.equipment_unit_price), 30);
        assert.deepEqual(
          await request(
            { booking_id: result.id, reference: "QTY-123456" },
            "payment",
          ),
          { success: true },
        );
        await as(staff, () =>
          db.query("select public.staff_update_booking($1,'confirmed')", [
            result.id,
          ]),
        );
        assert.equal(
          Number(
            (
              await db.query<{ paid_amount: number }>(
                "select paid_amount from public.bookings where id=$1",
                [result.id],
              )
            ).rows[0].paid_amount,
          ),
          95,
        );
        await as(staff, () =>
          db.query("select public.staff_record_balance($1,'cash')", [
            result.id,
          ]),
        );
        await db.exec(
          "update public.venue_settings set equipment_rental_price=45,equipment_ball_count=3",
        );
        const final = (
          await db.query<FinanceBooking>(
            "select * from public.bookings where id=$1",
            [result.id],
          )
        ).rows[0];
        assert.equal(Number(final.paid_amount), 190);
        assert.equal(final.equipment_quantity, 3);
        assert.equal(final.equipment_ball_count, 1);
        assert.equal(Number(final.equipment_unit_price), 30);
        const csv = dayCsv([final], {
          report_date: day,
          worker_on_duty: "",
          manager_notes: "",
        });
        assert.ok(csv.includes('"100","3","90","190"'));
      },
    );
    await t.test(
      "invalid quantities count toward cooldown and never create bookings",
      async () => {
        await reset();
        for (const quantity of [-1, 1.5, 9, 101, "bad"]) {
          const result = await request(court(quantity as number));
          assert.equal(result.code, "REQUEST_REJECTED", result.error);
        }
        assert.equal((await request(court(1))).code, "RATE_LIMITED");
        assert.equal(
          (
            await db.query<{ count: number }>(
              "select count(*)::int count from public.bookings",
            )
          ).rows[0].count,
          0,
        );
      },
    );
    await t.test(
      "open-play rentals cannot exceed the reserved passes",
      async () => {
        await reset();
        const input = { ...court(3), start_hour: 9, participant_count: 2 };
        assert.match(
          (await request(input, "reserve_open_play")).error!,
          /cannot exceed/,
        );
        const result = await request(
          { ...input, equipment_quantity: 2 },
          "reserve_open_play",
        );
        assert.ok(result.id, result.error);
        const b = (
          await db.query<FinanceBooking>(
            "select * from public.bookings where id=$1",
            [result.id],
          )
        ).rows[0];
        assert.equal(Number(b.total_amount), 160);
        assert.equal(b.equipment_quantity, 2);
        assert.equal(b.participant_count, 2);
      },
    );
    await t.test(
      "zero-price sets and no equipment remain distinct; unit prices round correctly",
      async () => {
        await reset();
        await db.exec(
          "update public.venue_settings set equipment_rental_price=0",
        );
        let result = await request(court(3));
        let b = (
          await db.query<FinanceBooking>(
            "select * from public.bookings where id=$1",
            [result.id],
          )
        ).rows[0];
        assert.equal(b.equipment_rental, true);
        assert.equal(b.equipment_quantity, 3);
        assert.equal(Number(b.total_amount), 100);
        await reset();
        result = await request({ ...court(0), equipment_rental: true });
        b = (
          await db.query<FinanceBooking>(
            "select * from public.bookings where id=$1",
            [result.id],
          )
        ).rows[0];
        assert.equal(b.equipment_rental, false);
        assert.equal(b.equipment_quantity, 0);
        assert.equal(b.equipment_ball_count, 0);
        await reset();
        await db.exec(
          "update public.venue_settings set equipment_rental_price=30.01",
        );
        result = await request(court(3));
        b = (
          await db.query<FinanceBooking>(
            "select * from public.bookings where id=$1",
            [result.id],
          )
        ).rows[0];
        assert.equal(Number(b.total_amount), 190.03);
        assert.equal(Number(b.initial_payment_amount), 95.02);
      },
    );
    await t.test(
      "legacy clients buy one set and share the same request allowance with v2",
      async () => {
        await reset();
        const { equipment_quantity, ...input } = court();
        const result = await request(
          { ...input, equipment_rental: true },
          "reserve_court",
          alice,
          "request_customer_booking",
        );
        assert.ok(result.id);
        assert.equal(
          (
            await db.query<{ equipment_quantity: number }>(
              "select equipment_quantity from public.bookings where id=$1",
              [result.id],
            )
          ).rows[0].equipment_quantity,
          1,
        );
        for (let i = 0; i < 4; i++)
          await request(
            null,
            "reserve_court",
            alice,
            i % 2 ? "request_customer_booking" : "request_customer_booking_v2",
          );
        assert.equal((await request(court(3))).code, "RATE_LIMITED");
      },
    );
    await t.test(
      "staff quantities update confirmed collections and reject unauthorized or blocked rentals",
      async () => {
        await reset();
        const sql =
          "select public.reserve_staff_equipment_booking(p_kind=>'court',p_date=>$1,p_name=>'Walk In',p_phone=>'09171234567',p_court=>1,p_start=>6,p_quantity=>3,p_payment_option=>'reservation_fee') id";
        await assert.rejects(
          () => as(alice, () => db.query(sql, [day])),
          /Staff access/,
        );
        const result = (
          await as(staff, () => db.query<{ id: string }>(sql, [day]))
        ).rows[0];
        const b = (
          await db.query<FinanceBooking>(
            "select * from public.bookings where id=$1",
            [result.id],
          )
        ).rows[0];
        assert.equal(b.equipment_quantity, 3);
        assert.equal(Number(b.paid_amount), 95);
        assert.equal(b.status, "confirmed");
        await assert.rejects(
          () =>
            as(staff, () =>
              db.query(
                "select public.reserve_staff_equipment_booking(p_kind=>'court',p_date=>$1,p_name=>'Maintenance',p_phone=>'',p_court=>2,p_start=>6,p_quantity=>1,p_blocked=>true)",
                [day],
              ),
            ),
          /valid number/,
        );
        for (const fn of [
          "public.reserve_equipment_booking(text,date,text,text,int,int,int,int,boolean,boolean,boolean,text,text,text,int)",
          "public.snapshot_equipment_quantity()",
        ])
          assert.equal(
            (
              await db.query<{ allowed: boolean }>(
                "select has_function_privilege('authenticated',$1,'execute') allowed",
                [fn],
              )
            ).rows[0].allowed,
            false,
          );
        assert.equal(
          (
            await db.query<{ allowed: boolean }>(
              "select has_function_privilege('anon','public.request_customer_booking_v2(text,jsonb)','execute') allowed",
            )
          ).rows[0].allowed,
          false,
        );
        await assert.rejects(
          () =>
            as(bob, () =>
              db.query("update public.bookings set equipment_quantity=10"),
            ),
          /permission denied/,
        );
      },
    );
  } finally {
    await db.close();
  }
});
