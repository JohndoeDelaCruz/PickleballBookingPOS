"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { bookingSchema, openPlaySchema, settingsSchema } from "@/lib/booking";
import { getVenue } from "@/lib/data";
import { financeBookingSchema, financeDaySchema } from "@/lib/finance";
import { z } from "zod";
import { balancePaymentSchema } from "@/lib/payment";
import { venueSettingPatch } from "@/lib/venue-setting";
import { scheduleConfigSchema } from "@/lib/schedule";
import { courtSchema, deleteCourtSchema, type Court } from "@/lib/courts";

export async function deleteCourt(input: unknown): Promise<{ deletedId?: number; error?: string }> {
  const parsed = deleteCourtSchema.safeParse(input);
  if (!parsed.success) return { error: "Reload the courts before deleting one." };
  try {
    const db = await staffClient();
    const { data, error } = await db.rpc("delete_court", {
      p_id: parsed.data.id, p_revision: parsed.data.revision,
    });
    if (error) return { error: error.message.startsWith("Booking:")
      ? bookingError(error)
      : error.code === "PGRST202"
        ? "Court deletion needs the latest database update. Apply migration 015 in Supabase first."
        : "The court could not be deleted. Refresh the courts and try again." };
    if (data?.id !== parsed.data.id) return { error: "The court could not be deleted. Refresh the courts and try again." };
    revalidatePath("/", "layout");
    return { deletedId: data.id };
  } catch (error) { return { error: (error as Error).message }; }
}

export async function saveCourt(input: unknown): Promise<{ court?: Court; error?: string }> {
  const parsed = courtSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const db = await staffClient();
    const c = parsed.data;
    const { data, error } = await db.rpc("save_court", {
      p_id: c.id, p_name: c.name, p_active: c.active, p_revision: c.revision,
    });
    if (error) return { error: error.message.startsWith("Booking:")
      ? bookingError(error) : "Court changes could not be saved. Please check that court management is set up and try again." };
    revalidatePath("/", "layout");
    return { court: data as Court };
  } catch (error) { return { error: (error as Error).message }; }
}
import {
  bookingError,
  requestCustomerBooking,
  type CustomerBookingAction,
  type CustomerBookingResult,
} from "@/lib/customer-request";

async function customerRequest(
  action: CustomerBookingAction,
  input: unknown,
  validationError?: string,
): Promise<CustomerBookingResult> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { error: "Please sign in before continuing." };
    return await requestCustomerBooking(
      supabase,
      action,
      input,
      validationError,
    );
  } catch {
    return {
      error: "We couldn’t complete that request. Please refresh and try again.",
    };
  }
}

export async function reserveCourt(input: unknown) {
  const parsed = bookingSchema.safeParse(input);
  const result = await customerRequest(
    "reserve_court",
    parsed.success ? parsed.data : null,
    parsed.success ? undefined : parsed.error.issues[0].message,
  );
  if (result.error) return result;
  revalidatePath("/book");
  revalidatePath("/my-bookings");
  revalidatePath("/admin/finance");
  return result;
}

export async function reserveOpenPlay(input: unknown, walkIn = false) {
  const parsed = openPlaySchema.safeParse(input);
  if (!walkIn) {
    const result = await customerRequest(
      "reserve_open_play",
      parsed.success ? parsed.data : null,
      parsed.success ? undefined : parsed.error.issues[0].message,
    );
    if (result.error) return result;
    revalidatePath("/book");
    revalidatePath("/admin");
    revalidatePath("/my-bookings");
    revalidatePath("/admin/finance");
    return result;
  }
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  if (!(await getVenue()).openPlayReady)
    return { error: "Open-play reservations aren’t available yet." };
  try {
    const supabase = await staffClient();
    const p = parsed.data;
    if (p.start_hour === undefined)
      return { error: "Choose an open-play session." };
    const finance = financeBookingSchema.safeParse(input);
    if (!finance.success) return { error: finance.error.issues[0].message };
    const { data, error } = await supabase.rpc(
      "reserve_staff_equipment_booking",
      {
        p_payment_option: p.payment_option,
        p_kind: "open_play",
        p_rental: p.equipment_rental,
        p_quantity: p.equipment_quantity ?? Number(p.equipment_rental),
        p_date: p.booking_date,
        ...(p.start_hour === undefined ? {} : { p_start: p.start_hour }),
        p_people: p.participant_count,
        p_name: p.customer_name,
        p_phone: p.customer_phone,
        p_method: finance.data.payment_method,
        p_notes: finance.data.finance_notes,
      },
    );
    if (error) return { error: bookingError(error) };
    revalidatePath("/book");
    revalidatePath("/admin");
    revalidatePath("/my-bookings");
    revalidatePath("/admin/finance");
    return { id: data as string };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export async function submitPayment(bookingId: string, reference: string) {
  const parsed = z
    .object({
      booking_id: z.uuid(),
      reference: z
        .string()
        .trim()
        .regex(
          /^[a-zA-Z0-9 -]{6,40}$/,
          "Enter a valid GCash reference number (6–40 characters).",
        ),
    })
    .safeParse({ booking_id: bookingId, reference });
  const result = await customerRequest(
    "payment",
    parsed.success ? parsed.data : null,
    parsed.success ? undefined : parsed.error.issues[0].message,
  );
  if (result.error) return result;
  revalidatePath(`/booking/${bookingId}`);
  revalidatePath("/my-bookings");
  revalidatePath("/admin/finance");
  return result;
}

export async function cancelBooking(bookingId: string) {
  const parsed = z.uuid().safeParse(bookingId);
  const result = await customerRequest(
    "cancel",
    parsed.success ? { booking_id: parsed.data } : null,
    parsed.success ? undefined : "Choose a valid reservation.",
  );
  if (result.error) return result;
  revalidatePath("/my-bookings");
  revalidatePath(`/booking/${bookingId}`);
  revalidatePath("/admin/finance");
  return result;
}

async function staffClient() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Please sign in.");
  const { data } = await supabase.rpc("is_staff");
  if (!data) throw new Error("Staff access is required.");
  return supabase;
}

export async function saveSettings(input: unknown) {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const supabase = await staffClient();
    const { error } = await supabase
      .from("venue_settings")
      .update(parsed.data)
      .eq("id", true);
    if (error)
      return {
        error: error.message.includes("Booking:")
          ? bookingError(error)
          : "Settings could not be saved. Apply the latest database migration, then try again.",
      };
    revalidatePath("/", "layout");
    return { success: true };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export async function saveSchedule(input: unknown, expected: unknown) {
  const parsed = scheduleConfigSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const previous =
    expected === null
      ? { success: true as const, data: null }
      : scheduleConfigSchema.safeParse(expected);
  if (!previous.success)
    return { error: "Reload your saved schedule before making changes." };
  try {
    const supabase = await staffClient();
    const { error } = await supabase.rpc("save_booking_schedule", {
      p_config: parsed.data,
      p_expected: previous.data,
    });
    if (error)
      return {
        error: error.message.includes("Booking:")
          ? bookingError(error)
          : "The schedule could not be saved. Check that the latest database migration has been applied.",
      };
    revalidatePath("/", "layout");
    return { success: true };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export async function saveVenueSetting(key: unknown, value: unknown) {
  try {
    const supabase = await staffClient();
    const { data: current, error: readError } = await supabase
      .from("venue_settings")
      .select("*")
      .eq("id", true)
      .single();
    if (readError || !current)
      return {
        error: "Your saved settings could not be loaded. Please try again.",
      };
    const parsed = venueSettingPatch(current, key, value);
    if (!parsed.data) return { error: parsed.error };
    const { error } = await supabase
      .from("venue_settings")
      .update(parsed.data)
      .eq("id", true)
      .select("id")
      .single();
    if (error)
      return {
        error: error.message.includes("Booking:")
          ? bookingError(error)
          : "This setting could not be applied. Please try again.",
      };
    revalidatePath("/", "layout");
    return { success: true };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export async function staffSetStatus(
  id: string,
  status: "confirmed" | "cancelled",
) {
  if (!["confirmed", "cancelled"].includes(status))
    return { error: "Invalid booking status." };
  try {
    const supabase = await staffClient();
    const { error } = await supabase.rpc("staff_update_booking", {
      p_booking: id,
      p_status: status,
    });
    if (error) return { error: bookingError(error) };
    revalidatePath("/admin");
    revalidatePath("/my-bookings");
    revalidatePath(`/booking/${id}`);
    revalidatePath("/admin/finance");
    return { success: true };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export async function staffCreateBooking(input: unknown, blocked: boolean) {
  const parsed = (
    blocked ? bookingSchema.omit({ customer_phone: true }) : bookingSchema
  ).safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const finance = financeBookingSchema.safeParse(input);
  if (!finance.success) return { error: finance.error.issues[0].message };
  if (!(await getVenue()).openPlayReady)
    return {
      error:
        "Apply the weekend open-play database migration before adding new bookings.",
    };
  try {
    const supabase = await staffClient();
    const p = parsed.data;
    const { error } = await supabase.rpc("reserve_staff_equipment_booking", {
      p_payment_option: blocked ? "full" : p.payment_option,
      p_kind: "court",
      p_rental: p.equipment_rental,
      p_quantity: blocked
        ? 0
        : (p.equipment_quantity ?? Number(p.equipment_rental)),
      p_court: p.court_id,
      p_date: p.booking_date,
      p_start: p.start_hour,
      p_duration: p.duration,
      p_name: p.customer_name,
      p_phone: "customer_phone" in p ? p.customer_phone : "",
      p_blocked: blocked,
      p_method: finance.data.payment_method,
      p_notes: finance.data.finance_notes,
    });
    if (error) return { error: bookingError(error) };
    revalidatePath("/admin");
    revalidatePath("/book");
    revalidatePath("/admin/finance");
    return { success: true };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export async function staffRecordBalance(input: unknown) {
  const parsed = balancePaymentSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const supabase = await staffClient();
    const p = parsed.data;
    const { error } = await supabase.rpc("staff_record_balance", {
      p_booking: p.booking_id,
      p_method: p.payment_method,
      p_reference: p.reference,
    });
    if (error) return { error: bookingError(error) };
    revalidatePath("/admin");
    revalidatePath("/admin/finance");
    revalidatePath("/my-bookings");
    revalidatePath(`/booking/${p.booking_id}`);
    return { success: true };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export async function saveFinanceDay(input: unknown) {
  const parsed = financeDaySchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const supabase = await staffClient();
    const p = parsed.data;
    const { error } = await supabase.rpc("staff_save_finance_day", {
      p_date: p.report_date,
      p_worker: p.worker_on_duty,
      p_notes: p.manager_notes,
    });
    if (error) return { error: bookingError(error) };
    revalidatePath("/admin/finance");
    return { success: true };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export async function saveBookingFinance(input: unknown) {
  const parsed = financeBookingSchema
    .extend({ booking_id: z.uuid() })
    .safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const supabase = await staffClient();
    const p = parsed.data;
    const { error } = await supabase.rpc("staff_save_booking_finance", {
      p_booking: p.booking_id,
      p_method: p.payment_method,
      p_notes: p.finance_notes,
    });
    if (error) return { error: bookingError(error) };
    revalidatePath("/admin/finance");
    return { success: true };
  } catch (error) {
    return { error: (error as Error).message };
  }
}
