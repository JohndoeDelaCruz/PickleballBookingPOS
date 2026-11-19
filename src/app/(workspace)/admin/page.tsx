import { Suspense } from "react";
import { getSession, getVenue } from "@/lib/data";
import { localDate, addDays, isValidDate } from "@/lib/booking";
import { createClient } from "@/lib/supabase/server";
import { AdminCalendar } from "@/components/admin-calendar";
import { WorkspaceRouteLoading } from "@/components/workspace-route-loading";
import type { CalendarBooking } from "@/lib/types";
import { getRegisterDay } from "@/lib/register-data";
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const params = await searchParams;
  const today = localDate();
  const date =
    isValidDate(params.date) &&
    params.date >= addDays(today, -365) &&
    params.date <= addDays(today, 30)
      ? params.date
      : today;
  return (
    <Suspense key={date} fallback={<WorkspaceRouteLoading />}>
      <CalendarData date={date} />
    </Suspense>
  );
}

async function CalendarData({ date }: { date: string }) {
  const { user, staff, role } = await getSession();
  if (!staff) return null;
  const manager = role !== "cashier";
  const venueRequest = getVenue();
  const registerRequest = getRegisterDay(date);
  const supabase = await createClient();
  await supabase.rpc("expire_unpaid_holds");
  const [result, { venue }, register] = await Promise.all([
    readCalendarBookings(supabase, date, manager),
    venueRequest,
    registerRequest,
  ]);
  if (!result)
    return (
      <div className="error-message">
        We couldn’t load the calendar. Please refresh and try again.
      </div>
    );
  return (
    <AdminCalendar
      bookings={result}
      date={date}
      venue={venue}
      manager={manager}
      register={register}
      operator={user?.email ?? "Signed-in staff"}
    />
  );
}

async function readCalendarBookings(
  supabase: Awaited<ReturnType<typeof createClient>>,
  date: string,
  manager: boolean,
) {
  const batchSize = 500;
  const bookings: CalendarBooking[] = [];
  let lastId: string | undefined;

  // The grid and session counts need the full day, even past the API row limit.
  for (;;) {
    const base = manager
      ? supabase.from("bookings").select("*").eq("booking_date", date)
      : supabase.rpc("pos_calendar_reservations", { p_date: date });
    const query = base.order("id").limit(batchSize);
    const { data, error } = await (lastId ? query.gt("id", lastId) : query);
    if (error) return null;
    bookings.push(...(data as CalendarBooking[]));
    if (data.length < batchSize) return bookings.sort((a, b) => a.start_hour - b.start_hour);
    lastId = data[data.length - 1].id;
  }
}
