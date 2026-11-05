import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { activeCourts, calendarCourts, courtName, courtSchema, type Court } from "../src/lib/courts";
import { bookingSchema, canBook } from "../src/lib/booking";
import { defaultVenue } from "../src/lib/types";
import { courtFinance, financeMetrics, monthCsv, sumFinance, type FinanceDay } from "../src/lib/finance";

test("court lists preserve historical courts, names, and arbitrary valid IDs", () => {
  const courts: Court[] = [{ id: 3, name: "Garden court", active: true, revision: 0 }, { id: 7, name: "Old court", active: false, revision: 1 }];
  assert.deepEqual(activeCourts(courts).map((c) => c.id), [3]);
  assert.deepEqual(calendarCourts(courts, [{ court_id: 7 }]).map((c) => c.id), [3, 7]);
  assert.equal(courtName(courts, 7), "Old court");
  assert.equal(courtName(courts, 99), "Court 99");
  assert.equal(courtSchema.safeParse({ id: null, revision: null, name: "  Garden court  ", active: true }).data?.name, "Garden court");
  assert.equal(courtSchema.safeParse({ id: 3, revision: 0, name: " ", active: true }).success, false);
  assert.equal(bookingSchema.shape.court_id.safeParse(7).success, true);
  assert.equal(bookingSchema.shape.court_id.safeParse(32768).success, false);
  assert.equal(canBook({ ...defaultVenue, booking_enabled: true, gcash_name: "Club", gcash_qr_url: "https://example.com/qr.png", courts: [] }), false);
});

test("finance totals and CSV include additional and inactive courts without dropping collections", () => {
  const courts: Court[] = [{ id: 3, name: "Garden", active: true, revision: 0 }, { id: 7, name: "Old court", active: false, revision: 0 }];
  const day = (date: string, sales: number): FinanceDay => ({
    ...Object.fromEntries(financeMetrics.map((key) => [key, 0])) as Record<(typeof financeMetrics)[number], number>,
    report_date: date, total_sales: sales + 25,
    court_totals: { 3: { sales, hours: 2 }, 7: { sales: 25, hours: 1 } },
  });
  const days = [day("2026-11-01", 100.25), day("2026-11-02", 200.5)];
  const totals = sumFinance(days);
  assert.deepEqual(courtFinance(totals, 3), { sales: 300.75, hours: 4 });
  assert.deepEqual(courtFinance(totals, 7), { sales: 50, hours: 2 });
  const csv = monthCsv(days, courts);
  assert.ok(csv.includes('"Garden sales (PHP)","Old court sales (PHP)"'));
  assert.ok(csv.includes('"MONTH TOTAL","300.75","50","0","350.75","4","2"'));
  assert.ok(!csv.includes("Court 1"));
});

test("court migration preserves IDs, enforces roles and availability, and reports new courts", async (t) => {
  const db = new PGlite({ extensions: { btree_gist } });
  const owner = "00000000-0000-4000-a000-000000000001";
  const cashier = "00000000-0000-4000-a000-000000000002";
  const player = "00000000-0000-4000-a000-000000000003";
  const other = "00000000-0000-4000-a000-000000000004";
  async function as<T>(user: string, fn: () => Promise<T>, role = "authenticated") {
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
    await db.exec(`set role ${role}`);
    try { return await fn(); } finally { await db.exec("reset role"); }
  }
  const call = async <T>(user: string, name: string, args: unknown[]) =>
    (await as(user, () => db.query<{ value: T }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`, args))).rows[0].value;
  const save = (user: string, id: number | null, name: string, active: boolean, revision: number | null) =>
    call<Court>(user, "save_court", [id, name, active, revision]);
  try {
    await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;create schema extensions;
      set search_path=public,extensions;grant usage on schema public,auth,storage to anon,authenticated;
      create table auth.users(id uuid primary key,email text);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
      alter table storage.objects enable row level security;grant select,insert,update on storage.objects to anon,authenticated;
      alter default privileges grant execute on functions to anon,authenticated;alter default privileges grant all on tables to anon,authenticated;`);
    for (const file of (await readdir("supabase/migrations")).filter((f) => f.endsWith(".sql") && f < "202611050014").sort())
      await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
    await db.query("insert into auth.users values($1,'owner@example.com'),($2,'cashier@example.com'),($3,'player@example.com'),($4,'other@example.com')", [owner, cashier, player, other]);
    await db.query("insert into public.staff_members(user_id,role) values($1,'owner'),($2,'cashier')", [owner, cashier]);
    await db.exec("insert into public.bookings(reference,court_id,booking_date,start_hour,duration,total_amount,status,customer_name,customer_phone) values('HISTORY',2,current_date-1,6,1,100,'cancelled','Past player','09171234567')");
    await db.exec(await readFile("supabase/migrations/202611050014_court_management.sql", "utf8"));
    const day = (await db.query<{ day: string }>("select ((now() at time zone 'Asia/Manila')::date+1)::text as day")).rows[0].day;
    await t.test("migration preserves court and booking records and protects direct writes", async () => {
      assert.deepEqual((await db.query<{ id: number }>("select id from public.courts order by id")).rows.map((c) => c.id), [1, 2]);
      assert.equal((await db.query("select * from public.bookings where reference='HISTORY'")).rows.length, 1);
      assert.equal((await as("", () => db.query("select * from public.courts"), "anon")).rows.length, 2);
      for (const user of [cashier, player]) await assert.rejects(() => save(user, null, "Forbidden", true, null), /Manager access/);
      await assert.rejects(() => as("", () => db.query("select public.save_court(null,'Forbidden',true,null)"), "anon"), /permission denied/);
      for (const sql of ["insert into public.courts(id,name) values(9,'Bypass')", "update public.courts set active=false where id=1", "delete from public.courts where id=1"])
        await assert.rejects(() => as(owner, () => db.exec(sql)), /permission denied/);
    });
    const garden = await save(owner, null, "Garden court", true, null);
    assert.equal(garden.id, 3);
    await t.test("names and revisions protect concurrent managers", async () => {
      await assert.rejects(() => save(owner, null, " garden COURT ", true, null), /already exists/);
      const renamed = await save(owner, 1, "Main court", true, 0);
      assert.equal(renamed.revision, 1);
      await assert.rejects(() => save(owner, 1, "Stale edit", false, 0), /Another manager/);
    });
    const weekly = { weekly: [{ id: "all-day", days: [1,2,3,4,5,6,7], kind: "court", start: 6, end: 22, rate: 100, capacity: 8 }], overrides: [] };
    await call(owner, "save_booking_schedule", [JSON.stringify(weekly), null]);
    await db.exec("update public.venue_settings set booking_enabled=true,gcash_name='Club',gcash_qr_url='https://example.com/qr.png'");
    const reserve = (user: string, court: number, start = 7) => call<{ id?: string; error?: string }>(user, "request_customer_booking_v2", ["reserve_court", JSON.stringify({
      court_id: court, booking_date: day, start_hour: start, duration: 2, customer_name: "Court player", customer_phone: "09171234567", payment_option: "full", equipment_rental: false,
    })]);
    let booking = "";
    await t.test("additional courts can be booked, conflicting bookings rejected, and reservations block deactivation", async () => {
      const reply = await reserve(player, 3);
      assert.ok(reply.id, reply.error);
      booking = reply.id!;
      assert.ok((await reserve(other, 3)).error);
      await assert.rejects(() => save(owner, 3, garden.name, false, 0), /upcoming reservations/);
    });
    await t.test("additional-court payments appear in finance and named POS receipts", async () => {
      const reply = await call<{ error?: string }>(player, "request_customer_booking_v2", ["payment", JSON.stringify({ booking_id: booking, reference: "GARDEN-REFERENCE-123" })]);
      assert.equal(reply.error, undefined);
      await call(owner, "staff_update_booking", [booking, "confirmed"]);
      const month = day.slice(0, 7) + "-01";
      const report = await as(owner, () => db.query<{ sales: string; hours: string }>("select sales,hours from public.get_court_finance_month($1) where report_date=$2 and court_id=3", [month, day]));
      assert.equal(Number(report.rows[0].sales), 200);
      assert.equal(Number(report.rows[0].hours), 2);
      assert.ok((await db.query<{ name: string }>("select name from public.pos_sale_items i join public.pos_sales s on s.id=i.sale_id where s.booking_id=$1", [booking])).rows[0].name.includes("Garden court"));
      await assert.rejects(() => call(player, "get_court_finance_month", [month]), /Staff access/);
    });
    await t.test("inactive courts reject customer and legacy booking paths while retaining history", async () => {
      const extra = await save(owner, null, "Practice court", true, null);
      await call(owner, "staff_create_booking", [extra.id, day, 11, 1, "Maintenance", "", true]);
      await assert.rejects(() => save(owner, extra.id, extra.name, false, 0), /upcoming reservations/);
      await db.exec(`update public.bookings set status='cancelled' where court_id=${extra.id}`);
      await save(owner, extra.id, extra.name, false, 0);
      assert.ok((await reserve(other, extra.id, 13)).error);
      await assert.rejects(() => call(player, "create_booking", [extra.id, day, 15, 1, "No booking", "09171234567"]), /permission denied/);
      await assert.rejects(() => db.query("select public.create_booking($1,$2,15,1,'No booking','09171234567')", [extra.id, day]), /valid court|valid time|inactive/i);
      assert.equal((await db.query("select * from public.bookings where court_id=$1", [extra.id])).rows.length, 1);
      const reactivated = await save(owner, extra.id, extra.name, true, 1);
      assert.equal(reactivated.active, true);
    });
    await t.test("the last court cannot be deactivated while online reservations are enabled", async () => {
      await save(owner, 1, "Main court", false, 1);
      await save(owner, 2, "Court 2", false, 0);
      await save(owner, 4, "Practice court", false, 2);
      await assert.rejects(() => save(owner, 3, garden.name, false, 0), /Pause online reservations/);
    });
    await t.test("shared open-play reservations prevent shrinking available courts", async () => {
      await save(owner, 4, "Practice court", true, 3);
      const openConfig = { weekly: [
        { ...weekly.weekly[0], end: 19 },
        { id: "open-evening", days: [1,2,3,4,5,6,7], kind: "open_play", start: 19, end: 20, rate: 50, capacity: 24 },
        { ...weekly.weekly[0], id: "late", start: 20 },
      ], overrides: [] };
      await call(owner, "save_booking_schedule", [JSON.stringify(openConfig), JSON.stringify(weekly)]);
      const reply = await call<{ id?: string; error?: string }>(other, "request_customer_booking_v2", ["reserve_open_play", JSON.stringify({
        booking_date: day, start_hour: 19, participant_count: 1, customer_name: "Open player", customer_phone: "09171234567", payment_option: "full", equipment_rental: false,
      })]);
      assert.ok(reply.id, reply.error);
      await assert.rejects(() => save(owner, 4, "Practice court", false, 4), /shared open-play/);
    });
  } finally { await db.close(); }
});
