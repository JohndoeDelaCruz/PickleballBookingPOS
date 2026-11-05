import test from "node:test";
import assert from "node:assert/strict";
import { requestCustomerBooking } from "../src/lib/customer-request";

const id = "00000000-0000-4000-a000-000000000001";
test("customer RPC gateway counts invalid forms and preserves rate-limit feedback", async () => {
  let calls = 0;
  const client = {
    rpc: async (name: string, args: unknown) => {
      calls++;
      assert.equal(name, "request_customer_booking_v2");
      assert.deepEqual(args, { p_action: "reserve_court", p_input: null });
      return {
        data:
          calls === 1
            ? { error: "Check details", code: "INVALID_INPUT" }
            : {
                error: "Too many requests. Please try again in 3 minutes.",
                code: "RATE_LIMITED",
                retry_after_seconds: 180,
              },
        error: null,
      };
    },
  };
  assert.deepEqual(
    await requestCustomerBooking(
      client,
      "reserve_court",
      {},
      "Enter your full name.",
    ),
    { error: "Enter your full name." },
  );
  assert.deepEqual(
    await requestCustomerBooking(
      client,
      "reserve_court",
      {},
      "Enter your full name.",
    ),
    {
      error: "Too many requests. Please try again in 3 minutes.",
      retryAfterSeconds: 180,
    },
  );
});

test("customer mutations fail closed on missing setup, network errors, or malformed responses", async () => {
  let calls = 0;
  const missing = {
    rpc: async (name: string) => {
      calls++;
      assert.equal(name, "request_customer_booking_v2");
      return {
        data: null,
        error: { code: "PGRST202", message: "not installed" },
      };
    },
  };
  assert.match(
    (await requestCustomerBooking(missing, "payment", {})).error!,
    /being updated/,
  );
  assert.equal(calls, 1); // No unprotected legacy fallback.
  const network = {
    rpc: async () => {
      throw new Error("secret database connection details");
    },
  };
  assert.doesNotMatch(
    (await requestCustomerBooking(network, "cancel", {})).error!,
    /secret/,
  );
  for (const data of [
    null,
    {},
    { success: false },
    { id: "invalid" },
    { success: true },
    { error: "limited", code: "RATE_LIMITED", retry_after_seconds: -1 },
  ]) {
    assert.ok(
      (
        await requestCustomerBooking(
          { rpc: async () => ({ data, error: null }) },
          "reserve_court",
          {},
        )
      ).error,
    );
  }
});

test("customer RPC responses expose only the expected success value", async () => {
  assert.deepEqual(
    await requestCustomerBooking(
      { rpc: async () => ({ data: { id, private: "hidden" }, error: null }) },
      "reserve_open_play",
      {},
    ),
    { id },
  );
  assert.deepEqual(
    await requestCustomerBooking(
      { rpc: async () => ({ data: { success: true }, error: null }) },
      "payment",
      {},
    ),
    { success: true },
  );
  assert.ok(
    (
      await requestCustomerBooking(
        { rpc: async () => ({ data: { id }, error: null }) },
        "cancel",
        {},
      )
    ).error,
  );
});
