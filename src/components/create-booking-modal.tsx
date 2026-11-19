"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { reserveOpenPlay, staffCreateBooking } from "@/app/actions";
import { bookAccountWalkIn, bookWalkIn, quoteMemberWalkIn, type MemberWalkInQuote, type WalkInCustomer } from "@/app/(workspace)/staff/actions";
import {
  addDays, bookingSchema, calculateCourtTotal, calculateReservationTotal, formatDate,
  formatHour, isPastSlot, localDate, money, privateEquipmentLimit,
} from "@/lib/booking";
import { activeCourts } from "@/lib/courts";
import { paymentMethods } from "@/lib/finance";
import { initialPaymentAmount } from "@/lib/payment";
import { resolveSchedule, scheduleHours } from "@/lib/schedule";
import type { PaymentOption, VenueSettings } from "@/lib/types";
import { EquipmentRental } from "./equipment-rental";
import { Modal } from "./modal";
import { WalkInCustomerLookup } from "./walk-in-customer-lookup";

type ReservationType = "court" | "open_play" | "block";
type StepPosition = { step: number; direction: "forward" | "backward" | null };
const customerDetails = bookingSchema.pick({ customer_name: true, customer_phone: true });
const blockDetails = bookingSchema.pick({ customer_name: true });

export function CreateBookingModal({
  date, venue, manager, onClose, onWalkInSaved, closing,
}: {
  date: string;
  venue: VenueSettings;
  manager: boolean;
  onClose: () => void;
  onWalkInSaved: () => void;
  closing: boolean;
}) {
  const courts = activeCourts(venue.courts);
  const today = localDate();
  const [type, setType] = useState<ReservationType>("court");
  const [{ step, direction }, setStepPosition] = useState<StepPosition>({ step: 0, direction: null });
  const [bookingDate, setBookingDate] = useState(date < today ? today : date);
  const [courtId, setCourtId] = useState(courts[0]?.id);
  const [startHour, setStartHour] = useState(6);
  const [sessionStart, setSessionStart] = useState<number>();
  const [duration, setDuration] = useState(1);
  const [people, setPeople] = useState("1");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [member, setMember] = useState<WalkInCustomer | null>(null);
  const [guestWalkIn, setGuestWalkIn] = useState(false);
  const [memberQuote, setMemberQuote] = useState<MemberWalkInQuote | null>(null);
  const [blockReason, setBlockReason] = useState("");
  const [requestedEquipmentQuantity, setEquipmentQuantity] = useState(0);
  const [paymentOption, setPaymentOption] = useState<PaymentOption>("full");
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const walkInRequest = useRef<{ payload: string; key: string } | null>(null);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const router = useRouter();

  const blocked = type === "block";
  const openPlay = type === "open_play";
  const memberId = blocked ? undefined : member?.id;
  const requiresPaymentConfirmation = !manager || Boolean(memberId);
  const lastStep = blocked ? 1 : 2;
  const stepTitle = ["Choose court time", blocked ? "Block details" : "Customer details", "Record payment"][step];
  const blocks = resolveSchedule(venue, bookingDate).blocks;
  const sessions = blocks.filter((block) => block.kind === "open_play" && !isPastSlot(bookingDate, block.end));
  const startHours = (blocked ? Array.from({ length: 24 }, (_, hour) => hour) : scheduleHours(blocks))
    .filter((hour) => !isPastSlot(bookingDate, hour) && (blocked || blocks.some(
      (block) => block.kind === "court" && hour >= block.start && hour < block.end,
    )));
  const selectedHour = startHours.includes(startHour) ? startHour : step === 0 ? startHours[0] : undefined;
  const session = sessions.find((item) => item.start === sessionStart) ?? (step === 0 ? sessions[0] : undefined);
  const playerCount = Number(people);
  const validPlayerCount = Number.isInteger(playerCount) && playerCount >= 1 && playerCount <= 20;
  const base = openPlay
    ? session && validPlayerCount ? session.rate * playerCount : null
    : courtId === undefined || selectedHour === undefined
      ? null
      : blocked
        ? selectedHour + duration <= 24 ? 0 : null
        : calculateCourtTotal(venue, selectedHour, duration, bookingDate);
  const equipmentLimit = openPlay
    ? validPlayerCount ? playerCount : 0
    : privateEquipmentLimit(venue, bookingDate, selectedHour, duration);
  const equipmentQuantity = blocked ? 0 : Math.min(requestedEquipmentQuantity, equipmentLimit);
  const total = base === null ? null : memberId && step === 2
    ? (memberQuote ? memberQuote.totalCents / 100 : null)
    : calculateReservationTotal(base, venue.equipment_rental_price, equipmentQuantity);
  const collected = total === null ? null : initialPaymentAmount(total, paymentOption);

  useEffect(() => {
    stepHeading.current?.focus({ preventScroll: true });
  }, [step]);

  function goToStep(next: number) {
    setError("");
    setVerified(false);
    setStepPosition({ step: next, direction: next > step ? "forward" : "backward" });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || closing) return;
    setError("");
    if (base === null || collected === null) {
      if (step !== 0) goToStep(0);
      setError("Choose an available time and duration.");
      return;
    }

    if (step === 1 && !blocked && !memberId && !guestWalkIn) {
      setError("Select a customer account or choose Book as guest.");
      return;
    }
    if (step === 1 && (blocked || guestWalkIn)) {
      const details = blocked
        ? blockDetails.safeParse({ customer_name: blockReason })
        : customerDetails.safeParse({ customer_name: customerName, customer_phone: customerPhone });
      if (!details.success) {
        setError(blocked ? "Enter a reason for blocking this time." : details.error.issues[0].message);
        return;
      }
    }
    if (step < lastStep) {
      if (step === 0) {
        if (selectedHour !== undefined) setStartHour(selectedHour);
        setSessionStart(session?.start);
      }
      const quoteStart = openPlay ? session?.start : selectedHour;
      if (step === 1 && memberId && quoteStart !== undefined) {
        startTransition(async () => {
          const result = await quoteMemberWalkIn({
            customerId: memberId, bookingDate, startHour: quoteStart, equipmentQuantity,
            ...(openPlay ? { kind: "open_play", people: playerCount } : { kind: "court", duration }),
          });
          if ("error" in result) {
            setError(result.error);
            return;
          }
          setMemberQuote(result.quote);
          goToStep(2);
        });
        return;
      }
      goToStep(step + 1);
      return;
    }
    if (requiresPaymentConfirmation && !verified) return;

    const input = {
      booking_date: bookingDate,
      court_id: courtId,
      start_hour: openPlay ? session?.start : selectedHour,
      duration,
      participant_count: playerCount,
      ...(!memberId && {
        customer_name: (blocked ? blockReason : customerName).trim(),
        customer_phone: blocked ? "" : customerPhone.trim(),
      }),
      equipment_rental: equipmentQuantity > 0,
      equipment_quantity: equipmentQuantity,
      payment_option: blocked ? "full" : paymentOption,
      payment_method: blocked ? "cash" : method,
      finance_notes: blocked ? "" : notes,
    };
    startTransition(async () => {
      try {
        if (!manager || memberId) {
          const payment = {
            ...input,
            member_id: memberId,
            expected_total_cents: memberId ? memberQuote?.totalCents : undefined,
            method,
            reference: method === "gcash" ? reference.trim() : "",
            verified,
            collectedCents: Math.round(collected * 100),
          };
          const payload = JSON.stringify({ ...payment, openPlay });
          if (walkInRequest.current?.payload !== payload) {
            walkInRequest.current = { payload, key: crypto.randomUUID() };
          }
          const request = { ...payment, key: walkInRequest.current.key };
          const result = memberId ? await bookAccountWalkIn(request, openPlay) : await bookWalkIn(request, openPlay);
          if (result.error) {
            setError(result.error);
            if (memberId) setVerified(false);
            return;
          }
        } else {
          const result = openPlay ? await reserveOpenPlay(input, true) : await staffCreateBooking(input, blocked);
          if (result.error) {
            setError(result.error);
            return;
          }
        }
        onClose();
        if ((!manager || memberId) && bookingDate !== date) router.push(`/admin?date=${bookingDate}`);
        else {
          if (!manager || memberId) onWalkInSaved();
          router.refresh();
        }
      } catch {
        setError("Couldn’t confirm the update. Check the calendar before starting another booking.");
      }
    });
  }

  const when = openPlay && session
    ? `${formatHour(session.start)}–${formatHour(session.end)} · ${playerCount} ${playerCount === 1 ? "player" : "players"}`
    : selectedHour === undefined ? "" : `${courts.find((court) => court.id === courtId)?.name} · ${formatHour(selectedHour)}–${formatHour(selectedHour + duration)}`;

  return (
    <Modal
      title={manager ? "Add court time" : "Add walk-in"}
      className="court-time-modal"
      closing={closing}
      onClose={() => !pending && onClose()}
    >
      <form onSubmit={submit} className="court-time-form" aria-busy={pending}>
        <div key={step} className="court-time-scroll" data-slide={direction ?? undefined}>
          <h3 className="court-time-step" ref={stepHeading} tabIndex={-1}>
            {stepTitle} <span>Step {step + 1} of {lastStep + 1}</span>
          </h3>
          <fieldset className="court-time-fields" disabled={pending || closing} aria-label={stepTitle}>
            {step === 0 && (
              <>
                <label className="field">
                  <span>Reservation type</span>
                  <select value={type} onChange={(event) => {
                    const value = event.target.value;
                    setType(value === "open_play" || (value === "block" && manager) ? value : "court");
                    setMember(null);
                    setMemberQuote(null);
                    setGuestWalkIn(false);
                    setError("");
                  }}>
                    <option value="court">Private court booking</option>
                    <option value="open_play">Open-play passes</option>
                    {manager && <option value="block">Court block</option>}
                  </select>
                </label>
                <div className="field-grid">
                  <label className="field">
                    <span>Date</span>
                    <input type="date" required value={bookingDate} min={today} max={addDays(today, 30)}
                      onChange={(event) => {
                        setBookingDate(event.target.value);
                        setMember(null);
                        setMemberQuote(null);
                      }} />
                  </label>
                  {openPlay ? (
                    <label className="field">
                      <span>Players</span>
                      <input type="number" min={1} max={20} required value={people}
                        onChange={(event) => setPeople(event.target.value)} />
                    </label>
                  ) : (
                    <>
                      <label className="field">
                        <span>Court</span>
                        <select required value={courtId ?? ""} onChange={(event) => setCourtId(Number(event.target.value))}>
                          {!courts.length && <option value="">No active courts</option>}
                          {courts.map((court) => <option key={court.id} value={court.id}>{court.name}</option>)}
                        </select>
                      </label>
                      <label className="field">
                        <span>Start time</span>
                        <select required value={selectedHour ?? ""} disabled={!startHours.length}
                          onChange={(event) => setStartHour(Number(event.target.value))}>
                          {!startHours.length && <option value="">No hours available</option>}
                          {startHours.map((hour) => <option key={hour} value={hour}>{formatHour(hour)}</option>)}
                        </select>
                      </label>
                      <label className="field">
                        <span>Duration</span>
                        <select value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
                          {[1, 2, 3, 4].map((hours) => <option key={hours} value={hours}>{hours} {hours === 1 ? "hour" : "hours"}</option>)}
                        </select>
                      </label>
                    </>
                  )}
                </div>
                {openPlay && (
                  <label className="field">
                    <span>Open-play session</span>
                    <select required value={session?.start ?? ""} disabled={!sessions.length}
                      onChange={(event) => setSessionStart(Number(event.target.value))}>
                      {!sessions.length && <option value="">No sessions available</option>}
                      {sessions.map((item) => (
                        <option key={item.id} value={item.start}>
                          {formatHour(item.start)}–{formatHour(item.end)} · {money(item.rate)} / person
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {base === null && bookingDate && !openPlay && startHours.length > 0 && courts.length > 0 && (
                  <p className="small-print">Choose a shorter duration or a different start time.</p>
                )}
              </>
            )}
            {step === 1 && (blocked ? (
              <>
                <p className="court-time-summary">{formatDate(bookingDate)} · {when}</p>
                <label className="field">
                  <span>Block reason</span>
                  <input required minLength={2} maxLength={100} value={blockReason} placeholder="e.g. Court maintenance"
                    onChange={(event) => setBlockReason(event.target.value)} />
                </label>
              </>
            ) : (
              <>
                {guestWalkIn ? <>
                  <label className="field">
                    <span>Guest name</span>
                    <input required minLength={2} maxLength={100} value={customerName}
                      onChange={(event) => setCustomerName(event.target.value)} />
                  </label>
                  <label className="field">
                    <span>Guest mobile</span>
                    <input type="tel" required value={customerPhone} placeholder="09171234567"
                      onChange={(event) => setCustomerPhone(event.target.value)} />
                  </label>
                  <div><button type="button" className="text-link" onClick={() => { setGuestWalkIn(false); setError(""); }}>
                    Look up a customer account
                  </button></div>
                </> : <>
                  <WalkInCustomerLookup date={bookingDate} customer={member} onChange={(customer) => {
                    setMember(customer);
                    setMemberQuote(null);
                    setError("");
                  }} />
                  {!member && <div><button type="button" className="text-link" onClick={() => { setGuestWalkIn(true); setError(""); }}>
                    Book as guest
                  </button></div>}
                </>}
                <EquipmentRental price={venue.equipment_rental_price} ballCount={venue.equipment_ball_count}
                  quantity={equipmentQuantity} maxQuantity={equipmentLimit} onChange={setEquipmentQuantity} />
              </>
            ))}
            {step === 2 && (
              <>
                <p className="court-time-summary">{formatDate(bookingDate)} · {when}</p>
                {memberId && member && <p className="small-print">Linked account · {member.full_name || member.email}</p>}
                <div className="field-grid">
                  <label className="field">
                    <span>Payment collected</span>
                    <select value={paymentOption} onChange={(event) => {
                      setPaymentOption(event.target.value === "reservation_fee" ? "reservation_fee" : "full");
                      setVerified(false);
                    }}>
                      <option value="full">Full payment</option>
                      <option value="reservation_fee">50% reservation fee</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Payment method</span>
                    <select value={method} onChange={(event) => {
                      setMethod(event.target.value);
                      setVerified(false);
                    }}>
                      {Object.entries(paymentMethods)
                        .filter(([key]) => manager ? key !== "unspecified" && (key !== "gcash" || memberId) : key === "cash" || key === "gcash")
                        .map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                    </select>
                  </label>
                </div>
                {method === "cash" && <p className="small-print">Cash payments require an open register shift.</p>}
                {manager && (
                  <label className="field">
                    <span>Staff notes (optional)</span>
                    <textarea rows={2} maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} />
                  </label>
                )}
                {requiresPaymentConfirmation && (
                  <>
                    {method === "gcash" && (
                      <label className="field">
                        <span>Verified GCash transaction reference</span>
                        <input required minLength={6} maxLength={40} value={reference} onChange={(event) => {
                          setReference(event.target.value);
                          setVerified(false);
                        }} />
                      </label>
                    )}
                    <label className="toggle-field">
                      <input type="checkbox" required checked={verified} onChange={(event) => setVerified(event.target.checked)} />
                      <span>{method === "gcash" ? "I verified the payment in GCash." : method === "cash" ? "I received the cash payment." : "I received the payment."}</span>
                    </label>
                  </>
                )}
                {total !== null && collected !== null && (
                  <dl className="court-time-totals">
                    {memberId && memberQuote && memberQuote.discountCents > 0 && <>
                      <div><dt>Regular total</dt><dd>{money(memberQuote.regularCents / 100)}</dd></div>
                      <div><dt>{openPlay ? "Membership discount · 1 pass" : "Membership discount"}</dt><dd>−{money(memberQuote.discountCents / 100)}</dd></div>
                    </>}
                    <div><dt>Booking total</dt><dd>{money(total)}</dd></div>
                    <div><dt>Amount to collect</dt><dd><strong>{money(collected)}</strong></dd></div>
                    {collected < total && <div><dt>Balance due before play</dt><dd>{money(total - collected)}</dd></div>}
                  </dl>
                )}
                {memberId && memberQuote?.discountCents === 0 && <p className="small-print">No membership discount applies to this booking.</p>}
              </>
            )}
          </fieldset>
        </div>
        <div className="court-time-footer">
          {error && <div className="error-message" role="alert">{error}</div>}
          <div className="court-time-actions">
            <button type="button" className="button button-outline" disabled={pending || closing}
              onClick={() => step === 0 ? onClose() : goToStep(step - 1)}>
              {step === 0 ? "Cancel" : "Back"}
            </button>
            <button type="submit" className="button button-dark"
              disabled={pending || closing || (step === 0 && base === null) ||
                (step === 1 && !blocked && !memberId && !guestWalkIn) ||
                (step === lastStep && requiresPaymentConfirmation && !verified)}>
              {pending ? (step === 1 && memberId ? "Checking price…" : "Saving…") : step < lastStep ? "Next" : blocked ? "Block court time" : "Confirm booking"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
