import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, ArrowUpRight, CalendarDays, Info } from "lucide-react";
import { getSession, getVenue } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import {
  equipmentBookingLabel,
  formatDate,
  formatHour,
  money,
} from "@/lib/booking";
import { bookingPayments } from "@/lib/payment";
import { bookingStatusLabel, type Booking } from "@/lib/types";
import { courtName } from "@/lib/courts";
export const metadata: Metadata = { title: "All bookings" };

const pageSize = 100;

export default async function AllBookings({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const { user } = await getSession();
  if (!user) redirect("/login?next=/my-bookings/all");
  const { page: pageParam } = await searchParams;
  const requestedPage = typeof pageParam === "string" ? Number(pageParam) : 1;
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const offset = (page - 1) * pageSize;
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
        .order("id")
        .range(offset, offset + pageSize)
    : { data: [], error: null };
  const bookings = (data || []).slice(0, pageSize) as Booking[];
  const hasNextPage = (data?.length ?? 0) > pageSize;
  if (page > 1 && (error?.code === "PGRST103" || (!error && !bookings.length)))
    redirect("/my-bookings/all");
  return (
    <main id="main" className="container content-page">
      <div className="page-heading">
        <Link href="/my-bookings" className="breadcrumb">
          <ArrowLeft size={13} aria-hidden="true" />
          Current matches
        </Link>
        <h1>All bookings</h1>
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
                <h2>
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
                </h2>
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
                  {bookingStatusLabel(b)}
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
      {!error && (page > 1 || hasNextPage) && (
        <nav className="booking-list-pagination" aria-label="Booking pages">
          {page > 1 && (
            <Link className="button button-outline button-small" href={page === 2 ? "/my-bookings/all" : `/my-bookings/all?page=${page - 1}`}>
              Previous
            </Link>
          )}
          <span>Page {page}</span>
          {hasNextPage && (
            <Link className="button button-outline button-small" href={`/my-bookings/all?page=${page + 1}`}>
              Next
            </Link>
          )}
        </nav>
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
