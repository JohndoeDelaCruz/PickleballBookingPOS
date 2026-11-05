import test from "node:test";
import assert from "node:assert/strict";
import {
  introductoryBlocks,
  legacySchedule,
  resolveSchedule,
  scheduleConfigSchema,
  scheduleHours,
} from "../src/lib/schedule";
import {
  calculateCourtTotal,
  courtScheduleLabel,
  getPriceBreakdown,
  hasOpenPlay,
} from "../src/lib/booking";
import { defaultVenue } from "../src/lib/types";

test("introductory week includes Friday morning private hours and two separate weekend sessions", () => {
  const config = { weekly: introductoryBlocks(), overrides: [] };
  assert.ok(scheduleConfigSchema.safeParse(config).success);
  const venue = { ...defaultVenue, schedule_config: config };
  assert.deepEqual(
    resolveSchedule(venue, "2026-10-26").blocks.map((b) => [
      b.start,
      b.end,
      b.kind,
      b.rate,
    ]),
    [
      [6, 8, "court", 100],
      [8, 17, "open_play", 50],
      [17, 22, "court", 200],
    ],
  );
  for (const date of ["2026-10-30", "2026-10-31", "2026-11-01"]) {
    assert.deepEqual(
      resolveSchedule(venue, date).blocks.map((b) => [
        b.start,
        b.end,
        b.kind,
        b.rate,
      ]),
      [
        [6, 9, "court", 100],
        [9, 17, "open_play", 100],
        [17, 22, "open_play", 100],
      ],
    );
    assert.equal(calculateCourtTotal(venue, 6, 3, date), 300);
    assert.equal(calculateCourtTotal(venue, 8, 2, date), null);
  }
  assert.equal(hasOpenPlay(venue, "2026-10-26"), true);
  assert.equal(courtScheduleLabel(venue, "2026-10-26", 8), "Open play");
});

test("temporary schedules replace the whole date range and resume the saved weekly schedule afterward", () => {
  const venue = {
    ...defaultVenue,
    schedule_config: {
      weekly: introductoryBlocks(),
      overrides: [
        {
          id: "special",
          name: "One week",
          start_date: "2026-10-26",
          end_date: "2026-11-01",
          blocks: [
            {
              id: "special-hour",
              days: [1],
              start: 10,
              end: 11,
              kind: "court" as const,
              rate: 175,
              capacity: 8,
            },
          ],
        },
      ],
    },
  };
  assert.equal(calculateCourtTotal(venue, 10, 1, "2026-10-26"), 175);
  assert.equal(calculateCourtTotal(venue, 6, 1, "2026-10-26"), null);
  assert.deepEqual(resolveSchedule(venue, "2026-10-27").blocks, []);
  assert.ok(resolveSchedule(venue, "2026-11-01").override);
  assert.equal(resolveSchedule(venue, "2026-11-02").override, null);
  assert.equal(calculateCourtTotal(venue, 6, 1, "2026-11-02"), 100);
});

test("private quotes split price changes, reject gaps and open-play boundaries, and support end-of-day midnight", () => {
  const venue = {
    ...defaultVenue,
    schedule_config: {
      weekly: [
        {
          id: "day",
          days: [1],
          start: 14,
          end: 16,
          kind: "court" as const,
          rate: 100,
          capacity: 8,
        },
        {
          id: "night",
          days: [1],
          start: 16,
          end: 18,
          kind: "court" as const,
          rate: 200,
          capacity: 8,
        },
        {
          id: "late",
          days: [1],
          start: 22,
          end: 24,
          kind: "court" as const,
          rate: 250,
          capacity: 8,
        },
      ],
      overrides: [],
    },
  };
  assert.equal(calculateCourtTotal(venue, 15, 2, "2026-10-26"), 300);
  assert.deepEqual(
    getPriceBreakdown(venue, 15, 2, "2026-10-26").map((p) => p.amount),
    [100, 200],
  );
  assert.equal(calculateCourtTotal(venue, 17, 2, "2026-10-26"), null);
  assert.equal(courtScheduleLabel(venue, "2026-10-26", 19), "Closed");
  assert.equal(calculateCourtTotal(venue, 23, 1, "2026-10-26"), 250);
  assert.equal(calculateCourtTotal(venue, 23, 2, "2026-10-26"), null);
  assert.deepEqual(scheduleHours([]), []);
  assert.deepEqual(
    scheduleHours(venue.schedule_config.weekly),
    Array.from({ length: 10 }, (_, i) => i + 14),
  );
});

test("schedule validation rejects overlaps, invalid days, impossible dates, and invalid capacity", () => {
  const base = { weekly: introductoryBlocks(), overrides: [] };
  const validate = (weekly: unknown) =>
    scheduleConfigSchema.safeParse({ ...base, weekly }).success;
  assert.equal(validate([{ ...base.weekly[0], days: ["1"] }]), false);
  assert.equal(validate([{ ...base.weekly[0], days: [1, 1] }]), false);
  assert.equal(validate([{ ...base.weekly[0], capacity: null }]), false);
  assert.equal(validate([{ ...base.weekly[1], capacity: null }]), true);
  assert.equal(validate([{ ...base.weekly[0], end: 6 }]), false);
  assert.equal(validate([{ ...base.weekly[0], rate: 100.001 }]), false);
  assert.equal(
    validate([base.weekly[0], { ...base.weekly[0], id: "overlap" }]),
    false,
  );
  assert.equal(
    validate([
      base.weekly[0],
      { ...base.weekly[0], id: "adjacent", start: 8, end: 9 },
    ]),
    true,
  );
  const period = {
    id: "one",
    name: "Test",
    start_date: "2026-10-26",
    end_date: "2026-11-01",
    blocks: [],
  };
  assert.equal(
    scheduleConfigSchema.safeParse({
      ...base,
      overrides: [period, { ...period, id: "two" }],
    }).success,
    false,
  );
  assert.equal(
    scheduleConfigSchema.safeParse({
      ...base,
      overrides: [{ ...period, start_date: "2026-02-30" }],
    }).success,
    false,
  );
  assert.ok(
    scheduleConfigSchema.safeParse({ weekly: [], overrides: [] }).success,
  );
});

test("converting the legacy schedule preserves custom rates, preparation gaps, and capacities", () => {
  const venue = {
    ...defaultVenue,
    hourly_rate: 120,
    evening_hourly_rate: 220,
    opening_hour: 6,
    closing_hour: 22,
    open_play_enabled: true,
    weekend_court_end_hour: 8,
    open_play_start_hour: 9,
    open_play_end_hour: 16,
    open_play_price: 125,
    open_play_capacity: 24,
  };
  const config = legacySchedule(venue);
  assert.ok(scheduleConfigSchema.safeParse(config).success);
  const converted = { ...venue, schedule_config: config };
  assert.equal(calculateCourtTotal(converted, 15, 2, "2026-10-26"), 340);
  assert.equal(calculateCourtTotal(converted, 7, 1, "2026-10-31"), 120);
  assert.equal(calculateCourtTotal(converted, 8, 1, "2026-10-31"), null);
  assert.deepEqual(
    resolveSchedule(converted, "2026-10-31")
      .blocks.filter((b) => b.kind === "open_play")
      .map((b) => [b.rate, b.capacity]),
    [[125, 24]],
  );
});
