import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

test("customer request limits persist failures and protect every mutation entry point", async (t) => {
  const db = new PGlite({ extensions: { btree_gist } });
  const alice = "00000000-0000-4000-a000-000000000001";
  const bob = "00000000-0000-4000-a000-000000000002";
  const staff = "00000000-0000-4000-a000-000000000003";
  const missing = "00000000-0000-4000-a000-000000000099";
  type Reply = {
    id?: string;
    success?: boolean;
    error?: string;
    code?: string;
    retry_after_seconds?: number;
  };
  try {
    await db.exec(`create role anon; create role authenticated;
      create schema auth; create schema storage; create schema extensions;
      set search_path=public,extensions;
      grant usage on schema public,auth,storage to anon,authenticated;
      create table auth.users(id uuid primary key,email text);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid; $$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
      alter table storage.objects enable row level security;
      grant select,insert,update on storage.objects to anon,authenticated;
      insert into auth.users values('${alice}','alice@example.com'),('${bob}','bob@example.com'),('${staff}','staff@example.com');
      -- Match permissive existing Supabase project defaults, including tables.
      alter default privileges grant execute on functions to anon,authenticated;
      alter default privileges grant all on tables to anon,authenticated;`);
    const files = (await readdir("supabase/migrations"))
      .filter((f) => f.endsWith(".sql") && f < "202611040013")
      .sort();
    for (const file of files.filter((f) => f < "202610270011"))
      await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
    await db.query("insert into public.staff_members values($1)", [staff]);
    await db.exec(
      "update public.venue_settings set booking_enabled=true,gcash_name='Rally',gcash_qr_url='https://example.com/qr.png'",
    );
    const day = (
      await db.query<{ day: string }>(
        "select ((now() at time zone 'Asia/Manila')::date+1)::text as day",
      )
    ).rows[0].day;
    const schedule = {
      weekly: [
        {
          id: "early",
          days: [1, 2, 3, 4, 5, 6, 7],
          kind: "court",
          start: 6,
          end: 9,
          rate: 100,
          capacity: 8,
        },
        {
          id: "day",
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
    await db.query("update public.venue_settings set schedule_config=$1", [
      JSON.stringify(schedule),
    ]);
    await db.query(
      "insert into public.bookings(reference,user_id,court_id,booking_date,start_hour,duration,total_amount,status,customer_name,customer_phone) values('AP-KEEP',$1,1,$2,6,1,123,'confirmed','Existing Player','09171234567')",
      [alice, day],
    );
    const original = (
      await db.query(
        "select to_jsonb(b)-'equipment_quantity'-'equipment_unit_price' b from public.bookings b",
      )
    ).rows;
    const originalVenue = (
      await db.query("select to_jsonb(v) v from public.venue_settings v")
    ).rows;
    for (const file of files.filter((f) => f >= "202610270011"))
      await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
    assert.deepEqual(
      (
        await db.query(
          "select to_jsonb(b)-'equipment_quantity'-'equipment_unit_price' b from public.bookings b",
        )
      ).rows,
      original,
    );
    assert.deepEqual(
      (await db.query("select to_jsonb(v) v from public.venue_settings v"))
        .rows,
      originalVenue,
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
    async function request(
      action: string,
      input: unknown = null,
      user = alice,
    ) {
      return as(
        user,
        async () =>
          (
            await db.query<{ result: Reply }>(
              "select public.request_customer_booking($1,$2) result",
              [action, JSON.stringify(input)],
            )
          ).rows[0].result,
      );
    }
    const court = (start = 6) => ({
      booking_date: day,
      court_id: 1,
      start_hour: start,
      duration: 1,
      customer_name: "Test Player",
      customer_phone: "09171234567",
    });
    const openPlay = () => ({ ...court(9), participant_count: 2 });
    async function reset() {
      await db.exec(
        "truncate public.bookings,public.booking_finance,private.booking_request_limits",
      );
    }
    async function count(action = "reserve", user = alice) {
      return (
        (
          await db.query<{ total: number }>(
            "select cardinality(attempts) total from private.booking_request_limits where user_id=$1 and action=$2",
            [user, action],
          )
        ).rows[0]?.total ?? 0
      );
    }

    await t.test(
      "anonymous callers, old RPCs, counters, and direct writes cannot bypass the gate",
      async () => {
        const signatures = [
          "public.create_booking(int,date,int,int,text,text)",
          "public.create_open_play_booking(date,int,text,text,boolean)",
          "public.reserve_with_equipment(text,date,text,text,int,int,int,int,boolean,boolean,boolean,text,text)",
          "public.reserve_with_payment(text,date,text,text,int,int,int,int,boolean,boolean,boolean,text,text,text)",
          "public.reserve_scheduled_booking_internal(text,date,text,text,int,int,int,int,boolean,boolean,boolean,text,text,text)",
          "public.submit_payment_reference(uuid,text)",
          "public.cancel_booking(uuid)",
        ];
        for (const fn of signatures) {
          const { rows } = await db.query<{ allowed: boolean }>(
            "select has_function_privilege('authenticated',$1,'execute') allowed",
            [fn],
          );
          assert.equal(rows[0].allowed, false, fn);
        }
        for (const fn of [
          ...signatures,
          "public.request_customer_booking(text,jsonb)",
          "public.reserve_scheduled_booking(text,date,text,text,int,int,int,int,boolean,boolean,boolean,text,text,text)",
        ])
          assert.equal(
            (
              await db.query<{ allowed: boolean }>(
                "select has_function_privilege('anon',$1,'execute') allowed",
                [fn],
              )
            ).rows[0].allowed,
            false,
            fn,
          );
        await assert.rejects(
          () =>
            as(alice, () =>
              db.query("select * from private.booking_request_limits"),
            ),
          /permission denied/,
        );
        await assert.rejects(
          () =>
            as(alice, () =>
              db.query("delete from private.booking_request_limits"),
            ),
          /permission denied/,
        );
        await assert.rejects(
          () =>
            as(alice, () =>
              db.query(
                "select public.create_booking(1,$1,7,1,'Test Player','09171234567')",
                [day],
              ),
            ),
          /permission denied/,
        );
        await assert.rejects(
          () =>
            as(alice, () =>
              db.query(
                "select public.reserve_scheduled_booking('court',$1,'Test Player','09171234567',1,7)",
                [day],
              ),
            ),
          /Staff access/,
        );
        await assert.rejects(
          () =>
            as(alice, () =>
              db.query("update public.bookings set status='cancelled'"),
            ),
          /permission denied/,
        );
        await assert.rejects(
          () =>
            as(
              "",
              () =>
                db.query(
                  "select public.request_customer_booking('cancel',null)",
                ),
              "anon",
            ),
          /permission denied/,
        );
        assert.equal(
          (await request("reserve_court", court(), "")).code,
          "AUTH_REQUIRED",
        );
      },
    );

    await t.test(
      "invalid requests commit their attempts; actions and accounts have independent allowances",
      async () => {
        await reset();
        for (let i = 0; i < 5; i++)
          assert.equal(
            (
              await request(
                "reserve_court",
                i === 0 ? null : { ...court(), booking_date: "bad" },
              )
            ).code,
            i === 0 ? "INVALID_INPUT" : "REQUEST_REJECTED",
          );
        const blocked = await request("reserve_open_play", openPlay());
        assert.equal(blocked.code, "RATE_LIMITED");
        assert.ok(
          blocked.retry_after_seconds! > 590 &&
            blocked.retry_after_seconds! <= 600,
        );
        assert.match(blocked.error!, /try again in 10 minutes/);
        assert.equal(await count(), 5);
        assert.equal(
          (await request("reserve_court", court(), bob)).id?.length,
          36,
        );
        assert.equal(
          (
            await request("payment", {
              booking_id: missing,
              reference: "123456789",
            })
          ).code,
          "REQUEST_REJECTED",
        );
        assert.equal(
          (await request("cancel", { booking_id: missing })).code,
          "REQUEST_REJECTED",
        );
        assert.equal(await count("payment"), 1);
        assert.equal(await count("cancel"), 1);
        assert.equal(
          (await request("not_an_action", court())).code,
          "INVALID_INPUT",
        );
        assert.equal(await count(), 5);
      },
    );

    await t.test(
      "cancellation and switching reservation type do not reset the booking quota",
      async () => {
        await reset();
        for (let i = 0; i < 5; i++) {
          const result = await request(
            i % 2 ? "reserve_open_play" : "reserve_court",
            i % 2 ? openPlay() : court(),
          );
          assert.ok(result.id, result.error);
          assert.deepEqual(await request("cancel", { booking_id: result.id }), {
            success: true,
          });
        }
        assert.equal(
          (await request("reserve_court", court())).code,
          "RATE_LIMITED",
        );
        assert.equal(
          (await request("cancel", { booking_id: missing })).code,
          "RATE_LIMITED",
        );
        assert.equal(
          (
            await db.query<{ total: number }>(
              "select count(*)::int total from public.bookings where status='cancelled'",
            )
          ).rows[0].total,
          5,
        );
      },
    );

    await t.test(
      "the sliding window reopens at expiry and retains newer attempts",
      async () => {
        await reset();
        for (let i = 0; i < 5; i++)
          await request("cancel", { booking_id: missing });
        await db.query(
          "update private.booking_request_limits set attempts=array[clock_timestamp()-interval '11 minutes',clock_timestamp()-interval '9 minutes',clock_timestamp()-interval '8 minutes',clock_timestamp()-interval '7 minutes',clock_timestamp()-interval '6 minutes'] where user_id=$1 and action='cancel'",
          [alice],
        );
        assert.equal(
          (await request("cancel", { booking_id: missing })).code,
          "REQUEST_REJECTED",
        );
        const blocked = await request("cancel", { booking_id: missing });
        assert.equal(blocked.code, "RATE_LIMITED");
        assert.ok(
          blocked.retry_after_seconds! > 50 &&
            blocked.retry_after_seconds! <= 60,
        );
        assert.match(blocked.error!, /in 1 minute\./);
        await db.exec(
          "update private.booking_request_limits set attempts=array[clock_timestamp()-interval '10 minutes']",
        );
        assert.equal(
          (await request("cancel", { booking_id: missing })).code,
          "REQUEST_REJECTED",
        );
        assert.equal(await count("cancel"), 1);
      },
    );

    await t.test(
      "customer prices, equipment, deposit, ownership and the two-pending cap remain authoritative",
      async () => {
        await reset();
        const first = await request("reserve_court", {
          ...court(),
          equipment_rental: true,
          payment_option: "reservation_fee",
          user_id: bob,
          total_amount: 1,
          p_walk_in: true,
          p_blocked: true,
          status: "confirmed",
        });
        assert.ok(first.id, first.error);
        const booking = (
          await db.query<{
            total_amount: number;
            initial_payment_amount: number;
            status: string;
            user_id: string;
          }>("select * from public.bookings where id=$1", [first.id])
        ).rows[0];
        assert.equal(Number(booking.total_amount), 130);
        assert.equal(Number(booking.initial_payment_amount), 65);
        assert.equal(booking.status, "awaiting_payment");
        assert.equal(booking.user_id, alice);
        const conflict = await request("reserve_court", court(), bob);
        assert.match(conflict.error!, /just reserved/);
        assert.equal(await count("reserve", bob), 1);
        assert.equal(
          (
            await db.query<{ total: number }>(
              "select count(*)::int total from public.bookings",
            )
          ).rows[0].total,
          1,
        );
        const second = await request("reserve_court", court(7));
        assert.ok(second.id);
        assert.match(
          (await request("reserve_court", court(8))).error!,
          /two pending/,
        );
        assert.match(
          (
            await request(
              "payment",
              { booking_id: first.id, reference: "123456789" },
              bob,
            )
          ).error!,
          /not found/,
        );
        assert.match(
          (await request("cancel", { booking_id: first.id }, bob)).error!,
          /Only unpaid/,
        );
        assert.deepEqual(
          await request("payment", {
            booking_id: first.id,
            reference: "123456789",
          }),
          { success: true },
        );
        assert.match(
          (
            await request("payment", {
              booking_id: second.id,
              reference: "123456789",
            })
          ).error!,
          /already been submitted/,
        );
        for (let i = 0; i < 3; i++)
          assert.equal(
            (
              await request("payment", {
                booking_id: missing,
                reference: "bad!",
              })
            ).code,
            "REQUEST_REJECTED",
          );
        assert.equal(
          (
            await request("payment", {
              booking_id: second.id,
              reference: "987654321",
            })
          ).code,
          "RATE_LIMITED",
        );
        const states = (
          await db.query<{ status: string }>(
            "select status from public.bookings order by start_hour",
          )
        ).rows;
        assert.deepEqual(
          states.map((b) => b.status),
          ["awaiting_verification", "awaiting_payment"],
        );
        assert.deepEqual(
          (await as(bob, () => db.query("select id from public.bookings")))
            .rows,
          [],
        );
        assert.deepEqual(await request("cancel", { booking_id: second.id }), {
          success: true,
        });
        assert.equal(await count(), 3);
      },
    );

    await t.test(
      "the gateway preserves legacy hours before a custom schedule is saved",
      async () => {
        await reset();
        await db.exec("update public.venue_settings set schedule_config=null");
        const result = await request("reserve_court", court());
        assert.ok(result.id, result.error);
        assert.equal(await count(), 1);
        await db.query("update public.venue_settings set schedule_config=$1", [
          JSON.stringify(schedule),
        ]);
      },
    );

    await t.test(
      "staff walk-ins and public availability keep working after customer limits are exhausted",
      async () => {
        await reset();
        for (let i = 0; i < 5; i++) await request("reserve_court", null, staff);
        assert.equal(
          (await request("reserve_court", court(), staff)).code,
          "RATE_LIMITED",
        );
        const result = await as(staff, () =>
          db.query<{ id: string }>(
            "select public.reserve_scheduled_booking(p_kind=>'court',p_date=>$1,p_name=>'Walk In',p_phone=>'09171234567',p_court=>2,p_start=>6,p_walk_in=>true) id",
            [day],
          ),
        );
        assert.ok(result.rows[0].id);
        assert.equal(
          (
            await db.query<{ status: string }>(
              "select status from public.bookings where id=$1",
              [result.rows[0].id],
            )
          ).rows[0].status,
          "confirmed",
        );
        const availability = await as(
          "",
          () => db.query("select public.get_booking_schedule($1)", [day]),
          "anon",
        );
        assert.equal(availability.rows.length, 1);
        assert.equal(await count("reserve", staff), 5);
      },
    );

    await t.test(
      "repeated queued requests cannot exceed five counted attempts or grow storage",
      async () => {
        await reset();
        // PGlite serializes its connection. This checks the gateway under queued
        // requests; the FOR UPDATE row lock provides cross-connection protection.
        await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
          alice,
        ]);
        await db.exec("set role authenticated");
        let results;
        try {
          results = await Promise.all(
            Array.from({ length: 15 }, () =>
              db.query<{ result: Reply }>(
                "select public.request_customer_booking('payment',null) result",
              ),
            ),
          );
        } finally {
          await db.exec("reset role");
        }
        assert.equal(
          results.filter((r) => r.rows[0].result.code === "INVALID_INPUT")
            .length,
          5,
        );
        assert.equal(
          results.filter((r) => r.rows[0].result.code === "RATE_LIMITED")
            .length,
          10,
        );
        assert.equal(await count("payment"), 5);
        assert.equal(
          (
            await db.query<{ total: number }>(
              "select count(*)::int total from private.booking_request_limits",
            )
          ).rows[0].total,
          1,
        );
      },
    );
  } finally {
    await db.close();
  }
});
