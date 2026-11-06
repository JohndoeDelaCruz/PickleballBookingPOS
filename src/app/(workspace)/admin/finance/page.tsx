import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getSession, getCourtInventory } from "@/lib/data";
import { reportPeriod } from "@/lib/finance";
import {
  readFinanceMonth,
  readFinanceDayNotes,
  readFinanceBookings,
} from "@/lib/finance-data";
import { FinanceDashboard } from "@/components/finance-dashboard";
import { WorkspaceRouteLoading } from "@/components/workspace-route-loading";

export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; date?: string; page?: string }>;
}) {
  const { user, staff } = await getSession();
  if (!user) redirect("/login?next=/admin/finance");
  if (!staff) redirect("/my-bookings");
  const params = await searchParams;
  const period = reportPeriod(params.month, params.date);
  const page = Math.max(1, Math.min(100000, Number(params.page) || 1)) | 0;
  return <Suspense key={`${period.date}:${page}`} fallback={<WorkspaceRouteLoading />}>
    <FinanceData period={period} page={page} />
  </Suspense>;
}

async function FinanceData({ period, page }: { period: ReturnType<typeof reportPeriod>; page: number }) {
  try {
    // Keep expiration before the daily log, while unrelated reads run alongside it.
    const monthRequest = readFinanceMonth(period.month);
    const [days, notes, { bookings, count }, inventory] = await Promise.all([
      monthRequest,
      readFinanceDayNotes(period.date),
      monthRequest.then(() => readFinanceBookings(period.date, page)),
      getCourtInventory(),
    ]);
    return (
      <FinanceDashboard
        courts={inventory.courts}
        key={`${period.date}:${page}`}
        period={period}
        days={days}
        notes={notes}
        bookings={bookings}
        count={count}
        page={page}
      />
    );
  } catch {
    return (
      <div className="error-message" role="alert">
        Finance reports couldn’t be loaded. Please refresh and try again.
      </div>
    );
  }
}
