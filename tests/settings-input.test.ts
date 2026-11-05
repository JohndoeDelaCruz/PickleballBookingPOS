import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSettingHour,
  parseSettingNumber,
  formatSettingTime,
} from "../src/lib/settings-input";
import { settingsSchema } from "../src/lib/booking";
import { defaultVenue } from "../src/lib/types";

test("typed setting amounts keep blanks distinct from zero and preserve centavos", () => {
  const range = { min: 0, max: 100000 };
  assert.ok(parseSettingNumber("", range).error);
  assert.deepEqual(parseSettingNumber("", { ...range, optional: true }), {
    value: null,
  });
  assert.deepEqual(parseSettingNumber("0", range), { value: 0 });
  assert.deepEqual(parseSettingNumber(" 30.50 ", range), { value: 30.5 });
  assert.ok(parseSettingNumber("0", { min: 0.01, max: 100000 }).error);
  for (const value of ["-1", "1e3", "100000.01", "30.123", "Infinity", "1,000"])
    assert.ok(parseSettingNumber(value, range).error, value);
});
test("typed hold and player limits accept integers within the existing ranges", () => {
  assert.deepEqual(
    parseSettingNumber("75", { min: 15, max: 120, integer: true }),
    { value: 75 },
  );
  for (const value of ["14", "121", "30.5", ""])
    assert.ok(
      parseSettingNumber(value, { min: 15, max: 120, integer: true }).error,
      value,
    );
  assert.deepEqual(
    parseSettingNumber("", {
      min: 1,
      max: 100000,
      integer: true,
      optional: true,
    }),
    { value: null },
  );
});
test("typed times accept AM/PM and 24-hour formats while keeping bookings on whole hours", () => {
  const range = { min: 0, max: 23 };
  for (const value of ["4 PM", "4:00 PM", "4:00pm", "16:00", "16", " 16:00 "])
    assert.deepEqual(parseSettingHour(value, range), { value: 16 }, value);
  assert.deepEqual(parseSettingHour("12 PM", range), { value: 12 });
  assert.deepEqual(parseSettingHour("12 AM", range), { value: 0 });
  assert.deepEqual(parseSettingHour("6AM", range), { value: 6 });
  for (const value of ["4:30 PM", "13 PM", "24:00", "25", "0 AM", "abc", ""])
    assert.ok(parseSettingHour(value, range).error, value);
});
test("closing midnight remains hour 24 and converted drafts retain server schedule validation", () => {
  assert.equal(formatSettingTime(null), "");
  assert.equal(formatSettingTime(6), "06:00");
  assert.equal(formatSettingTime(22), "22:00");
  assert.equal(
    parseSettingHour(formatSettingTime(24), { min: 1, max: 24 }).value,
    24,
  );
  assert.equal(
    parseSettingHour(formatSettingTime(0), { min: 0, max: 23 }).value,
    0,
  );
  for (const value of ["12:00 AM", "00:00", "24:00"])
    assert.deepEqual(parseSettingHour(value, { min: 1, max: 24 }), {
      value: 24,
    });
  assert.deepEqual(parseSettingHour("", { min: 0, max: 23, optional: true }), {
    value: null,
  });
  const draft = {
    ...defaultVenue,
    evening_start_hour: parseSettingHour("4PM", { min: 1, max: 23 }).value,
    closing_hour: parseSettingHour("10PM", { min: 1, max: 24 }).value,
    hold_minutes: parseSettingNumber("75", { min: 15, max: 120, integer: true })
      .value,
  };
  assert.equal(settingsSchema.safeParse(draft).success, true);
  assert.equal(
    settingsSchema.safeParse({ ...draft, closing_hour: 15 }).success,
    false,
  );
});
