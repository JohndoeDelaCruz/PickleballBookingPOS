export type SettingInputResult =
  { value: number | null; error?: never } | { error: string; value?: never };

type InputRange = { min: number; max: number; optional?: boolean };

export function formatSettingTime(hour: number | null) {
  return hour === null ? "" : `${String(hour % 24).padStart(2, "0")}:00`;
}

export function parseSettingNumber(
  text: string,
  {
    min,
    max,
    optional = false,
    integer = false,
  }: InputRange & { integer?: boolean },
): SettingInputResult {
  const draft = text.trim();
  if (!draft) return optional ? { value: null } : { error: "Enter a value." };
  if (!(integer ? /^\d+$/ : /^\d+(?:\.\d{1,2})?$/).test(draft))
    return {
      error: integer
        ? "Enter a whole number."
        : "Enter a number with up to 2 decimal places.",
    };
  const value = Number(draft);
  if (!Number.isFinite(value) || value < min || value > max)
    return { error: `Enter a value from ${min} to ${max}.` };
  return { value };
}

export function parseSettingHour(
  text: string,
  { min, max, optional = false }: InputRange,
): SettingInputResult {
  const draft = text.trim();
  if (!draft) return optional ? { value: null } : { error: "Enter a time." };
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(draft);
  const invalid = {
    error: "Enter a whole-hour time, such as 4:00 PM or 16:00.",
  };
  if (!match || (match[2] !== undefined && match[2] !== "00")) return invalid;
  let hour = Number(match[1]);
  if (match[3]) {
    if (hour < 1 || hour > 12) return invalid;
    hour = (hour % 12) + (match[3].toLowerCase() === "pm" ? 12 : 0);
  }
  // Closing/session-end midnight is the end of the day, saved as hour 24.
  if (hour === 0 && min > 0 && max === 24) hour = 24;
  if (hour < min || hour > max) return invalid;
  return { value: hour };
}
