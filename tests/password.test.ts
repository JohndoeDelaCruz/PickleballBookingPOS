import test from "node:test";
import assert from "node:assert/strict";
import { changeAccountPassword, type PasswordAuth } from "../src/lib/password";

const input = {
  currentPassword: "old-password",
  newPassword: "new-password",
  confirmPassword: "new-password",
  captchaToken: "verified-captcha-token",
};
function fixture(overrides: Partial<PasswordAuth> = {}) {
  const calls: unknown[] = [];
  const auth: PasswordAuth = {
    async getUser() {
      calls.push("getUser");
      return { data: { user: { email: "owner@example.com" } }, error: null };
    },
    async signInWithPassword(credentials) {
      calls.push(credentials);
      return { error: null };
    },
    async updateUser(attributes) {
      calls.push(attributes);
      return { error: null };
    },
    ...overrides,
  };
  return { auth, calls };
}

test("rejects short, mismatched, reused, and oversized passwords before auth calls", async () => {
  for (const patch of [
    { currentPassword: "" },
    { newPassword: "short", confirmPassword: "short" },
    { confirmPassword: "another-password" },
    {
      newPassword: input.currentPassword,
      confirmPassword: input.currentPassword,
    },
    { newPassword: "x".repeat(129), confirmPassword: "x".repeat(129) },
  ]) {
    const { auth, calls } = fixture();
    assert.ok(
      (await changeAccountPassword(auth, { ...input, ...patch })).error,
    );
    assert.deepEqual(calls, []);
  }
});

test("requires a verified signed-in session", async () => {
  const { auth, calls } = fixture({
    async getUser() {
      return { data: { user: null }, error: null };
    },
  });
  assert.match(
    (await changeAccountPassword(auth, input)).error!,
    /log in again/i,
  );
  assert.deepEqual(calls, []);
});

test("wrong current password never triggers a password update", async () => {
  const { auth, calls } = fixture({
    async signInWithPassword() {
      return {
        error: {
          code: "invalid_credentials",
          message: "Invalid login credentials",
        },
      };
    },
  });
  assert.match(
    (await changeAccountPassword(auth, input)).error!,
    /current password is incorrect/i,
  );
  assert.deepEqual(calls, ["getUser"]);
});

test("reauthenticates the session owner and ignores client-supplied account or role", async () => {
  const { auth, calls } = fixture();
  assert.equal(
    (
      await changeAccountPassword(auth, {
        ...input,
        email: "someone-else@example.com",
        staff: true,
      })
    ).success,
    true,
  );
  assert.deepEqual(calls, [
    "getUser",
    {
      email: "owner@example.com",
      password: input.currentPassword,
      options: { captchaToken: input.captchaToken },
    },
    { password: input.newPassword, current_password: input.currentPassword },
  ]);
});

test("reports provider password-policy failures without reporting success", async () => {
  const { auth } = fixture({
    async updateUser() {
      return {
        error: {
          code: "weak_password",
          message: "Password must contain a number.",
        },
      };
    },
  });
  assert.equal(
    (await changeAccountPassword(auth, input)).error,
    "Password must contain a number.",
  );
});

test("rate limits and network failures stop the update and return useful errors", async () => {
  const { auth, calls } = fixture({
    async signInWithPassword() {
      return {
        error: {
          code: "over_request_rate_limit",
          message: "Too many requests",
        },
      };
    },
  });
  assert.match(
    (await changeAccountPassword(auth, input)).error!,
    /try again in a moment/i,
  );
  assert.deepEqual(calls, ["getUser"]);
  const network = fixture({
    async getUser() {
      throw new Error("network unavailable");
    },
  });
  assert.match(
    (await changeAccountPassword(network.auth, input)).error!,
    /account service/i,
  );
});

test("password changes require a security token and stop when Supabase rejects verification", async () => {
  for (const token of [undefined, "", " ", "x".repeat(2049)]) {
    const { auth, calls } = fixture();
    assert.ok(
      (await changeAccountPassword(auth, { ...input, captchaToken: token }))
        .error,
    );
    assert.deepEqual(calls, []);
  }
  const { auth, calls } = fixture({
    async signInWithPassword(credentials) {
      calls.push(credentials);
      return {
        error: {
          code: "captcha_failed",
          message: "CAPTCHA verification failed",
        },
      };
    },
  });
  assert.match(
    (await changeAccountPassword(auth, input)).error!,
    /security check/i,
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], {
    email: "owner@example.com",
    password: input.currentPassword,
    options: { captchaToken: input.captchaToken },
  });
});
