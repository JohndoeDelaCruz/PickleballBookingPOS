"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, Pencil, RefreshCw } from "lucide-react";
import {
  bookingBaseAmount,
  formatDate,
  formatHour,
  money,
  equipmentBookingLabel,
} from "@/lib/booking";
import {
  bookingFinanceDescription,
  bookingPaymentMethod,
  monthLabel,
  paymentMethods,
  sumFinance,
  courtFinance,
  type FinanceBooking,
  type FinanceDay,
  type FinanceDayNotes,
  type PaymentMethod,
} from "@/lib/finance";
import { financePageSize } from "@/lib/finance";
import { statusLabels } from "@/lib/types";
import { saveBookingFinance, saveFinanceDay } from "@/app/actions";
import { Modal } from "./modal";
import { bookingPayments } from "@/lib/payment";
import { BalancePaymentModal } from "./balance-payment-modal";
import { defaultCourts, type Court } from "@/lib/courts";
import { WorkspaceSkeleton } from "./workspace-skeleton";

type Period = { month: string; date: string; start: string; end: string };
export function FinanceDashboard({
  period,
  days,
  notes,
  bookings,
  count,
  page,
  courts = defaultCourts,
}: {
  period: Period;
  days: FinanceDay[];
  notes: FinanceDayNotes;
  bookings: FinanceBooking[];
  count: number;
  page: number;
  courts?: Court[];
}) {
  const router = useRouter();
  const totals = sumFinance(days);
  const daily = days.find((d) => d.report_date === period.date)!;
  const [editing, setEditing] = useState<FinanceBooking | null>(null);
  const [balanceBooking, setBalanceBooking] = useState<FinanceBooking | null>(
    null,
  );
  const [worker, setWorker] = useState(notes.worker_on_duty);
  const [managerNotes, setManagerNotes] = useState(notes.manager_notes);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const [refreshing, startRefresh] = useTransition();
  const href = (date: string, nextPage = 1) =>
    `/admin/finance?month=${period.month}&date=${date}&page=${nextPage}`;
  function saveNotes(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSaved(false);
    startTransition(async () => {
      const result = await saveFinanceDay({
        report_date: period.date,
        worker_on_duty: worker,
        manager_notes: managerNotes,
      });
      if (result.error) setError(result.error);
      else {
        setSaved(true);
        router.refresh();
      }
    });
  }
  return (
    <>
      <div className="console-page-heading">
        <div>
          <span className="console-kicker">BOOKING FINANCE</span>
          <h1>The numbers behind the courts.</h1>
          <p>Review booking collections, outstanding balances, and daily records.</p>
        </div>
        <div className="finance-actions">
          <button
            className="icon-button"
            aria-label="Refresh finance reports"
            disabled={refreshing}
            onClick={() => startRefresh(() => router.refresh())}
          >
            <RefreshCw size={16} />
          </button>
          <a
            className="button button-dark button-small"
            href={`/admin/finance/export?month=${period.month}`}
            download
          >
            <Download size={15} /> Monthly CSV
          </a>
        </div>
      </div>
      {refreshing && <WorkspaceSkeleton view="finance" heading={false} courtCount={courts.length} />}
      <div hidden={refreshing}>
      <div className="finance-toolbar">
        <div>
          <span className="eyebrow">MONTHLY SUMMARY</span>
          <h3>{monthLabel(period.month)}</h3>
        </div>
        <label className="field">
          <span>Report month</span>
          <input
            type="month"
            value={period.month}
            min="2000-01"
            max="2100-12"
            onChange={(e) =>
              e.target.value &&
              router.push(`/admin/finance?month=${e.target.value}`)
            }
          />
        </label>
      </div>
      <div className="finance-stats">
        <div className="panel stat-card">
          <span>Collected payments</span>
          <strong>{money(totals.total_sales)}</strong>
          <small>
            {totals.confirmed_bookings} confirmed{" "}
            {totals.confirmed_bookings === 1 ? "reservation" : "reservations"}
          </small>
        </div>
        <div className="panel stat-card">
          <span>Private court hours</span>
          <strong>{courts.reduce((sum, court) => sum + courtFinance(totals, court.id).hours, 0)}</strong>
          <small>
            Across {courts.length} court records, including inactive courts
          </small>
        </div>
        <div className="panel stat-card">
          <span>Open-play sales</span>
          <strong>{money(totals.open_play_sales)}</strong>
          <small>{totals.open_play_players} players</small>
        </div>
        <div className="panel stat-card">
          <span>Confirmed booking value</span>
          <strong>{money(totals.booking_value)}</strong>
          <small>Includes unpaid balances</small>
        </div>
        <div className="panel stat-card">
          <span>Balance to collect</span>
          <strong>{money(totals.balance_due)}</strong>
          <small>Due at the venue before play</small>
        </div>
        <div className="panel stat-card">
          <span>Pending value</span>
          <strong>{money(totals.pending_value)}</strong>
          <small>Not yet verified</small>
        </div>
      </div>
      <p className="small-print finance-report-note">
        Collections include verified payments for confirmed reservations,
        assigned to the Philippine play date. Reservation fees count only as the
        amount collected. Unpaid balances are separate. Court/pass and equipment
        collections are allocated proportionally. Cancelled, expired, and
        pending reservations are excluded. Refunds are outside this report.
      </p>
      <section className="panel finance-month-panel">
        <div className="table-scroll">
          <table className="admin-table finance-month-table">
            <caption className="sr-only">
              Daily totals for {monthLabel(period.month)}
            </caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                {courts.map((court) => <th scope="col" key={`sales-${court.id}`}>{court.name} sales</th>)}
                <th scope="col">Open play</th>
                <th scope="col">Equipment</th>
                <th scope="col">Collected</th>
                <th scope="col">Balance due</th>
                {courts.map((court) => <th scope="col" key={`hours-${court.id}`}>{court.name} hours</th>)}
                <th scope="col">Open-play players</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr
                  key={d.report_date}
                  className={
                    d.report_date === period.date ? "finance-selected-day" : ""
                  }
                >
                  <th scope="row">
                    <Link
                      href={href(d.report_date)}
                      aria-current={
                        d.report_date === period.date ? "date" : undefined
                      }
                    >
                      {formatDate(d.report_date, {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      })}
                    </Link>
                  </th>
                  {courts.map((court) => <td key={`sales-${court.id}`}>{money(courtFinance(d, court.id).sales)}</td>)}
                  <td>{money(d.open_play_sales)}</td>
                  <td>{money(d.equipment_sales)}</td>
                  <td>
                    <strong>{money(d.total_sales)}</strong>
                  </td>
                  <td>{money(d.balance_due)}</td>
                  {courts.map((court) => <td key={`hours-${court.id}`}>{courtFinance(d, court.id).hours}</td>)}
                  <td>{d.open_play_players}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Month total</th>
                {courts.map((court) => <td key={`sales-${court.id}`}>{money(courtFinance(totals, court.id).sales)}</td>)}
                <td>{money(totals.open_play_sales)}</td>
                <td>{money(totals.equipment_sales)}</td>
                <td>{money(totals.total_sales)}</td>
                <td>{money(totals.balance_due)}</td>
                {courts.map((court) => <td key={`hours-${court.id}`}>{courtFinance(totals, court.id).hours}</td>)}
                <td>{totals.open_play_players}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
      <section className="finance-daily-section" aria-label="Daily finance log">
        <div className="finance-toolbar">
          <div>
            <span className="eyebrow">DAILY LOG</span>
            <h3>{formatDate(period.date)}</h3>
          </div>
          <div className="finance-actions">
            <label className="field">
              <span>Play date</span>
              <input
                type="date"
                value={period.date}
                min={period.start}
                max={days.at(-1)?.report_date}
                onChange={(e) =>
                  e.target.value && router.push(href(e.target.value))
                }
              />
            </label>
            <a
              className="button button-outline button-small"
              href={`/admin/finance/export?month=${period.month}&date=${period.date}`}
              download
            >
              <Download size={15} /> Daily CSV
            </a>
          </div>
        </div>
        <div className="finance-day-totals">
          {courts.map((court) => <div key={court.id}>
            <span>{court.name} sales{!court.active && " · Inactive"}</span>
            <strong>{money(courtFinance(daily, court.id).sales)}</strong>
            <small>{courtFinance(daily, court.id).hours} private court hours</small>
          </div>)}
          <div>
            <span>Open-play sales</span>
            <strong>{money(daily.open_play_sales)}</strong>
            <small>{daily.open_play_players} players</small>
          </div>
          <div>
            <span>Day’s collections</span>
            <strong>{money(daily.total_sales)}</strong>
            <small>{daily.confirmed_bookings} reservations</small>
          </div>
        </div>
        <p className="small-print">
          Equipment rental sales:{" "}
          <strong>{money(daily.equipment_sales)}</strong>. Included in the day’s
          collections; court and open-play amounts above exclude rental.
        </p>
        <div className="finance-payment-totals">
          {(
            [
              "cash",
              "gcash",
              "bank_transfer",
              "card",
              "other",
              "unspecified",
            ] as const
          ).map((method) => (
            <div key={method}>
              <span>{paymentMethods[method]}</span>
              <strong>{money(daily[`${method}_sales`])}</strong>
            </div>
          ))}
        </div>
        {Number(daily.unspecified_sales) > 0 && (
          <div className="notice notice-warning">
            Some confirmed walk-ins have no recorded payment method. Use “Edit”
            in the daily log to classify them. Their saved amounts are already
            included in sales.
          </div>
        )}
        <form className="panel form-stack finance-notes" onSubmit={saveNotes}>
          <div className="finance-notes-fields">
            <label className="field">
              <span>Worker on duty</span>
              <input
                value={worker}
                onChange={(e) => {
                  setWorker(e.target.value);
                  setSaved(false);
                }}
                maxLength={200}
                placeholder="Name or shift team"
              />
            </label>
            <label className="field">
              <span>Manager review / notes</span>
              <textarea
                value={managerNotes}
                onChange={(e) => {
                  setManagerNotes(e.target.value);
                  setSaved(false);
                }}
                maxLength={4000}
                rows={2}
                placeholder="Notes for this day"
              />
            </label>
          </div>
          {error && (
            <div className="error-message" role="alert">
              {error}
            </div>
          )}
          <div className="finance-actions">
            <button
              className="button button-dark button-small"
              disabled={pending}
            >
              {pending ? "Saving…" : "Save daily notes"}
            </button>
            {saved && (
              <span className="small-print" role="status">
                Daily notes saved.
              </span>
            )}
            <span className="small-print">Visible to staff only.</span>
          </div>
        </form>
        <section className="panel finance-log-panel">
          <div className="table-scroll">
            <table className="admin-table finance-log-table">
              <caption className="sr-only">
                Reservation log for {period.date}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Time / court</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Hours / players</th>
                  <th scope="col">Booking value</th>
                  <th scope="col">Payment</th>
                  <th scope="col">Status</th>
                  <th scope="col">Staff notes</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {bookings.length ? (
                  bookings.map((b) => (
                    <tr key={b.id}>
                      <td>
                        <strong>{bookingFinanceDescription(b, courts)}</strong>
                        <small>
                          {formatHour(b.start_hour)}–
                          {formatHour(b.start_hour + b.duration)}
                        </small>
                      </td>
                      <td>
                        <Link className="text-link" href={`/booking/${b.id}`}>
                          {b.customer_name}
                        </Link>
                        <small>{b.reference}</small>
                      </td>
                      <td>
                        {b.booking_type === "open_play" ? (
                          `${b.participant_count} players`
                        ) : (
                          <>
                            {b.duration} {b.duration === 1 ? "hour" : "hours"}
                            <small>
                              {money(bookingBaseAmount(b) / b.duration)}/hr
                              saved average
                            </small>
                          </>
                        )}
                      </td>
                      <td>
                        {money(b.total_amount)}
                        <small>
                          {b.payment_option === "reservation_fee"
                            ? "50% reservation fee"
                            : "Full payment"}
                        </small>
                        <small>Paid: {money(bookingPayments(b).paid)}</small>
                        {b.status === "confirmed" && (
                          <small>
                            Balance: {money(bookingPayments(b).balance)}
                          </small>
                        )}
                        {b.equipment_rental && (
                          <small>
                            Includes {money(b.equipment_amount)} ·{" "}
                            {equipmentBookingLabel(b)}
                          </small>
                        )}
                      </td>
                      <td>
                        {paymentMethods[bookingPaymentMethod(b)]}
                        {b.payment_reference && (
                          <small>{b.payment_reference}</small>
                        )}
                        {b.balance_payment_method && (
                          <small>
                            Balance: {paymentMethods[b.balance_payment_method]}
                            {b.balance_payment_reference
                              ? ` · ${b.balance_payment_reference}`
                              : ""}
                          </small>
                        )}
                      </td>
                      <td>
                        <span className={`status-badge status-${b.status}`}>
                          {statusLabels[b.status]}
                        </span>
                      </td>
                      <td className="finance-staff-note">
                        {b.booking_finance?.notes || "—"}
                      </td>
                      <td>
                        {b.status === "confirmed" &&
                          bookingPayments(b).balance > 0 && (
                            <button
                              className="text-link"
                              onClick={() => setBalanceBooking(b)}
                            >
                              Record balance
                            </button>
                          )}
                        <button
                          className="text-link"
                          onClick={() => setEditing(b)}
                          aria-label={`Edit finance details for ${b.reference}`}
                        >
                          <Pencil size={13} /> Edit
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={8} className="finance-empty">
                      No reservations for this date. Bookings and paid walk-ins
                      will appear here automatically.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="finance-log-footer">
            <span>
              {count} {count === 1 ? "reservation" : "reservations"} · Day’s
              collections: <strong>{money(daily.total_sales)}</strong>
            </span>
            {count > financePageSize && (
              <div className="finance-actions">
                {page > 1 && (
                  <Link href={href(period.date, page - 1)}>Previous</Link>
                )}
                <span>
                  Page {page} of {Math.ceil(count / financePageSize)}
                </span>
                {page * financePageSize < count && (
                  <Link href={href(period.date, page + 1)}>Next</Link>
                )}
              </div>
            )}
          </div>
        </section>
      </section>
      </div>
      {editing && (
        <FinanceBookingEditor
          booking={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {balanceBooking && (
        <BalancePaymentModal
          booking={balanceBooking}
          onClose={() => setBalanceBooking(null)}
        />
      )}
    </>
  );
}

function FinanceBookingEditor({
  booking: b,
  onClose,
}: {
  booking: FinanceBooking;
  onClose: () => void;
}) {
  const [method, setMethod] = useState<PaymentMethod>(bookingPaymentMethod(b));
  const [notes, setNotes] = useState(b.booking_finance?.notes || "");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    startTransition(async () => {
      const result = await saveBookingFinance({
        booking_id: b.id,
        payment_method: method,
        finance_notes: notes,
      });
      if (result.error) setError(result.error);
      else {
        router.refresh();
        onClose();
      }
    });
  }
  return (
    <Modal
      title="Payment method & staff notes"
      onClose={() => !pending && onClose()}
    >
      <p className="small-print">
        {b.customer_name} · {b.reference} · {money(b.total_amount)}
      </p>
      <form className="form-stack" onSubmit={submit}>
        <label className="field">
          <span>Payment method</span>
          <select
            value={method}
            disabled={Boolean(b.user_id)}
            onChange={(e) => setMethod(e.target.value as PaymentMethod)}
          >
            {Object.entries(paymentMethods).map(([key, label]) => (
              <option value={key} key={key}>
                {label}
              </option>
            ))}
          </select>
          {b.user_id && <small>Online reservations use GCash.</small>}
        </label>
        <label className="field">
          <span>Staff notes</span>
          <textarea
            rows={4}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={2000}
          />
        </label>
        <p className="small-print">
          These notes are visible to staff only. This records the payment
          method; confirmation and cancellation stay in the court calendar.
        </p>
        {error && (
          <div className="error-message" role="alert">
            {error}
          </div>
        )}
        <button className="button button-dark" disabled={pending}>
          {pending ? "Saving…" : "Save finance details"}
        </button>
      </form>
    </Modal>
  );
}
