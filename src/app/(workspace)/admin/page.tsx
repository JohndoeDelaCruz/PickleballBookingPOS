import { Suspense } from "react";
import { getVenue } from "@/lib/data";
import { localDate, addDays, isValidDate } from "@/lib/booking";
import { createClient } from "@/lib/supabase/server";
import { AdminCalendar } from "@/components/admin-calendar";
import { WorkspaceRouteLoading } from "@/components/workspace-route-loading";
import type { Booking } from "@/lib/types";
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
  const supabase = await createClient();
  await supabase.rpc("expire_unpaid_holds");
  const [{ data, error }, { venue }] = await Promise.all([
    supabase
      .from("bookings")
      .select("*")
      .eq("booking_date", date)
      .order("start_hour"),
    getVenue(),
  ]);
  if (error)
    return (
      <div className="error-message">
        We couldn’t load the calendar. Please refresh and try again.
      </div>
    );
  return (
    <AdminCalendar
      bookings={(data || []) as Booking[]}
      date={date}
      venue={venue}
    />
  );
}
