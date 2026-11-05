"use client";

import { useId, useState, type ReactNode, type Ref } from "react";
import {
  formatSettingTime,
  parseSettingHour,
  parseSettingNumber,
} from "@/lib/settings-input";

export function TypedSettingField({
  label,
  ariaLabel,
  value,
  kind = "money",
  min,
  max,
  optional = false,
  hint,
  placeholder,
  action,
  inputRef,
  disabled = false,
  onDraftChange,
  onChange,
}: {
  label: string;
  ariaLabel?: string;
  value: number | null;
  kind?: "money" | "integer" | "hour";
  min: number;
  max: number;
  optional?: boolean;
  hint?: string;
  placeholder?: string;
  action?: ReactNode;
  inputRef?: Ref<HTMLInputElement>;
  disabled?: boolean;
  onDraftChange?: () => void;
  onChange: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(() =>
    kind === "hour"
      ? formatSettingTime(value)
      : value === null
        ? ""
        : String(value),
  );
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  function parse(text: string) {
    return kind === "hour"
      ? parseSettingHour(text, { min, max, optional })
      : parseSettingNumber(text, {
          min,
          max,
          optional,
          integer: kind === "integer",
        });
  }
  const input = (
    <input
      id={inputId}
      aria-label={ariaLabel}
      ref={inputRef}
      type={kind === "hour" ? "time" : "text"}
      step={kind === "hour" ? 3600 : undefined}
      inputMode={
        kind === "hour" ? undefined : kind === "integer" ? "numeric" : "decimal"
      }
      value={draft}
      disabled={disabled}
      required={!optional}
      maxLength={kind === "hour" ? undefined : 14}
      placeholder={kind === "hour" ? undefined : placeholder}
      aria-describedby={hint ? hintId : undefined}
      autoComplete="off"
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        onDraftChange?.();
        const result = parse(text);
        event.currentTarget.setCustomValidity(result.error ?? "");
        if (result.error === undefined) onChange(result.value);
      }}
      onBlur={(event) =>
        event.currentTarget.setCustomValidity(parse(draft).error ?? "")
      }
    />
  );
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      {action ? (
        <div className="field-control-row">
          {input}
          {action}
        </div>
      ) : (
        input
      )}
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  );
}
