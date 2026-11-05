import test from "node:test";
import assert from "node:assert/strict";
import {
  initialPaymentAmount,
  bookingPayments,
  balancePaymentSchema,
} from "../src/lib/payment";
import { bookingSchema } from "../src/lib/booking";

test("reservation fees round to centavos and balance plus fee equals the saved total", () => {
  for (const [total, fee, later] of [
    [130, 65, 65],
    [130.01, 65.01, 65],
    [50, 25, 25],
    [0.01, 0.01, 0],
  ]) {
    assert.equal(initialPaymentAmount(total, "reservation_fee"), fee);
    assert.equal(initialPaymentAmount(total, "full"), total);
    const p = bookingPayments({
      total_amount: total,
      status: "awaiting_payment",
      payment_option: "reservation_fee",
    });
    assert.equal(p.initial, fee);
    assert.equal(p.later, later);
    assert.equal(p.paid, 0);
  }
});
test("payment summaries trust saved amounts and distinguish verified fees from pending references", () => {
  assert.deepEqual(
    bookingPayments({
      total_amount: 130,
      status: "confirmed",
      payment_option: "reservation_fee",
      initial_payment_amount: 65,
      paid_amount: 65,
    }),
    { initial: 65, paid: 65, balance: 65, later: 65 },
  );
  assert.equal(
    bookingPayments({
      total_amount: 130,
      status: "awaiting_verification",
      payment_option: "reservation_fee",
      paid_amount: 0,
    }).paid,
    0,
  );
  assert.equal(
    bookingPayments({
      total_amount: 130,
      status: "confirmed",
      payment_option: "reservation_fee",
      paid_amount: 130,
    }).balance,
    0,
  );
  assert.equal(
    bookingPayments({ total_amount: 130, status: "confirmed" }).paid,
    130,
  );
});
test("invalid payment options and meaningless reference strings are rejected", () => {
  const input = {
    court_id: 1,
    booking_date: "2026-11-01",
    start_hour: 8,
    duration: 1,
    customer_name: "Test Player",
    customer_phone: "09171234567",
  };
  assert.equal(bookingSchema.parse(input).payment_option, "full");
  assert.equal(
    bookingSchema.safeParse({ ...input, payment_option: "free" }).success,
    false,
  );
  const balance = {
    booking_id: "00000000-0000-4000-a000-000000000001",
    payment_method: "gcash",
    reference: "------",
  };
  assert.equal(balancePaymentSchema.safeParse(balance).success, false);
  assert.equal(
    balancePaymentSchema.safeParse({ ...balance, reference: "REF-123456" })
      .success,
    true,
  );
  assert.equal(
    balancePaymentSchema.safeParse({
      ...balance,
      payment_method: "cash",
      reference: "",
    }).success,
    true,
  );
});
