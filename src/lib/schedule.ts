import { z } from "zod";
import type { VenueSettings } from "./types";

export const weekDays = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
export type ScheduleBlock = {
  id: string;
  days: number[];
  start: number;
  end: number;
  kind: "court" | "open_play";
  rate: number;
  capacity: number | null;
};
export type ScheduleOverride = {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  blocks: ScheduleBlock[];
};
export type ScheduleConfig = {
  weekly: ScheduleBlock[];
  overrides: ScheduleOverride[];
};
export type DaySchedule = {
  blocks: ScheduleBlock[];
  override: Omit<ScheduleOverride, "blocks"> | null;
};

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const blockSchema = z
  .object({
    id,
    days: z
      .array(z.number().int().min(1).max(7))
      .min(1, "Choose at least one day.")
      .max(7),
    start: z.number().int().min(0).max(23),
    end: z.number().int().min(1).max(24),
    kind: z.enum(["court", "open_play"]),
    rate: z
      .number()
      .positive("Enter a rate above zero.")
      .max(100000)
      .multipleOf(0.01),
    capacity: z.number().int().min(1).max(100000).nullable(),
  })
  .superRefine((block, ctx) => {
    if (block.end <= block.start)
      ctx.addIssue({
        code: "custom",
        message: "End time must be after start time.",
      });
    if (new Set(block.days).size !== block.days.length)
      ctx.addIssue({ code: "custom", message: "Choose each day only once." });
    if (
      block.kind === "court" &&
      (block.capacity === null || block.capacity > 100)
    )
      ctx.addIssue({
        code: "custom",
        message: "Private courts need a player limit between 1 and 100.",
      });
  });
function validateBlocks(blocks: ScheduleBlock[], ctx: z.RefinementCtx) {
  if (new Set(blocks.map((b) => b.id)).size !== blocks.length)
    ctx.addIssue({
      code: "custom",
      message: "Each time block needs a unique identifier.",
    });
  for (let day = 1; day <= 7; day++) {
    const rows = blocks
      .filter((b) => b.days.includes(day))
      .sort((a, b) => a.start - b.start);
    if (rows.some((b, i) => i > 0 && b.start < rows[i - 1].end))
      ctx.addIssue({
        code: "custom",
        message: `${weekDays[day - 1]} has overlapping time blocks.`,
      });
  }
}
const blocksSchema = z.array(blockSchema).max(100).superRefine(validateBlocks);
const scheduleDate = z.iso
  .date()
  .refine(
    (value) => value >= "2000-01-01" && value <= "2100-12-31",
    "Choose a date between 2000 and 2100.",
  );
export const scheduleConfigSchema = z
  .object({
    weekly: blocksSchema,
    overrides: z
      .array(
        z.object({
          id,
          name: z
            .string()
            .trim()
            .min(1, "Name the temporary schedule.")
            .max(100),
          start_date: scheduleDate,
          end_date: scheduleDate,
          blocks: blocksSchema,
        }),
      )
      .max(30),
  })
  .superRefine((config, ctx) => {
    const periods = [...config.overrides].sort((a, b) =>
      a.start_date.localeCompare(b.start_date),
    );
    if (new Set(periods.map((p) => p.id)).size !== periods.length)
      ctx.addIssue({
        code: "custom",
        message: "Each temporary schedule needs a unique identifier.",
      });
    periods.forEach((period, i) => {
      if (period.end_date < period.start_date)
        ctx.addIssue({
          code: "custom",
          message: "The last date must be on or after the first date.",
        });
      if (i > 0 && period.start_date <= periods[i - 1].end_date)
        ctx.addIssue({
          code: "custom",
          message: "Temporary schedule date ranges must not overlap.",
        });
    });
  });

// Convert the saved legacy settings without changing any dates, prices, or preparation gaps.
export function legacySchedule(venue: VenueSettings): ScheduleConfig {
  const weekly: ScheduleBlock[] = [];
  if (
    venue.opening_hour === null ||
    venue.closing_hour === null ||
    venue.hourly_rate === null
  )
    return { weekly, overrides: [] };
  for (let day = 1; day <= 7; day++) {
    const openPlay = venue.open_play_enabled && day >= 6;
    for (let hour = venue.opening_hour; hour < venue.closing_hour; hour++) {
      if (
        openPlay &&
        hour >= venue.weekend_court_end_hour &&
        hour < venue.open_play_end_hour
      )
        continue;
      const rate =
        hour < venue.evening_start_hour
          ? venue.hourly_rate
          : venue.evening_hourly_rate;
      const previous = weekly.at(-1);
      if (
        previous?.kind === "court" &&
        previous.days[0] === day &&
        previous.end === hour &&
        previous.rate === rate
      )
        previous.end++;
      else
        weekly.push({
          id: `legacy-${day}-${hour}`,
          days: [day],
          start: hour,
          end: hour + 1,
          kind: "court",
          rate,
          capacity: venue.private_court_capacity,
        });
    }
    if (openPlay)
      weekly.push({
        id: `legacy-open-${day}`,
        days: [day],
        start: venue.open_play_start_hour,
        end: venue.open_play_end_hour,
        kind: "open_play",
        rate: venue.open_play_price,
        capacity: venue.open_play_capacity,
      });
  }
  // Group identical blocks across days for a compact staff editor.
  const grouped: ScheduleBlock[] = [];
  for (const block of weekly) {
    const match = grouped.find(
      (b) =>
        b.start === block.start &&
        b.end === block.end &&
        b.kind === block.kind &&
        b.rate === block.rate &&
        b.capacity === block.capacity,
    );
    if (match) match.days.push(...block.days);
    else grouped.push({ ...block, days: [...block.days] });
  }
  return { weekly: grouped, overrides: [] };
}

export function resolveSchedule(
  venue: VenueSettings,
  date: string,
): DaySchedule {
  const config = venue.schedule_config ?? legacySchedule(venue);
  const day = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  const override =
    config.overrides.find((p) => date >= p.start_date && date <= p.end_date) ??
    null;
  return {
    blocks: (override?.blocks ?? config.weekly)
      .filter((b) => b.days.includes(day))
      .sort((a, b) => a.start - b.start),
    override: override
      ? {
          id: override.id,
          name: override.name,
          start_date: override.start_date,
          end_date: override.end_date,
        }
      : null,
  };
}
export function scheduleHours(blocks: ScheduleBlock[]) {
  if (!blocks.length) return [];
  const start = Math.min(...blocks.map((b) => b.start));
  const end = Math.max(...blocks.map((b) => b.end));
  return Array.from({ length: end - start }, (_, i) => start + i);
}
export function scheduleCourtParts(
  blocks: ScheduleBlock[],
  start: number,
  duration: number,
) {
  return blocks
    .filter((b) => b.kind === "court")
    .flatMap((b) => {
      const from = Math.max(start, b.start),
        to = Math.min(start + duration, b.end);
      return to > from
        ? [
            {
              start: from,
              end: to,
              rate: b.rate,
              hours: to - from,
              amount: Math.round(b.rate * (to - from) * 100) / 100,
            },
          ]
        : [];
    });
}
export function daysLabel(days: number[]) {
  return [...days]
    .sort((a, b) => a - b)
    .map((day) => weekDays[day - 1].slice(0, 3))
    .join(", ");
}

export function introductoryBlocks(): ScheduleBlock[] {
  return [
    {
      id: "intro-weekday-early",
      days: [1, 2, 3, 4],
      start: 6,
      end: 8,
      kind: "court",
      rate: 100,
      capacity: 8,
    },
    {
      id: "intro-weekday-open",
      days: [1, 2, 3, 4],
      start: 8,
      end: 17,
      kind: "open_play",
      rate: 50,
      capacity: 24,
    },
    {
      id: "intro-weekday-evening",
      days: [1, 2, 3, 4],
      start: 17,
      end: 22,
      kind: "court",
      rate: 200,
      capacity: 8,
    },
    {
      id: "intro-weekend-early",
      days: [5, 6, 7],
      start: 6,
      end: 9,
      kind: "court",
      rate: 100,
      capacity: 8,
    },
    {
      id: "intro-weekend-day",
      days: [5, 6, 7],
      start: 9,
      end: 17,
      kind: "open_play",
      rate: 100,
      capacity: 24,
    },
    {
      id: "intro-weekend-evening",
      days: [5, 6, 7],
      start: 17,
      end: 22,
      kind: "open_play",
      rate: 100,
      capacity: 24,
    },
  ];
}
