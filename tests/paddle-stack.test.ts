import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import type { CurrentMatch, StackBoard, StackSession, StackSkill } from "../src/lib/paddle-stack";

test("Paddle Stack keeps the queue, court permissions, and final scores consistent", async (t) => {
  const db = new PGlite({ extensions: { btree_gist } });
  const staff = randomUUID();
  const customer = randomUUID();

  async function as<T>(user: string, action: () => Promise<T>) {
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user]);
    await db.exec(user ? "set role authenticated" : "set role anon");
    try {
      return await action();
    } finally {
      await db.exec("reset role");
    }
  }

  async function call<T>(user: string, name: string, args: unknown[] = []) {
    return as(user, async () => {
      const parameters = args.map((_, index) => `$${index + 1}`).join(", ");
      const result = await db.query<{ result: T }>(`select public.${name}(${parameters}) as result`, args);
      return result.rows[0].result;
    });
  }

  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create schema auth;
      create schema storage;
      create schema extensions;
      set search_path = public, extensions;
      grant usage on schema public, auth, storage to anon, authenticated;
      create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;
      create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text);
      alter table storage.objects enable row level security;
      grant select, insert, update on storage.objects to anon, authenticated;
      alter default privileges grant execute on functions to anon, authenticated;
      alter default privileges grant all on tables to anon, authenticated;
    `);
    for (const migration of (await readdir("supabase/migrations")).filter((name) => name.endsWith(".sql")).sort()) {
      await db.exec(await readFile(`supabase/migrations/${migration}`, "utf8"));
    }
    await db.query("insert into auth.users values ($1, 'staff@example.test'), ($2, 'player@example.test')", [staff, customer]);
    await db.query("insert into public.staff_members(user_id, role) values ($1, 'cashier')", [staff]);
    const schedule = {
      weekly: [{ id: "open", days: [1, 2, 3, 4, 5, 6, 7], start: 0, end: 24, kind: "open_play", rate: 50, capacity: 9 }],
      overrides: [],
    };
    await db.query("update public.venue_settings set schedule_config = $1", [JSON.stringify(schedule)]);

    await assert.rejects(() => call(customer, "paddle_stack_open", [0, 24]), /staff access/);
    await assert.rejects(() => call(staff, "paddle_stack_open", [1, 24]), /open-play session/);
    const session = await call<string>(staff, "paddle_stack_open", [0, 24]);
    assert.equal(await call(staff, "paddle_stack_open", [0, 24]), session);
    assert.equal((await call<StackSession[]>(staff, "paddle_stack_sessions"))[0].id, session);

    const manage = (action: string, args: unknown[] = []) =>
      call<string | null>(staff, "paddle_stack_manage", [session, action, ...args]);
    const board = (user = "", key: string | null = null, staffView = false) =>
      call<StackBoard>(user, "get_paddle_stack", [session, key, staffView]);
    const currentMatches = (user: string = customer) => as(user, async () => (
      await db.query<CurrentMatch>("select * from public.current_paddle_stack_matches()")
    ).rows);
    const players = Array.from({ length: 10 }, (_, index) => ({
      id: randomUUID(),
      name: `Player ${index + 1}`,
    }));
    const checkIn = (index: number) =>
      manage("check_in", [null, players[index].id, players[index].name]);

    await t.test("only staff check players in and the public board shows just the active queue", async () => {
      assert.deepEqual(await currentMatches(), []);
      await assert.rejects(() => currentMatches(""), /permission denied/);
      await assert.rejects(() => call(customer, "paddle_stack_manage", [session, "check_in", null, players[0].id, "Player 1"]), /staff access/);
      await assert.rejects(() => call("", "paddle_stack_manage", [session, "close"]), /permission denied/);
      await assert.rejects(() => as(customer, () => db.exec("select * from private.paddle_stack_courts")), /permission denied/);
      for (let index = 0; index < 9; index++) await checkIn(index);
      await checkIn(0);
      await assert.rejects(() => checkIn(9), /player limit/);
      assert.deepEqual((await board()).waiting, players.slice(0, 9));

      await manage("pause", [null, players[8].id]);
      assert.deepEqual((await board(customer, null, true)).resting, []);
      assert.deepEqual((await board(staff, null, true)).resting, [players[8]]);
      await manage("leave", [null, players[8].id]);
      await checkIn(9);
      assert.equal((await board()).checked_in, 9);
    });

    await t.test("only staff can shuffle the entire waiting queue, using its current order", async () => {
      const before = (await board()).waiting.map((player) => player.id);
      const shuffle = (user: string, expected: string[]) =>
        call(user, "paddle_stack_shuffle", [session, expected]);
      await assert.rejects(() => shuffle(customer, before), /staff access/);
      await assert.rejects(() => shuffle("", before), /permission denied/);
      await assert.rejects(() => shuffle(staff, before.slice(0, 4)), /queue changed/);
      await shuffle(staff, before);
      const after = (await board()).waiting.map((player) => player.id);
      assert.notDeepEqual(after, before);
      assert.deepEqual(new Set(after), new Set(before));
      await assert.rejects(() => shuffle(staff, before), /queue changed/);
      assert.deepEqual((await board()).waiting.map((player) => player.id), after);
    });

    const shuffled = (await board()).waiting;
    const firstFour = shuffled.slice(0, 4).map((player) => player.id);
    const secondFour = shuffled.slice(4, 8).map((player) => player.id);
    const lastWaiting = shuffled[8];

    await t.test("calling a court uses the exact first four waiting players", async () => {
      await assert.rejects(() => manage("call", [1, null, null, secondFour]), /queue changed/);
      await manage("call", [1, null, null, firstFour]);
      await assert.rejects(() => manage("call", [1, null, null, secondFour]), /current game/);
      await assert.rejects(() => manage("call", [2, null, null, firstFour]), /queue changed/);
      await manage("call", [2, null, null, secondFour]);
      const current = await board();
      assert.deepEqual(current.courts.map((court) => new Set(court.game?.players)), [
        new Set(shuffled.slice(0, 4).map((player) => player.name)),
        new Set(shuffled.slice(4, 8).map((player) => player.name)),
      ]);
      assert.deepEqual(current.waiting, [lastWaiting]);
      const matches = await currentMatches();
      assert.deepEqual(matches, current.courts.map(({ name, game }) => ({
        session_id: session,
        court_name: name,
        game: { id: game!.id, team_a: 0, team_b: 0, players: game!.players },
      })));
      await assert.rejects(() => call(staff, "paddle_stack_shuffle", [session, [lastWaiting.id]]), /at least two/i);
    });

    await t.test("scorer links are scoped and revocable, and stale updates cannot add points twice", async () => {
      const key = await manage("assign", [1]);
      const current = await board("", key);
      const game = current.courts[0].game!;
      const otherGame = current.courts[1].game!;
      const score = (id: string, revision: number, action: string, token = key, user = "") =>
        call(user, "paddle_stack_score", [session, id, revision, action, token]);

      assert.equal(current.score_court, 1);
      assert.equal((await board()).score_court, null);
      assert.ok(!JSON.stringify(current).includes(key!));
      await assert.rejects(() => score(otherGame.id, 0, "point_a"), /valid scorekeeper link/);
      await assert.rejects(() => score(game.id, 0, "point_a", null), /valid scorekeeper link/);
      await score(game.id, 0, "point_a");
      assert.equal((await currentMatches())[0].game.team_a, 1);
      await assert.rejects(() => score(game.id, 0, "point_a"), /game changed/);
      await score(game.id, 1, "point_b");
      await score(game.id, 2, "undo");
      const replacement = await manage("assign", [1]);
      await assert.rejects(() => score(game.id, 3, "point_a"), /valid scorekeeper link/);
      assert.equal((await board("", key)).score_court, null);
      assert.equal((await board("", replacement)).score_court, 1);
      await manage("revoke", [1]);
      await assert.rejects(() => score(game.id, 3, "finish", replacement), /valid scorekeeper link/);
      await assert.rejects(() => manage("close"), /finish the games/i);
      const activeKey = await manage("assign", [1]);
      await score(game.id, 3, "finish", activeKey);
      assert.deepEqual((await currentMatches()).map(({ game }) => game.id), [otherGame.id]);
      const afterFinish = [lastWaiting.id, ...firstFour];
      assert.deepEqual((await board()).waiting.map(({ id }) => id), afterFinish);
      await assert.rejects(() => score(game.id, 3, "finish", activeKey), /game changed/);
      assert.deepEqual((await board()).waiting.map(({ id }) => id), afterFinish);
      await score(otherGame.id, 0, "finish", null, staff);
      const finished = await board(staff, null, true);
      assert.equal(finished.results.length, 2);
      assert.deepEqual(finished.results.find((result) => result.id === game.id)?.team_a, 1);
      assert.deepEqual(finished.results.find((result) => result.id === game.id)?.team_b, 0);
      assert.deepEqual(finished.waiting.map(({ id }) => id), [...afterFinish, ...secondFour]);
      assert.deepEqual(finished.resting, []);
    });

    await t.test("the next matchup splits winners and losers, even when only some players return", async () => {
      const finished = await board();
      const winners = finished.courts[0].game!.players.slice(0, 2);
      await manage("pause", [null, lastWaiting.id]);
      await manage("call", [1, null, null, firstFour]);
      const rematch = (await board()).courts[0].game!;
      assert.equal(rematch.players.slice(0, 2).filter((name) => winners.includes(name)).length, 1);
      assert.equal(rematch.players.slice(2).filter((name) => winners.includes(name)).length, 1);
      await call(staff, "paddle_stack_score", [session, rematch.id, 0, "finish"]);

      // Sit out the others so pairs from two previous games are up next.
      const firstPair = rematch.players.slice(0, 2);
      const secondPair = finished.courts[1].game!.players.slice(0, 2);
      const mixedFour = [];
      for (const player of (await board()).waiting) {
        if (firstPair.includes(player.name) || secondPair.includes(player.name)) mixedFour.push(player.id);
        else await manage("pause", [null, player.id]);
      }
      await manage("call", [2, null, null, mixedFour]);
      const mixedGame = (await board()).courts[1].game!;
      assert.equal(mixedGame.players.slice(0, 2).filter((name) => firstPair.includes(name)).length, 1);
      assert.equal(mixedGame.players.slice(0, 2).filter((name) => secondPair.includes(name)).length, 1);
      await call(staff, "paddle_stack_score", [session, mixedGame.id, 0, "finish"]);
      assert.deepEqual((await board()).waiting.map(({ id }) => id), mixedFour);
      assert.ok((await board(staff, null, true)).resting.some(({ id }) => id === lastWaiting.id));
    });

    await t.test("players can requeue at the back, and closing retires the queue", async () => {
      const waiting = (await board()).waiting;
      await manage("rejoin", [null, lastWaiting.id]);
      await manage("rejoin", [null, lastWaiting.id]);
      assert.deepEqual((await board()).waiting, [...waiting, lastWaiting]);
      await manage("close");
      assert.equal((await board()).status, "closed");
      assert.deepEqual((await board()).waiting, []);
      await assert.rejects(() => manage("rejoin", [null, shuffled[2].id]), /closed/);
      await assert.rejects(() => call(staff, "paddle_stack_shuffle", [session, []]), /closed/);
      assert.equal((await db.query("select id from public.bookings")).rows.length, 0);
      const settings = await db.query<{ schedule_config: unknown }>("select schedule_config from public.venue_settings");
      assert.deepEqual(settings.rows[0].schedule_config, schedule);
    });

    await t.test("the match feed excludes closed and expired sessions even with unfinished games", async () => {
      await db.query(`update private.paddle_stack_games set finished_at = null
        where id = (select id from private.paddle_stack_games where session_id = $1 order by started_at desc limit 1)`, [session]);
      assert.deepEqual(await currentMatches(), []);
      await db.query(`update private.paddle_stack_sessions
        set closed_at = null, play_date = (now() at time zone 'Asia/Manila')::date - 2
        where id = $1`, [session]);
      assert.deepEqual(await currentMatches(), []);
    });

    await t.test("skill matching keeps the queue leader in the game and balances mixed teams", async () => {
      const session = await call<string>(staff, "paddle_stack_open", [0, 24]);
      const manage = (action: string, args: unknown[]) =>
        call(staff, "paddle_stack_manage", [session, action, ...args]);
      const board = (user: string = staff) => call<StackBoard>(user, "get_paddle_stack", [session, null, true]);
      const levels: (StackSkill | null)[] = [
        "beginner", "advanced", "beginner", "intermediate", "beginner", "beginner", null, null,
      ];
      const queued = levels.map((skill, index) => ({ id: randomUUID(), name: `Skill player ${index + 1}`, skill }));
      const checkIn = ({ id, name, skill }: typeof queued[number]) =>
        manage("check_in", [null, id, name, null, skill]);
      const setSkill = (index: number, skill: StackSkill | null) =>
        manage("set_skill", [null, queued[index].id, null, null, skill]);

      await assert.rejects(
        () => manage("check_in", [null, randomUUID(), "Invalid player", null, "expert"]),
        /valid skill level/,
      );
      for (const player of queued) await checkIn(player);
      await checkIn(queued[0]);
      assert.equal((await board()).checked_in, 8);
      assert.equal((await board()).waiting[0].skill_level, "beginner");
      assert.ok((await board(customer)).waiting.every((player) => !("skill_level" in player)));
      assert.ok((await board("")).waiting.every((player) => !("skill_level" in player)));
      await assert.rejects(
        () => call(customer, "paddle_stack_manage", [session, "set_skill", null, queued[0].id, null, null, "advanced"]),
        /staff access/,
      );
      await assert.rejects(
        () => call("", "paddle_stack_manage", [session, "set_skill", null, queued[0].id, null, null, "advanced"]),
        /permission denied/,
      );

      const beginnerIds = [0, 2, 4, 5].map((i) => queued[i].id);
      const fifoIds = queued.slice(0, 4).map((player) => player.id);
      assert.deepEqual((await board()).next_players, beginnerIds);
      assert.deepEqual((await board("")).next_players, beginnerIds);
      await assert.rejects(() => manage("call", [1, null, null, fifoIds]), /queue changed/);

      // There are only two beginners now. The first four play and split them.
      await setSkill(4, null);
      await setSkill(5, "advanced");
      assert.deepEqual((await board()).next_players, fifoIds);
      await assert.rejects(() => manage("call", [1, null, null, beginnerIds]), /queue changed/);
      await manage("call", [1, null, null, fifoIds]);
      let game = (await board()).courts[0].game!;
      assert.ok(game.players.slice(2).includes(queued[2].name));
      await assert.rejects(() => setSkill(0, "advanced"), /waiting or resting/);
      assert.deepEqual((await board()).waiting.map(({ id }) => id), queued.slice(4).map(({ id }) => id));
      await call(staff, "paddle_stack_score", [session, game.id, 0, "finish"]);

      // With one beginner, their partner is the strongest of the other three.
      await setSkill(2, "intermediate");
      for (const player of queued.slice(4)) await manage("pause", [null, player.id]);
      await manage("call", [1, null, null, fifoIds]);
      game = (await board()).courts[0].game!;
      assert.deepEqual(game.players.slice(0, 2), [queued[0].name, queued[1].name]);
      await call(staff, "paddle_stack_score", [session, game.id, 0, "finish"]);

      await setSkill(2, "beginner");
      await setSkill(4, "beginner");
      await setSkill(5, "beginner");
      for (const player of queued.slice(4)) await manage("rejoin", [null, player.id]);
      assert.deepEqual((await board()).next_players, beginnerIds);
      await manage("call", [1, null, null, beginnerIds]);
      const next = await board();
      assert.deepEqual(new Set(next.courts[0].game!.players), new Set([0, 2, 4, 5].map((i) => queued[i].name)));
      assert.deepEqual(next.waiting.map(({ id }) => id), [1, 3, 6, 7].map((i) => queued[i].id));
    });
  } finally {
    await db.close();
  }
});
