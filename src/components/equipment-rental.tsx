"use client";

import { useId, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { equipmentPackageLabel, money } from "@/lib/booking";

export function EquipmentRental({
  price,
  ballCount,
  quantity,
  maxQuantity,
  onChange,
  disabled = false,
}: {
  price: number;
  ballCount: number;
  quantity: number;
  maxQuantity: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const selected = quantity > 0;
  function change(value: number) {
    setDraft(null);
    onChange(Math.max(0, Math.min(maxQuantity, value)));
  }
  return (
    <div
      className={`equipment-rental-option ${selected ? "is-selected" : ""}`}
      role="group"
      aria-label="Equipment rental"
    >
      <div className="equipment-rental-row">
        <label htmlFor={id}>Equipment</label>
        <div className="equipment-quantity-stepper">
          <button
            type="button"
            aria-label="Decrease equipment sets"
            disabled={disabled || quantity <= 0}
            onClick={() => change(quantity - 1)}
          >
            <Minus size={16} />
          </button>
          <input
            id={id}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            role="spinbutton"
            aria-label="Number of sets"
            aria-valuemin={0}
            aria-valuemax={maxQuantity}
            aria-valuenow={quantity}
            value={draft ?? String(quantity)}
            disabled={disabled || maxQuantity < 1}
            aria-describedby={`${id}-hint`}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "") setDraft("");
              else if (/^\d+$/.test(value)) change(Number(value));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                change(draft && /^\d+$/.test(draft) ? Number(draft) : quantity);
              }
              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                change(quantity + (event.key === "ArrowUp" ? 1 : -1));
              }
            }}
            onBlur={() => {
              if (draft !== null && /^\d+$/.test(draft)) change(Number(draft));
              else setDraft(null);
            }}
          />
          <button
            type="button"
            aria-label="Increase equipment sets"
            disabled={disabled || quantity >= maxQuantity}
            onClick={() => change(quantity + 1)}
          >
            <Plus size={16} />
          </button>
        </div>
      </div>
      <div className="equipment-rental-description">
        <span>{money(price)} / set</span>
        <span aria-hidden="true">·</span>
        <span>{equipmentPackageLabel(ballCount)}</span>
      </div>
      <span id={`${id}-hint`} className="sr-only">
        Choose 0 for no equipment. Up to {maxQuantity} sets for this booking.
      </span>
      <span className="sr-only" aria-live="polite">
        Equipment rental: {quantity} {quantity === 1 ? "set" : "sets"},{" "}
        {money((Math.round(price * 100) * quantity) / 100)}.
      </span>
    </div>
  );
}
