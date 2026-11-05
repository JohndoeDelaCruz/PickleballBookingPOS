import { getSession, getCourtInventory } from "@/lib/data";
import { dayCsv, isReportMonth, monthCsv } from "@/lib/finance";
import {
  readAllFinanceBookings,
  readFinanceDayNotes,
  readFinanceMonth,
} from "@/lib/finance-data";
import { isValidDate } from "@/lib/booking";

export async function GET(request: Request) {
  const { user, staff } = await getSession();
  if (!user || !staff)
    return new Response("Staff access is required.", {
      status: user ? 403 : 401,
    });
  const params = new URL(request.url).searchParams;
  const month = params.get("month");
  const date = params.get("date");
  if (
    !isReportMonth(month) ||
    (date && (!isValidDate(date) || !date.startsWith(month)))
  )
    return new Response("Choose a valid report period.", { status: 400 });
  try {
    const days = await readFinanceMonth(month);
    const { courts } = await getCourtInventory();
    const csv = date
      ? dayCsv(
          await readAllFinanceBookings(date),
          await readFinanceDayNotes(date),
          courts,
        )
      : monthCsv(days, courts);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="rally-${date ? "daily" : "monthly"}-finance-${date || month}.csv"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response(
      "The report couldn’t be downloaded. Please refresh and try again.",
      { status: 503 },
    );
  }
}
