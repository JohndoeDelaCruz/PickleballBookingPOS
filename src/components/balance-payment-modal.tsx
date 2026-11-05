"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { staffRecordBalance } from "@/app/actions";
import { money } from "@/lib/booking";
import { bookingPayments } from "@/lib/payment";
import { paymentMethods, type PaymentMethod } from "@/lib/finance";
import type { Booking } from "@/lib/types";
import { Modal } from "./modal";

export function BalancePaymentModal({
  booking,
  onClose,
}: {
  booking: Booking;
  onClose: () => void;
}) {
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [reference, setReference] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const balance = bookingPayments(booking).balance;
  return (
    <Modal title="Record balance payment" onClose={() => !pending && onClose()}>
      <p>
        {booking.customer_name} · {booking.reference}
      </p>
      <div className="summary-total">
        <span>Remaining balance</span>
        <strong>{money(balance)}</strong>
      </div>
      <p className="small-print">
        Save only after you have received and checked this payment. This marks
        the reservation as fully paid.
      </p>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          startTransition(async () => {
            const result = await staffRecordBalance({
              booking_id: booking.id,
              payment_method: method,
              reference,
            });
            if (result.error) setError(result.error);
            else {
              router.refresh();
              onClose();
            }
          });
        }}
      >
        <label className="field">
          <span>Balance received via</span>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as PaymentMethod)}
            disabled={pending}
          >
            {Object.entries(paymentMethods)
              .filter(([key]) => key !== "unspecified")
              .map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>
            Payment reference {method === "gcash" ? "(required)" : "(optional)"}
          </span>
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            required={method === "gcash"}
            minLength={6}
            maxLength={40}
            disabled={pending}
          />
        </label>
        {error && (
          <div className="error-message" role="alert">
            {error}
          </div>
        )}
        <button
          className="button button-dark"
          disabled={pending || balance <= 0}
        >
          {pending ? "Saving…" : `Payment checked · record ${money(balance)}`}
        </button>
      </form>
    </Modal>
  );
}
