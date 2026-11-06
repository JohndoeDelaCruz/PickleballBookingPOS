import test from "node:test";
import assert from "node:assert/strict";
import type { User } from "@supabase/supabase-js";
import { readSessionAccess } from "../src/lib/session-access";

const user: User = {
  id: "user-a",
  aud: "authenticated",
  app_metadata: {},
  user_metadata: {},
  created_at: "2026-11-07T00:00:00.000Z",
};
type Client = Parameters<typeof readSessionAccess>[0];
type RpcName = Parameters<Client["rpc"]>[0];
type Result = { data: unknown; error: Error | null };
const unavailable = { data: null, error: new Error("RPC unavailable") };

function fixture({
  currentUser = user as User | null,
  authError = null as Error | null,
  results = { club_role: { data: null, error: null } } as Partial<Record<RpcName, Result>>,
} = {}) {
  const calls: string[] = [];
  const client: Client = {
    auth: {
      async getUser() {
        calls.push("getUser");
        return { data: { user: currentUser }, error: authError };
      },
    },
    async rpc(name) {
      calls.push(name);
      const result = results[name];
      assert.ok(result, `Unexpected membership request: ${name}`);
      return result;
    },
  };
  return { client, calls };
}

for (const role of ["owner", "manager", "cashier"] as const) {
  test(`${role} gets staff access with one membership request`, async () => {
    const { client, calls } = fixture({ results: { club_role: { data: role, error: null } } });
    assert.deepEqual(await readSessionAccess(client), { user, staff: true, role });
    assert.deepEqual(calls, ["getUser", "club_role"]);
  });
}

test("customers and unrecognized roles never receive staff access", async () => {
  for (const role of [null, "customer", "admin", true]) {
    const { client, calls } = fixture({ results: { club_role: { data: role, error: null } } });
    assert.deepEqual(await readSessionAccess(client), { user, staff: false, role: undefined });
    assert.deepEqual(calls, ["getUser", "club_role"]);
  }
});

test("signed-out requests do not perform membership queries", async () => {
  const { client, calls } = fixture({ currentUser: null });
  assert.deepEqual(await readSessionAccess(client), { user: null, staff: false, role: undefined });
  assert.deepEqual(calls, ["getUser"]);
});

test("an Auth error fails closed even if a user is returned", async () => {
  const { client, calls } = fixture({ authError: new Error("Invalid session") });
  assert.deepEqual(await readSessionAccess(client), { user: null, staff: false, role: undefined });
  assert.deepEqual(calls, ["getUser"]);
});

test("older databases keep their membership check without inventing a role", async () => {
  for (const staff of [true, false]) {
    const { client, calls } = fixture({
      results: { club_role: unavailable, is_club_staff: { data: staff, error: null } },
    });
    assert.deepEqual(await readSessionAccess(client), { user, staff, role: undefined });
    assert.deepEqual(calls, ["getUser", "club_role", "is_club_staff"]);
  }
});

test("the oldest membership fallback requires a successful true response", async () => {
  for (const result of [
    { data: true, error: null },
    { data: false, error: null },
    { data: true, error: new Error("Permission denied") },
  ]) {
    const { client, calls } = fixture({
      results: { club_role: unavailable, is_club_staff: unavailable, is_staff: result },
    });
    assert.deepEqual(await readSessionAccess(client), {
      user, staff: !result.error && result.data === true, role: undefined,
    });
    assert.deepEqual(calls, ["getUser", "club_role", "is_club_staff", "is_staff"]);
  }
});

test("separate users never share an access result", async () => {
  const owner = fixture({ results: { club_role: { data: "owner", error: null } } });
  const customerUser = { ...user, id: "user-b" };
  const customer = fixture({ currentUser: customerUser });
  assert.equal((await readSessionAccess(owner.client)).staff, true);
  assert.deepEqual(await readSessionAccess(customer.client), {
    user: customerUser, staff: false, role: undefined,
  });
});
