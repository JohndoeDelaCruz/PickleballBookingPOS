import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowUpRight, CalendarDays, Info } from "lucide-react";
import { getSession, getVenue } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import {
  equipmentBookingLabel,
  formatDate,
  formatHour,
  money,
} from "@/lib/booking";
import { bookingPayments } from "@/lib/payment";
import { statusLabels, type Booking } from "@/lib/types";
import { courtName } from "@/lib/courts";
export const metadata: Metadata = { title: "My bookings" };
export default async function MyBookings() {
  const { user } = await getSession();
  if (!user) redirect("/login?next=/my-bookings");
  const { ready, venue } = await getVenue();
  const supabase = await createClient();
  if (ready) await supabase.rpc("expire_unpaid_holds");
  const { data, error } = ready
    ? await supabase
        .from("bookings")
        .select("*")
        .eq("user_id", user.id)
        .order("booking_date", { ascending: false })
        .order("start_hour", { ascending: false })
        .limit(100)
    : { data: [], error: null };
  const bookings = (data || []) as Booking[];
  return (
    <main id="main" className="container content-page">
      <div className="page-heading">
        <span className="eyebrow">MORE GOOD GAMES AHEAD</span>
        <h1>YOUR COURT TIME.</h1>
        <p>
          Reservations, payment updates, and everything you need for your next
          game.
        </p>
        <Link href="/account" className="text-link account-link">
          Account settings / Change password <ArrowUpRight size={17} />
        </Link>
      </div>
      {error ? (
        <div className="error-message">
          We couldn’t load your bookings. Please refresh and try again.
        </div>
      ) : !bookings.length ? (
        <div className="empty-state">
          <CalendarDays />
          <h2>Your next game is waiting.</h2>
          <p>
            {ready
              ? "You haven’t reserved a court yet. Find a time and get your crew together."
              : "Reservations are opening soon. You’ll find all your bookings here once they’re available."}
          </p>
          <Link href="/book" className="button button-dark">
            Explore the courts <ArrowUpRight size={17} />
          </Link>
        </div>
      ) : (
        <div className="booking-list">
          {bookings.map((b) => (
            <Link
              key={b.id}
              href={`/booking/${b.id}`}
              className="panel booking-list-item"
            >
              <div className="booking-date-tile">
                <span>{formatDate(b.booking_date, { month: "short" })}</span>
                <strong>
                  {formatDate(b.booking_date, { day: "numeric" })}
                </strong>
              </div>
              <div>
                <h3>
                  {b.booking_type === "open_play"
                    ? `Open play · ${b.participant_count} ${b.participant_count === 1 ? "player" : "players"}`
                    : courtName(venue.courts, b.court_id)}{" "}
                  <span
                    style={{
                      fontSize: 14,
                      color: "var(--muted)",
                      fontWeight: 400,
                      marginLeft: 7,
                    }}
                  >
                    {b.reference}
                  </span>
                </h3>
                <p>
                  {formatDate(b.booking_date, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })}
                  <br />
                  {formatHour(b.start_hour)} –{" "}
                  {formatHour(b.start_hour + b.duration)} · {b.duration}{" "}
                  {b.duration === 1 ? "hour" : "hours"}
                  {b.equipment_rental && (
                    <>
                      <br />
                      Includes {equipmentBookingLabel(b)}
                    </>
                  )}
                </p>
              </div>
              <div className="booking-list-side">
                <span className={`status-badge status-${b.status}`}>
                  {statusLabels[b.status]}
                </span>
                {b.status === "confirmed" && (
                  <small>
                    {bookingPayments(b).balance > 0
                      ? `${money(bookingPayments(b).balance)} balance at venue`
                      : "Fully paid"}
                  </small>
                )}
                <span className="text-link" style={{ fontSize: 14 }}>
                  View booking <ArrowUpRight size={15} />
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
      <div className="notice" style={{ marginTop: 25 }}>
        <Info size={17} />
        <span>
          A GCash reference submission puts your payment under review. Your
          reservation is confirmed when our team verifies the payment.
        </span>
      </div>
    </main>
  );
}
