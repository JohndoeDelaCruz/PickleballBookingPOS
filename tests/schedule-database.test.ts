import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

test("schedule migration, session limits, snapshots, and staff-only editing", async () => {
  const db = new PGlite({ extensions: { btree_gist } });
  const staff = "00000000-0000-4000-a000-000000000001";
  const player = "00000000-0000-4000-a000-000000000002";
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
      insert into auth.users values('${staff}','staff@example.com'),('${player}','player@example.com');
      alter default privileges grant execute on functions to anon,authenticated;`);
    for (const file of (await readdir("supabase/migrations"))
      .filter((f) => f.endsWith(".sql") && f < "202611040013")
      .sort()) {
      await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
    }
    await db.query("insert into public.staff_members values($1)", [staff]);
    await db.exec(
      "update public.venue_settings set booking_enabled=true,gcash_name='Rally',gcash_qr_url='https://example.com/qr.png'",
    );
    const day = (
      await db.query<{ day: string }>(
        "select ((now() at time zone 'Asia/Manila')::date+1)::text as day",
      )
    ).rows[0].day;
    const days = [1, 2, 3, 4, 5, 6, 7];
    const weekly = [
      {
        id: "early",
        days,
        kind: "court",
        start: 6,
        end: 8,
        rate: 100,
        capacity: 8,
      },
      {
        id: "day",
        days,
        kind: "open_play",
        start: 8,
        end: 17,
        rate: 50,
        capacity: 24,
      },
      {
        id: "evening",
        days,
        kind: "open_play",
        start: 17,
        end: 22,
        rate: 100,
        capacity: 24,
      },
    ];
    let saved: unknown = null;
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
    async function save(config: unknown, user = staff) {
      await as(user, () =>
        db.query("select public.save_booking_schedule($1,$2)", [
          JSON.stringify(config),
          saved === null ? null : JSON.stringify(saved),
        ]),
      );
      saved = structuredClone(config);
    }
    const config = { weekly, overrides: [] as unknown[] };
    await assert.rejects(() => save(config, player), /Staff access/);
    await save(config);
    const reserve = (
      start: number,
      people: number,
      rental = false,
      kind = "open_play",
      duration = 1,
    ) =>
      as(
        staff,
        async () =>
          (
            await db.query<{ id: string }>(
              `select public.reserve_scheduled_booking(p_kind=>$1,p_date=>$2,p_name=>'Test Player',p_phone=>'09171234567',
        p_start=>$3,p_people=>$4,p_walk_in=>true,p_rental=>$5,p_court=>1,p_duration=>$6,p_payment_option=>'reservation_fee') as id`,
              [kind, day, start, people, rental, duration],
            )
          ).rows[0].id,
      );
    const first = await reserve(8, 20, true);
    await reserve(8, 4);
    await assert.rejects(() => reserve(8, 1), /not enough open-play places/);
    await reserve(17, 20);
    const sessions = await as(
      "",
      () =>
        db.query<{ players: number; remaining: number }>(
          "select * from public.get_open_play_sessions($1)",
          [day],
        ),
      "anon",
    );
    assert.deepEqual(
      sessions.rows.map((s) => [s.players, s.remaining]),
      [
        [24, 0],
        [20, 4],
      ],
    );
    const before = (
      await db.query<{
        total_amount: number;
        paid_amount: number;
        equipment_amount: number;
        equipment_ball_count: number;
        payment_option: string;
      }>(
        "select total_amount,paid_amount,equipment_amount,equipment_ball_count,payment_option from public.bookings where id=$1",
        [first],
      )
    ).rows[0];
    assert.equal(Number(before.total_amount), 1030);
    assert.equal(Number(before.paid_amount), 515);
    assert.equal(before.equipment_ball_count, 1);
    await assert.rejects(
      () => reserve(9, 1, false, "court"),
      /private-booking time/,
    );
    await assert.rejects(
      () => reserve(7, 1, false, "court", 2),
      /private-booking time/,
    );
    const updated = structuredClone(config);
    updated.weekly[1].rate = 70;
    await save(updated);
    assert.deepEqual(
      (
        await db.query(
          "select total_amount,paid_amount,equipment_amount,equipment_ball_count,payment_option from public.bookings where id=$1",
          [first],
        )
      ).rows[0],
      before,
    );
    const changed = structuredClone(updated);
    changed.weekly[1].start = 9;
    await assert.rejects(
      () => save(changed),
      /conflicts with open-play reservation/,
    );
    const smaller = structuredClone(updated);
    smaller.weekly[1].capacity = 23;
    await assert.rejects(() => save(smaller), /player limit is lower/);
    const overlap = structuredClone(updated);
    overlap.weekly[0].end = 9;
    await assert.rejects(() => save(overlap), /overlap/);
    const temporary = structuredClone(updated);
    const nextDay = (
      await db.query<{ day: string }>("select ($1::date+1)::text as day", [day])
    ).rows[0].day;
    temporary.overrides = [
      {
        id: "intro",
        name: "Introductory schedule",
        start_date: nextDay,
        end_date: nextDay,
        blocks: [
          {
            id: "temporary",
            days,
            kind: "open_play",
            start: 9,
            end: 22,
            rate: 100,
            capacity: 24,
          },
        ],
      },
    ];
    await save(temporary);
    const resolver = async (date: string) =>
      (
        await as(
          "",
          () =>
            db.query<{
              config: { blocks: { start: number }[]; override: unknown };
            }>("select public.get_booking_schedule($1) as config", [date]),
          "anon",
        )
      ).rows[0].config;
    assert.equal((await resolver(nextDay)).blocks.length, 1);
    assert.ok((await resolver(nextDay)).override);
    const afterDay = (
      await db.query<{ day: string }>("select ($1::date+1)::text as day", [
        nextDay,
      ])
    ).rows[0].day;
    assert.equal((await resolver(afterDay)).blocks.length, 3);
    assert.equal((await resolver(afterDay)).override, null);
    const privateDate = (
      await db.query<{ day: string }>("select ($1::date+2)::text as day", [
        nextDay,
      ])
    ).rows[0].day;
    const custom = structuredClone(temporary);
    custom.weekly[0].rate = 175.5;
    await save(custom);
    const customerBooking = await as(
      player,
      async () =>
        (
          await db.query<{ id: string }>(
            `select (public.request_customer_booking('reserve_court',jsonb_build_object(
        'booking_date',$1::text,'customer_name','Private Player','customer_phone','09171234567',
        'court_id',2,'start_hour',6,'duration',2,'equipment_rental',true,'payment_option','reservation_fee'))->>'id')::uuid id`,
            [privateDate],
          )
        ).rows[0].id,
    );
    const quote = (
      await db.query<{
        total_amount: number;
        initial_payment_amount: number;
        paid_amount: number;
      }>(
        "select total_amount,initial_payment_amount,paid_amount from public.bookings where id=$1",
        [customerBooking],
      )
    ).rows[0];
    assert.equal(Number(quote.total_amount), 381);
    assert.equal(Number(quote.initial_payment_amount), 190.5);
    assert.equal(Number(quote.paid_amount), 0);
    const rejected = await as(player, () =>
      db.query<{ error: string }>(
        `select public.request_customer_booking('reserve_court',jsonb_build_object(
        'booking_date',$1::text,'customer_name','Private Player','customer_phone','09171234567',
        'court_id',1,'start_hour',7,'duration',2))->>'error' error`,
        [privateDate],
      ),
    );
    assert.match(rejected.rows[0].error, /private-booking time/);
    const invalidDays = structuredClone(custom) as unknown as {
      weekly: { days: unknown[] }[];
    };
    invalidDays.weekly[0].days = ["1"];
    await assert.rejects(() => save(invalidDays), /valid weekdays/);
    const removal = structuredClone(custom);
    removal.weekly[0].start = 7;
    await assert.rejects(() => save(removal), /conflicts with reservation/);
    const closed = structuredClone(custom);
    closed.overrides.push({
      id: "closed",
      name: "Closed day",
      start_date: afterDay,
      end_date: afterDay,
      blocks: [],
    });
    await save(closed);
    assert.deepEqual((await resolver(afterDay)).blocks, []);
    await assert.rejects(
      () =>
        as(staff, () =>
          db.query("select public.save_booking_schedule($1,null)", [
            JSON.stringify(config),
          ]),
        ),
      /Another staff member/,
    );
    for (const fn of [
      "public.save_booking_schedule(jsonb,jsonb)",
      "public.reserve_scheduled_booking(text,date,text,text,int,int,int,int,boolean,boolean,boolean,text,text,text)",
      "public.resolve_schedule_blocks(jsonb,date)",
    ])
      assert.equal(
        (
          await db.query<{ allowed: boolean }>(
            "select has_function_privilege('anon',$1,'execute') allowed",
            [fn],
          )
        ).rows[0].allowed,
        false,
      );
  } finally {
    await db.close();
  }
});
