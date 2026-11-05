import { z } from "zod";
import { settingsSchema } from "./booking";
import type { VenueSettings } from "./types";

export const individualSettingKey = z.enum([
  "hourly_rate",
  "evening_hourly_rate",
  "evening_start_hour",
  "equipment_rental_price",
  "equipment_ball_count",
  "private_court_capacity",
  "hold_minutes",
  "opening_hour",
  "closing_hour",
  "weekend_court_end_hour",
  "open_play_start_hour",
  "open_play_end_hour",
  "open_play_price",
  "open_play_capacity",
]);

export type IndividualSettingKey = z.infer<typeof individualSettingKey>;

export function venueSettingPatch(
  current: VenueSettings,
  key: unknown,
  value: unknown,
) {
  const field = individualSettingKey.safeParse(key);
  if (!field.success)
    return { error: "Choose a numeric or time setting to apply." };
  const parsed = settingsSchema.safeParse({ ...current, [field.data]: value });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  return {
    data: { [field.data]: parsed.data[field.data] } as Partial<
      Pick<VenueSettings, IndividualSettingKey>
    >,
  };
}
