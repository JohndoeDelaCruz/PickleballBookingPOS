import { z } from "zod";
import type { Booking, PaymentOption } from "./types";

export const paymentOptionSchema = z.enum(["full", "reservation_fee"]);
export function initialPaymentAmount(total: number, option: PaymentOption) {
  const cents = Math.round(Number(total) * 100);
  return (option === "reservation_fee" ? Math.round(cents / 2) : cents) / 100;
}
export function bookingPayments(
  b: Pick<Booking, "total_amount" | "status"> &
    Partial<
      Pick<Booking, "payment_option" | "initial_payment_amount" | "paid_amount">
    >,
) {
  const total = Math.round(Number(b.total_amount) * 100);
  const initial = Math.round(
    Number(
      b.initial_payment_amount ??
        initialPaymentAmount(b.total_amount, b.payment_option ?? "full"),
    ) * 100,
  );
  const paid = Math.round(
    Number(b.paid_amount ?? (b.status === "confirmed" ? b.total_amount : 0)) *
      100,
  );
  return {
    initial: initial / 100,
    paid: paid / 100,
    balance: Math.max(0, total - paid) / 100,
    later: Math.max(0, total - initial) / 100,
  };
}
export const balancePaymentSchema = z
  .object({
    booking_id: z.uuid(),
    payment_method: z.enum(["cash", "gcash", "bank_transfer", "card", "other"]),
    reference: z.string().trim().max(40).default(""),
  })
  .refine(
    (p) =>
      (!p.reference && p.payment_method !== "gcash") ||
      (/^[a-zA-Z0-9 -]{6,40}$/.test(p.reference) &&
        p.reference.replace(/[^a-zA-Z0-9]/g, "").length >= 6),
    "Enter a valid payment reference (6–40 letters or numbers).",
  );
