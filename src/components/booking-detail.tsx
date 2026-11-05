"use client";
import { courtName } from "@/lib/courts";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDownToLine,
  Check,
  Clock3,
  ExternalLink,
  Info,
} from "lucide-react";
import { cancelBooking, submitPayment } from "@/app/actions";
import {
  bookingBaseAmount,
  formatDate,
  formatHour,
  money,
  equipmentBookingLabel,
} from "@/lib/booking";
import { statusLabels, type Booking, type VenueSettings } from "@/lib/types";
import { bookingPayments } from "@/lib/payment";

export function BookingDetail({
  booking: b,
  venue,
  owner,
}: {
  booking: Booking;
  venue: VenueSettings;
  owner: boolean;
}) {
  const [reference, setReference] = useState("");
  const [error, setError] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [remaining, setRemaining] = useState<number | null>(null);
  const [downloadError, setDownloadError] = useState(false);
  const router = useRouter();
  useEffect(() => {
    if (!b.hold_expires_at || b.status !== "awaiting_payment") return;
    const tick = () =>
      setRemaining(
        Math.max(
          0,
          Math.floor(
            (new Date(b.hold_expires_at!).getTime() - Date.now()) / 1000,
          ),
        ),
      );
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [b.hold_expires_at, b.status]);
  useEffect(() => {
    const interval = setInterval(() => router.refresh(), 30000);
    return () => clearInterval(interval);
  }, [router]);
  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    startTransition(async () => {
      const result = await submitPayment(b.id, reference);
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }
  function cancel() {
    setError("");
    startTransition(async () => {
      const result = await cancelBooking(b.id);
      if (result.error) setError(result.error);
      else {
        setCancelOpen(false);
        router.refresh();
      }
    });
  }
  async function downloadQr() {
    try {
      const response = await fetch(venue.gcash_qr_url);
      if (!response.ok) throw new Error();
      const blob = await response.blob();
      const extensions: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
      };
      if (!extensions[blob.type]) throw new Error("Unsupported QR image");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `rally-gcash-qr.${extensions[blob.type]}`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setDownloadError(true);
    }
  }
  const awaitingPayment = b.status === "awaiting_payment" && remaining !== 0;
  const openPlay = b.booking_type === "open_play";
  const payments = bookingPayments(b);
  return (
    <div className="detail-layout">
      <div>
        <section className="panel detail-panel">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "start",
              gap: 20,
              marginBottom: 24,
            }}
          >
            <div>
              <span className="eyebrow">BOOKING REFERENCE</span>
              <h2 style={{ margin: "10px 0 0" }}>{b.reference}</h2>
            </div>
            <span className={`status-badge status-${b.status}`}>
              {statusLabels[b.status]}
            </span>
          </div>
          <dl className="summary-rows">
            <div>
              <dt>{openPlay ? "Session" : "Court"}</dt>
              <dd>
                {openPlay ? "Open play · shared courts" : courtName(venue.courts, b.court_id)}
              </dd>
            </div>
            <div>
              <dt>Date</dt>
              <dd>{formatDate(b.booking_date)}</dd>
            </div>
            <div>
              <dt>Time (PHT)</dt>
              <dd>
                {formatHour(b.start_hour)} –{" "}
                {formatHour(b.start_hour + b.duration)}
              </dd>
            </div>
            <div>
              <dt>{openPlay ? "Players" : "Duration"}</dt>
              <dd>
                {openPlay
                  ? `${b.participant_count} ${b.participant_count === 1 ? "player" : "players"} · full session access`
                  : `${b.duration} ${b.duration === 1 ? "hour" : "hours"}`}
              </dd>
            </div>
            <div>
              <dt>Player</dt>
              <dd>{b.customer_name}</dd>
            </div>
            <div>
              <dt>Mobile</dt>
              <dd>{b.customer_phone}</dd>
            </div>
            {b.payment_reference && (
              <div>
                <dt>GCash reference</dt>
                <dd>{b.payment_reference}</dd>
              </div>
            )}
          </dl>
          {b.equipment_rental && (
            <dl className="summary-rows equipment-cost-rows">
              <div>
                <dt>{openPlay ? "Open-play passes" : "Court subtotal"}</dt>
                <dd>{money(bookingBaseAmount(b))}</dd>
              </div>
              <div>
                <dt>
                  Equipment rental
                  <small className="equipment-description">
                    {equipmentBookingLabel(b)}
                  </small>
                </dt>
                <dd>{money(b.equipment_amount)}</dd>
              </div>
            </dl>
          )}
          <div className="summary-total">
            <span>Booking total</span>
            <strong>{money(b.total_amount)}</strong>
          </div>
          <dl className="summary-rows payment-cost-rows">
            <div>
              <dt>Payment option</dt>
              <dd>
                {b.payment_option === "reservation_fee"
                  ? "Reservation fee · 50%"
                  : "Full payment"}
              </dd>
            </div>
            <div>
              <dt>Verified payment</dt>
              <dd>{money(payments.paid)}</dd>
            </div>
            {b.status === "confirmed" ? (
              <div>
                <dt>Balance at venue</dt>
                <dd>
                  <strong>{money(payments.balance)}</strong>
                </dd>
              </div>
            ) : ["awaiting_payment", "awaiting_verification"].includes(
                b.status,
              ) ? (
              <>
                <div>
                  <dt>
                    {b.status === "awaiting_verification"
                      ? "Payment under review"
                      : "Pay now"}
                  </dt>
                  <dd>{money(payments.initial)}</dd>
                </div>
                <div>
                  <dt>Balance after verification</dt>
                  <dd>{money(payments.later)}</dd>
                </div>
              </>
            ) : null}
            {b.balance_payment_reference && (
              <div>
                <dt>Balance payment reference</dt>
                <dd>{b.balance_payment_reference}</dd>
              </div>
            )}
          </dl>
          {b.status === "confirmed" && (
            <div
              className="success-message"
              style={{ display: "flex", gap: 10 }}
            >
              <Check size={19} />
              <span>
                {payments.balance > 0
                  ? `Your reservation fee is verified and your booking is confirmed. Please settle ${money(payments.balance)} at the venue before you play.`
                  : "You’re confirmed and fully paid. We’ll see you on court!"}
              </span>
            </div>
          )}
          {b.status === "awaiting_verification" && (
            <div className="notice">
              <Clock3 size={18} />
              <span>
                <strong>Thanks! Your payment is under review.</strong>
                <br />
                Our team will check your GCash transaction and confirm your
                reservation. Your slot stays held while we review it.
              </span>
            </div>
          )}
          {(b.status === "expired" ||
            (b.status === "awaiting_payment" && remaining === 0)) && (
            <div className="notice notice-warning">
              <Info size={18} />
              <span>
                This unpaid hold has expired. Please make a new reservation. If
                you already paid, contact the venue with your booking and GCash
                references before paying again.
              </span>
            </div>
          )}
          {b.status === "cancelled" && (
            <div className="notice">
              <Info size={18} />
              <span>
                This reservation has been cancelled. For any payment or refund
                questions, please contact the venue.
              </span>
            </div>
          )}
          {error && (
            <div
              className="error-message"
              style={{ marginTop: 20 }}
              role="alert"
            >
              {error}
            </div>
          )}
          {owner && awaitingPayment && (
            <div className="booking-detail-actions">
              {cancelOpen ? (
                <div
                  className="notice"
                  style={{ width: "100%", flexDirection: "column" }}
                >
                  <span>
                    {openPlay
                      ? "Cancel these unpaid open-play passes?"
                      : "Cancel this unpaid reservation and release the court?"}
                  </span>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button
                      className="button button-small button-dark"
                      onClick={cancel}
                      disabled={pending}
                    >
                      {pending ? "Cancelling…" : "Yes, cancel"}
                    </button>
                    <button
                      className="button button-small button-outline"
                      onClick={() => setCancelOpen(false)}
                    >
                      Keep reservation
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="button button-outline button-small"
                  onClick={() => setCancelOpen(true)}
                >
                  Cancel unpaid reservation
                </button>
              )}
            </div>
          )}
        </section>
        <section className="panel" style={{ marginTop: 20 }}>
          <h3 style={{ fontSize: 14 }}>Before you play</h3>
          <p className="small-print">{venue.cancellation_policy}</p>
          <p className="small-print">
            {venue.address
              ? `${venue.name} · ${venue.address} ${venue.city}`
              : "Venue location details will be shared here."}
          </p>
          {venue.phone && (
            <a
              className="text-link"
              style={{ marginTop: 15 }}
              href={`tel:${venue.phone}`}
            >
              Contact the venue <ExternalLink size={13} />
            </a>
          )}
          {venue.email && (
            <a
              className="text-link"
              style={{ marginTop: 15, marginLeft: 15 }}
              href={`mailto:${venue.email}`}
            >
              Email our team <ExternalLink size={13} />
            </a>
          )}
        </section>
      </div>
      {owner && awaitingPayment ? (
        <aside className="panel qr-panel">
          <span
            className="eyebrow"
            style={{ justifyContent: "center", marginBottom: 13 }}
          >
            MAKE IT YOURS
          </span>
          <h3>Pay with GCash</h3>
          <p>
            Pay exactly <strong>{money(payments.initial)}</strong> and send your
            reference before the hold expires.
          </p>
          {payments.later > 0 && (
            <p className="small-print">
              This is your 50% reservation fee. The remaining{" "}
              {money(payments.later)} is due at the venue before you play.
            </p>
          )}
          {remaining !== null && (
            <div className="countdown" aria-label="Time remaining">
              {String(Math.floor(remaining / 60)).padStart(2, "0")}:
              {String(remaining % 60).padStart(2, "0")}
            </div>
          )}
          {venue.gcash_qr_url ? (
            <>
              <img
                className="qr-image"
                src={venue.gcash_qr_url}
                alt="Rally GCash payment QR"
              />
              <button
                className="text-link"
                style={{
                  border: 0,
                  background: "transparent",
                  marginBottom: 20,
                }}
                onClick={downloadQr}
              >
                <ArrowDownToLine size={15} />
                Save QR image
              </button>
              {downloadError && (
                <p className="small-print">
                  Open the image and save it to your phone:{" "}
                  <a
                    href={venue.gcash_qr_url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ textDecoration: "underline" }}
                  >
                    Open QR image
                  </a>
                </p>
              )}
            </>
          ) : (
            <div className="notice notice-warning">
              GCash QR is currently unavailable. Please contact the venue before
              paying.
            </div>
          )}
          <div className="qr-account">
            <strong>{venue.gcash_name}</strong>
            {venue.gcash_number && <span>{venue.gcash_number}</span>}
          </div>
          <form className="form-stack payment-form" onSubmit={submit}>
            <label className="field">
              <span>GCash reference number</span>
              <input
                required
                minLength={6}
                maxLength={40}
                placeholder="From your GCash transaction"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </label>
            <button
              className="button button-dark"
              disabled={pending || remaining === 0}
            >
              {pending ? "Submitting…" : "Submit payment reference"}
              <Check size={16} />
            </button>
            <p className="small-print">
              Your reservation is confirmed only after staff verifies the
              incoming payment. Never send your GCash PIN or OTP.
            </p>
          </form>
        </aside>
      ) : (
        <aside className="panel">
          <span className="eyebrow">YOUR NEXT GOOD GAME</span>
          <h3 style={{ fontSize: 24, marginTop: 15 }}>
            Good games.
            <br />
            Great company.
          </h3>
          <p className="small-print">
            Keep your booking reference handy. Payment updates appear on this
            page and in My bookings.
          </p>
        </aside>
      )}
    </div>
  );
}
