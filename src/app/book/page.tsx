import type { Metadata } from "next";
import Link from "next/link";
import { getSession, getVenue } from "@/lib/data";
import { BookingCalendar } from "@/components/booking-calendar";
export const metadata: Metadata = { title: "Make time for a game" };
export default async function BookPage({
  searchParams,
}: {
  searchParams: Promise<{
    court?: string;
    date?: string;
    play?: string;
    session?: string;
  }>;
}) {
  const [{ venue, ready, openPlayReady }, { user }, params] = await Promise.all(
    [getVenue(), getSession(), searchParams],
  );
  return (
    <main id="main" className="reservation-page">
      <div className="reservation-page-heading">
        <span className="editorial-label">RALLY CLUB / COURT RESERVATIONS</span>
        <h1>
          Make time
          <br />
          for a <em>good game.</em>
        </h1>
        <p>
          Pick a day. Find your people. Reserve your session with a 50%
          reservation fee or full GCash payment. All times are in Philippine
          Time.
        </p>
      </div>
      {!ready && (
        <div className="reservation-preview-note">
          <span>
            Preview calendar · Sample courts and rates. Live reservations will
            open after the venue is configured.
          </span>
          <Link href="/demo">Explore the interactive client demo ↗</Link>
        </div>
      )}
      <div className="reservation-workspace">
        <BookingCalendar
          venue={venue}
          ready={ready}
          openPlayReady={openPlayReady}
          initialOpenPlay={params.play === "open"}
          signedIn={Boolean(user)}
          userName={user?.user_metadata?.full_name || ""}
          initialDate={params.date}
          initialSession={
            params.session !== undefined && /^\d+$/.test(params.session)
              ? Number(params.session)
              : undefined
          }
        />
      </div>
    </main>
  );
}
