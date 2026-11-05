import test from "node:test";
import assert from "node:assert/strict";
import {
  authCallbackDestination,
  type AuthCallbackClient,
} from "../src/lib/auth-callback";
import { authCallbackUrl, siteOrigin } from "../src/lib/site-url";

test("callback redirects use a reachable browser origin instead of a bind address", () => {
  assert.equal(
    siteOrigin("http://0.0.0.0:3000/auth/callback", { host: "localhost:3000" }),
    "http://localhost:3000",
  );
  assert.equal(
    siteOrigin("http://0.0.0.0:3000/auth/callback", { host: "127.0.0.1:3000" }),
    "http://127.0.0.1:3000",
  );
  assert.equal(
    siteOrigin("http://0.0.0.0:3000/auth/callback", {
      host: "192.168.1.20:3000",
    }),
    "http://192.168.1.20:3000",
  );
  assert.equal(
    siteOrigin("http://0.0.0.0:3000/auth/callback"),
    "http://localhost:3000",
  );
  assert.equal(
    siteOrigin("http://[::]:3000/auth/callback"),
    "http://localhost:3000",
  );
  assert.equal(
    siteOrigin("https://courts.example.com/auth/callback"),
    "https://courts.example.com",
  );
  assert.equal(
    siteOrigin("http://0.0.0.0:3000/auth/callback", {
      siteUrl: "https://courts.example.com",
      host: "localhost:3000",
    }),
    "https://courts.example.com",
  );
  for (const host of [
    "user@example.com",
    "example.com/path",
    "example.com?next=evil",
    "example.com#evil",
    "bad host",
  ])
    assert.equal(
      siteOrigin("http://0.0.0.0:3000/auth/callback", { host }),
      "http://localhost:3000",
    );
  assert.throws(() => siteOrigin("javascript:alert(1)"), /website address/);
  assert.throws(
    () => siteOrigin("https://user:password@example.com"),
    /website address/,
  );
});

test("signup and recovery email callbacks use usable origins and encode return links", () => {
  assert.equal(
    authCallbackUrl("http://0.0.0.0:3000"),
    "http://localhost:3000/auth/callback",
  );
  const next = "/book?court=2&date=2026-10-24";
  const booking = new URL(authCallbackUrl("http://localhost:3000", next));
  assert.equal(booking.pathname, "/auth/callback");
  assert.equal(booking.searchParams.get("next"), next);
  const recovery = new URL(
    authCallbackUrl("http://localhost:3000", "/login?recovery=true"),
  );
  assert.equal(recovery.searchParams.get("next"), "/login?recovery=true");
});

function fixture({
  staff = false,
  exchangeError = false,
  accessError = false,
} = {}) {
  const calls: { code?: string; flowId?: string; roleChecks: number } = {
    roleChecks: 0,
  };
  const client: AuthCallbackClient = {
    auth: {
      exchangeCodeForSession: async (code, options) => {
        calls.code = code;
        calls.flowId = options?.flowId;
        return {
          error: exchangeError ? new Error("Invalid or consumed code") : null,
        };
      },
    },
    rpc: async (name) => {
      assert.equal(name, "is_club_staff");
      calls.roleChecks++;
      return {
        data: staff,
        error: accessError ? new Error("Unavailable") : null,
      };
    },
  };
  return { calls, client };
}

test("confirmation exchanges the session before choosing the customer or staff destination", async () => {
  for (const staff of [true, false]) {
    const { calls, client } = fixture({ staff });
    const destination = await authCallbackDestination(
      new URLSearchParams({
        code: "test-confirmation-code",
        sb_flow_id: "test-flow",
      }),
      client,
    );
    assert.equal(destination, staff ? "/staff" : "/my-bookings");
    assert.equal(calls.code, "test-confirmation-code");
    assert.equal(calls.flowId, "test-flow");
    assert.equal(calls.roleChecks, 1);
    const redirect = new URL(
      destination,
      siteOrigin("http://0.0.0.0:3000/auth/callback", {
        host: "localhost:3000",
      }),
    );
    assert.equal(redirect.hostname, "localhost");
    assert.equal(redirect.pathname, destination);
  }
});

test("confirmation keeps local booking and password recovery return paths and rejects external redirects", async () => {
  for (const next of [
    "/book?court=2&date=2026-10-24",
    "/login?recovery=true",
  ]) {
    assert.equal(
      await authCallbackDestination(
        new URLSearchParams({ code: "test", next }),
        fixture().client,
      ),
      next,
    );
  }
  assert.equal(
    await authCallbackDestination(
      new URLSearchParams({ code: "test", next: "//example.com" }),
      fixture().client,
    ),
    "/my-bookings",
  );
});

test("missing or expired confirmation codes and account lookup failures return usable login pages", async () => {
  const missing = fixture();
  assert.equal(
    await authCallbackDestination(new URLSearchParams(), missing.client),
    "/login?error=callback",
  );
  assert.equal(missing.calls.roleChecks, 0);
  const expired = fixture({ exchangeError: true });
  assert.equal(
    await authCallbackDestination(
      new URLSearchParams({ code: "expired" }),
      expired.client,
    ),
    "/login?error=callback",
  );
  assert.equal(expired.calls.roleChecks, 0);
  assert.equal(
    await authCallbackDestination(
      new URLSearchParams({ code: "test" }),
      fixture({ accessError: true }).client,
    ),
    "/login?error=access",
  );
});
