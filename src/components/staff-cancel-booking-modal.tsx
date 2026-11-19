"use client";

import { useState, useTransition, type FormEvent } from "react";
import { staffSetStatus } from "@/app/actions";
import { formatHour, money } from "@/lib/booking";
import { Modal } from "./modal";

export function StaffCancelBookingModal({ booking, releaseBlock = false, closing, onClose, onSaved }: {
  booking: { id: string; reference: string; customer_name: string; start_hour: number; duration: number; paid_amount: number };
  releaseBlock?: boolean;
  closing: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || closing) return;
    setError("");
    startTransition(async () => {
      const result = await staffSetStatus(booking.id, "cancelled");
      if (result.error) setError(result.error);
      else onSaved();
    });
  }

  return <Modal title={releaseBlock ? "Release court block?" : "Cancel reservation?"} closing={closing}
    onClose={() => !pending && onClose()}>
    <form className="form-stack" onSubmit={submit}>
      <p>
        <strong>{booking.customer_name}</strong>
        <br />{booking.reference} · {formatHour(booking.start_hour)}–{formatHour(booking.start_hour + booking.duration)}
      </p>
      <div className="notice notice-warning">
        {releaseBlock ? "This releases the blocked court time." : "This cancels the reservation and releases the court time or open-play places."}
        {Number(booking.paid_amount) > 0 && <> The customer paid {money(booking.paid_amount)}. Handle any refund separately.</>}
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="membership-plan-actions">
        <button type="button" className="console-button" disabled={pending || closing} onClick={onClose}>Go back</button>
        <button type="submit" className="console-button primary" disabled={pending || closing}>
          {pending ? "Updating…" : releaseBlock ? "Release block" : "Cancel reservation"}
        </button>
      </div>
    </form>
  </Modal>;
}
