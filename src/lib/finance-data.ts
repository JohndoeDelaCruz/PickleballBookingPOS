import "server-only";
import { createClient } from "./supabase/server";
import { getCourtInventory } from "./data";
import {
  financePageSize,
  type FinanceBooking,
  type FinanceDay,
  type FinanceDayNotes,
} from "./finance";

export async function readFinanceMonth(month: string) {
  const client = await createClient();
  const [inventory, { data, error }] = await Promise.all([
    getCourtInventory(),
    client.rpc("get_finance_month", { p_month: `${month}-01` }),
  ]);
  if (!inventory.loaded) throw new Error("Court details could not be loaded.");
  if (error) throw error;
  if (!data?.length) throw new Error("No finance summary returned.");
  const days = data as FinanceDay[];
  const byDate = new Map(days.map((day) => [day.report_date, day]));
  for (let offset = 0; ; offset += 500) {
    const breakdown = await client.rpc("get_court_finance_month", { p_month: `${month}-01` })
      .order("report_date").order("court_id").range(offset, offset + 499);
    if (breakdown.error) {
      if (!inventory.ready && offset === 0 && inventory.courts.every((court) => court.id <= 2) &&
        ["PGRST202", "42883"].includes(breakdown.error.code)) return days;
      throw breakdown.error;
    }
    if (offset === 0) for (const day of days) day.court_totals = {};
    for (const row of breakdown.data ?? []) {
      const day = byDate.get(row.report_date);
      if (day) day.court_totals![row.court_id] = { sales: Number(row.sales), hours: Number(row.hours) };
    }
    if (!breakdown.data || breakdown.data.length < 500) break;
  }
  return days;
}
export async function readFinanceDayNotes(
  date: string,
): Promise<FinanceDayNotes> {
  const client = await createClient();
  const { data, error } = await client
    .from("finance_day_notes")
    .select("report_date,worker_on_duty,manager_notes")
    .eq("report_date", date)
    .maybeSingle();
  if (error) throw error;
  return data || { report_date: date, worker_on_duty: "", manager_notes: "" };
}
export async function readFinanceBookings(date: string, page: number) {
  const client = await createClient();
  const { data, error, count } = await client
    .from("bookings")
    .select("*,booking_finance(payment_method,notes)", { count: "exact" })
    .eq("booking_date", date)
    .neq("status", "blocked")
    .order("start_hour")
    .order("id")
    .range((page - 1) * financePageSize, page * financePageSize - 1);
  if (error) throw error;
  return { bookings: (data || []) as FinanceBooking[], count: count || 0 };
}
export async function readAllFinanceBookings(date: string) {
  const client = await createClient();
  const bookings: FinanceBooking[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await client
      .from("bookings")
      .select("*,booking_finance(payment_method,notes)")
      .eq("booking_date", date)
      .neq("status", "blocked")
      .order("start_hour")
      .order("id")
      .range(offset, offset + 499);
    if (error) throw error;
    bookings.push(...((data || []) as FinanceBooking[]));
    if (!data || data.length < 500) return bookings;
  }
}
