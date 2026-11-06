import { z } from "zod";

export type Court = { id: number; name: string; active: boolean; revision: number };
export const defaultCourts: Court[] = [
  { id: 1, name: "Court 1", active: true, revision: 0 },
  { id: 2, name: "Court 2", active: true, revision: 0 },
];
export const courtSchema = z.object({
  id: z.number().int().min(1).max(32767).nullable(),
  name: z.string().trim().min(1, "Enter a court name.").max(60),
  active: z.boolean(),
  revision: z.number().int().min(0).nullable(),
});
export const deleteCourtSchema = z.object({
  id: z.number().int().min(1).max(32767),
  revision: z.number().int().min(0),
});
export function activeCourts(courts: Court[] = defaultCourts) {
  return courts.filter((court) => court.active);
}
export function courtName(courts: Court[] | undefined, id: number | null) {
  return courts?.find((court) => court.id === id)?.name ?? `Court ${id}`;
}
export function calendarCourts(courts: Court[], bookings: { court_id: number | null }[]) {
  return courts.filter((court) => court.active || bookings.some((b) => b.court_id === court.id));
}
