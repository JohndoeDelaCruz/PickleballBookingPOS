import { z } from "zod";
import {
  addDays,
  formatDate,
  formatHour,
  isValidDate,
  localDate,
  bookingBaseAmount,
  savedEquipmentQuantity,
} from "./booking";
import type { Booking } from "./types";
import { bookingPayments } from "./payment";
import { courtName, defaultCourts, type Court } from "./courts";

export const paymentMethods = {
  cash: "Cash",
  gcash: "GCash",
  bank_transfer: "Bank transfer",
  card: "Card",
  other: "Other",
  unspecified: "Not recorded",
} as const;
export type PaymentMethod = keyof typeof paymentMethods;
export const financePageSize = 50;
export const financeBookingSchema = z.object({
  payment_method: z
    .enum(["cash", "gcash", "bank_transfer", "card", "other", "unspecified"])
    .default("cash"),
  finance_notes: z.string().trim().max(2000).default(""),
});
export const financeDaySchema = z.object({
  report_date: z.iso
    .date()
    .refine(
      (value) => value >= "2000-01-01" && value <= "2100-12-31",
      "Choose a date from 2000 to 2100.",
    ),
  worker_on_duty: z.string().trim().max(200),
  manager_notes: z.string().trim().max(4000),
});
export type FinanceDayNotes = z.infer<typeof financeDaySchema>;
export type FinanceBooking = Booking & {
  booking_finance: { payment_method: PaymentMethod; notes: string } | null;
};
export const financeMetrics = [
  "court_1_sales",
  "court_2_sales",
  "open_play_sales",
  "total_sales",
  "court_1_hours",
  "court_2_hours",
  "open_play_players",
  "cash_sales",
  "gcash_sales",
  "bank_transfer_sales",
  "card_sales",
  "other_sales",
  "unspecified_sales",
  "pending_value",
  "confirmed_bookings",
  "equipment_sales",
  "booking_value",
  "balance_due",
] as const;
export type CourtFinance = { sales: number; hours: number };
export type FinanceSummary = Record<(typeof financeMetrics)[number], number> & { court_totals?: Record<string, CourtFinance> };
export type FinanceDay = FinanceSummary & { report_date: string };
export function sumFinance(days: FinanceDay[]): FinanceSummary {
  const totals: FinanceSummary = Object.fromEntries(
    financeMetrics.map((key) => [
      key,
      days.reduce((sum, day) => sum + Math.round(Number(day[key]) * 100), 0) /
        100,
    ]),
  ) as Record<(typeof financeMetrics)[number], number>;
  const ids = new Set(days.flatMap((day) => Object.keys(day.court_totals ?? {})));
  if (ids.size) totals.court_totals = Object.fromEntries([...ids].map((id) => [id, {
    sales: days.reduce((sum, day) => sum + Math.round((day.court_totals?.[id]?.sales ?? 0) * 100), 0) / 100,
    hours: days.reduce((sum, day) => sum + (day.court_totals?.[id]?.hours ?? 0), 0),
  }]));
  return totals;
}
export function courtFinance(day: FinanceSummary, id: number): CourtFinance {
  return day.court_totals?.[id] ?? (id === 1 ? { sales: day.court_1_sales, hours: day.court_1_hours }
    : id === 2 ? { sales: day.court_2_sales, hours: day.court_2_hours } : { sales: 0, hours: 0 });
}
export function isReportMonth(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 7 &&
    /^20\d{2}-(0[1-9]|1[0-2])$|^2100-(0[1-9]|1[0-2])$/.test(value)
  );
}
export function reportPeriod(month?: string, date?: string) {
  const today = localDate();
  const selectedMonth = isReportMonth(month) ? month : today.slice(0, 7);
  const start = `${selectedMonth}-01`;
  const end = addDays(start, 32).slice(0, 7) + "-01";
  const selectedDate =
    isValidDate(date) && date.startsWith(selectedMonth)
      ? date
      : today.startsWith(selectedMonth)
        ? today
        : start;
  return { month: selectedMonth, date: selectedDate, start, end };
}
export function bookingPaymentMethod(b: FinanceBooking): PaymentMethod {
  return (
    b.booking_finance?.payment_method ?? (b.user_id ? "gcash" : "unspecified")
  );
}
export function bookingFinanceDescription(b: FinanceBooking, courts?: Court[]) {
  return b.booking_type === "open_play"
    ? `Open play · ${b.participant_count} ${b.participant_count === 1 ? "player" : "players"}`
    : courtName(courts, b.court_id);
}
// Neutralize spreadsheet formulas in names/notes without changing numeric data.
export function toCsv(rows: (string | number)[][]) {
  return (
    "\uFEFF" +
    rows
      .map((row) =>
        row
          .map((value) => {
            let text = String(value);
            if (
              typeof value === "string" &&
              /^[\s\u0000-\u001f]*[=+\-@]/.test(text)
            )
              text = "'" + text;
            return `"${text.replaceAll('"', '""')}"`;
          })
          .join(","),
      )
      .join("\r\n")
  );
}
export function monthCsv(days: FinanceDay[], courts: Court[] = defaultCourts) {
  const headers = [
    "Date (PHT)",
    ...courts.map((court) => `${court.name} sales (PHP)`),
    "Open-play sales (PHP)",
    "Verified collections (PHP)",
    ...courts.map((court) => `${court.name} hours`),
    "Open-play players",
    "Cash (PHP)",
    "GCash (PHP)",
    "Bank transfer (PHP)",
    "Card (PHP)",
    "Other (PHP)",
    "Not recorded (PHP)",
    "Pending value (PHP)",
    "Confirmed reservations",
    "Equipment rental sales (PHP)",
    "Confirmed booking value (PHP)",
    "Unpaid balance (PHP)",
  ];
  const fields = financeMetrics.slice(6);
  const totals = sumFinance(days);
  const values = (day: FinanceSummary) => [
    ...courts.map((c) => courtFinance(day, c.id).sales), day.open_play_sales, day.total_sales,
    ...courts.map((c) => courtFinance(day, c.id).hours), ...fields.map((key) => Number(day[key])),
  ];
  return toCsv([
    headers,
    ...days.map((d) => [d.report_date, ...values(d)]),
    ["MONTH TOTAL", ...values(totals)],
  ]);
}
export function dayCsv(bookings: FinanceBooking[], notes: FinanceDayNotes, courts?: Court[]) {
  return toCsv([
    ["Play date (PHT)", notes.report_date],
    ["Worker on duty", notes.worker_on_duty],
    ["Manager notes", notes.manager_notes],
    [
      "Amounts are assigned to play date. Collections include verified payments only; unpaid balances are separate. Equipment collections are allocated proportionally. Refunds are not tracked here.",
    ],
    [],
    [
      "Reference",
      "Play date (PHT)",
      "Court / session",
      "Customer",
      "Start (PHT)",
      "End (PHT)",
      "Private court hours",
      "Open-play players",
      "Saved average hourly rate (PHP)",
      "Court/pass subtotal (PHP)",
      "Equipment sets",
      "Equipment charge (PHP)",
      "Booking value (PHP)",
      "Verified collections (PHP)",
      "Payment method",
      "Status",
      "GCash reference",
      "Staff notes",
      "Payment option",
      "Initial payment due (PHP)",
      "Unpaid balance (PHP)",
      "Balance payment method",
      "Balance payment reference",
    ],
    ...bookings.map((b) => [
      b.reference,
      b.booking_date,
      bookingFinanceDescription(b, courts),
      b.customer_name,
      formatHour(b.start_hour),
      formatHour(b.start_hour + b.duration),
      b.booking_type === "court" ? b.duration : 0,
      b.booking_type === "open_play" ? b.participant_count : 0,
      b.booking_type === "court"
        ? Math.round((bookingBaseAmount(b) * 100) / b.duration) / 100
        : "",
      bookingBaseAmount(b),
      savedEquipmentQuantity(b),
      Number(b.equipment_amount || 0),
      Number(b.total_amount),
      b.status === "confirmed" ? bookingPayments(b).paid : 0,
      paymentMethods[bookingPaymentMethod(b)],
      b.status,
      b.payment_reference || "",
      b.booking_finance?.notes || "",
      b.payment_option === "reservation_fee"
        ? "50% reservation fee"
        : "Full payment",
      bookingPayments(b).initial,
      b.status === "confirmed" ? bookingPayments(b).balance : 0,
      b.balance_payment_method ? paymentMethods[b.balance_payment_method] : "",
      b.balance_payment_reference || "",
    ]),
  ]);
}
export function monthLabel(month: string) {
  return formatDate(`${month}-01`, { month: "long", year: "numeric" });
}
