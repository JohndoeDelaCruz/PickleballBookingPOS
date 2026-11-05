"use client";

import { useId } from "react";
import { money } from "@/lib/booking";
import { initialPaymentAmount } from "@/lib/payment";
import type { PaymentOption } from "@/lib/types";

export function PaymentOptions({
  total,
  value,
  onChange,
  disabled = false,
}: {
  total: number;
  value: PaymentOption;
  onChange: (value: PaymentOption) => void;
  disabled?: boolean;
}) {
  const group = useId();
  const due = initialPaymentAmount(total, value);
  return (
    <fieldset className="payment-options" disabled={disabled}>
      <legend>Payment option</legend>
      {(["reservation_fee", "full"] as const).map((option) => (
        <label
          key={option}
          className={`payment-option ${value === option ? "is-selected" : ""}`}
        >
          <input
            type="radio"
            name={`payment-option-${group}`}
            value={option}
            checked={value === option}
            onChange={() => onChange(option)}
          />
          <span>
            <strong>
              {option === "reservation_fee"
                ? "Reservation fee · 50%"
                : "Full payment"}
            </strong>
            <small>
              {option === "reservation_fee"
                ? "Pay half now; settle the balance at the venue."
                : "Pay the entire booking total now."}
            </small>
          </span>
          <b>{money(initialPaymentAmount(total, option))}</b>
        </label>
      ))}
      <dl className="summary-rows payment-cost-rows" aria-live="polite">
        <div>
          <dt>Pay now</dt>
          <dd>
            <strong>{money(due)}</strong>
          </dd>
        </div>
        <div>
          <dt>Balance at venue</dt>
          <dd>
            {money((Math.round(total * 100) - Math.round(due * 100)) / 100)}
          </dd>
        </div>
      </dl>
      {value === "reservation_fee" && (
        <p className="small-print">
          The reservation fee counts toward your total. Pay the remaining
          balance before you play.
        </p>
      )}
    </fieldset>
  );
}
