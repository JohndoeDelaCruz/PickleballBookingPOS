"use client";
import type { CSSProperties } from "react";
import { activeCourts, courtName } from "@/lib/courts";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ArrowRight, CalendarDays, Check, Info, RefreshCw } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  addDays,
  canBook,
  calculateCourtTotal,
  calculateReservationTotal,
  formatDate,
  formatHour,
  getPriceBreakdown,
  isPastSlot,
  isSlotAvailable,
  isValidDate,
  localDate,
  money,
  courtScheduleLabel,
  openPlayCapacityLabel,
  equipmentPackageLabel,
  privateEquipmentLimit,
} from "@/lib/booking";
import type { Availability, PaymentOption, VenueSettings } from "@/lib/types";
import { reserveCourt } from "@/app/actions";
import { DateSlider } from "@/components/date-slider";
import { OpenPlayBooking } from "@/components/open-play-booking";
import { EquipmentRental } from "@/components/equipment-rental";
import { PaymentOptions } from "@/components/payment-options";
import {
  resolveSchedule,
  scheduleHours,
  type DaySchedule,
} from "@/lib/schedule";

export function BookingCalendar({
  venue: initialVenue,
  ready,
  signedIn,
  userName,
  initialDate,
  openPlayReady,
  initialOpenPlay = false,
  initialSession,
}: {
  venue: VenueSettings;
  ready: boolean;
  signedIn: boolean;
  userName: string;
  initialDate?: string;
  openPlayReady: boolean;
  initialOpenPlay?: boolean;
  initialSession?: number;
}) {
  const courts = activeCourts(initialVenue.courts);
  const [mode, setMode] = useState<"court" | "open_play">(
    initialOpenPlay ? "open_play" : "court",
  );
  const [today] = useState(localDate);
  const validInitial =
    isValidDate(initialDate) &&
    initialDate >= today &&
    initialDate <= addDays(today, 30)
      ? initialDate
      : today;
  const [date, setDate] = useState(validInitial);
  const [liveSchedule, setLiveSchedule] = useState<{
    date: string;
    schedule: DaySchedule;
  } | null>(null);
  const [selectedSession, setSelectedSession] = useState<number | null>(
    initialSession ?? null,
  );
  const daySchedule =
    liveSchedule?.date === date
      ? liveSchedule.schedule
      : resolveSchedule(initialVenue, date);
  const venue =
    liveSchedule?.date === date
      ? {
          ...initialVenue,
          schedule_config: { weekly: daySchedule.blocks, overrides: [] },
        }
      : initialVenue;
  const openSessions = daySchedule.blocks.filter((b) => b.kind === "open_play");
  const selectedOpenSession =
    openSessions.find((b) => b.start === selectedSession) ?? openSessions[0];
  const [duration, setDuration] = useState(1);
  const [selection, setSelection] = useState<{
    court: number;
    hour: number;
  } | null>(null);
  const [slots, setSlots] = useState<Availability[]>([]);
  const [loading, setLoading] = useState(ready);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [name, setName] = useState(userName);
  const [phone, setPhone] = useState("");
  const [requestedEquipmentQuantity, setEquipmentQuantity] = useState(0);
  const equipmentLimit = privateEquipmentLimit(
    venue,
    date,
    selection?.hour,
    duration,
  );
  const equipmentQuantity = Math.min(
    requestedEquipmentQuantity,
    equipmentLimit,
  );
  const [paymentOption, setPaymentOption] = useState<PaymentOption>("full");
  const [accepted, setAccepted] = useState(false);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [pending, startTransition] = useTransition();
  const summaryRef = useRef<HTMLElement>(null);
  const router = useRouter();
  const open = ready && openPlayReady && canBook(venue);
  const preview = venue.opening_hour === null || venue.closing_hour === null;
  const hours = venue.schedule_config
    ? scheduleHours(daySchedule.blocks)
    : Array.from(
        { length: (venue.closing_hour ?? 22) - (venue.opening_hour ?? 6) },
        (_, i) => i + (venue.opening_hour ?? 6),
      );

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    const client = createClient();
    async function refresh() {
      setLoading(true);
      const [{ data, error: requestError }, scheduleResult] = await Promise.all(
        [
          client.rpc("get_availability", { p_date: date }),
          "schedule_config" in initialVenue
            ? client.rpc("get_booking_schedule", { p_date: date })
            : Promise.resolve({ data: null, error: null }),
        ],
      );
      if (!active) return;
      setLoading(false);
      if (requestError || scheduleResult.error) {
        setLoadError(
          "We couldn’t load live availability. Please try again before reserving.",
        );
        return;
      }
      setLoadError("");
      setSlots(data || []);
      if (scheduleResult.data)
        setLiveSchedule({ date, schedule: scheduleResult.data as DaySchedule });
      const checkedVenue = scheduleResult.data
        ? {
            ...initialVenue,
            schedule_config: {
              weekly: (scheduleResult.data as DaySchedule).blocks,
              overrides: [],
            },
          }
        : initialVenue;
      setSelection((selected) =>
        selected &&
        isSlotAvailable(data || [], selected.court, selected.hour, duration) &&
        calculateCourtTotal(checkedVenue, selected.hour, duration, date) !==
          null
          ? selected
          : null,
      );
    }
    refresh();
    const interval = setInterval(refresh, 30000);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [date, ready, revision, duration, initialVenue]);

  function changeDate(value: string) {
    if (
      !isValidDate(value) ||
      value < today ||
      value > addDays(today, 30) ||
      value === date
    )
      return;
    setDate(value);
    setSelection(null);
    setSelectedSession(null);
    setError("");
  }
  function selectSlot(court: number, hour: number) {
    setSelection({ court, hour });
    setError("");
    if (window.innerWidth < 850)
      summaryRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
  }
  function reserve(event: React.FormEvent) {
    event.preventDefault();
    if (!selection || !accepted || !open) return;
    setError("");
    startTransition(async () => {
      const result = await reserveCourt({
        court_id: selection.court,
        booking_date: date,
        start_hour: selection.hour,
        duration,
        customer_name: name,
        customer_phone: phone,
        equipment_rental: equipmentQuantity > 0,
        equipment_quantity: equipmentQuantity,
        payment_option: paymentOption,
      });
      if (result.error) {
        setError(result.error);
        setRevision((v) => v + 1);
      } else if (result.id) router.push(`/booking/${result.id}`);
    });
  }

  return (
    <div className="booking-layout">
      <div className="booking-main">
        {!open && (
          <div className="notice">
            <Info size={17} />
            <span>
              <strong>Reservations opening soon.</strong>{" "}
              {preview
                ? "This is a preview of the calendar. Our hours and rates will be announced before booking opens."
                : "You can explore the schedule. Reservations will open when the venue is ready."}
            </span>
          </div>
        )}
        {(venue.schedule_config ||
          venue.open_play_enabled ||
          "schedule_config" in initialVenue) && (
          <div
            className="booking-mode-switch"
            role="group"
            aria-label="Reservation type"
          >
            <button
              className={mode === "court" ? "active" : ""}
              aria-pressed={mode === "court"}
              onClick={() => {
                setMode("court");
                setSelection(null);
              }}
            >
              Book a court
            </button>
            <button
              className={mode === "open_play" ? "active" : ""}
              aria-pressed={mode === "open_play"}
              onClick={() => {
                setMode("open_play");
                setSelection(null);
              }}
            >
              Open play
            </button>
          </div>
        )}
        <div className="calendar-toolbar">
          <div>
            <h2>{formatDate(date, { month: "long", year: "numeric" })}</h2>
            <p>
              {preview
                ? "Example hours · not the final schedule"
                : "Choose a date and an available time"}
            </p>
          </div>
          <label className="field">
            <span>Jump to date</span>
            <input
              aria-label="Booking date"
              type="date"
              value={date}
              min={today}
              max={addDays(today, 30)}
              onChange={(event) => changeDate(event.target.value)}
            />
          </label>
        </div>
        <DateSlider today={today} date={date} onChange={changeDate} />
        {daySchedule.override && (
          <div className="notice schedule-period-notice">
            <span>
              <strong>{daySchedule.override.name}</strong> · Temporary schedule
              through {formatDate(daySchedule.override.end_date)}. Regular hours
              resume {formatDate(addDays(daySchedule.override.end_date, 1))}.
            </span>
          </div>
        )}
        {mode === "open_play" ? (
          <OpenPlayBooking
            venue={venue}
            date={date}
            ready={ready && openPlayReady}
            signedIn={signedIn}
            userName={userName}
            selectedStart={selectedSession}
            onSessionChange={setSelectedSession}
          />
        ) : (
          <>
            <div className="notice booking-court-rules">
              <Info size={17} aria-hidden="true" />
              <span>
                Private bookings allow up to{" "}
                <strong>
                  {(selection
                    ? daySchedule.blocks.find(
                        (b) =>
                          b.kind === "court" &&
                          selection.hour >= b.start &&
                          selection.hour < b.end,
                      )?.capacity
                    : null) ?? venue.private_court_capacity}{" "}
                  players per court
                </strong>
                . Optional rental: {money(venue.equipment_rental_price)} per
                session per set:{" "}
                {equipmentPackageLabel(venue.equipment_ball_count)}.{" "}
                <Link
                  href="/court-rules"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="policy-link"
                >
                  Read court rules
                </Link>
                .
              </span>
            </div>
            {openSessions.length > 0 && (
              <div className="notice weekend-schedule-note">
                <Info size={17} />
                <span>
                  {openSessions
                    .map(
                      (s) =>
                        `${formatHour(s.start)}–${formatHour(s.end)} · ${money(s.rate)}/person`,
                    )
                    .join("; ")}
                  .{" "}
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => setMode("open_play")}
                  >
                    Get open-play passes <ArrowRight size={12} />
                  </button>
                </span>
              </div>
            )}
            <div className="calendar-toolbar">
              <label className="field" style={{ width: 175 }}>
                <span>How long are we playing?</span>
                <select
                  value={duration}
                  onChange={(e) => {
                    setDuration(Number(e.target.value));
                    setSelection(null);
                  }}
                >
                  {[1, 2, 3, 4].map((v) => (
                    <option key={v} value={v}>
                      {v} {v === 1 ? "hour" : "hours"}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="icon-button"
                title="Refresh availability"
                aria-label="Refresh availability"
                disabled={loading || !ready}
                onClick={() => setRevision((v) => v + 1)}
              >
                <RefreshCw size={16} />
              </button>
            </div>
            {loadError && (
              <div className="error-message" role="alert">
                {loadError}
              </div>
            )}
            <div className="calendar-legend">
              <span>
                <i className="legend-dot" />
                {open ? "Available" : "Preview slot"}
              </span>
              <span>
                <i className="legend-dot unavailable" />
                Unavailable
              </span>
              <span>
                <i className="legend-dot selected" />
                Your selection
              </span>
              {loading && <span>Updating…</span>}
            </div>
            {!courts.length && <div className="notice">No active courts are available. Please contact the venue.</div>}
            <div className="availability-grid dynamic-court-grid" aria-busy={loading}
              style={{ "--court-columns": courts.length, display: courts.length ? undefined : "none" } as CSSProperties}>
              <div className="availability-header booking-court-header">
                <div>PHT / UTC+8</div>
                {courts.map(({ id: court, name }) => (
                  <div className="court-column-heading" key={court}>
                    <div className="court-column-photo">
                      <Image
                        src="/images/rally-courts-v2.webp"
                        alt={`Concept image for ${name}`}
                        fill
                        sizes="(max-width: 650px) 35vw, (max-width: 850px) 40vw, 30vw"
                      />
                      <span className="court-column-label">{name}</span>
                    </div>
                  </div>
                ))}
              </div>
              {hours.map((hour) => (
                <div className="availability-row" key={hour}>
                  <div className="time-label">{formatHour(hour)}</div>
                  {openSessions.some((s) => hour >= s.start && hour < s.end)
                    ? (() => {
                        const session = openSessions.find(
                          (s) => hour >= s.start && hour < s.end,
                        )!;
                        return (
                          <div className="slot-cell open-play-grid-cell">
                            <button
                              type="button"
                              className="open-play-grid-button"
                              disabled={
                                loading ||
                                Boolean(loadError) ||
                                isPastSlot(date, session.end, now)
                              }
                              aria-label={`Join open play, ${formatHour(session.start)} to ${formatHour(session.end)}`}
                              onClick={() => {
                                setSelectedSession(session.start);
                                setMode("open_play");
                              }}
                            >
                              Open play · Join session{" "}
                              {hour === session.start && (
                                <small>
                                  {formatHour(session.start)}–
                                  {formatHour(session.end)} ·{" "}
                                  {money(session.rate)}/person
                                </small>
                              )}
                            </button>
                          </div>
                        );
                      })()
                    : courts.map(({ id: court }) => {
                        const past = isPastSlot(date, hour, now);
                        const fits =
                          calculateCourtTotal(venue, hour, duration, date) !==
                          null;
                        const available =
                          fits && isSlotAvailable(slots, court, hour, duration);
                        const selected =
                          selection?.court === court && selection.hour === hour;
                        const sessionLabel = courtScheduleLabel(
                          venue,
                          date,
                          hour,
                          duration,
                        );
                        const disabled =
                          !available ||
                          past ||
                          loading ||
                          Boolean(loadError) ||
                          Boolean(sessionLabel);
                        return (
                          <div className="slot-cell" key={court}>
                            <button
                              type="button"
                              className={`slot-button ${selected ? "active" : ""}`}
                              disabled={disabled}
                              aria-label={`${courtName(venue.courts, court)}, ${formatHour(hour)}, ${sessionLabel || (past ? "past" : !fits ? "outside hours" : !available ? "unavailable" : "available")}`}
                              aria-pressed={selected}
                              onClick={() => selectSlot(court, hour)}
                            >
                              {sessionLabel ? (
                                sessionLabel
                              ) : selected ? (
                                <>
                                  <Check size={12} />
                                  Selected
                                </>
                              ) : past ? (
                                "Past"
                              ) : !fits ? (
                                "Outside hours"
                              ) : !available ? (
                                "Reserved"
                              ) : open ? (
                                "Available"
                              ) : (
                                "Preview"
                              )}
                            </button>
                          </div>
                        );
                      })}
                </div>
              ))}
              {!hours.length && (
                <div className="empty-state">
                  <h3>No sessions scheduled</h3>
                  <p>The venue is closed on this date. Choose another date.</p>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      <aside
        className="panel booking-sidebar"
        ref={summaryRef}
        style={{ scrollMarginTop: 110 }}
      >
        <span className="eyebrow">YOUR NEXT GAME</span>
        <h3 style={{ marginTop: 12 }}>Booking summary</h3>
        <p>Good times start with a plan.</p>
        {mode === "open_play" ? (
          <div className="open-play-sidebar">
            <CalendarDays size={38} />
            <h3>
              {selectedOpenSession
                ? `${formatHour(selectedOpenSession.start)}–${formatHour(selectedOpenSession.end)}`
                : "No session scheduled"}
            </h3>
            <p>
              {formatDate(date, {
                weekday: "long",
                month: "short",
                day: "numeric",
              })}
            </p>
            {selectedOpenSession && (
              <strong>
                {money(selectedOpenSession.rate)} / person / session
              </strong>
            )}
            {selectedOpenSession && (
              <p>
                One pass covers the session. Share the active courts and rotate
                between games.
              </p>
            )}
            {selectedOpenSession && (
              <p>{openPlayCapacityLabel(selectedOpenSession.capacity)}.</p>
            )}
          </div>
        ) : !selection ? (
          <div className="summary-placeholder">
            <CalendarDays size={38} />
            <p>
              Choose a court and time
              <br />
              to see your booking here.
            </p>
          </div>
        ) : (
          <>
            <dl className="summary-rows">
              <div>
                <dt>Court</dt>
                <dd>{courtName(venue.courts, selection.court)}</dd>
              </div>
              <div>
                <dt>Date</dt>
                <dd>{formatDate(date, { month: "short", day: "numeric" })}</dd>
              </div>
              <div>
                <dt>Time</dt>
                <dd>
                  {formatHour(selection.hour)} –{" "}
                  {formatHour(selection.hour + duration)}
                </dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>
                  {duration} {duration === 1 ? "hour" : "hours"}
                </dd>
              </div>
              {getPriceBreakdown(venue, selection.hour, duration, date).map(
                (part) => (
                  <div key={part.start}>
                    <dt>
                      {formatHour(part.start)} – {formatHour(part.end)}
                    </dt>
                    <dd>
                      {part.hours} {part.hours === 1 ? "hr" : "hrs"} ×{" "}
                      {money(part.rate)}
                    </dd>
                  </div>
                ),
              )}
            </dl>
            <EquipmentRental
              price={venue.equipment_rental_price}
              ballCount={venue.equipment_ball_count}
              quantity={equipmentQuantity}
              maxQuantity={equipmentLimit}
              onChange={setEquipmentQuantity}
              disabled={pending}
            />
            <dl className="summary-rows equipment-cost-rows">
              <div>
                <dt>Court subtotal</dt>
                <dd>
                  {money(
                    calculateCourtTotal(
                      venue,
                      selection.hour,
                      duration,
                      date,
                    ) ?? 0,
                  )}
                </dd>
              </div>
              <div>
                <dt>Equipment rental</dt>
                <dd>
                  {money(equipmentQuantity * venue.equipment_rental_price)}
                </dd>
              </div>
            </dl>
            <div className="summary-total">
              <span>Booking total</span>
              <strong>
                {calculateCourtTotal(venue, selection.hour, duration, date) !==
                null
                  ? money(
                      calculateReservationTotal(
                        calculateCourtTotal(
                          venue,
                          selection.hour,
                          duration,
                          date,
                        )!,
                        venue.equipment_rental_price,
                        equipmentQuantity,
                      ),
                    )
                  : "To be announced"}
              </strong>
            </div>
            <PaymentOptions
              total={calculateReservationTotal(
                calculateCourtTotal(venue, selection.hour, duration, date) ?? 0,
                venue.equipment_rental_price,
                equipmentQuantity,
              )}
              value={paymentOption}
              onChange={setPaymentOption}
              disabled={pending}
            />
            {!open ? (
              <div className="notice">
                <Info size={16} />
                <span>
                  Booking will open once our rates, hours, and GCash details are
                  ready.
                </span>
              </div>
            ) : !signedIn ? (
              <>
                <Link
                  className="button button-dark"
                  href={`/login?next=${encodeURIComponent(`/book?court=${selection.court}&date=${date}`)}`}
                >
                  Sign in to reserve <ArrowRight size={16} />
                </Link>
                <p className="small-print">
                  Availability is rechecked when you reserve.
                </p>
              </>
            ) : (
              <form onSubmit={reserve} className="form-stack">
                <label className="field">
                  <span>Full name</span>
                  <input
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    minLength={2}
                    maxLength={100}
                  />
                </label>
                <label className="field">
                  <span>Mobile number</span>
                  <input
                    type="tel"
                    autoComplete="tel"
                    placeholder="09171234567"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    required
                  />
                </label>
                <label
                  style={{
                    display: "flex",
                    gap: 9,
                    fontSize: 14,
                    lineHeight: 1.8,
                  }}
                >
                  <input
                    type="checkbox"
                    required
                    checked={accepted}
                    onChange={(e) => setAccepted(e.target.checked)}
                  />
                  <span>
                    I agree to the{" "}
                    <a
                      href="#booking-policy"
                      style={{ textDecoration: "underline" }}
                    >
                      booking and cancellation policy
                    </a>{" "}
                    and the{" "}
                    <Link
                      href="/court-rules"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="policy-link"
                    >
                      court rules
                    </Link>
                    .
                  </span>
                </label>
                {error && (
                  <div className="error-message" role="alert">
                    {error}
                  </div>
                )}
                <button
                  className="button button-dark"
                  disabled={
                    pending || loading || Boolean(loadError) || !accepted
                  }
                >
                  {pending ? "Reserving…" : "Reserve & view GCash QR"}
                  <ArrowRight size={16} />
                </button>
                <p className="small-print">
                  Your slot is held for {venue.hold_minutes} minutes. Submit
                  your GCash reference before the deadline. Staff confirms after
                  checking payment.
                </p>
              </form>
            )}
          </>
        )}
        <details style={{ marginTop: 23 }} id="booking-policy">
          <summary style={{ fontSize: 14, color: "var(--muted)" }}>
            Booking & cancellation policy
          </summary>
          <p className="small-print">{venue.cancellation_policy}</p>
          <Link
            href="/court-rules"
            target="_blank"
            rel="noopener noreferrer"
            className="text-link policy-link"
          >
            Read the full court rules
          </Link>
          <p className="small-print">
            Unpaid holds expire after {venue.hold_minutes} minutes. Submitted
            payments stay pending for staff verification. Contact the venue if
            you paid after your hold expired.
          </p>
        </details>
      </aside>
    </div>
  );
}
