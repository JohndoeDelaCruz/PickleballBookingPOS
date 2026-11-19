import { getSession, getCourtInventory } from "@/lib/data";
import { dayCsv, isReportMonth, monthCsv } from "@/lib/finance";
import { dailyFinanceWorkbook, monthlyFinanceWorkbook } from "@/lib/finance-workbook";
import {
  readAllFinanceBookings,
  readFinanceDayNotes,
  readFinanceMonth,
} from "@/lib/finance-data";
import { isValidDate } from "@/lib/booking";

export async function GET(request: Request) {
  const { user, staff, role } = await getSession();
  if (!user || !staff || role === "cashier")
    return new Response("Staff access is required.", {
      status: user ? 403 : 401,
    });
  const params = new URL(request.url).searchParams;
  const month = params.get("month");
  const date = params.get("date");
  const format = params.get("format") ?? "csv";
  if (
    !isReportMonth(month) ||
    (date && (!isValidDate(date) || !date.startsWith(month)))
  )
    return new Response("Choose a valid report period.", { status: 400 });
  if (format !== "csv" && format !== "xlsx")
    return new Response("Choose CSV or Excel.", { status: 400 });
  try {
    const days = await readFinanceMonth(month);
    const { courts } = await getCourtInventory();
    let body: string | Uint8Array<ArrayBuffer>;
    if (date) {
      const [bookings, notes] = await Promise.all([
        readAllFinanceBookings(date),
        readFinanceDayNotes(date),
      ]);
      const day = days.find((entry) => entry.report_date === date);
      if (!day) throw new Error("The selected day is missing from the finance report.");
      body = format === "xlsx"
        ? new Uint8Array(await dailyFinanceWorkbook(bookings, notes, day, courts))
        : dayCsv(bookings, notes, courts);
    } else {
      body = format === "xlsx"
        ? new Uint8Array(await monthlyFinanceWorkbook(days, courts, month))
        : monthCsv(days, courts);
    }
    return new Response(body, {
      headers: {
        "Content-Type": format === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="rally-${date ? "daily" : "monthly"}-finance-${date || month}.${format}"`,
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
