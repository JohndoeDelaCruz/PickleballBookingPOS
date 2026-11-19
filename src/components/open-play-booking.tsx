"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Users, RefreshCw } from "lucide-react";
import { reserveOpenPlay } from "@/app/actions";
import { createClient } from "@/lib/supabase/client";
import {
  formatDate,
  formatHour,
  hasOpenPlay,
  isPastSlot,
  money,
  canBook,
  calculateReservationTotal,
  openPlayCapacityLabel,
} from "@/lib/booking";
import type {
  OpenPlayAvailability,
  PaymentOption,
  VenueSettings,
} from "@/lib/types";
import { EquipmentRental } from "./equipment-rental";
import { PaymentOptions } from "./payment-options";
import { resolveSchedule } from "@/lib/schedule";
import { activeCourts } from "@/lib/courts";

export function OpenPlayBooking({
  venue,
  date,
  ready,
  signedIn,
  userName,
  selectedStart,
  onSessionChange,
}: {
  venue: VenueSettings;
  date: string;
  ready: boolean;
  signedIn: boolean;
  userName: string;
  selectedStart: number | null;
  onSessionChange: (start: number) => void;
}) {
  const [people, setPeople] = useState(1);
  const [name, setName] = useState(userName);
  const [phone, setPhone] = useState("");
  const [requestedEquipmentQuantity, setEquipmentQuantity] = useState(0);
  const equipmentLimit = Math.max(0, Math.min(20, Math.floor(people) || 0));
  const equipmentQuantity = Math.min(
    requestedEquipmentQuantity,
    equipmentLimit,
  );
  const [paymentOption, setPaymentOption] = useState<PaymentOption>("full");
  const [accepted, setAccepted] = useState(false);
  const [availability, setAvailability] = useState<
    OpenPlayAvailability[] | null
  >(null);
  const [loadedDate, setLoadedDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(ready);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [revision, setRevision] = useState(0);
  const [memberQuote, setMemberQuote] = useState<{ key: string; discountCents: number | null } | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const [now, setNow] = useState(() => new Date());
  const sessionApiReady = "schedule_config" in venue;
  const previewSessions = resolveSchedule(venue, date)
    .blocks.filter((b) => b.kind === "open_play")
    .map((b) => ({
      enabled: false,
      start_hour: b.start,
      end_hour: b.end,
      price: b.rate,
      capacity: b.capacity,
      players: 0,
      remaining: b.capacity,
      conflict: false,
    }));
  const sessions =
    loadedDate === date && availability ? availability : previewSessions;
  const chosen =
    sessions.find((s) => s.start_hour === selectedStart) ??
    sessions.find((s) => !isPastSlot(date, s.end_hour, now)) ??
    sessions[0];
  const activeSession = chosen ?? {
    enabled: false,
    start_hour: 0,
    end_hour: 0,
    price: 0,
    capacity: 0,
    players: 0,
    remaining: 0,
    conflict: false,
  };
  const scheduled = Boolean(chosen);
  useEffect(() => {
    if (chosen) onSessionChange(chosen.start_hour);
    setAccepted(false);
    setError("");
  }, [date, chosen?.start_hour, onSessionChange]);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    setAvailability(null);
    setLoadError("");
    const shouldLoad = ready && (sessionApiReady || hasOpenPlay(venue, date));
    setLoading(shouldLoad);
    if (!shouldLoad) return;
    const client = createClient();
    async function refresh() {
      const { data, error } = await client.rpc(
        sessionApiReady
          ? "get_open_play_sessions"
          : "get_open_play_availability",
        {
          p_date: date,
        },
      );
      if (!active) return;
      setLoading(false);
      if (error) {
        setLoadError(
          "We couldn’t load open-play availability. Please refresh before reserving.",
        );
        return;
      }
      setLoadError("");
      setAvailability(
        (data || []).map((s: OpenPlayAvailability) => ({
          ...s,
          price: Number(s.price),
        })),
      );
      setLoadedDate(date);
    }
    refresh();
    const timer = setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [date, ready, sessionApiReady, revision]);
  useEffect(() => {
    setError("");
  }, [date]);
  const ended = isPastSlot(date, activeSession.end_hour, now);
  const canReserve =
    ready &&
    scheduled &&
    canBook(venue) &&
    activeSession.enabled &&
    !activeSession.conflict &&
    !ended;
  const remaining = activeSession.remaining;
  const tooMany =
    remaining !== null && remaining !== undefined && people > remaining;
  const start = activeSession.start_hour;
  const price = activeSession.price;
  const quoteKey = signedIn && canReserve ? `${date}:${start}:${price}:${revision}` : null;
  const quoteFailed = quoteKey !== null && memberQuote?.key === quoteKey && memberQuote.discountCents === null;
  const checkingPrice = quoteKey !== null && memberQuote?.key !== quoteKey;
  const discountCents = people >= 1 && memberQuote?.key === quoteKey ? memberQuote.discountCents ?? 0 : 0;
  const regularTotal = calculateReservationTotal((people || 0) * price, venue.equipment_rental_price, equipmentQuantity);
  const totalCents = Math.round(regularTotal * 100) - discountCents;

  useEffect(() => {
    if (!quoteKey) return;
    let active = true;
    async function loadPrice() {
      const { data, error } = await createClient().rpc("get_open_play_member_discount", { p_date: date, p_start: start });
      if (!active || !quoteKey) return;
      const discount = error?.code === "PGRST202" ? 0
        : !error && Number.isInteger(data) && data >= 0 && data <= Math.round(price * 100) ? data : null;
      setMemberQuote({ key: quoteKey, discountCents: discount });
    }
    loadPrice().catch(() => {
      if (active) setMemberQuote({ key: quoteKey, discountCents: null });
    });
    return () => { active = false; };
  }, [date, start, price, quoteKey]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canReserve || !accepted || tooMany || checkingPrice || quoteFailed) return;
    setError("");
    startTransition(async () => {
      const result = await reserveOpenPlay({
        booking_date: date,
        start_hour: activeSession.start_hour,
        participant_count: people,
        customer_name: name,
        customer_phone: phone,
        equipment_rental: equipmentQuantity > 0,
        equipment_quantity: equipmentQuantity,
        payment_option: paymentOption,
        expected_total_cents: totalCents,
      });
      if (result.error) {
        setError(result.error);
        setRevision((v) => v + 1);
      } else if (result.id) router.push(`/booking/${result.id}`);
    });
  }
  return (
    <section className="panel open-play-panel" aria-label="Open play">
      <div className="open-play-heading">
        <span className="open-play-icon">
          <Users size={24} />
        </span>
        <div>
          <span className="eyebrow">SHARE THE COURT</span>
          <h2>Open play</h2>
        </div>
        {scheduled && (
          <strong className="open-play-price">
            {money(activeSession.price)}
            <small>/ person</small>
          </strong>
        )}
      </div>
      {sessions.length > 0 && (
        <div
          className="open-play-session-picker"
          role="group"
          aria-label="Open-play session"
        >
          {sessions.map((s) => (
            <button
              key={s.start_hour}
              type="button"
              aria-pressed={activeSession.start_hour === s.start_hour}
              className={
                activeSession.start_hour === s.start_hour ? "active" : ""
              }
              onClick={() => onSessionChange(s.start_hour)}
            >
              <strong>
                {formatHour(s.start_hour)}–{formatHour(s.end_hour)}
              </strong>
              <span>{money(s.price)} / person / session</span>
              <small>
                {s.capacity === null
                  ? "No player limit"
                  : `${s.remaining ?? s.capacity} places remaining`}
              </small>
            </button>
          ))}
        </div>
      )}
      {scheduled && (
        <>
          <p>
            Come for a few rallies or stay for the session. Your pass covers{" "}
            {formatHour(activeSession.start_hour)}–
            {formatHour(activeSession.end_hour)}.
          </p>
          <p>
            <strong>{openPlayCapacityLabel(activeSession.capacity, activeCourts(venue.courts).length)}.</strong>{" "}
            Players share the active courts and rotate between games.
          </p>
          <div className="open-play-meta">
            <span>
              {formatDate(date, {
                weekday: "long",
                month: "short",
                day: "numeric",
              })}
            </span>
            <span>
              {activeSession.capacity === null
                ? "No player limit"
                : `${remaining ?? activeSession.capacity} places remaining`}
            </span>
          </div>
        </>
      )}
      {!scheduled ? (
        <div className="notice">
          {loading
            ? "Checking sessions…"
            : "No open-play sessions are scheduled for this date. Choose another date or book a private court."}
        </div>
      ) : (
        <>
          {activeSession.conflict && (
            <div className="notice notice-warning">
              Open play is unavailable on this date because a court is reserved
              or blocked. Choose another session.
            </div>
          )}
          {ended && (
            <div className="notice">
              This open-play session has ended. Choose another session or date.
            </div>
          )}
          {(!ready || !venue.booking_enabled) && (
            <div className="notice">
              Online open-play reservations are opening soon. You can preview
              the session details here.
            </div>
          )}
          {error && (
            <div className="error-message" role="alert">
              {error}
            </div>
          )}
          {loadError && (
            <div className="error-message" role="alert">
              {loadError}
              <button
                type="button"
                className="text-link"
                onClick={() => setRevision((v) => v + 1)}
              >
                <RefreshCw size={12} /> Refresh availability
              </button>
            </div>
          )}
          {quoteFailed && <div className="error-message" role="alert">
            We couldn’t check the member price.
            <button type="button" className="text-link" onClick={() => setRevision((v) => v + 1)}>
              <RefreshCw size={12} /> Check price again
            </button>
          </div>}
          {!signedIn ? (
            <Link
              className="button button-dark"
              href={`/login?next=${encodeURIComponent(`/book?play=open&date=${date}&session=${activeSession.start_hour}`)}`}
            >
              Sign in for open play <ArrowRight size={16} />
            </Link>
          ) : (
            <form className="form-stack" onSubmit={submit}>
              <div className="field-grid">
                <label className="field">
                  <span>Number of players</span>
                  <input
                    type="number"
                    min="1"
                    max="20"
                    value={people}
                    onChange={(e) => setPeople(Number(e.target.value))}
                    required
                  />
                  <small>
                    Up to 20 players per reservation. Each player needs a pass.
                  </small>
                </label>
                <label className="field">
                  <span>Full name</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                    required
                    minLength={2}
                    maxLength={100}
                  />
                </label>
              </div>
              <label className="field">
                <span>Mobile number</span>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  autoComplete="tel"
                  placeholder="09171234567"
                  required
                />
              </label>
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
                  <dt>
                    {people || 0} {people === 1 ? "player" : "players"} ×{" "}
                    {money(activeSession.price)}
                  </dt>
                  <dd>{money((people || 0) * activeSession.price)}</dd>
                </div>
                {discountCents > 0 && <div>
                  <dt>Membership discount · 1 pass</dt>
                  <dd>−{money(discountCents / 100)}</dd>
                </div>}
                <div>
                  <dt>Equipment rental</dt>
                  <dd>
                    {money(equipmentQuantity * venue.equipment_rental_price)}
                  </dd>
                </div>
              </dl>
              <div className="summary-total">
                <span>Booking total</span>
                <strong>{checkingPrice ? "Checking price…" : quoteFailed ? "—" : money(totalCents / 100)}</strong>
              </div>
              {!checkingPrice && !quoteFailed && <PaymentOptions
                total={totalCents / 100}
                value={paymentOption}
                onChange={setPaymentOption}
                disabled={pending}
              />}
              {tooMany && (
                <div className="notice notice-warning">
                  There are not enough places for this group. Choose fewer
                  players or another date.
                </div>
              )}
              <label className="open-play-agreement">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                  required
                />
                <span>
                  I agree to the booking policy and{" "}
                  <Link
                    href="/court-rules"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="policy-link"
                  >
                    court rules
                  </Link>
                  , and understand that open play uses shared courts with player
                  rotation.
                </span>
              </label>
              <button
                className="button button-dark"
                disabled={
                  !canReserve ||
                  tooMany ||
                  loading ||
                  checkingPrice ||
                  quoteFailed ||
                  pending ||
                  !accepted ||
                  Boolean(loadError)
                }
              >
                {pending
                  ? "Reserving…"
                  : loading
                    ? "Checking availability…"
                    : checkingPrice ? "Checking price…" : "Reserve passes & view GCash QR"}
                <ArrowRight size={16} />
              </button>
            </form>
          )}
          <p className="small-print">
            Pay through the venue’s GCash QR and submit your reference. Staff
            confirms after checking payment. Selected equipment rental is
            included in your total. {venue.cancellation_policy}
          </p>
        </>
      )}
    </section>
  );
}
