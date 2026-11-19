import writeExcelFile, { type CellObject, type Row } from "write-excel-file/node";
import type { Court } from "./courts";
import {
  courtFinance,
  monthFinanceRows,
  monthLabel,
  reservationFinanceRows,
  sumFinance,
  type FinanceBooking,
  type FinanceDay,
  type FinanceDayNotes,
  type FinanceSummary,
} from "./finance";

const moneyFormat = '"₱"#,##0.00;("₱"#,##0.00);"₱"0.00';
const bodyColor = "#243E32";
const workbookStyle = { fontFamily: "Arial", fontSize: 10 };
const sheetStyle = { showGridLines: false, dateFormat: "mmm d, yyyy" };
const dateCell = (date: string): CellObject => ({ value: new Date(`${date}T00:00:00Z`), align: "left" });
const currency = (value: number): CellObject => ({ value, format: moneyFormat });

function title(text: string): Row {
  return [{ value: text, fontWeight: "bold", fontSize: 16, textColor: bodyColor, height: 29 }];
}

function headerRow(headers: string[]): Row {
  return headers.map((value) => ({
    value,
    fontWeight: "bold",
    textColor: "#FFFFFF",
    backgroundColor: "#214B3A",
    wrap: true,
    height: 31,
    align: "center",
    alignVertical: "center",
  }));
}

function summaryRows(totals: FinanceSummary, courts: Court[]): Row[] {
  const hours = courts.reduce((total, court) => total + courtFinance(totals, court.id).hours, 0);
  const [collectionLabel, amountLabel, activityLabel, countLabel] = headerRow(["Collections", "Amount", "Court activity", "Count"]);
  return [
    [collectionLabel, amountLabel, null, activityLabel, countLabel],
    ["Verified collections", currency(totals.total_sales), null, "Confirmed reservations", Number(totals.confirmed_bookings)],
    ["Confirmed booking value", currency(totals.booking_value), null, "Private court hours", hours],
    ["Unpaid balance", currency(totals.balance_due), null, "Open-play players", Number(totals.open_play_players)],
    ["Pending value", currency(totals.pending_value)],
    ["Open-play collections", currency(totals.open_play_sales)],
    ["Equipment collections", currency(totals.equipment_sales)],
  ];
}

function summaryLabel(value: string): CellObject {
  return { value, fontWeight: "bold", textColor: bodyColor, height: 19 };
}

function wrappedHeight(text: string, width: number) {
  const lines = text.split(/\r?\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / width)), 0);
  return Math.min(400, Math.max(21, 7 + 15 * lines));
}

function noteRow(label: string, value: string): Row {
  return [
    { ...summaryLabel(label), alignVertical: "top" },
    { value: value || "—", type: String, columnSpan: 4, wrap: true, alignVertical: "top", height: wrappedHeight(value, 65) },
    null,
    null,
    null,
  ];
}

function tableData(
  headers: string[],
  rows: (string | number)[][],
  monthly = false,
): Row[] {
  return [
    headerRow(headers),
    ...rows.map((row, index) => {
      const total = monthly && index === rows.length - 1;
      const style: CellObject = {
        backgroundColor: total ? "#E3ECE4" : index % 2 ? "#F3F7F3" : "#FFFFFF",
        alignVertical: "center",
        height: 21,
        ...(total ? { fontWeight: "bold", topBorderStyle: "thin", topBorderColor: "#BACFBF" } : {}),
      };
      return row.map((value, column): CellObject => {
        const heading = headers[column];
        if (typeof value === "number") {
          return { ...style, value, format: heading.endsWith("(PHP)") ? moneyFormat : "#,##0" };
        }
        if (!total && (heading === "Date (PHT)" || heading === "Play date (PHT)")) {
          return { ...style, ...dateCell(value) };
        }
        const width = heading === "Staff notes" ? 33 : heading === "Customer" ? 22 : 0;
        if (width && value) {
          return { ...style, value, type: String, wrap: true, height: wrappedHeight(value, width) };
        }
        return { ...style, value, type: String, ...(heading === "Status" ? { align: "left", indent: 1 } : {}) };
      });
    }),
  ];
}

function columns(widths: number[]) {
  return widths.map((width) => ({ width }));
}

export function dailyFinanceWorkbook(
  bookings: FinanceBooking[], notes: FinanceDayNotes, day: FinanceDay, courts: Court[],
) {
  const [headers, ...rows] = reservationFinanceRows(bookings, courts);
  // Keep the booking and payment columns up front, with supporting details to the right.
  const order = [0, 3, 2, 4, 5, 12, 13, 20, 15, 14, 1, 6, 7, 8, 9, 10, 11, 18, 19, 16, 21, 22, 17];
  const detail = tableData(order.map((i) => String(headers[i])), rows.map((row) => order.map((i) => row[i])));
  return writeExcelFile([
    {
      ...sheetStyle,
      sheet: "Daily summary",
      columns: columns([28, 19, 3, 25, 18]),
      data: [
        title("Daily booking finance"),
        [summaryLabel("Play date (PHT)"), dateCell(day.report_date)],
        noteRow("Worker on duty", notes.worker_on_duty),
        noteRow("Manager notes", notes.manager_notes),
        [],
        ...summaryRows(day, courts),
        [],
        [{ value: "Collections are grouped by play date. Verified payments are allocated proportionally to court or pass fees and equipment. Refunds are outside this report.",
          fontStyle: "italic", textColor: "#53675B", columnSpan: 5, wrap: true, height: 32 }, null, null, null, null],
      ],
    },
    {
      ...sheetStyle,
      sheet: "Reservations",
      columns: columns([18, 24, 22, 12, 12, 17, 18, 16, 24, 16, 17, 13, 13, 19, 17, 12, 16, 23, 17, 23, 17, 23, 38]),
      stickyRowsCount: 1,
      stickyColumnsCount: 2,
      data: detail,
    },
  ], workbookStyle).toBuffer();
}

export function monthlyFinanceWorkbook(days: FinanceDay[], courts: Court[], month: string) {
  const [headers, ...rows] = monthFinanceRows(days, courts);
  const labels = headers.map(String);
  const detail = tableData(labels, rows, true);
  return writeExcelFile([
    {
      ...sheetStyle,
      sheet: "Monthly summary",
      columns: columns([28, 19, 3, 25, 18]),
      data: [
        title("Monthly booking finance"),
        [summaryLabel("Report month (PHT)"), monthLabel(month)],
        [],
        ...summaryRows(sumFinance(days), courts),
      ],
    },
    {
      ...sheetStyle,
      sheet: "Daily breakdown",
      columns: columns(labels.map((label) => Math.max(15, Math.min(21, label.length + 2)))),
      stickyRowsCount: 1,
      stickyColumnsCount: 1,
      data: detail,
    },
  ], workbookStyle).toBuffer();
}
