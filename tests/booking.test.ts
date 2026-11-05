import test from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  bookingSchema,
  canBook,
  calculateCourtTotal,
  calculateReservationTotal,
  bookingBaseAmount,
  formatHour,
  isPastSlot,
  isSlotAvailable,
  localDate,
  money,
  getPriceBreakdown,
  settingsSchema,
  courtScheduleLabel,
  hasOpenPlay,
  isWeekend,
  openPlaySchema,
} from "../src/lib/booking";
import { defaultVenue } from "../src/lib/types";

test("optional equipment adds one saved package charge without changing hourly or open-play prices", () => {
  assert.equal(calculateReservationTotal(100, 30, false), 100);
  assert.equal(calculateReservationTotal(100, 30, true), 130);
  assert.equal(calculateReservationTotal(600, 30, true), 630);
  assert.equal(calculateReservationTotal(150, 30, true), 180);
  assert.equal(calculateReservationTotal(100.1, 30.2, true), 130.3);
  assert.equal(
    bookingBaseAmount({ total_amount: 630, equipment_amount: 30 }),
    600,
  );
  assert.equal(
    bookingBaseAmount({ total_amount: 130.3, equipment_amount: 30.2 }),
    100.1,
  );
  assert.equal(
    openPlaySchema.parse({
      booking_date: "2026-10-24",
      participant_count: 1,
      customer_name: "Player",
      customer_phone: "09171234567",
    }).equipment_rental,
    false,
  );
  assert.equal(
    openPlaySchema.safeParse({
      booking_date: "2026-10-24",
      participant_count: 1,
      customer_name: "Player",
      customer_phone: "09171234567",
      equipment_rental: "true",
    }).success,
    false,
  );
});

test("weekend sessions use Philippine dates and leave private bookings before 9 AM and from 4 PM", () => {
  assert.equal(isWeekend("2026-10-24"), true);
  assert.equal(isWeekend("2026-10-25"), true);
  assert.equal(isWeekend("2026-10-26"), false);
  assert.equal(hasOpenPlay(defaultVenue, "2026-10-24"), true);
  assert.equal(courtScheduleLabel(defaultVenue, "2026-10-24", 8), null);
  assert.equal(
    courtScheduleLabel(defaultVenue, "2026-10-24", 8, 2),
    "Open play",
  );
  assert.equal(courtScheduleLabel(defaultVenue, "2026-10-24", 9), "Open play");
  assert.equal(courtScheduleLabel(defaultVenue, "2026-10-25", 15), "Open play");
  assert.equal(courtScheduleLabel(defaultVenue, "2026-10-24", 16), null);
  assert.equal(courtScheduleLabel(defaultVenue, "2026-10-26", 9), null);
  assert.equal(
    courtScheduleLabel(
      { ...defaultVenue, open_play_enabled: false },
      "2026-10-24",
      9,
    ),
    null,
  );
  assert.equal(
    courtScheduleLabel(
      { ...defaultVenue, weekend_court_end_hour: 8 },
      "2026-10-24",
      8,
    ),
    "Preparation",
  );
});

test("open-play settings default to 24 players, allow an optional limit, and validate sessions and pass groups", () => {
  assert.equal(defaultVenue.open_play_price, 50);
  assert.equal(defaultVenue.open_play_capacity, 24);
  assert.equal(settingsSchema.safeParse(defaultVenue).success, true);
  assert.equal(
    settingsSchema.safeParse({ ...defaultVenue, open_play_capacity: null })
      .success,
    true,
  );
  for (const patch of [
    { open_play_end_hour: 9 },
    { weekend_court_end_hour: 10 },
    { open_play_price: 0 },
    { open_play_capacity: 0 },
    { opening_hour: 10 },
  ])
    assert.equal(
      settingsSchema.safeParse({ ...defaultVenue, ...patch }).success,
      false,
    );
  const valid = {
    booking_date: "2026-10-24",
    participant_count: 3,
    customer_name: "Group Player",
    customer_phone: "09171234567",
  };
  assert.equal(openPlaySchema.safeParse(valid).success, true);
  for (const patch of [
    { participant_count: 0 },
    { participant_count: 21 },
    { customer_phone: "123" },
  ])
    assert.equal(
      openPlaySchema.safeParse({ ...valid, ...patch }).success,
      false,
    );
});

test("court prices switch at 4 PM, split mixed bookings, and exclude rentals", () => {
  assert.equal(calculateCourtTotal(defaultVenue, 6, 1), 100);
  assert.equal(calculateCourtTotal(defaultVenue, 15, 1), 100);
  assert.equal(calculateCourtTotal(defaultVenue, 16, 1), 200);
  assert.equal(calculateCourtTotal(defaultVenue, 21, 1), 200);
  assert.equal(calculateCourtTotal(defaultVenue, 15, 2), 300);
  assert.equal(calculateCourtTotal(defaultVenue, 14, 4), 600);
  assert.equal(calculateCourtTotal(defaultVenue, 18, 4), 800);
  assert.equal(calculateCourtTotal(defaultVenue, 22, 1), null);
  assert.equal(calculateCourtTotal(defaultVenue, 5, 2), null);
  assert.equal(calculateCourtTotal(defaultVenue, 15, 5), null);
  assert.equal(
    calculateCourtTotal(
      { ...defaultVenue, equipment_rental_price: 999 },
      15,
      2,
    ),
    300,
  );
  assert.equal(
    calculateCourtTotal(
      { ...defaultVenue, hourly_rate: 100.5, evening_hourly_rate: 150.25 },
      15,
      2,
    ),
    250.75,
  );
  assert.deepEqual(
    getPriceBreakdown(defaultVenue, 15, 2).map(({ hours, rate }) => ({
      hours,
      rate,
    })),
    [
      { hours: 1, rate: 100 },
      { hours: 1, rate: 200 },
    ],
  );
});

test("editable pricing enforces a valid evening start and uses saved rates", () => {
  const changed = {
    ...defaultVenue,
    hourly_rate: 120,
    evening_hourly_rate: 180,
    evening_start_hour: 17,
  };
  assert.equal(calculateCourtTotal(changed, 16, 2), 300);
  for (const patch of [
    { evening_start_hour: 6 },
    { evening_start_hour: 22 },
    { evening_hourly_rate: -1 },
    { equipment_rental_price: -1 },
  ])
    assert.equal(
      settingsSchema.safeParse({ ...defaultVenue, ...patch }).success,
      false,
    );
});

test("booking totals preserve centavos in displayed GCash amounts", () => {
  assert.match(money(500.5), /500\.50$/);
  assert.match(money(1000.01), /1,000\.01$/);
  assert.match(money(500), /500$/);
});

test("dates and cutoffs use Philippine Time across midnight and month boundaries", () => {
  assert.equal(localDate(new Date("2026-10-23T16:01:00Z")), "2026-10-24");
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(formatHour(0), "12:00 AM");
  assert.equal(formatHour(12), "12:00 PM");
  assert.equal(formatHour(24), "12:00 AM");
  assert.equal(
    isPastSlot("2026-10-24", 8, new Date("2026-10-24T00:00:00Z")),
    true,
  );
  assert.equal(
    isPastSlot("2026-10-24", 9, new Date("2026-10-24T00:00:00Z")),
    false,
  );
});
test("multi-hour slots detect every overlap and allow adjacent play on either court", () => {
  const slots = [
    { court_id: 1, start_hour: 10, duration: 2, status: "confirmed" as const },
  ];
  assert.equal(isSlotAvailable(slots, 1, 9, 2), false);
  assert.equal(isSlotAvailable(slots, 1, 11, 1), false);
  assert.equal(isSlotAvailable(slots, 1, 8, 2), true);
  assert.equal(isSlotAvailable(slots, 1, 12, 2), true);
  assert.equal(isSlotAvailable(slots, 2, 10, 2), true);
  assert.equal(
    isSlotAvailable([{ ...slots[0], status: "expired" }], 1, 10, 2),
    true,
  );
});
test("incomplete venue details cannot open reservations", () => {
  assert.equal(canBook(defaultVenue), false);
  assert.equal(
    settingsSchema.safeParse({ ...defaultVenue, booking_enabled: true })
      .success,
    false,
  );
  assert.equal(
    settingsSchema.safeParse({
      ...defaultVenue,
      opening_hour: 8,
      closing_hour: 7,
    }).success,
    false,
  );
  const configured = {
    ...defaultVenue,
    booking_enabled: true,
    hourly_rate: 500,
    opening_hour: 6,
    closing_hour: 22,
    gcash_name: "Rally",
    gcash_qr_url: "https://example.com/qr.png",
  };
  assert.equal(canBook(configured), true);
  assert.equal(settingsSchema.safeParse(configured).success, true);
  assert.equal(
    settingsSchema.safeParse({
      ...configured,
      gcash_qr_url: "javascript:alert(1)",
    }).success,
    false,
  );
});
test("booking validation rejects invalid phones, court IDs, durations, and impossible dates", () => {
  const valid = {
    court_id: 1,
    booking_date: "2026-10-24",
    start_hour: 8,
    duration: 2,
    customer_name: "Player One",
    customer_phone: "09171234567",
  };
  assert.equal(bookingSchema.safeParse(valid).success, true);
  for (const patch of [
    { court_id: 0 },
    { court_id: 32768 },
    { duration: 5 },
    { customer_phone: "123" },
    { booking_date: "2026-02-30" },
  ])
    assert.equal(
      bookingSchema.safeParse({ ...valid, ...patch }).success,
      false,
    );
});
