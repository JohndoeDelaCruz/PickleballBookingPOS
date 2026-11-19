"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, CalendarDays, Plus } from "lucide-react";
import { addDays, courtScheduleLabel, formatDate, formatHour, isPastSlot, localDate, money } from "@/lib/booking";
import { activeCourts, calendarCourts, defaultCourts } from "@/lib/courts";
import type { RegisterDay as RegisterData } from "@/lib/register";
import { resolveSchedule, scheduleHours, type ScheduleBlock } from "@/lib/schedule";
import { bookingStatusLabel, type CalendarBooking, type VenueSettings } from "@/lib/types";
import { reservationsForDateHref } from "@/lib/workspace";
import { CreateBookingModal } from "./create-booking-modal";
import { RegisterControl } from "./register-day";
import { StaffCancelBookingModal } from "./staff-cancel-booking-modal";
import { TablePagination, useTablePage } from "./table-pagination";
import { useAnimatedModal } from "./use-animated-modal";
import { WorkspacePageHeading } from "./workspace-page-heading";
import styles from "./admin-calendar.module.css";

type CalendarRow = { hour: number; session?: ScheduleBlock };

export function AdminCalendar({ bookings, date, venue, manager, register, operator }: {
  bookings: CalendarBooking[];
  date: string;
  venue: VenueSettings;
  manager: boolean;
  register: RegisterData | null;
  operator: string;
}) {
  const router = useRouter();
  const [createOpen, setCreateOpen, createClosing] = useAnimatedModal<true>();
  const [blockedBooking, setBlockedBooking, releaseClosing] = useAnimatedModal<CalendarBooking>();
  const [walkInSaved, setWalkInSaved] = useState(false);
  const courts = calendarCourts(venue.courts ?? defaultCourts, bookings);
  const activeCourtCount = activeCourts(venue.courts).length;
  const activeBookings = bookings.filter(({ status }) => status !== "cancelled" && status !== "expired");
  const privateBookings = activeBookings.filter(({ booking_type }) => booking_type === "court");
  const schedule = resolveSchedule(venue, date);
  const sessions = schedule.blocks.filter(({ kind }) => kind === "open_play");
  const hours = [...new Set([
    ...scheduleHours(schedule.blocks),
    ...activeBookings.flatMap(({ start_hour, duration }) =>
      Array.from({ length: duration }, (_, offset) => start_hour + offset)),
  ])].sort((a, b) => a - b);
  const rows = hours.flatMap<CalendarRow>((hour) => {
    const session = sessions.find(({ start, end }) => start <= hour && hour < end);
    if (!session) return [{ hour }];
    const entries: CalendarRow[] = hour === session.start ? [{ hour, session }] : [];
    // A court block can close an open-play session. Keep affected court slots visible.
    if (privateBookings.some((booking) => overlaps(booking, hour, hour + 1))) entries.push({ hour });
    return entries;
  });
  const pagination = useTablePage(rows.length, date);

  return <div className={styles.calendar}>
    <WorkspacePageHeading title="Court calendar" actions={<>
      <label className="console-date">
        <CalendarDays size={16} aria-hidden="true" />
        <input type="date" aria-label="View date" value={date}
          min={addDays(localDate(), -365)} max={addDays(localDate(), 30)}
          onChange={(event) => event.target.value && router.push(`/admin?date=${event.target.value}`)} />
      </label>
      <button type="button" className="console-button primary" onClick={() => {
        setWalkInSaved(false);
        setCreateOpen(true);
      }}>
        <Plus size={16} aria-hidden="true" /> {manager ? "Add booking or block" : "Add walk-in"}
      </button>
    </>} />
    <div className={styles.dayBar}>
      <div>
        <h2><time dateTime={date}>{formatDate(date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</time></h2>
        <span>Philippine time</span>
      </div>
      {register && <RegisterControl compact data={register} shift={register.active?.own_shift ?? undefined} operator={operator} ready />}
    </div>
    {walkInSaved && <p className="success-message" role="status">Walk-in booking saved.</p>}
    {schedule.override && <p className={styles.override}>
      {schedule.override.name} · through {formatDate(schedule.override.end_date)}.
      {" "}Regular hours resume {formatDate(addDays(schedule.override.end_date, 1))}.
    </p>}
    {courts.length > 0 && rows.length > 0 ? <section className="console-panel">
      <div id="calendar-court-slots" tabIndex={-1} role="region" aria-label="Court calendar time slots" className={styles.schedule}>
        <table className={styles.table} style={courts.length > 2 ? { minWidth: 72 + courts.length * 136 } : undefined}>
          <colgroup><col className={styles.timeColumn} />{courts.map(({ id }) => <col key={id} />)}</colgroup>
          <thead><tr>
            <th scope="col">Time</th>
            {courts.map(({ id, name, active }) => <th scope="col" key={id}>{name}{!active && <small>Inactive</small>}</th>)}
          </tr></thead>
          <tbody>{rows.slice(pagination.start, pagination.end).map(({ hour, session }) => {
            if (session) {
              const players = activeBookings
                .filter((b) => b.booking_type === "open_play" && b.start_hour === session.start && b.start_hour + b.duration === session.end)
                .reduce((sum, b) => sum + b.participant_count, 0);
              const conflict = privateBookings.some((b) => overlaps(b, session.start, session.end));
              return <tr key={session.id}>
                <th scope="row">{formatHour(hour)}</th>
                <td colSpan={courts.length}>
                  <div className={`${styles.slot} ${styles.openPlay}`}>
                    <div>
                      <strong>{activeCourtCount === 2 ? "Open play · both courts" : "Open play"}</strong>
                      <small>{formatHour(session.start)}–{formatHour(session.end)} · {money(session.rate)} / person</small>
                    </div>
                    <div className={styles.capacity}>
                      <strong>{session.capacity === null ? `${players} reserved` : `${players} / ${session.capacity} players`}</strong>
                      {session.capacity === null && <small>No player limit</small>}
                      {conflict && <small>Court reserved or blocked</small>}
                    </div>
                  </div>
                </td>
              </tr>;
            }
            const available = schedule.blocks.some((block) => block.kind === "court" && hour >= block.start && hour < block.end);
            const emptyLabel = sessions.some(({ start, end }) => start <= hour && hour < end) ? "Unavailable" : available
              ? isPastSlot(date, hour) ? "Past time" : "Available"
              : courtScheduleLabel(venue, date, hour) ?? "Closed";
            return <tr key={hour}>
              <th scope="row">{formatHour(hour)}</th>
              {courts.map(({ id, name, active }) => {
                const booking = privateBookings.find((b) => b.court_id === id && overlaps(b, hour, hour + 1));
                return <td key={id}>
                  {booking ? <CalendarSlot booking={booking} date={date} manager={manager}
                    court={name} onRelease={() => setBlockedBooking(booking)} />
                    : <span className={styles.emptySlot}>{active ? emptyLabel : "Inactive"}</span>}
                </td>;
              })}
            </tr>;
          })}</tbody>
        </table>
      </div>
      <TablePagination {...pagination} label="Court calendar time slot pages" anchorId="calendar-court-slots" />
    </section> : <p className="notice">No scheduled court time on this date.</p>}
    <footer className={styles.footer}>
      <Link className="text-link" href={reservationsForDateHref(date)}>
        View reservations for this date <ArrowUpRight size={16} aria-hidden="true" />
      </Link>
    </footer>
    {createOpen && <CreateBookingModal date={date} venue={venue} manager={manager}
      onClose={() => setCreateOpen(null)} onWalkInSaved={() => setWalkInSaved(true)} closing={createClosing} />}
    {blockedBooking && <StaffCancelBookingModal booking={blockedBooking} releaseBlock closing={releaseClosing}
      onClose={() => setBlockedBooking(null)} onSaved={() => setBlockedBooking(null)} />}
  </div>;
}

function overlaps(booking: CalendarBooking, start: number, end: number) {
  return booking.start_hour < end && booking.start_hour + booking.duration > start;
}

function CalendarSlot({ booking, date, manager, court, onRelease }: {
  booking: CalendarBooking;
  date: string;
  manager: boolean;
  court: string;
  onRelease: () => void;
}) {
  const slot = <>
    <strong>{booking.customer_name}</strong>
    <small>{bookingStatusLabel(booking)} · {formatHour(booking.start_hour)}–{formatHour(booking.start_hour + booking.duration)}</small>
  </>;
  if (booking.status === "blocked") {
    return <div className={`${styles.slot} ${styles.blocked}`}>
      <div>{slot}</div>
      {manager && <button type="button" className={styles.release} onClick={onRelease}
        aria-label={`Release block on ${court} at ${formatHour(booking.start_hour)}`}>Release block</button>}
    </div>;
  }
  return <Link className={`${styles.slot} ${booking.status === "confirmed" ? styles.confirmed : styles.pending}`}
    href={reservationsForDateHref(date, booking.reference)}>{slot}</Link>;
}
