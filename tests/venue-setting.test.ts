import test from "node:test";
import assert from "node:assert/strict";
import { venueSettingPatch } from "../src/lib/venue-setting";
import { defaultVenue } from "../src/lib/types";

test("individual setting updates contain only the requested field and preserve other saved settings", () => {
  const current = {
    ...defaultVenue,
    equipment_rental_price: 45,
    open_play_price: 100,
  };
  const before = structuredClone(current);
  assert.deepEqual(venueSettingPatch(current, "hourly_rate", 125.5).data, {
    hourly_rate: 125.5,
  });
  assert.deepEqual(venueSettingPatch(current, "open_play_price", 75).data, {
    open_play_price: 75,
  });
  assert.deepEqual(current, before);
});

test("individual Apply cannot update arbitrary columns or smuggle other fields through its value", () => {
  for (const key of [
    "id",
    "booking_enabled",
    "name",
    "__proto__",
    "constructor",
    null,
    ["hourly_rate"],
  ])
    assert.ok(venueSettingPatch(defaultVenue, key, 1).error, String(key));
  for (const value of ["125", NaN, { hourly_rate: 125, booking_enabled: true }])
    assert.ok(venueSettingPatch(defaultVenue, "hourly_rate", value).error);
});

test("individual time changes validate against saved session and opening hours", () => {
  assert.deepEqual(venueSettingPatch(defaultVenue, "closing_hour", 23).data, {
    closing_hour: 23,
  });
  for (const [key, value] of [
    ["closing_hour", 15],
    ["opening_hour", 17],
    ["evening_start_hour", 6],
    ["open_play_start_hour", 17],
    ["weekend_court_end_hour", 10],
    ["open_play_end_hour", 23],
    ["opening_hour", 6.5],
    ["closing_hour", null],
  ])
    assert.ok(
      venueSettingPatch(defaultVenue, key, value).error,
      `${key}=${value}`,
    );
});

test("individual numeric fields keep nullable limits, zero-price rental, integer holds, and booking prerequisites", () => {
  assert.deepEqual(
    venueSettingPatch(defaultVenue, "private_court_capacity", 10).data,
    { private_court_capacity: 10 },
  );
  assert.deepEqual(
    venueSettingPatch(defaultVenue, "equipment_ball_count", 2).data,
    { equipment_ball_count: 2 },
  );
  assert.deepEqual(
    venueSettingPatch(defaultVenue, "open_play_capacity", null).data,
    { open_play_capacity: null },
  );
  assert.deepEqual(
    venueSettingPatch(defaultVenue, "equipment_rental_price", 0).data,
    { equipment_rental_price: 0 },
  );
  for (const [key, value] of [
    ["hold_minutes", 14],
    ["hold_minutes", 30.5],
    ["open_play_capacity", 0],
    ["open_play_price", 0],
    ["equipment_rental_price", -1],
    ["equipment_ball_count", 0],
    ["equipment_ball_count", 21],
    ["equipment_ball_count", 1.5],
    ["private_court_capacity", 0],
    ["private_court_capacity", 101],
  ])
    assert.ok(
      venueSettingPatch(defaultVenue, key, value).error,
      `${key}=${value}`,
    );
  const openVenue = {
    ...defaultVenue,
    booking_enabled: true,
    gcash_name: "Rally",
    gcash_qr_url: "https://example.com/qr.png",
  };
  assert.ok(venueSettingPatch(openVenue, "hourly_rate", null).error);
});
