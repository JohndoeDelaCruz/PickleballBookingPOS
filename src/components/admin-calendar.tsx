"use client";
import { WorkspacePageHeading } from "./workspace-page-heading";
import type { CSSProperties } from "react";
import { activeCourts, calendarCourts, courtName, defaultCourts } from "@/lib/courts";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, Check, Plus, X, Wallet } from "lucide-react";
import {
  addDays,
  formatDate,
  formatHour,
  localDate,
  money,
  courtScheduleLabel,
  openPlayCapacityLabel,
  equipmentBookingLabel,
  calculateCourtTotal,
  calculateReservationTotal,
  privateEquipmentLimit,
} from "@/lib/booking";
import { statusLabels, type Booking, type VenueSettings } from "@/lib/types";
import {
  staffCreateBooking,
  staffSetStatus,
  reserveOpenPlay,
} from "@/app/actions";
import { Modal } from "./modal";
import { paymentMethods } from "@/lib/finance";
import { EquipmentRental } from "./equipment-rental";
import { bookingPayments } from "@/lib/payment";
import { BalancePaymentModal } from "./balance-payment-modal";
import { resolveSchedule, scheduleHours } from "@/lib/schedule";

export function AdminCalendar({
  bookings,
  date,
  venue,
}: {
  bookings: Booking[];
  date: string;
  venue: VenueSettings;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const courts = calendarCourts(venue.courts ?? defaultCourts, bookings);
  const [balanceBooking, setBalanceBooking] = useState<Booking | null>(null);
  const [action, setAction] = useState<{
    booking: Booking;
    status: "confirmed" | "cancelled";
  } | null>(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const active = bookings.filter(
    (b) => !["cancelled", "expired"].includes(b.status),
  );
  const schedule = resolveSchedule(venue, date);
  const sessions = schedule.blocks.filter(
    (block) => block.kind === "open_play",
  );
  const hours = [
    ...new Set([
      ...scheduleHours(schedule.blocks),
      ...active.flatMap((b) =>
        Array.from({ length: b.duration }, (_, i) => b.start_hour + i),
      ),
    ]),
  ].sort((a, b) => a - b);
  function update() {
    if (!action) return;
    setError("");
    startTransition(async () => {
      const result = await staffSetStatus(action.booking.id, action.status);
      if (result.error) setError(result.error);
      else {
        setAction(null);
        router.refresh();
      }
    });
  }
  return (
    <>
      <WorkspacePageHeading title="Court calendar" actions={
        <button
          className="button button-dark button-small"
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={16} />
          Add booking or block
        </button>
      } />
      <div className="admin-stats">
        <div className="panel stat-card">
          <span>Active reservations</span>
          <strong>{active.filter((b) => b.status !== "blocked").length}</strong>
        </div>
        <div className="panel stat-card">
          <span>Payments to review</span>
          <strong>
            {active.filter((b) => b.status === "awaiting_verification").length}
          </strong>
        </div>
        <div className="panel stat-card">
          <span>Confirmed booking value</span>
          <strong>
            {money(
              active
                .filter((b) => b.status === "confirmed")
                .reduce((sum, b) => sum + Number(b.total_amount), 0),
            )}
          </strong>
        </div>
      </div>
      <div className="admin-toolbar">
        <h2>
          {formatDate(date, {
            weekday: "short",
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        </h2>
        <label className="field">
          <span>View date</span>
          <input
            type="date"
            value={date}
            min={addDays(localDate(), -365)}
            max={addDays(localDate(), 30)}
            onChange={(e) =>
              e.target.value && router.push(`/admin?date=${e.target.value}`)
            }
          />
        </label>
      </div>
      {schedule.override && (
        <div className="notice" style={{ marginBottom: 20 }}>
          {schedule.override.name} · through{" "}
          {formatDate(schedule.override.end_date)}. Regular hours resume{" "}
          {formatDate(addDays(schedule.override.end_date, 1))}.
        </div>
      )}
      {!hours.length && (
        <div className="notice" style={{ marginBottom: 20 }}>
          No scheduled court time on this date.
        </div>
      )}
      <div className="availability-grid dynamic-court-grid" style={{ marginBottom: 28, "--court-columns": Math.max(1, courts.length) } as CSSProperties}>
        <div className="availability-header">
          <div>PHT / UTC+8</div>
          {courts.map((court) => <div key={court.id}>{court.name}{!court.active && " · Inactive"}</div>)}
        </div>
        {hours.map((hour) => (
          <div className="availability-row" key={hour}>
            <div className="time-label">{formatHour(hour)}</div>
            {courts.map(({ id: court }) => {
              const b = active.find(
                (b) =>
                  b.court_id === court &&
                  hour >= b.start_hour &&
                  hour < b.start_hour + b.duration,
              );
              return (
                <div className="slot-cell" key={court}>
                  {b ? (
                    <span
                      className={`status-badge status-${b.status}`}
                      style={{
                        display: "flex",
                        justifyContent: "center",
                        minHeight: 34,
                        borderRadius: 4,
                        fontSize: 14,
                      }}
                    >
                      {b.status === "blocked"
                        ? b.customer_name
                        : `${b.customer_name} · ${statusLabels[b.status]}`}
                    </span>
                  ) : (
                    <span
                      style={{
                        display: "flex",
                        justifyContent: "center",
                        alignItems: "center",
                        height: 34,
                        fontSize: 14,
                        color: "var(--muted)",
                      }}
                    >
                      {courtScheduleLabel(venue, date, hour) || "—"}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {sessions.map((session) => (
        <div className="notice" style={{ marginBottom: 24 }} key={session.id}>
          <span>
            <strong>
              Open play · {formatHour(session.start)}–{formatHour(session.end)}
            </strong>
            <br />
            {active
              .filter(
                (b) =>
                  b.booking_type === "open_play" &&
                  b.start_hour === session.start &&
                  b.duration === session.end - session.start,
              )
              .reduce((sum, b) => sum + b.participant_count, 0)}{" "}
            players held or confirmed · {money(session.rate)} per person ·{" "}
            {openPlayCapacityLabel(session.capacity)}
          </span>
        </div>
      ))}
      <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "22px 24px" }}>
          <h3 style={{ fontSize: 17, margin: 0 }}>
            Reservations & payment review
          </h3>
          <p className="small-print">
            Check incoming transactions in GCash before confirming. Cancelling a
            paid booking does not issue a refund.
          </p>
        </div>
        {!bookings.length ? (
          <div className="empty-state" style={{ border: 0 }}>
            <CalendarDays />
            <h2>No reservations</h2>
            <p>There are no bookings for this date.</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Player / reference</th>
                  <th>Court & time</th>
                  <th>Amount</th>
                  <th>GCash reference</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <strong>{b.customer_name}</strong>
                      <small>
                        {b.reference}
                        {b.customer_phone && (
                          <>
                            {" "}
                            ·{" "}
                            <a href={`tel:${b.customer_phone}`}>
                              {b.customer_phone}
                            </a>
                          </>
                        )}
                      </small>
                    </td>
                    <td>
                      {b.booking_type === "open_play"
                        ? `Open play · ${b.participant_count} ${b.participant_count === 1 ? "player" : "players"}`
                        : courtName(venue.courts, b.court_id)}
                      <small>
                        {formatHour(b.start_hour)} –{" "}
                        {formatHour(b.start_hour + b.duration)}
                      </small>
                      {b.equipment_rental && (
                        <small>
                          Equipment: {equipmentBookingLabel(b)} ·{" "}
                          {money(b.equipment_amount)}
                        </small>
                      )}
                    </td>
                    <td>
                      {money(b.total_amount)}
                      {b.status !== "blocked" && (
                        <>
                          <small>
                            {b.payment_option === "reservation_fee"
                              ? "50% reservation fee"
                              : "Full payment"}
                          </small>
                          <small>Paid: {money(bookingPayments(b).paid)}</small>
                          {b.status === "confirmed" ? (
                            <small>
                              {bookingPayments(b).balance > 0
                                ? `Balance: ${money(bookingPayments(b).balance)}`
                                : "Fully paid"}
                            </small>
                          ) : (
                            [
                              "awaiting_payment",
                              "awaiting_verification",
                            ].includes(b.status) && (
                              <small>
                                Due now: {money(bookingPayments(b).initial)}
                              </small>
                            )
                          )}
                        </>
                      )}
                    </td>
                    <td>{b.payment_reference || "—"}</td>
                    <td>
                      <span className={`status-badge status-${b.status}`}>
                        {statusLabels[b.status]}
                      </span>
                    </td>
                    <td>
                      <div className="table-actions">
                        {b.status === "confirmed" &&
                          bookingPayments(b).balance > 0 && (
                            <button
                              aria-label={`Record balance for ${b.reference}`}
                              title="Record balance payment"
                              onClick={() => setBalanceBooking(b)}
                            >
                              <Wallet size={16} />
                            </button>
                          )}
                        {["awaiting_payment", "awaiting_verification"].includes(
                          b.status,
                        ) && (
                          <button
                            aria-label={`Confirm ${b.reference}`}
                            title="Confirm after verifying payment"
                            onClick={() => {
                              setAction({ booking: b, status: "confirmed" });
                              setError("");
                            }}
                          >
                            <Check size={15} />
                          </button>
                        )}
                        {!["cancelled", "expired"].includes(b.status) && (
                          <button
                            className="danger"
                            aria-label={`Cancel ${b.reference}`}
                            title="Cancel / release court"
                            onClick={() => {
                              setAction({ booking: b, status: "cancelled" });
                              setError("");
                            }}
                          >
                            <X size={15} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {createOpen && (
        <CreateBookingModal
          date={date}
          venue={venue}
          onClose={() => setCreateOpen(false)}
        />
      )}
      {balanceBooking && (
        <BalancePaymentModal
          booking={balanceBooking}
          onClose={() => setBalanceBooking(null)}
        />
      )}
      {action && (
        <Modal
          title={
            action.status === "confirmed"
              ? "Verify & confirm reservation"
              : "Cancel this reservation?"
          }
          onClose={() => !pending && setAction(null)}
        >
          <p style={{ fontSize: 14, lineHeight: 1.8 }}>
            <strong>
              {action.booking.reference} · {action.booking.customer_name}
            </strong>
            <br />
            {action.booking.booking_type === "open_play"
              ? `Open play · ${action.booking.participant_count} players`
              : `Court ${action.booking.court_id}`}{" "}
            · {formatHour(action.booking.start_hour)} ·{" "}
            {money(action.booking.total_amount)}
          </p>
          {action.status === "confirmed" && (
            <p>
              <strong>
                Verify {money(bookingPayments(action.booking).initial)}
              </strong>
              {action.booking.payment_option === "reservation_fee"
                ? ` reservation fee. Balance at venue: ${money(bookingPayments(action.booking).later)}.`
                : " full payment."}
            </p>
          )}
          <div className="notice notice-warning">
            <span>
              {action.status === "confirmed"
                ? "Confirm only after you have checked that the payment reached your GCash account. A submitted reference alone is not payment verification."
                : "This releases the court. If the customer already paid, arrange any refund directly through GCash according to your policy. This website will not send money."}
            </span>
          </div>
          {error && (
            <div
              className="error-message"
              style={{ marginTop: 15 }}
              role="alert"
            >
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: 12, marginTop: 22 }}>
            <button
              className="button button-dark"
              onClick={update}
              disabled={pending}
            >
              {pending
                ? "Updating…"
                : action.status === "confirmed"
                  ? "Payment checked — confirm"
                  : "Cancel reservation"}
            </button>
            <button
              className="button button-outline"
              onClick={() => setAction(null)}
              disabled={pending}
            >
              Go back
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function CreateBookingModal({
  date,
  venue,
  onClose,
}: {
  date: string;
  venue: VenueSettings;
  onClose: () => void;
}) {
  const courts = activeCourts(venue.courts);
  const [blocked, setBlocked] = useState(false);
  const [openPlay, setOpenPlay] = useState(false);
  const [bookingDate, setBookingDate] = useState(
    date < localDate() ? localDate() : date,
  );
  const [startHour, setStartHour] = useState(6);
  const [sessionStart, setSessionStart] = useState<number | null>(null);
  const [duration, setDuration] = useState(1);
  const [people, setPeople] = useState(1);
  const [requestedEquipmentQuantity, setEquipmentQuantity] = useState(0);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const blocks = resolveSchedule(venue, bookingDate).blocks;
  const sessions = blocks.filter((block) => block.kind === "open_play");
  const startHours = blocked
    ? Array.from({ length: 24 }, (_, i) => i)
    : scheduleHours(blocks).filter((hour) =>
        blocks.some(
          (block) =>
            block.kind === "court" && hour >= block.start && hour < block.end,
        ),
      );
  const selectedHour = startHours.includes(startHour)
    ? startHour
    : startHours[0];
  const selectedSession =
    sessions.find((session) => session.start === sessionStart) ?? sessions[0];
  const base = blocked
    ? selectedHour !== undefined && selectedHour + duration <= 24
      ? 0
      : null
    : openPlay
      ? selectedSession
        ? selectedSession.rate * people
        : null
      : selectedHour === undefined
        ? null
        : calculateCourtTotal(venue, selectedHour, duration, bookingDate);
  const equipmentLimit = openPlay
    ? Math.max(0, Math.min(20, Math.floor(people) || 0))
    : privateEquipmentLimit(venue, bookingDate, selectedHour, duration);
  const equipmentQuantity = blocked
    ? 0
    : Math.min(requestedEquipmentQuantity, equipmentLimit);
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const input = {
      ...Object.fromEntries(form.entries()),
      equipment_rental: equipmentQuantity > 0,
      equipment_quantity: equipmentQuantity,
    };
    startTransition(async () => {
      const result = openPlay
        ? await reserveOpenPlay(input, true)
        : await staffCreateBooking(input, blocked);
      if (result.error) setError(result.error);
      else {
        router.refresh();
        onClose();
      }
    });
  }
  return (
    <Modal title="Add court time" onClose={() => !pending && onClose()}>
      <form onSubmit={submit} className="form-stack">
        <label className="field">
          <span>Reservation type</span>
          <select
            value={openPlay ? "open_play" : "court"}
            onChange={(e) => {
              setOpenPlay(e.target.value === "open_play");
              setBlocked(false);
            }}
          >
            <option value="court">Court booking / block</option>
            <option value="open_play">Confirmed open-play passes</option>
          </select>
        </label>
        {!openPlay && (
          <label className="toggle-field">
            <input
              type="checkbox"
              checked={blocked}
              onChange={(e) => setBlocked(e.target.checked)}
            />
            <span>
              <strong>Block court for maintenance or an event</strong>
              <small>Leave off for a confirmed walk-in reservation.</small>
            </span>
          </label>
        )}
        <div className="field-grid">
          <label className="field">
            <span>Date</span>
            <input
              type="date"
              name="booking_date"
              value={bookingDate}
              onChange={(event) => setBookingDate(event.target.value)}
              min={localDate()}
              max={addDays(localDate(), 30)}
              required
            />
          </label>
          {!openPlay && (
            <label className="field">
              <span>Court</span>
              <select name="court_id">
                {courts.map((court) => <option key={court.id} value={court.id}>{court.name}</option>)}
              </select>
            </label>
          )}
          {openPlay ? (
            <label className="field">
              <span>Number of players</span>
              <input
                type="number"
                name="participant_count"
                min="1"
                max="20"
                value={people}
                onChange={(event) => setPeople(Number(event.target.value))}
                required
              />
            </label>
          ) : (
            <>
              <label className="field">
                <span>Start time</span>
                <select
                  name="start_hour"
                  value={selectedHour ?? ""}
                  onChange={(event) => setStartHour(Number(event.target.value))}
                  required
                  disabled={!startHours.length}
                >
                  {!startHours.length && (
                    <option value="">No private hours</option>
                  )}
                  {startHours.map((h) => (
                    <option value={h} key={h}>
                      {formatHour(h)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Duration</span>
                <select
                  name="duration"
                  value={duration}
                  onChange={(event) => setDuration(Number(event.target.value))}
                >
                  {[1, 2, 3, 4].map((d) => (
                    <option value={d} key={d}>
                      {d} {d === 1 ? "hour" : "hours"}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>
        {openPlay && (
          <label className="field">
            <span>Open-play session</span>
            <select
              name="start_hour"
              value={selectedSession?.start ?? ""}
              onChange={(event) => setSessionStart(Number(event.target.value))}
              required
              disabled={!sessions.length}
            >
              {!sessions.length && (
                <option value="">No sessions on this date</option>
              )}
              {sessions.map((session) => (
                <option value={session.start} key={session.id}>
                  {formatHour(session.start)}–{formatHour(session.end)} ·{" "}
                  {money(session.rate)} / person
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>{blocked ? "Block reason" : "Customer name"}</span>
          <input
            name="customer_name"
            required
            minLength={2}
            maxLength={100}
            placeholder={blocked ? "e.g. Court maintenance" : "Full name"}
          />
        </label>
        {!blocked && (
          <label className="field">
            <span>Customer mobile</span>
            <input
              name="customer_phone"
              type="tel"
              required
              placeholder="09171234567"
            />
          </label>
        )}
        {!blocked && (
          <>
            <EquipmentRental
              price={venue.equipment_rental_price}
              ballCount={venue.equipment_ball_count}
              quantity={equipmentQuantity}
              maxQuantity={equipmentLimit}
              onChange={setEquipmentQuantity}
              disabled={pending}
            />
            <label className="field">
              <span>Payment collected</span>
              <select name="payment_option" defaultValue="full">
                <option value="full">Full payment</option>
                <option value="reservation_fee">50% reservation fee</option>
              </select>
              <small>
                Choose the amount already collected. Any remaining balance is
                due before play.
              </small>
            </label>
            <label className="field">
              <span>Payment received via</span>
              <select name="payment_method" defaultValue="cash">
                {Object.entries(paymentMethods)
                  .filter(([key]) => key !== "unspecified")
                  .map(([key, label]) => (
                    <option value={key} key={key}>
                      {label}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              <span>Staff notes (optional)</span>
              <textarea name="finance_notes" rows={2} maxLength={2000} />
            </label>
          </>
        )}
        {base === null ? (
          <div className="notice notice-warning">
            Choose a time and duration within available private-booking hours,
            or select a scheduled open-play session.
          </div>
        ) : (
          !blocked && (
            <div className="summary-total">
              <span>Booking total</span>
              <strong>
                {money(
                  calculateReservationTotal(
                    base,
                    venue.equipment_rental_price,
                    equipmentQuantity,
                  ),
                )}
              </strong>
            </div>
          )
        )}
        {!blocked && (
          <p className="small-print">
            Walk-ins are saved as confirmed reservations. Record these only
            after collecting the selected payment amount. Open play uses both
            courts; places are checked when saving.
          </p>
        )}
        {error && (
          <div className="error-message" role="alert">
            {error}
          </div>
        )}
        <button
          className="button button-dark"
          disabled={pending || base === null}
        >
          {pending
            ? "Saving…"
            : blocked
              ? "Block court time"
              : openPlay
                ? "Add confirmed open-play passes"
                : "Add confirmed walk-in"}
        </button>
      </form>
    </Modal>
  );
}
