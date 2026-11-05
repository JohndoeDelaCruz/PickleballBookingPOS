import test from "node:test";
import assert from "node:assert/strict";
import {
  financeDaySchema,
  isReportMonth,
  reportPeriod,
  sumFinance,
  toCsv,
  monthCsv,
  financeMetrics,
  type FinanceDay,
  dayCsv,
  type FinanceBooking,
} from "../src/lib/finance";

test("finance periods handle leap months, year boundaries, invalid dates, and selected play dates", () => {
  assert.deepEqual(reportPeriod("2028-02", "2028-02-29"), {
    month: "2028-02",
    date: "2028-02-29",
    start: "2028-02-01",
    end: "2028-03-01",
  });
  assert.equal(reportPeriod("2028-12", "2028-12-31").end, "2029-01-01");
  assert.equal(reportPeriod("2028-02", "2028-02-30").date, "2028-02-01");
  assert.equal(reportPeriod("2028-02", "2028-03-01").date, "2028-02-01");
  for (const value of [
    "2028-13",
    "1999-01",
    "2101-01",
    "2028-2",
    "2028-02<script>",
    "2028-02\n",
  ])
    assert.equal(isReportMonth(value), false);
  assert.equal(
    financeDaySchema.safeParse({
      report_date: "1999-01-01",
      worker_on_duty: "",
      manager_notes: "",
    }).success,
    false,
  );
});
test("finance CSV preserves centavos, reconciles columns, escapes quoted notes, and neutralizes spreadsheet formulas", () => {
  const day = (date: string, amount: number) =>
    ({
      ...Object.fromEntries(financeMetrics.map((k) => [k, 0])),
      report_date: date,
      court_1_sales: amount,
      total_sales: amount,
      court_1_hours: 1,
      confirmed_bookings: 1,
    }) as FinanceDay;
  const days = [day("2028-02-01", 100.1), day("2028-02-02", 200.2)];
  assert.equal(sumFinance(days).total_sales, 300.3);
  assert.equal(sumFinance(days).court_1_hours, 2);
  const csv = monthCsv(days);
  assert.ok(csv.startsWith('\uFEFF"Date (PHT)"'));
  assert.ok(csv.includes('"MONTH TOTAL","300.3","0","0","300.3","2"'));
  const text = toCsv([
    [
      '=HYPERLINK("https://example.com")',
      " +SUM(1,2)",
      "@command",
      'A, B\n"note"',
      100.25,
    ],
  ]);
  assert.ok(text.includes('"\'=HYPERLINK(""https://example.com"")"'));
  assert.ok(text.includes('"\' +SUM(1,2)"'));
  assert.ok(text.includes('"\'@command"'));
  assert.ok(text.includes('"A, B\n""note"""'));
  assert.ok(text.endsWith('"100.25"'));
});
test("daily CSV separates a verified reservation fee from booking value and the unpaid balance", () => {
  const b = {
    reference: "AP-FEE",
    booking_date: "2026-10-25",
    booking_type: "court",
    court_id: 1,
    customer_name: "Fee Player",
    start_hour: 8,
    duration: 1,
    participant_count: 1,
    total_amount: 130,
    equipment_rental: true,
    equipment_amount: 30,
    status: "confirmed",
    payment_option: "reservation_fee",
    initial_payment_amount: 65,
    paid_amount: 65,
    payment_reference: "FEE-REFERENCE",
    booking_finance: { payment_method: "gcash", notes: "" },
    balance_payment_method: null,
    balance_payment_reference: null,
  } as FinanceBooking;
  const csv = dayCsv([b], {
    report_date: "2026-10-25",
    worker_on_duty: "",
    manager_notes: "",
  });
  assert.ok(csv.includes('"130","65","GCash","confirmed"'));
  assert.ok(csv.includes('"50% reservation fee","65","65"'));
  const settled = dayCsv(
    [{ ...b, paid_amount: 130, balance_payment_method: "cash" }],
    { report_date: "2026-10-25", worker_on_duty: "", manager_notes: "" },
  );
  assert.ok(settled.includes('"50% reservation fee","65","0","Cash"'));
});
