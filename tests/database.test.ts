import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

test("Postgres migration, booking lifecycle, and access controls", async (t) => {
  const db = new PGlite({ extensions: { btree_gist } });
  const alice = "00000000-0000-4000-a000-000000000001";
  const bob = "00000000-0000-4000-a000-000000000002";
  const staff = "00000000-0000-4000-a000-000000000003";
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth; create schema storage; create schema extensions;
      set search_path = public,extensions;
      grant usage on schema public,auth,storage to anon,authenticated;
      create table auth.users(id uuid primary key,email text);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid; $$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
      alter table storage.objects enable row level security;
      grant select,insert,update on storage.objects to anon,authenticated;
      insert into auth.users values ('${alice}','alice@example.com'),('${bob}','bob@example.com'),('${staff}','staff@example.com');
    `);
    await db.exec(
      await readFile(
        resolve("supabase/migrations/202610230001_initial.sql"),
        "utf8",
      ),
    );
    await db.exec(
      "insert into public.bookings (reference,court_id,booking_date,start_hour,duration,total_amount,status,customer_name,customer_phone) values ('AP-LEGACY',1,current_date+1,10,1,999,'cancelled','Existing Player','09171234567')",
    );
    await db.exec(
      await readFile(
        resolve("supabase/migrations/202610230002_time_based_rates.sql"),
        "utf8",
      ),
    );
    await db.exec(
      "insert into public.bookings (reference,court_id,booking_date,start_hour,duration,total_amount,status,customer_name,customer_phone) values ('AP-OLD-EVENING',2,current_date+1,16,1,150,'cancelled','Existing Evening Player','09171234567')",
    );
    await db.exec(
      await readFile(
        resolve("supabase/migrations/202610230003_evening_rate_200.sql"),
        "utf8",
      ),
    );
    await db.query("insert into public.staff_members(user_id) values ($1)", [
      staff,
    ]);
    await db.exec(
      await readFile(
        resolve("supabase/migrations/202610230004_weekend_open_play.sql"),
        "utf8",
      ),
    );
    await db.exec(
      await readFile(
        resolve("supabase/migrations/202610230005_finance.sql"),
        "utf8",
      ),
    );
    await db.exec(
      await readFile(
        resolve("supabase/migrations/202610230006_equipment_rental.sql"),
        "utf8",
      ),
    );
    await db.exec(
      "insert into public.bookings(reference,court_id,booking_date,start_hour,duration,total_amount,status,customer_name,customer_phone) values ('AP-OLD-PAID',1,current_date+1,6,1,175.25,'confirmed','Legacy Paid Player','09171234567')",
    );
    // Supabase projects may explicitly grant new functions to anon by default.
    await db.exec(
      "alter default privileges grant execute on functions to anon,authenticated",
    );
    await db.exec(
      await readFile(
        resolve("supabase/migrations/202610240007_payment_options.sql"),
        "utf8",
      ),
    );
    await db.exec(
      await readFile(
        resolve("supabase/migrations/202610240008_open_play_capacity.sql"),
        "utf8",
      ),
    );
    await db.exec(
      "update public.bookings set equipment_rental=true,equipment_amount=30 where reference='AP-OLD-PAID'",
    );
    await db.exec(
      await readFile(
        resolve("supabase/migrations/202610260009_venue_rules.sql"),
        "utf8",
      ),
    );
    await db.exec(await readFile(resolve("supabase/migrations/202610260010_schedule_editor.sql"), "utf8"));
    for (const fn of [
      "public.snapshot_equipment_inclusions()",
      "public.staff_record_balance(uuid,text,text)",
      "public.get_finance_month(date)",
      "public.reserve_with_payment(text,date,text,text,int,int,int,int,boolean,boolean,boolean,text,text,text)",
    ]) {
      assert.equal(
        (
          await db.query<{ allowed: boolean }>(
            "select has_function_privilege('anon',$1,'execute') as allowed",
            [fn],
          )
        ).rows[0].allowed,
        false,
      );
    }
    const legacyPaid = (
      await db.query<{
        payment_option: string;
        initial_payment_amount: string;
        paid_amount: string;
        equipment_ball_count: number;
      }>("select * from public.bookings where reference='AP-OLD-PAID'")
    ).rows[0];
    assert.equal(legacyPaid.payment_option, "full");
    assert.equal(Number(legacyPaid.initial_payment_amount), 175.25);
    assert.equal(Number(legacyPaid.paid_amount), 175.25);
    assert.equal(legacyPaid.equipment_ball_count, 2);

    async function asUser<T>(
      id: string,
      fn: () => Promise<T>,
      role: "authenticated" | "anon" = "authenticated",
    ) {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        id,
      ]);
      await db.exec(`set role ${role}`);
      try {
        return await fn();
      } finally {
        await db.exec("reset role");
      }
    }
    async function reset() {
      await db.exec(
        "truncate public.bookings,public.booking_finance,public.finance_day_notes; update public.venue_settings set open_play_enabled=false,open_play_start_hour=9,open_play_end_hour=16,weekend_court_end_hour=9,open_play_price=50,open_play_capacity=null,hourly_rate=100,evening_hourly_rate=200,evening_start_hour=16,equipment_rental_price=30,equipment_ball_count=1,private_court_capacity=8,opening_hour=6,closing_hour=22,gcash_name='Rally',gcash_qr_url='https://example.com/qr.png',booking_enabled=true;",
      );
    }
    async function reserve(user: string, court = 1, start = 10, duration = 1) {
      return asUser(user, async () => {
        const result = await db.query<{ id: string }>(
          "select public.create_booking($1,((now() at time zone 'Asia/Manila')::date+1),$2,$3,'Test Player','09171234567') as id",
          [court, start, duration],
        );
        return result.rows[0].id;
      });
    }
    await t.test(
      "confirmed rates are configured while reservations stay closed; migration preserves existing totals",
      async () => {
        const { rows } = await db.query<{
          booking_enabled: boolean;
          hourly_rate: string;
          opening_hour: number;
          evening_hourly_rate: string;
          equipment_rental_price: string;
        }>("select * from public.venue_settings");
        assert.equal(rows[0].booking_enabled, false);
        assert.equal(Number(rows[0].hourly_rate), 100);
        assert.equal(rows[0].opening_hour, 6);
        assert.equal(Number(rows[0].evening_hourly_rate), 200);
        assert.equal(Number(rows[0].equipment_rental_price), 30);
        assert.equal(
          Number(
            (
              await db.query<{ total_amount: string }>(
                "select total_amount from public.bookings where reference='AP-LEGACY'",
              )
            ).rows[0].total_amount,
          ),
          999,
        );
        assert.equal(
          Number(
            (
              await db.query<{ total_amount: string }>(
                "select total_amount from public.bookings where reference='AP-OLD-EVENING'",
              )
            ).rows[0].total_amount,
          ),
          150,
        );
        await assert.rejects(() => reserve(alice), /not open/);
      },
    );
    await t.test(
      "database constraints reject overlaps, permit adjacency and separate courts, and calculate price",
      async () => {
        await reset();
        const id = await reserve(alice, 1, 10, 2);
        await assert.rejects(
          () => reserve(bob, 1, 11),
          /conflicting key value violates exclusion/,
        );
        await reserve(bob, 2, 10);
        await reserve(bob, 1, 12);
        const { rows } = await db.query<{ total_amount: string }>(
          "select total_amount from public.bookings where id=$1",
          [id],
        );
        assert.equal(Number(rows[0].total_amount), 200);
      },
    );
    await t.test(
      "database quotes and both booking paths split at 4 PM without adding equipment charges",
      async () => {
        await reset();
        await asUser(alice, async () => {
          for (const [start, duration, expected] of [
            [6, 1, 100],
            [15, 1, 100],
            [16, 1, 200],
            [21, 1, 200],
            [15, 2, 300],
            [14, 4, 600],
          ]) {
            const { rows } = await db.query<{ total: string }>(
              "select public.quote_court_total($1,$2) as total",
              [start, duration],
            );
            assert.equal(Number(rows[0].total), expected);
          }
          await assert.rejects(
            () => db.query("select public.quote_court_total(22,1)"),
            /within opening hours/,
          );
        });
        const onlineId = await reserve(alice, 1, 15, 2);
        const walkIn = await asUser(staff, () =>
          db.query<{ id: string }>(
            "select public.staff_create_booking(2,(now() at time zone 'Asia/Manila')::date+1,15,2,'Walk-in Player','09171234567',false) as id",
          ),
        );
        for (const id of [onlineId, walkIn.rows[0].id])
          assert.equal(
            Number(
              (
                await db.query<{ total_amount: string }>(
                  "select total_amount from public.bookings where id=$1",
                  [id],
                )
              ).rows[0].total_amount,
            ),
            300,
          );
        await db.exec(
          "update public.venue_settings set hourly_rate=120,evening_hourly_rate=180,evening_start_hour=17,equipment_rental_price=999",
        );
        assert.equal(
          Number(
            (
              await db.query<{ total: string }>(
                "select public.quote_court_total(16,2) as total",
              )
            ).rows[0].total,
          ),
          300,
        );
        assert.equal(
          Number(
            (
              await db.query<{ total_amount: string }>(
                "select total_amount from public.bookings where id=$1",
                [onlineId],
              )
            ).rows[0].total_amount,
          ),
          300,
        );
      },
    );
    await t.test(
      "database rejects invalid evening rates and time boundaries",
      async () => {
        await reset();
        await asUser(staff, async () => {
          for (const update of [
            "evening_hourly_rate=-1",
            "evening_start_hour=6",
            "evening_start_hour=22",
            "equipment_rental_price=-1",
          ])
            await assert.rejects(
              () => db.exec(`update public.venue_settings set ${update}`),
              /check constraint/,
            );
        });
      },
    );
    await t.test(
      "anonymous visitors see availability without player details; players see only their own bookings",
      async () => {
        await reset();
        await reserve(alice);
        await asUser(
          "",
          async () => {
            await assert.rejects(
              () => db.query("select * from public.bookings"),
              /permission denied/,
            );
            const { rows } = await db.query<Record<string, unknown>>(
              "select * from public.get_availability((now() at time zone 'Asia/Manila')::date+1)",
            );
            assert.equal(rows.length, 1);
            assert.deepEqual(Object.keys(rows[0]).sort(), [
              "court_id",
              "duration",
              "start_hour",
              "status",
            ]);
          },
          "anon",
        );
        await asUser(bob, async () =>
          assert.equal(
            (await db.query("select * from public.bookings")).rows.length,
            0,
          ),
        );
        await asUser(staff, async () =>
          assert.equal(
            (await db.query("select * from public.bookings")).rows.length,
            1,
          ),
        );
      },
    );
    await t.test(
      "players cannot edit settings, assign themselves staff, insert bookings directly, or confirm payments",
      async () => {
        await reset();
        const id = await reserve(alice);
        await asUser(alice, async () => {
          await assert.rejects(
            () =>
              db.query("insert into public.staff_members values ($1)", [alice]),
            /permission denied/,
          );
          assert.equal(
            (
              await db.query(
                "update public.venue_settings set hourly_rate=1 returning *",
              )
            ).rows.length,
            0,
          );
          await assert.rejects(
            () => db.query("update public.bookings set status='confirmed'"),
            /permission denied/,
          );
          await assert.rejects(
            () =>
              db.query("select public.staff_update_booking($1,'confirmed')", [
                id,
              ]),
            /Staff access/,
          );
        });
        await asUser(staff, async () =>
          assert.equal(
            (
              await db.query(
                "update public.venue_settings set city='Test city' returning city",
              )
            ).rows.length,
            1,
          ),
        );
      },
    );
    await t.test(
      "expired unpaid holds release the slot and reject late payment references",
      async () => {
        await reset();
        const id = await reserve(alice);
        await db.query(
          "update public.bookings set hold_expires_at=now()-interval '1 minute' where id=$1",
          [id],
        );
        await asUser(
          alice,
          async () =>
            await assert.rejects(
              () =>
                db.query(
                  "select public.submit_payment_reference($1,'1234567890123')",
                  [id],
                ),
              /hold expired/,
            ),
        );
        await reserve(bob);
        assert.equal(
          (
            await db.query<{ status: string }>(
              "select status from public.bookings where id=$1",
              [id],
            )
          ).rows[0].status,
          "expired",
        );
      },
    );
    await t.test(
      "payment references are owner-only, unique, stay held for review, and need staff confirmation",
      async () => {
        await reset();
        const id = await reserve(alice);
        const second = await reserve(bob, 2);
        await asUser(
          bob,
          async () =>
            await assert.rejects(
              () =>
                db.query(
                  "select public.submit_payment_reference($1,'1234567890123')",
                  [id],
                ),
              /not found/,
            ),
        );
        await asUser(alice, async () => {
          await db.query(
            "select public.submit_payment_reference($1,'1234567890123')",
            [id],
          );
        });
        await asUser(
          bob,
          async () =>
            await assert.rejects(
              () =>
                db.query(
                  "select public.submit_payment_reference($1,'1234567890123')",
                  [second],
                ),
              /already been submitted/,
            ),
        );
        await db.query(
          "update public.bookings set hold_expires_at=now()-interval '1 hour' where id=$1",
          [id],
        );
        await db.exec("select public.expire_unpaid_holds()");
        assert.equal(
          (
            await db.query<{ status: string }>(
              "select status from public.bookings where id=$1",
              [id],
            )
          ).rows[0].status,
          "awaiting_verification",
        );
        await asUser(
          alice,
          async () =>
            await assert.rejects(
              () => db.query("select public.cancel_booking($1)", [id]),
              /Only unpaid/,
            ),
        );
        await asUser(staff, async () => {
          await db.query("select public.staff_update_booking($1,'confirmed')", [
            id,
          ]);
        });
        assert.equal(
          (
            await db.query<{ status: string }>(
              "select status from public.bookings where id=$1",
              [id],
            )
          ).rows[0].status,
          "confirmed",
        );
      },
    );
    await t.test(
      "pending holds are limited; null, past, outside-hours, and far-future inputs are rejected",
      async () => {
        await reset();
        await reserve(alice, 1, 10);
        await reserve(alice, 1, 11);
        await assert.rejects(() => reserve(alice, 2, 12), /two pending/);
        await assert.rejects(() => reserve(bob, 1, 23), /within opening hours/);
        await asUser(bob, async () => {
          await assert.rejects(
            () =>
              db.query(
                "select public.create_booking(1,current_date-1,10,1,'Test','09171234567')",
              ),
            /future time/,
          );
          await assert.rejects(
            () =>
              db.query(
                "select public.create_booking(1,current_date+90,10,1,'Test','09171234567')",
              ),
            /future time/,
          );
          await assert.rejects(
            () =>
              db.query(
                "select public.create_booking(null,current_date+1,10,1,'Test','09171234567')",
              ),
            /valid court/,
          );
          await assert.rejects(
            () =>
              db.query(
                "select public.create_booking(1,current_date+1,10,null,'Test','09171234567')",
              ),
            /valid court/,
          );
        });
      },
    );
    await t.test(
      "staff blocks and walk-ins use the same database overlap protection",
      async () => {
        await reset();
        const result = await asUser(staff, () =>
          db.query<{ id: string }>(
            "select public.staff_create_booking(1,(now() at time zone 'Asia/Manila')::date+1,10,2,'Maintenance','',true) as id",
          ),
        );
        await assert.rejects(
          () => reserve(alice, 1, 11),
          /conflicting key value/,
        );
        await asUser(staff, () =>
          db.query("select public.staff_update_booking($1,'cancelled')", [
            result.rows[0].id,
          ]),
        );
        await reserve(alice, 1, 10);
        await asUser(staff, () =>
          db.query(
            "select public.staff_create_booking(2,(now() at time zone 'Asia/Manila')::date+1,10,1,'Walk-in Player','09171234567',false)",
          ),
        );
        await assert.rejects(
          () => reserve(bob, 2, 10),
          /conflicting key value/,
        );
      },
    );
    const weekend = (
      await db.query<{ day: string }>(
        "select (((now() at time zone 'Asia/Manila')::date+1) + ((6-extract(isodow from ((now() at time zone 'Asia/Manila')::date+1))::int+7)%7))::text as day",
      )
    ).rows[0].day;
    async function startOpenPlay(capacity: number | null = null) {
      await reset();
      await db.query(
        "update public.venue_settings set open_play_enabled=true,open_play_capacity=$1",
        [capacity],
      );
    }
    async function openPass(
      user: string,
      people = 1,
      day = weekend,
      walkIn = false,
    ) {
      return asUser(
        user,
        async () =>
          (
            await db.query<{ id: string }>(
              "select public.create_open_play_booking($1,$2,'Open Player','09171234567',$3) as id",
              [day, people, walkIn],
            )
          ).rows[0].id,
      );
    }
    async function openAvailability(day = weekend) {
      return asUser(
        "",
        async () =>
          (
            await db.query<{
              enabled: boolean;
              price: string;
              capacity: number | null;
              players: number;
              remaining: number | null;
              conflict: boolean;
            }>("select * from public.get_open_play_availability($1)", [day])
          ).rows[0],
        "anon",
      );
    }
    async function courtOnWeekend(user: string, start: number, duration = 1) {
      return asUser(
        user,
        async () =>
          (
            await db.query<{ id: string }>(
              "select public.create_booking(1,$1,$2,$3,'Court Player','09171234567') as id",
              [weekend, start, duration],
            )
          ).rows[0].id,
      );
    }
    await t.test(
      "open play allows 24 participants across both courts and rejects a 25th pass",
      async () => {
        await reset();
        await db.exec(
          "update public.venue_settings set open_play_enabled=true",
        );
        await db.exec(
          await readFile(
            resolve("supabase/migrations/202610240008_open_play_capacity.sql"),
            "utf8",
          ),
        );
        assert.equal((await openAvailability()).capacity, 24);
        await openPass(alice, 20);
        assert.equal((await openAvailability()).remaining, 4);
        await openPass(bob, 4);
        assert.equal((await openAvailability()).remaining, 0);
        await assert.rejects(
          () => openPass(alice),
          /not enough open-play places/,
        );
        await assert.rejects(
          () => openPass(staff, 1, weekend, true),
          /not enough open-play places/,
        );
      },
    );
    await t.test(
      "weekends reserve both courts for open play while morning and evening bookings remain available",
      async () => {
        await startOpenPlay();
        await courtOnWeekend(alice, 8);
        await courtOnWeekend(bob, 16);
        await assert.rejects(
          () => courtOnWeekend(alice, 8, 2),
          /reserved for open play/,
        );
        await assert.rejects(
          () => courtOnWeekend(alice, 9),
          /reserved for open play/,
        );
        await assert.rejects(
          () => courtOnWeekend(alice, 15, 2),
          /reserved for open play/,
        );
        await assert.rejects(
          () =>
            asUser(staff, () =>
              db.query(
                "select public.staff_create_booking(2,$1,10,1,'Walk-in','09171234567',false)",
                [weekend],
              ),
            ),
          /reserved for open play/,
        );
        await db.exec(
          "update public.venue_settings set weekend_court_end_hour=8",
        );
        await assert.rejects(
          () =>
            asUser(bob, () =>
              db.query(
                "select public.create_booking(2,$1,8,1,'Player','09171234567')",
                [weekend],
              ),
            ),
          /reserved for open play/,
        );
      },
    );
    await t.test(
      "open-play group passes share the session, charge per person, and expose only aggregate availability",
      async () => {
        await startOpenPlay();
        const id = await openPass(alice, 3);
        await openPass(bob, 4);
        const row = (
          await db.query<{
            booking_type: string;
            court_id: number | null;
            participant_count: number;
            start_hour: number;
            duration: number;
            total_amount: string;
            status: string;
          }>("select * from public.bookings where id=$1", [id])
        ).rows[0];
        assert.equal(row.booking_type, "open_play");
        assert.equal(row.court_id, null);
        assert.equal(row.participant_count, 3);
        assert.equal(row.start_hour, 9);
        assert.equal(row.duration, 7);
        assert.equal(Number(row.total_amount), 150);
        assert.equal(row.status, "awaiting_payment");
        const available = await openAvailability();
        assert.equal(available.enabled, true);
        assert.equal(available.capacity, null);
        assert.equal(available.remaining, null);
        assert.equal(available.players, 7);
        assert.equal(available.conflict, false);
        assert.equal("customer_name" in available, false);
        assert.equal("payment_reference" in available, false);
        assert.equal(
          (
            await asUser(bob, () =>
              db.query("select id from public.bookings where id=$1", [id]),
            )
          ).rows.length,
          0,
        );
        await db.exec("update public.venue_settings set open_play_price=60");
        assert.equal(
          Number(
            (
              await db.query<{ total_amount: string }>(
                "select total_amount from public.bookings where id=$1",
                [id],
              )
            ).rows[0].total_amount,
          ),
          150,
        );
        const later = await openPass(alice, 2);
        assert.equal(
          Number(
            (
              await db.query<{ total_amount: string }>(
                "select total_amount from public.bookings where id=$1",
                [later],
              )
            ).rows[0].total_amount,
          ),
          120,
        );
      },
    );
    await t.test(
      "open-play caps count people, reject overselling, and release cancelled or expired holds",
      async () => {
        await startOpenPlay(5);
        const first = await openPass(alice, 3);
        const second = await openPass(bob, 2);
        await assert.rejects(
          () => openPass(alice),
          /not enough open-play places/,
        );
        assert.equal((await openAvailability()).remaining, 0);
        await assert.rejects(
          () =>
            db.exec("update public.venue_settings set open_play_capacity=4"),
          /lower than the passes/,
        );
        await assert.rejects(
          () =>
            db.exec("update public.venue_settings set open_play_start_hour=10"),
          /Existing open-play passes/,
        );
        await assert.rejects(
          () =>
            db.exec("update public.venue_settings set open_play_enabled=false"),
          /Existing open-play passes/,
        );
        await asUser(alice, () =>
          db.query("select public.cancel_booking($1)", [first]),
        );
        assert.equal((await openAvailability()).remaining, 3);
        await openPass(alice, 3);
        await db.query(
          "update public.bookings set hold_expires_at=now()-interval '1 minute' where id=$1",
          [second],
        );
        assert.equal((await openAvailability()).remaining, 2);
        assert.equal(
          (
            await db.query<{ status: string }>(
              "select status from public.bookings where id=$1",
              [second],
            )
          ).rows[0].status,
          "expired",
        );
        await openPass(bob, 2);
        await assert.rejects(
          () => openPass(staff, 1, weekend, true),
          /not enough open-play places/,
        );
      },
    );
    await t.test(
      "maintenance blocks and existing private reservations cannot overlap active open-play passes",
      async () => {
        await startOpenPlay();
        const block = await asUser(
          staff,
          async () =>
            (
              await db.query<{ id: string }>(
                "select public.staff_create_booking(1,$1,10,1,'Maintenance','',true) as id",
                [weekend],
              )
            ).rows[0].id,
        );
        assert.equal((await openAvailability()).conflict, true);
        await assert.rejects(
          () => openPass(alice),
          /court is reserved or blocked/,
        );
        await asUser(staff, () =>
          db.query("select public.staff_update_booking($1,'cancelled')", [
            block,
          ]),
        );
        await openPass(alice);
        await assert.rejects(
          () =>
            asUser(staff, () =>
              db.query(
                "select public.staff_create_booking(2,$1,10,1,'Maintenance','',true)",
                [weekend],
              ),
            ),
          /Cancel the open-play passes/,
        );
        await reset();
        const legacy = await courtOnWeekend(alice, 10);
        await db.exec(
          "update public.venue_settings set open_play_enabled=true",
        );
        await assert.rejects(
          () => openPass(bob),
          /court is reserved or blocked/,
        );
        assert.equal(
          (
            await db.query<{ status: string }>(
              "select status from public.bookings where id=$1",
              [legacy],
            )
          ).rows[0].status,
          "awaiting_payment",
        );
      },
    );
    await t.test(
      "open-play passes use owner-only payments, shared GCash reference uniqueness, and staff confirmation",
      async () => {
        await startOpenPlay();
        const pass = await openPass(alice, 2);
        const court = await courtOnWeekend(bob, 8);
        await assert.rejects(
          () =>
            asUser(bob, () =>
              db.query(
                "select public.submit_payment_reference($1,'OPEN123456')",
                [pass],
              ),
            ),
          /not found/,
        );
        await asUser(alice, () =>
          db.query("select public.submit_payment_reference($1,'OPEN123456')", [
            pass,
          ]),
        );
        await assert.rejects(
          () =>
            asUser(bob, () =>
              db.query(
                "select public.submit_payment_reference($1,'OPEN123456')",
                [court],
              ),
            ),
          /already been submitted/,
        );
        await asUser(staff, () =>
          db.query("select public.staff_update_booking($1,'confirmed')", [
            pass,
          ]),
        );
        assert.equal(
          (
            await db.query<{ status: string }>(
              "select status from public.bookings where id=$1",
              [pass],
            )
          ).rows[0].status,
          "confirmed",
        );
        await assert.rejects(
          () => openPass(alice, 1, weekend, true),
          /Staff access/,
        );
        const walkin = await openPass(staff, 2, weekend, true);
        const record = (
          await db.query<{
            status: string;
            user_id: string | null;
            total_amount: string;
            hold_expires_at: string | null;
          }>("select * from public.bookings where id=$1", [walkin])
        ).rows[0];
        assert.equal(record.status, "confirmed");
        assert.equal(record.user_id, null);
        assert.equal(record.hold_expires_at, null);
        assert.equal(Number(record.total_amount), 100);
      },
    );
    await t.test(
      "open play rejects weekdays, invalid groups, closed booking, and excessive pending holds",
      async () => {
        await startOpenPlay();
        const monday = (
          await db.query<{ day: string }>("select ($1::date+2)::text as day", [
            weekend,
          ])
        ).rows[0].day;
        await assert.rejects(
          () => openPass(alice, 1, monday),
          /Saturday or Sunday/,
        );
        for (const people of [0, 21])
          await assert.rejects(
            () => openPass(alice, people),
            /between 1 and 20/,
          );
        await openPass(alice);
        await openPass(alice);
        await assert.rejects(() => openPass(alice), /two pending reservations/);
        await db.exec("update public.venue_settings set booking_enabled=false");
        await assert.rejects(() => openPass(bob), /not open yet/);
        await assert.rejects(
          () =>
            asUser(bob, () =>
              db.query(
                "select public.create_open_play_booking($1,1,'Player','09171234567',null)",
                [weekend],
              ),
            ),
          /valid reservation type/,
        );
        await asUser(
          "",
          () =>
            assert.rejects(
              () =>
                db.query(
                  "select public.create_open_play_booking($1,1,'Player','09171234567',false)",
                  [weekend],
                ),
              /permission denied/,
            ),
          "anon",
        );
      },
    );
    async function financeWalkin(
      kind = "court",
      court = 1,
      hour = 8,
      method = "cash",
      people = 1,
    ) {
      return asUser(
        staff,
        async () =>
          (
            await db.query<{ id: string }>(
              "select public.staff_record_booking($1,$2,'Paid Walk-in','09171234567',$3,$4,1,$5,false,$6,'Receipt checked') as id",
              [kind, weekend, court, hour, people, method],
            )
          ).rows[0].id,
      );
    }
    await t.test(
      "finance totals reconcile saved court and open-play sales without counting pending, cancelled, expired, or other months",
      async () => {
        await startOpenPlay();
        const month = weekend.slice(0, 7) + "-01";
        await financeWalkin();
        await financeWalkin("court", 2, 16, "gcash");
        await financeWalkin("open_play", 1, 9, "cash", 3);
        const online = await openPass(alice, 2);
        await asUser(alice, () =>
          db.query(
            "select public.submit_payment_reference($1,'FINANCE123456')",
            [online],
          ),
        );
        await asUser(staff, () =>
          db.query("select public.staff_update_booking($1,'confirmed')", [
            online,
          ]),
        );
        await courtOnWeekend(bob, 7);
        const expired = await courtOnWeekend(bob, 6);
        await db.query(
          "update public.bookings set hold_expires_at=now()-interval '1 minute' where id=$1",
          [expired],
        );
        await asUser(staff, () =>
          db.query(
            "select public.staff_create_booking(2,$1,8,1,'Old Walk-in','09171234567',false)",
            [weekend],
          ),
        );
        const cancelled = await financeWalkin("court", 2, 7, "card");
        await asUser(staff, () =>
          db.query("select public.staff_update_booking($1,'cancelled')", [
            cancelled,
          ]),
        );
        await db.query(
          "insert into public.bookings(court_id,booking_date,start_hour,duration,total_amount,status,customer_name,customer_phone) values (1,$1::date-1,6,1,999,'confirmed','Prior month','09171234567'),(1,($1::date+interval '1 month')::date,6,1,888,'confirmed','Next month','09171234567')",
          [month],
        );
        await db.exec(
          "update public.venue_settings set hourly_rate=700,evening_hourly_rate=900,open_play_price=99",
        );
        const rows = (
          await asUser(staff, () =>
            db.query<Record<string, string | number>>(
              "select *,report_date::text as day from public.get_finance_month($1)",
              [month],
            ),
          )
        ).rows;
        const day = rows.find((r) => r.day === weekend)!;
        for (const [key, expected] of Object.entries({
          court_1_sales: 100,
          court_2_sales: 300,
          open_play_sales: 250,
          total_sales: 650,
          court_1_hours: 1,
          court_2_hours: 2,
          open_play_players: 5,
          cash_sales: 250,
          gcash_sales: 300,
          unspecified_sales: 100,
          card_sales: 0,
          pending_value: 100,
          confirmed_bookings: 5,
        }))
          assert.equal(Number(day[key]), expected, key);
        assert.equal(
          rows.reduce((sum, r) => sum + Number(r.total_sales), 0),
          650,
        );
        const leap = await asUser(staff, () =>
          db.query("select * from public.get_finance_month('2028-02-01')"),
        );
        assert.equal(leap.rows.length, 29);
        await assert.rejects(
          () =>
            asUser(staff, () =>
              db.query("select * from public.get_finance_month('2028-02-15')"),
            ),
          /valid report month/,
        );
        assert.equal(
          (
            await db.query<{ status: string }>(
              "select status from public.bookings where id=$1",
              [expired],
            )
          ).rows[0].status,
          "expired",
        );
      },
    );
    await t.test(
      "finance data and manager notes are staff-only; payment classification cannot change prices or online GCash",
      async () => {
        await startOpenPlay();
        const walkin = await financeWalkin();
        const online = await openPass(alice);
        await asUser(staff, () =>
          db.query(
            "select public.staff_save_finance_day($1,'Morning team','Manager review')",
            [weekend],
          ),
        );
        await asUser(staff, () =>
          db.query(
            "select public.staff_save_booking_finance($1,'bank_transfer','Private staff note')",
            [walkin],
          ),
        );
        assert.equal(
          (
            await asUser(staff, () =>
              db.query<{ notes: string }>(
                "select notes from public.booking_finance where booking_id=$1",
                [walkin],
              ),
            )
          ).rows[0].notes,
          "Private staff note",
        );
        assert.equal(
          Number(
            (
              await db.query<{ total_amount: string }>(
                "select total_amount from public.bookings where id=$1",
                [walkin],
              )
            ).rows[0].total_amount,
          ),
          100,
        );
        await assert.rejects(
          () =>
            asUser(staff, () =>
              db.query(
                "select public.staff_save_booking_finance($1,'cash','')",
                [online],
              ),
            ),
          /Online reservations use GCash/,
        );
        await asUser(alice, async () => {
          assert.equal(
            (await db.query("select * from public.booking_finance")).rows
              .length,
            0,
          );
          assert.equal(
            (await db.query("select * from public.finance_day_notes")).rows
              .length,
            0,
          );
          for (const query of [
            "select * from public.get_finance_month('2026-10-01')",
            "select public.staff_save_finance_day(current_date,'Self','Not allowed')",
            `select public.staff_save_booking_finance('${online}','gcash','Not allowed')`,
          ])
            await assert.rejects(() => db.query(query), /Staff access/);
          await assert.rejects(
            () =>
              db.query(
                "insert into public.finance_day_notes(report_date) values(current_date)",
              ),
            /permission denied/,
          );
          await assert.rejects(
            () =>
              db.query(
                "update public.booking_finance set payment_method='cash'",
              ),
            /permission denied/,
          );
        });
        await assert.rejects(
          () =>
            asUser(
              "",
              () =>
                db.query(
                  "select * from public.get_finance_month('2026-10-01')",
                ),
              "anon",
            ),
          /permission denied/,
        );
        await assert.rejects(
          () =>
            asUser(
              "",
              () => db.query("select * from public.finance_day_notes"),
              "anon",
            ),
          /permission denied/,
        );
      },
    );
    await t.test(
      "walk-in payment metadata commits atomically and still enforces weekend schedule and capacity",
      async () => {
        await startOpenPlay(2);
        await assert.rejects(
          () => financeWalkin("court", 1, 8, "invalid"),
          /payment method/,
        );
        assert.equal(
          (await db.query("select id from public.bookings")).rows.length,
          0,
        );
        await assert.rejects(
          () => financeWalkin("court", 1, 10),
          /reserved for open play/,
        );
        const id = await financeWalkin("open_play", 1, 9, "other", 2);
        assert.equal(
          (
            await db.query<{ payment_method: string }>(
              "select payment_method from public.booking_finance where booking_id=$1",
              [id],
            )
          ).rows[0].payment_method,
          "other",
        );
        await assert.rejects(
          () => financeWalkin("open_play", 1, 9, "gcash", 1),
          /not enough open-play/,
        );
        await assert.rejects(
          () =>
            asUser(alice, () =>
              db.query(
                "select public.staff_record_booking('court',$1,'Attacker','09171234567',1,8)",
                [weekend],
              ),
            ),
          /Staff access/,
        );
      },
    );
    async function equipmentBooking(
      user: string,
      {
        rental = true,
        kind = "court",
        court = 1,
        start = 8,
        duration = 1,
        people = 1,
        walkIn = false,
        blocked = false,
        method = "cash",
      } = {},
    ) {
      return asUser(
        user,
        async () =>
          (
            await db.query<{ id: string }>(
              "select public.reserve_with_equipment($1,$2,'Equipment Player','09171234567',$3,$4,$5,$6,$7,$8,$9,$10,'Equipment receipt checked') as id",
              [
                kind,
                weekend,
                court,
                start,
                duration,
                people,
                rental,
                walkIn,
                blocked,
                method,
              ],
            )
          ).rows[0].id,
      );
    }
    await t.test(
      "rental inclusions are saved with each booking, remain historical after settings edits, and are staff-only",
      async () => {
        await startOpenPlay();
        await asUser(staff, () =>
          db.exec(
            "update public.venue_settings set equipment_ball_count=3,private_court_capacity=10",
          ),
        );
        const original = await equipmentBooking(alice);
        await asUser(staff, () =>
          db.exec("update public.venue_settings set equipment_ball_count=1"),
        );
        const next = await equipmentBooking(bob, { court: 2 });
        const without = await equipmentBooking(staff, {
          start: 7,
          rental: false,
          walkIn: true,
        });
        for (const [id, count] of [
          [original, 3],
          [next, 1],
          [without, 0],
        ] as const) {
          const saved = (
            await db.query<{
              equipment_ball_count: number;
              total_amount: string;
            }>(
              "select equipment_ball_count,total_amount from public.bookings where id=$1",
              [id],
            )
          ).rows[0];
          assert.equal(saved.equipment_ball_count, count);
          assert.equal(Number(saved.total_amount), count ? 130 : 100);
        }
        assert.equal(
          (
            await asUser(alice, () =>
              db.query(
                "update public.venue_settings set equipment_ball_count=20,private_court_capacity=100 returning id",
              ),
            )
          ).rows.length,
          0,
        );
        const settings = (
          await db.query<{
            equipment_ball_count: number;
            private_court_capacity: number;
          }>(
            "select equipment_ball_count,private_court_capacity from public.venue_settings",
          )
        ).rows[0];
        assert.deepEqual(settings, {
          equipment_ball_count: 1,
          private_court_capacity: 10,
        });
        for (const change of [
          "equipment_ball_count=0",
          "equipment_ball_count=21",
          "private_court_capacity=0",
          "private_court_capacity=101",
        ])
          await assert.rejects(
            () => db.exec(`update public.venue_settings set ${change}`),
            /check constraint/,
          );
      },
    );
    await t.test(
      "equipment is optional and charged once per reservation, including multi-hour court bookings and shared open play",
      async () => {
        await startOpenPlay();
        const court = await equipmentBooking(alice);
        const without = await equipmentBooking(bob, {
          court: 2,
          rental: false,
        });
        const multi = await equipmentBooking(staff, {
          start: 6,
          duration: 2,
          walkIn: true,
        });
        const passes = await equipmentBooking(alice, {
          kind: "open_play",
          people: 3,
        });
        for (const [id, total, equipment, selected] of [
          [court, 130, 30, true],
          [without, 100, 0, false],
          [multi, 230, 30, true],
          [passes, 180, 30, true],
        ] as const) {
          const b = (
            await db.query<{
              total_amount: string;
              equipment_amount: string;
              equipment_rental: boolean;
            }>(
              "select total_amount,equipment_amount,equipment_rental from public.bookings where id=$1",
              [id],
            )
          ).rows[0];
          assert.equal(Number(b.total_amount), total);
          assert.equal(Number(b.equipment_amount), equipment);
          assert.equal(b.equipment_rental, selected);
        }
        assert.equal(
          (
            await asUser(staff, () =>
              db.query<{ payment_method: string }>(
                "select payment_method from public.booking_finance where booking_id=$1",
                [multi],
              ),
            )
          ).rows[0].payment_method,
          "cash",
        );
      },
    );
    await t.test(
      "equipment prices are calculated on the server, saved with the booking, and preserved after rate changes",
      async () => {
        await startOpenPlay();
        const original = await equipmentBooking(staff, { walkIn: true });
        await db.exec(
          "update public.venue_settings set equipment_rental_price=45.25",
        );
        const updated = await equipmentBooking(staff, {
          court: 2,
          walkIn: true,
          method: "bank_transfer",
        });
        await db.exec(
          "update public.venue_settings set equipment_rental_price=0",
        );
        const free = await equipmentBooking(staff, { start: 7, walkIn: true });
        for (const [id, total, fee] of [
          [original, 130, 30],
          [updated, 145.25, 45.25],
          [free, 100, 0],
        ] as const) {
          const b = (
            await db.query<{
              total_amount: string;
              equipment_amount: string;
              equipment_rental: boolean;
            }>("select * from public.bookings where id=$1", [id])
          ).rows[0];
          assert.equal(Number(b.total_amount), total);
          assert.equal(Number(b.equipment_amount), fee);
          assert.equal(b.equipment_rental, true);
        }
        const legacy = (
          await db.query<{
            equipment_amount: string;
            equipment_rental: boolean;
          }>(
            "select equipment_amount,equipment_rental from public.bookings where id=$1",
            [original],
          )
        ).rows[0];
        assert.equal(Number(legacy.equipment_amount), 30);
      },
    );
    await t.test(
      "rental reservations retain owner-only payments and cancellation, pending limits, staff permissions, and atomicity",
      async () => {
        await startOpenPlay();
        await assert.rejects(
          () => equipmentBooking(alice, { walkIn: true }),
          /Staff access/,
        );
        await assert.rejects(
          () => equipmentBooking(staff, { walkIn: true, blocked: true }),
          /valid reservation and equipment/,
        );
        await assert.rejects(
          () => equipmentBooking(staff, { walkIn: true, method: "invalid" }),
          /payment method/,
        );
        assert.equal(
          (await db.query("select id from public.bookings")).rows.length,
          0,
        );
        await assert.rejects(
          () =>
            asUser(alice, () =>
              db.query(
                "select public.reserve_with_equipment('court',$1,'Player','09171234567',1,8,1,1,null)",
                [weekend],
              ),
            ),
          /equipment option/,
        );
        await assert.rejects(
          () =>
            asUser(
              "",
              () =>
                db.query(
                  "select public.reserve_with_equipment('court',$1,'Player','09171234567',1,8)",
                  [weekend],
                ),
              "anon",
            ),
          /permission denied/,
        );
        const id = await equipmentBooking(alice);
        await equipmentBooking(alice, { kind: "open_play" });
        await assert.rejects(
          () => equipmentBooking(alice, { kind: "open_play" }),
          /two pending reservations/,
        );
        await assert.rejects(
          () =>
            asUser(bob, () =>
              db.query(
                "select public.submit_payment_reference($1,'RENTAL123456')",
                [id],
              ),
            ),
          /not found/,
        );
        await assert.rejects(
          () =>
            asUser(alice, () =>
              db.query(
                "update public.bookings set equipment_amount=0,total_amount=1 where id=$1",
                [id],
              ),
            ),
          /permission denied/,
        );
        await asUser(alice, () =>
          db.query("select public.cancel_booking($1)", [id]),
        );
        const b = (
          await db.query<{ status: string; total_amount: string }>(
            "select * from public.bookings where id=$1",
            [id],
          )
        ).rows[0];
        assert.equal(b.status, "cancelled");
        assert.equal(Number(b.total_amount), 130);
        await equipmentBooking(bob);
      },
    );
    await t.test(
      "finance reconciles court/pass subtotals and equipment sales against the full confirmed GCash and cash amounts",
      async () => {
        await startOpenPlay();
        const court = await equipmentBooking(staff, {
          walkIn: true,
          method: "gcash",
        });
        await equipmentBooking(staff, {
          kind: "open_play",
          people: 2,
          walkIn: true,
        });
        const pending = await equipmentBooking(alice, { kind: "open_play" });
        const month = weekend.slice(0, 7) + "-01";
        async function totals() {
          return (
            await asUser(staff, () =>
              db.query<Record<string, string | number>>(
                "select *,report_date::text as day from public.get_finance_month($1)",
                [month],
              ),
            )
          ).rows.find((r) => r.day === weekend)!;
        }
        let day = await totals();
        for (const [key, value] of Object.entries({
          court_1_sales: 100,
          open_play_sales: 100,
          equipment_sales: 60,
          total_sales: 260,
          cash_sales: 130,
          gcash_sales: 130,
          pending_value: 80,
          court_1_hours: 1,
          open_play_players: 2,
        }))
          assert.equal(Number(day[key]), value, key);
        await db.query(
          "update public.bookings set hold_expires_at=now()-interval '1 minute' where id=$1",
          [pending],
        );
        day = await totals();
        assert.equal(Number(day.pending_value), 0);
        assert.equal(Number(day.equipment_sales), 60);
        await asUser(staff, () =>
          db.query("select public.staff_update_booking($1,'cancelled')", [
            court,
          ]),
        );
        day = await totals();
        assert.equal(Number(day.total_sales), 130);
        assert.equal(Number(day.equipment_sales), 30);
        assert.equal(Number(day.court_1_sales), 0);
      },
    );
    async function paymentBooking(
      user: string,
      option: string,
      {
        kind = "court",
        court = 1,
        start = 8,
        rental = true,
        people = 1,
        walkIn = false,
      } = {},
    ) {
      return asUser(
        user,
        async () =>
          (
            await db.query<{ id: string }>(
              "select public.reserve_with_payment($1,$2,'Payment Player','09171234567',$3,$4,1,$5,$6,$7,false,'cash','',$8) as id",
              [kind, weekend, court, start, people, rental, walkIn, option],
            )
          ).rows[0].id,
      );
    }
    async function paymentRow(id: string) {
      return (
        await db.query<{
          status: string;
          payment_option: string;
          total_amount: string;
          initial_payment_amount: string;
          paid_amount: string;
          balance_payment_method: string | null;
          balance_payment_reference: string | null;
        }>("select * from public.bookings where id=$1", [id])
      ).rows[0];
    }
    async function verifyPayment(id: string, user: string, reference: string) {
      await asUser(user, () =>
        db.query("select public.submit_payment_reference($1,$2)", [
          id,
          reference,
        ]),
      );
      await asUser(staff, () =>
        db.query("select public.staff_update_booking($1,'confirmed')", [id]),
      );
    }
    await t.test(
      "payment options snapshot 50% of the entire court/pass and equipment total, including centavos",
      async () => {
        await startOpenPlay();
        const fee = await paymentBooking(alice, "reservation_fee");
        const full = await paymentBooking(bob, "full", { court: 2 });
        const passes = await paymentBooking(alice, "reservation_fee", {
          kind: "open_play",
          people: 3,
        });
        await db.exec(
          "update public.venue_settings set equipment_rental_price=30.01",
        );
        const walkin = await paymentBooking(staff, "reservation_fee", {
          start: 7,
          walkIn: true,
        });
        for (const [id, total, initial, paid] of [
          [fee, 130, 65, 0],
          [full, 130, 130, 0],
          [passes, 180, 90, 0],
          [walkin, 130.01, 65.01, 65.01],
        ] as const) {
          const b = await paymentRow(id);
          assert.equal(Number(b.total_amount), total);
          assert.equal(Number(b.initial_payment_amount), initial);
          assert.equal(Number(b.paid_amount), paid);
        }
        await db.exec(
          "update public.venue_settings set hourly_rate=900,equipment_rental_price=99",
        );
        assert.equal(
          Number((await paymentRow(fee)).initial_payment_amount),
          65,
        );
        await assert.rejects(
          () => paymentBooking(bob, "fake"),
          /Choose reservation fee/,
        );
      },
    );
    await t.test(
      "a fee remains unpaid during reference review and becomes a partial verified payment only on staff confirmation",
      async () => {
        await startOpenPlay();
        const id = await paymentBooking(alice, "reservation_fee");
        await asUser(alice, () =>
          db.query("select public.submit_payment_reference($1,'FEE-123456')", [
            id,
          ]),
        );
        assert.equal((await paymentRow(id)).status, "awaiting_verification");
        assert.equal(Number((await paymentRow(id)).paid_amount), 0);
        await asUser(staff, () =>
          db.query("select public.staff_update_booking($1,'confirmed')", [id]),
        );
        assert.equal((await paymentRow(id)).status, "confirmed");
        assert.equal(Number((await paymentRow(id)).paid_amount), 65);
        await assert.rejects(
          () =>
            asUser(alice, () =>
              db.query(
                "update public.bookings set paid_amount=130,payment_option='full' where id=$1",
                [id],
              ),
            ),
          /permission denied/,
        );
        await assert.rejects(
          () => paymentBooking(bob, "full"),
          /conflicting key/,
        );
      },
    );
    await t.test(
      "only staff can record an exact remaining balance once, preserving the deposit and confirmed reservation",
      async () => {
        await startOpenPlay();
        const id = await paymentBooking(alice, "reservation_fee");
        await assert.rejects(
          () =>
            asUser(staff, () =>
              db.query("select public.staff_record_balance($1,'cash')", [id]),
            ),
          /Only a confirmed/,
        );
        await verifyPayment(id, alice, "BALANCE-INITIAL");
        await assert.rejects(
          () =>
            asUser(alice, () =>
              db.query("select public.staff_record_balance($1,'cash')", [id]),
            ),
          /Staff access/,
        );
        await assert.rejects(
          () =>
            asUser(staff, () =>
              db.query("select public.staff_record_balance($1,'unspecified')", [
                id,
              ]),
            ),
          /payment method/,
        );
        await assert.rejects(
          () =>
            asUser(staff, () =>
              db.query("select public.staff_record_balance($1,'gcash')", [id]),
            ),
          /valid payment reference/,
        );
        await asUser(staff, () =>
          db.query("select public.staff_record_balance($1,'cash')", [id]),
        );
        const b = await paymentRow(id);
        assert.equal(Number(b.paid_amount), 130);
        assert.equal(Number(b.initial_payment_amount), 65);
        assert.equal(b.balance_payment_method, "cash");
        assert.equal(b.status, "confirmed");
        await assert.rejects(
          () =>
            asUser(staff, () =>
              db.query("select public.staff_record_balance($1,'cash')", [id]),
            ),
          /Only a confirmed/,
        );
        const full = await paymentBooking(staff, "full", {
          court: 2,
          walkIn: true,
        });
        await assert.rejects(
          () =>
            asUser(staff, () =>
              db.query("select public.staff_record_balance($1,'cash')", [full]),
            ),
          /Only a confirmed/,
        );
      },
    );
    await t.test(
      "finance separates confirmed value, verified fee, and outstanding balance, then reconciles mixed GCash/cash settlement",
      async () => {
        await startOpenPlay();
        const id = await paymentBooking(alice, "reservation_fee");
        await verifyPayment(id, alice, "FINANCE-FEE");
        async function finance() {
          return (
            await asUser(staff, () =>
              db.query<Record<string, string | number>>(
                "select *,report_date::text as day from public.get_finance_month($1)",
                [weekend.slice(0, 7) + "-01"],
              ),
            )
          ).rows.find((r) => r.day === weekend)!;
        }
        let day = await finance();
        for (const [key, value] of Object.entries({
          total_sales: 65,
          booking_value: 130,
          balance_due: 65,
          court_1_sales: 50,
          equipment_sales: 15,
          gcash_sales: 65,
          cash_sales: 0,
          court_1_hours: 1,
        }))
          assert.equal(Number(day[key]), value, key);
        await asUser(staff, () =>
          db.query("select public.staff_record_balance($1,'cash')", [id]),
        );
        day = await finance();
        for (const [key, value] of Object.entries({
          total_sales: 130,
          booking_value: 130,
          balance_due: 0,
          court_1_sales: 100,
          equipment_sales: 30,
          gcash_sales: 65,
          cash_sales: 65,
          court_1_hours: 1,
        }))
          assert.equal(Number(day[key]), value, key);
      },
    );
    await t.test(
      "initial and balance references share duplicate protection, including normalized references on other bookings",
      async () => {
        await startOpenPlay();
        const first = await paymentBooking(alice, "reservation_fee");
        const second = await paymentBooking(bob, "reservation_fee", {
          court: 2,
        });
        await verifyPayment(first, alice, "ORIGINAL-FIRST");
        await verifyPayment(second, bob, "ORIGINAL-SECOND");
        await assert.rejects(
          () =>
            asUser(staff, () =>
              db.query(
                "select public.staff_record_balance($1,'gcash','original second')",
                [first],
              ),
            ),
          /already been submitted/,
        );
        await asUser(staff, () =>
          db.query(
            "select public.staff_record_balance($1,'gcash','SETTLED-REFERENCE')",
            [first],
          ),
        );
        await assert.rejects(
          () =>
            asUser(staff, () =>
              db.query(
                "select public.staff_record_balance($1,'gcash','settled reference')",
                [second],
              ),
            ),
          /already been submitted/,
        );
        const third = await paymentBooking(alice, "reservation_fee", {
          kind: "open_play",
        });
        await assert.rejects(
          () =>
            asUser(alice, () =>
              db.query(
                "select public.submit_payment_reference($1,'settled reference')",
                [third],
              ),
            ),
          /already been submitted/,
        );
        assert.equal(Number((await paymentRow(third)).paid_amount), 0);
      },
    );
    await t.test("QR uploads are restricted to staff", async () => {
      await asUser(
        alice,
        async () =>
          await assert.rejects(
            () =>
              db.query(
                "insert into storage.objects(bucket_id,name) values ('venue-assets','malicious.png')",
              ),
            /row-level security/,
          ),
      );
      await asUser(staff, async () => {
        await db.query(
          "insert into storage.objects(bucket_id,name) values ('venue-assets','gcash/qr.png')",
        );
      });
    });
  } finally {
    await db.close();
  }
});
