import { z } from "zod";
import type { Availability, VenueSettings } from "./types";
import { paymentOptionSchema } from "./payment";
import { resolveSchedule, scheduleCourtParts } from "./schedule";

export const TIME_ZONE = "Asia/Manila";
export function isValidDate(value: string | undefined): value is string {
  return z.iso.date().safeParse(value).success;
}
export function localDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}-${parts.find((p) => p.type === "day")!.value}`;
}
export function addDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00+08:00`);
  value.setUTCDate(value.getUTCDate() + days);
  return localDate(value);
}
export function formatDate(
  date: string,
  options: Intl.DateTimeFormatOptions = {
    month: "long",
    day: "numeric",
    year: "numeric",
  },
) {
  return new Intl.DateTimeFormat("en-PH", {
    ...options,
    timeZone: TIME_ZONE,
  }).format(new Date(`${date}T12:00:00+08:00`));
}
export function formatHour(hour: number) {
  return `${hour % 12 || 12}:00 ${hour < 12 || hour === 24 ? "AM" : "PM"}`;
}
export function money(amount: number) {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: Number.isInteger(Number(amount)) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
}
export function equipmentPackageLabel(ballCount: number, quantity = 1) {
  const balls = ballCount * quantity;
  return `${quantity} ${quantity === 1 ? "paddle" : "paddles"} + ${balls} ${balls === 1 ? "ball" : "balls"}`;
}
export function savedEquipmentQuantity(booking: {
  equipment_rental: boolean;
  equipment_quantity?: number;
}) {
  return booking.equipment_quantity ?? (booking.equipment_rental ? 1 : 0);
}
export function equipmentBookingLabel(booking: {
  equipment_rental: boolean;
  equipment_quantity?: number;
  equipment_ball_count?: number;
}) {
  const quantity = savedEquipmentQuantity(booking);
  return `${quantity} equipment ${quantity === 1 ? "set" : "sets"} · ${equipmentPackageLabel(booking.equipment_ball_count ?? 2, quantity)}`;
}
export function privateEquipmentLimit(
  venue: VenueSettings,
  date: string,
  start?: number,
  duration = 1,
) {
  const limits =
    start === undefined
      ? []
      : resolveSchedule(venue, date)
          .blocks.filter(
            (b) =>
              b.kind === "court" && b.start < start + duration && b.end > start,
          )
          .map((b) => b.capacity ?? venue.private_court_capacity);
  return Math.min(
    100,
    ...(limits.length ? limits : [venue.private_court_capacity]),
  );
}
export function getRatePeriods(venue: VenueSettings) {
  if (
    venue.opening_hour === null ||
    venue.closing_hour === null ||
    venue.hourly_rate === null
  )
    return [];
  return [
    {
      start: venue.opening_hour,
      end: Math.min(venue.evening_start_hour, venue.closing_hour),
      rate: venue.hourly_rate,
    },
    {
      start: Math.max(venue.evening_start_hour, venue.opening_hour),
      end: venue.closing_hour,
      rate: venue.evening_hourly_rate,
    },
  ].filter((period) => period.start < period.end);
}
export function getPriceBreakdown(
  venue: VenueSettings,
  start: number,
  duration: number,
  date?: string,
) {
  if (date)
    return scheduleCourtParts(
      resolveSchedule(venue, date).blocks,
      start,
      duration,
    );
  return getRatePeriods(venue).flatMap((period) => {
    const from = Math.max(start, period.start);
    const to = Math.min(start + duration, period.end);
    return to > from
      ? [
          {
            start: from,
            end: to,
            rate: period.rate,
            hours: to - from,
            amount: Math.round(period.rate * (to - from) * 100) / 100,
          },
        ]
      : [];
  });
}
export function calculateCourtTotal(
  venue: VenueSettings,
  start: number,
  duration: number,
  date?: string,
) {
  const parts = getPriceBreakdown(venue, start, duration, date);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(duration) ||
    duration < 1 ||
    duration > 4 ||
    parts.reduce((sum, part) => sum + part.hours, 0) !== duration
  )
    return null;
  return (
    Math.round(parts.reduce((sum, part) => sum + part.amount, 0) * 100) / 100
  );
}
export function isPastSlot(date: string, hour: number, now = new Date()) {
  return (
    new Date(
      `${date}T${String(hour).padStart(2, "0")}:00:00+08:00`,
    ).getTime() <= now.getTime()
  );
}
export function isWeekend(date: string) {
  const day = new Date(`${date}T12:00:00+08:00`).getUTCDay();
  return day === 0 || day === 6;
}
export function hasOpenPlay(venue: VenueSettings, date: string) {
  if (venue.schedule_config)
    return resolveSchedule(venue, date).blocks.some(
      (b) => b.kind === "open_play",
    );
  return venue.open_play_enabled && isWeekend(date);
}
export function openPlayCapacityLabel(capacity: number | null) {
  if (capacity === null) return "No player limit across active courts";
  return `${capacity} ${capacity === 1 ? "player" : "players"} total across active courts`;
}
export function courtScheduleLabel(
  venue: VenueSettings,
  date: string,
  start: number,
  duration = 1,
) {
  if (venue.schedule_config) {
    const blocks = resolveSchedule(venue, date).blocks;
    if (
      blocks.some(
        (b) =>
          b.kind === "open_play" && start < b.end && start + duration > b.start,
      )
    )
      return "Open play";
    return calculateCourtTotal(venue, start, duration, date) === null
      ? "Closed"
      : null;
  }
  if (!hasOpenPlay(venue, date)) return null;
  if (
    start < venue.open_play_end_hour &&
    start + duration > venue.weekend_court_end_hour
  )
    return start + duration > venue.open_play_start_hour
      ? "Open play"
      : "Preparation";
  return null;
}
export function isSlotAvailable(
  slots: Availability[],
  court: number,
  start: number,
  duration: number,
) {
  return !slots.some(
    (slot) =>
      slot.court_id === court &&
      !["cancelled", "expired"].includes(slot.status) &&
      start < slot.start_hour + slot.duration &&
      start + duration > slot.start_hour,
  );
}
export function canBook(venue: VenueSettings) {
  if (venue.courts && !venue.courts.some((court) => court.active)) return false;
  if (venue.schedule_config)
    return (
      venue.booking_enabled && Boolean(venue.gcash_qr_url && venue.gcash_name)
    );
  return (
    venue.booking_enabled &&
    venue.hourly_rate !== null &&
    venue.hourly_rate > 0 &&
    venue.evening_hourly_rate > 0 &&
    venue.opening_hour !== null &&
    venue.closing_hour !== null &&
    venue.closing_hour > venue.opening_hour &&
    venue.evening_start_hour > venue.opening_hour &&
    venue.evening_start_hour < venue.closing_hour &&
    Boolean(venue.gcash_qr_url && venue.gcash_name)
  );
}
export const bookingSchema = z.object({
  payment_option: paymentOptionSchema.default("full"),
  equipment_rental: z.boolean().default(false),
  equipment_quantity: z.number().int().min(0).max(100).optional(),
  court_id: z.coerce.number().int().min(1).max(32767),
  booking_date: z.iso.date(),
  start_hour: z.coerce.number().int().min(0).max(23),
  duration: z.coerce.number().int().min(1).max(4),
  customer_name: z
    .string()
    .trim()
    .min(2, "Please enter your full name.")
    .max(100),
  customer_phone: z
    .string()
    .trim()
    .regex(
      /^(?:\+63|0)9\d{9}$/,
      "Use a Philippine mobile number, e.g. 09171234567.",
    ),
});
export const openPlaySchema = bookingSchema
  .pick({
    booking_date: true,
    customer_name: true,
    customer_phone: true,
    equipment_rental: true,
    equipment_quantity: true,
    payment_option: true,
  })
  .extend({
    participant_count: z.coerce.number().int().min(1).max(20),
    start_hour: z.coerce.number().int().min(0).max(23).optional(),
  });
export function calculateReservationTotal(
  base: number,
  equipmentPrice: number,
  equipmentRental: boolean | number,
) {
  const quantity =
    typeof equipmentRental === "boolean"
      ? Number(equipmentRental)
      : equipmentRental;
  return (
    (Math.round(base * 100) + quantity * Math.round(equipmentPrice * 100)) / 100
  );
}
export function bookingBaseAmount(booking: {
  total_amount: number;
  equipment_amount?: number;
}) {
  return (
    (Math.round(Number(booking.total_amount) * 100) -
      Math.round(Number(booking.equipment_amount || 0) * 100)) /
    100
  );
}
export const settingsSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    tagline: z.string().trim().max(180),
    address: z.string().trim().max(300),
    city: z.string().trim().max(100),
    phone: z.string().trim().max(40),
    email: z.union([z.literal(""), z.email()]),
    facebook_url: z.union([
      z.literal(""),
      z.url().regex(/^https:\/\//, "Use an https:// link."),
    ]),
    hourly_rate: z.number().positive().max(100000).nullable(),
    evening_hourly_rate: z.number().positive().max(100000),
    evening_start_hour: z.number().int().min(1).max(23),
    equipment_rental_price: z.number().min(0).max(100000),
    equipment_ball_count: z.number().int().min(1).max(20),
    private_court_capacity: z.number().int().min(1).max(100),
    opening_hour: z.number().int().min(0).max(23).nullable(),
    closing_hour: z.number().int().min(1).max(24).nullable(),
    hold_minutes: z.number().int().min(15).max(120),
    booking_enabled: z.boolean(),
    open_play_enabled: z.boolean(),
    open_play_start_hour: z.number().int().min(0).max(23),
    open_play_end_hour: z.number().int().min(1).max(24),
    weekend_court_end_hour: z.number().int().min(0).max(23),
    open_play_price: z.number().positive().max(100000),
    open_play_capacity: z.number().int().min(1).max(100000).nullable(),
    gcash_name: z.string().trim().max(100),
    gcash_number: z.string().trim().max(40),
    gcash_qr_url: z.union([
      z.literal(""),
      z.url().regex(/^https:\/\//, "Use an https:// image link."),
    ]),
    cancellation_policy: z.string().trim().min(10).max(2000),
  })
  .superRefine((v, ctx) => {
    if (
      v.open_play_end_hour <= v.open_play_start_hour ||
      v.weekend_court_end_hour > v.open_play_start_hour ||
      (v.open_play_enabled &&
        (v.opening_hour === null ||
          v.closing_hour === null ||
          v.weekend_court_end_hour < v.opening_hour ||
          v.open_play_end_hour > v.closing_hour))
    )
      ctx.addIssue({
        code: "custom",
        path: ["open_play_start_hour"],
        message:
          "Keep weekend booking and open-play hours within opening hours, with open play ending after it starts.",
      });
    if (
      v.opening_hour !== null &&
      v.closing_hour !== null &&
      (v.evening_start_hour <= v.opening_hour ||
        v.evening_start_hour >= v.closing_hour)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "The evening rate must start between opening and closing time.",
        path: ["evening_start_hour"],
      });
    if ((v.opening_hour === null) !== (v.closing_hour === null))
      ctx.addIssue({
        code: "custom",
        message: "Set both opening and closing hours, or leave both empty.",
        path: ["closing_hour"],
      });
    if (
      v.opening_hour !== null &&
      v.closing_hour !== null &&
      v.closing_hour <= v.opening_hour
    )
      ctx.addIssue({
        code: "custom",
        message: "Closing time must be after opening time.",
        path: ["closing_hour"],
      });
    if (
      v.booking_enabled &&
      (!v.hourly_rate ||
        v.opening_hour === null ||
        v.closing_hour === null ||
        !v.gcash_name ||
        !v.gcash_qr_url)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Add rates, hours, GCash account name, and a QR image before opening reservations.",
        path: ["booking_enabled"],
      });
  });
