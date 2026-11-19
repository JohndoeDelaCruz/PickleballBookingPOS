"use server";
import { z } from "zod";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { checkoutSchema, productSchema, type Sale } from "@/lib/pos";
import { productPhotoSchema } from "@/lib/product-photo";
import { readVerifiedUser } from "@/lib/session-access";
import { bookingSchema, openPlaySchema } from "@/lib/booking";
import { getSession } from "@/lib/data";
import { financeBookingSchema } from "@/lib/finance";
import { bookingError } from "@/lib/customer-request";
import { posMessage } from "@/lib/pos-message";
import { membershipApplyPath, membershipReviewPath } from "@/lib/membership-applications";
const id = z.uuid();
const cents = z.int().min(0).max(100000000);
const schema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("checkout"), payload: checkoutSchema }),
  z.object({ op: z.literal("product"), payload: productSchema, photo: productPhotoSchema.nullish() }),
  z.object({
    op: z.literal("stock"),
    id,
    quantity: z
      .int()
      .min(-100000)
      .max(100000)
      .refine((n) => n !== 0),
    reason: z.string().trim().min(3).max(200),
  }),
  z.object({ op: z.literal("open"), amount: cents }),
  z.object({ op: z.literal("close"), id, amount: cents }),
  z.object({ op: z.literal("verify"), id, verified: z.literal(true) }),
  z.object({
    op: z.literal("reject_payment"),
    id,
    reason: z.string().trim().min(3).max(200),
    verified: z.literal(true),
  }),
  z.object({
    op: z.literal("balance"),
    id,
    method: z.enum(["cash", "gcash"]),
    reference: z.string().max(40),
    verified: z.literal(true),
  }),
  z.object({
    op: z.literal("refund"),
    id,
    method: z.enum(["cash", "gcash"]),
    reason: z.string().trim().min(3).max(200),
    restock: z.boolean(),
    verified: z.literal(true),
  }),
]);
export type PosCommand = z.infer<typeof schema>;

const walkInPayment = z.discriminatedUnion("method", [
  z.object({ method: z.literal("cash"), reference: z.literal("") }),
  z.object({
    method: z.literal("gcash"),
    reference: z.string().trim().regex(/^[a-zA-Z0-9 -]{6,40}$/, "Enter a valid GCash transaction reference."),
  }),
]).and(z.object({
  key: id,
  verified: z.literal(true, "Confirm that you received the payment."),
  collectedCents: z.int().min(0).max(2147483647),
}));

export async function bookWalkIn(input: unknown, openPlay: boolean): Promise<{ id?: string; error?: string }> {
  const payment = walkInPayment.safeParse(input);
  if (!payment.success) return { error: payment.error.issues[0].message };
  const booking = openPlay ? openPlaySchema.safeParse(input) : bookingSchema.safeParse(input);
  if (!booking.success) return { error: booking.error.issues[0].message };
  const p = booking.data;
  const counter = payment.data;

  try {
    const db = await createClient();
    const { data: { user }, error: authError } = await readVerifiedUser(db.auth);
    if (isAuthRetryableFetchError(authError))
      return { error: "Sign-in verification is temporarily unavailable. Try again in a moment." };
    if (authError || !user) return { error: "Please sign in again." };

    const { data, error } = await db.rpc("pos_book_walk_in", {
      p_key: counter.key, p_kind: openPlay ? "open_play" : "court", p_date: p.booking_date,
      p_name: p.customer_name, p_phone: p.customer_phone, p_start: p.start_hour ?? null,
      p_court: "court_id" in p ? p.court_id : null, p_duration: "duration" in p ? p.duration : 1,
      p_people: "participant_count" in p ? p.participant_count : 1,
      p_quantity: p.equipment_quantity ?? Number(p.equipment_rental), p_payment_option: p.payment_option,
      p_method: counter.method, p_reference: counter.reference, p_verified: counter.verified,
      p_collected_cents: counter.collectedCents,
    });
    if (error) return { error: error.code === "PGRST202"
      ? "Walk-in booking needs database migration 023. Ask a manager to apply it."
      : bookingError(error) };
    const saved = id.safeParse(data);
    if (!saved.success) return { error: "Couldn’t confirm the walk-in. Check Reservations before starting another booking." };
    revalidatePath("/staff");
    revalidatePath("/admin");
    revalidatePath("/book");
    revalidatePath("/admin/finance");
    return { id: saved.data };
  } catch {
    return { error: "Connection interrupted. Retry the same walk-in before starting another booking." };
  }
}

const walkInCustomerSchema = z.object({
  id, full_name: z.string().nullable(), email: z.string(), active_membership: z.boolean(),
});
export type WalkInCustomer = z.infer<typeof walkInCustomerSchema>;

const walkInSearchSchema = z.object({
  query: z.string().trim().min(2).max(254),
  date: z.iso.date(),
  activeOnly: z.boolean(),
});

export async function findWalkInCustomers(input: unknown): Promise<{ customers: WalkInCustomer[] } | { error: string }> {
  const parsed = walkInSearchSchema.safeParse(input);
  if (!parsed.success) return { error: "Enter at least two characters of a name or the full email address." };
  const failed = "Account lookup is temporarily unavailable. Try again.";
  try {
    if (!(await getSession()).staff) return { error: "Staff access is required." };
    const { query, date, activeOnly } = parsed.data;
    const db = await createClient();
    const { data, error } = await db.rpc("pos_find_walk_in_customers", { p_query: query, p_date: date, p_active_only: activeOnly });
    if (error) return { error: error.code === "PGRST202"
      ? "Apply migration 047 to enable walk-in account lookup." : bookingError(error) };
    const result = z.array(walkInCustomerSchema).safeParse(data);
    return result.success ? { customers: result.data } : { error: failed };
  } catch {
    return { error: failed };
  }
}

const memberQuoteFields = z.object({
  customerId: id,
  bookingDate: z.iso.date(),
  startHour: z.int().min(0).max(23),
  equipmentQuantity: z.int().min(0).max(100),
});
const memberQuoteRequest = z.discriminatedUnion("kind", [
  memberQuoteFields.extend({ kind: z.literal("court"), duration: z.int().min(1).max(4) }),
  memberQuoteFields.extend({ kind: z.literal("open_play"), people: z.int().min(1).max(20) }),
]);
const memberQuoteSchema = z.object({
  regularCents: z.int().nonnegative(), discountCents: z.int().nonnegative(), totalCents: z.int().nonnegative(),
});
export type MemberWalkInQuote = z.infer<typeof memberQuoteSchema>;

export async function quoteMemberWalkIn(input: unknown): Promise<{ quote: MemberWalkInQuote } | { error: string }> {
  const parsed = memberQuoteRequest.safeParse(input);
  if (!parsed.success) return { error: "Choose a valid booking time and customer account." };
  try {
    if (!(await getSession()).staff) return { error: "Staff access is required." };
    const quote = parsed.data;
    const db = await createClient();
    const args = {
      p_customer: quote.customerId, p_date: quote.bookingDate, p_start: quote.startHour,
      p_quantity: quote.equipmentQuantity,
    };
    const { data, error } = quote.kind === "open_play"
      ? await db.rpc("pos_quote_member_open_play_walk_in", { ...args, p_people: quote.people })
      : await db.rpc("pos_quote_member_walk_in", { ...args, p_duration: quote.duration });
    if (error) return { error: error.code === "PGRST202"
      ? `Apply migration ${quote.kind === "open_play" ? "046" : "045"} to enable this member walk-in.` : bookingError(error) };
    const result = memberQuoteSchema.safeParse(data);
    return result.success ? { quote: result.data } : { error: "The member price couldn’t be checked. Try again." };
  } catch {
    return { error: "The member price couldn’t be checked. Try again." };
  }
}

const memberWalkInPayment = financeBookingSchema.and(z.object({
  key: id, member_id: id, reference: z.string().trim().max(40), verified: z.literal(true),
  collectedCents: z.int().nonnegative().max(9_999_999_999), expected_total_cents: z.int().nonnegative().max(9_999_999_999),
}));

export async function bookAccountWalkIn(input: unknown, openPlay: boolean): Promise<{ id?: string; error?: string }> {
  const omit = { expected_total_cents: true, customer_name: true, customer_phone: true } as const;
  const schedule = openPlay ? openPlaySchema.omit(omit) : bookingSchema.omit(omit);
  const parsed = schedule.and(memberWalkInPayment).safeParse(input);
  if (!parsed.success || parsed.data.start_hour === undefined) return { error: "Check the customer, booking, and payment details." };
  try {
    if (!(await getSession()).staff) return { error: "Staff access is required." };
    const booking = parsed.data;
    const db = await createClient();
    const passes = "participant_count" in booking;
    const { data, error } = await db.rpc("pos_book_account_walk_in", {
      p_key: booking.key, p_customer: booking.member_id, p_date: booking.booking_date,
      p_kind: passes ? "open_play" : "court", p_start: booking.start_hour, p_court: passes ? null : booking.court_id,
      p_duration: passes ? 1 : booking.duration, p_people: passes ? booking.participant_count : 1,
      p_quantity: booking.equipment_quantity ?? Number(booking.equipment_rental), p_payment_option: booking.payment_option,
      p_method: booking.payment_method, p_reference: booking.reference, p_verified: booking.verified,
      p_collected_cents: booking.collectedCents, p_expected_total_cents: booking.expected_total_cents,
      p_notes: booking.finance_notes,
    });
    if (error) return { error: error.code === "PGRST202"
      ? "Apply migration 047 to book a linked walk-in." : bookingError(error) };
    const saved = id.safeParse(data);
    if (!saved.success) return { error: "Couldn’t confirm the walk-in. Check Reservations before starting another booking." };
    for (const path of ["/staff", "/admin", "/book", "/admin/finance", "/my-bookings/all"])
      revalidatePath(path);
    return { id: saved.data };
  } catch {
    return { error: "Connection interrupted. Retry the same walk-in before starting another booking." };
  }
}

export async function posCommand(
  input: unknown,
): Promise<{ ok: true; receipt?: Sale } | { error: string }> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const db = await createClient();
    const {
      data: { user },
      error: authError,
    } = await readVerifiedUser(db.auth);
    if (isAuthRetryableFetchError(authError)) {
      return { error: "Sign-in verification is temporarily unavailable. Try again in a moment." };
    }
    if (authError || !user) return { error: "Please sign in again." };
    const c = parsed.data;
    // The close RPC verifies ownership even during a change of cashier duty.
    if (c.op !== "close") {
      const { data: allowed } = await db.rpc("is_club_staff");
      if (!allowed) return { error: "Staff tools are available to the front desk staff member assigned for today." };
    }
    let rpc: string;
    let args: Record<string, unknown>;
    switch (c.op) {
      case "checkout":
        rpc = "pos_checkout";
        args = { p_request: c.payload };
        break;
      case "product":
        rpc = c.photo === undefined ? "pos_save_product" : "pos_save_product_with_photo";
        args = { p_product: c.payload, ...(c.photo !== undefined && { p_photo: c.photo }) };
        break;
      case "stock":
        rpc = "pos_adjust_stock";
        args = { p_product: c.id, p_quantity: c.quantity, p_reason: c.reason };
        break;
      case "open":
        rpc = "pos_open_shift";
        args = { p_opening: c.amount };
        break;
      case "close":
        rpc = "pos_close_shift";
        args = { p_shift: c.id, p_counted: c.amount };
        break;
      case "verify":
        rpc = "pos_verify_booking";
        args = { p_booking: c.id };
        break;
      case "reject_payment":
        rpc = "pos_reject_booking_payment";
        args = { p_booking: c.id, p_reason: c.reason };
        break;
      case "balance":
        rpc = "pos_collect_balance";
        args = {
          p_booking: c.id,
          p_method: c.method,
          p_reference: c.reference,
        };
        break;
      case "refund":
        rpc = "pos_refund";
        args = {
          p_sale: c.id,
          p_method: c.method,
          p_reason: c.reason,
          p_restock: c.restock,
        };
        break;
    }
    const { data, error } = await db.rpc(rpc, args);
    if (error) {
      if (c.op === "product" && c.photo !== undefined && error.code === "PGRST202")
        return { error: "Apply migration 038 to save product photos." };
      const match = error.message.match(/(?:POS|Booking):\s*([\s\S]+)/);
      return {
        error: match ? posMessage(match[1]) : (c.op === "open" || c.op === "close"
          ? "The shift could not be updated. Refresh the register and try again."
          : c.op === "reject_payment"
          ? "The reference could not be rejected. Refresh to check the booking status before retrying."
          : "The operation could not be completed. Check database setup and your permissions. For a checkout retry, keep the same cart."),
      };
    }
    revalidatePath("/staff");
    revalidatePath("/admin");
    revalidatePath("/admin/finance");
    revalidatePath("/my-bookings/all");
    if (c.op === "close") revalidatePath("/my-bookings");
    revalidatePath("/booking/[id]", "page");
    if (c.op === "reject_payment" || c.op === "refund") revalidatePath("/book");
    if (c.op === "refund") {
      revalidatePath(membershipReviewPath);
      revalidatePath(membershipApplyPath);
      revalidatePath("/account");
    }
    return {
      ok: true,
      ...(c.op === "checkout" ? { receipt: data as Sale } : {}),
    };
  } catch {
    return {
      error:
        parsed.data.op === "open" || parsed.data.op === "close"
          ? "Connection interrupted. Refresh the register to check the shift status."
          : parsed.data.op === "reject_payment"
          ? "Connection interrupted. Refresh to check the booking status before retrying."
          : "Connection interrupted. Retry the same checkout to check its saved result before starting another sale.",
    };
  }
}
