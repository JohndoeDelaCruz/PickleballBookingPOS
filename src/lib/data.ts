import { cache } from "react";
import { createClient } from "./supabase/server";
import { defaultVenue, type VenueResult } from "./types";
import { defaultCourts, type Court } from "./courts";
import { readSessionAccess } from "./session-access";

export const getCourtInventory = cache(async () => {
  try {
  const db = await createClient();
  const { data, error } = await db.from("courts").select("*").order("id");
  if (error || !data) return { courts: defaultCourts, ready: false, loaded: false };
  return {
    courts: data.map((c) => ({ id: c.id, name: c.name, active: c.active ?? true, revision: c.revision ?? 0 })) as Court[],
    ready: data.every((c) => typeof c.active === "boolean" && typeof c.revision === "number"),
    loaded: true,
  };
  } catch { return { courts: defaultCourts, ready: false, loaded: false }; }
});

export const getVenue = cache(async (): Promise<VenueResult> => {
  // Public venue details and court inventory are independent reads.
  const settings = (async () => {
    try {
      const db = await createClient();
      const { data, error } = await db.from("venue_settings").select("*").eq("id", true).single();
      return error ? null : data;
    } catch { return null; }
  })();
  const [inventory, data] = await Promise.all([getCourtInventory(), settings]);
  const defaults = { ...defaultVenue, courts: inventory.courts };
  if (!data)
    return { venue: defaults, ready: false, openPlayReady: false, courtsReady: inventory.ready };
  if (!("evening_hourly_rate" in data))
    return {
      venue: {
        ...defaults,
        ...data,
        hourly_rate: data.hourly_rate ?? defaultVenue.hourly_rate,
        opening_hour: data.opening_hour ?? defaultVenue.opening_hour,
        closing_hour: data.closing_hour ?? defaultVenue.closing_hour,
      },
      ready: false,
      openPlayReady: false,
    };
  return {
    venue: { ...defaults, ...data },
    ready: inventory.loaded,
    courtsReady: inventory.ready,
    openPlayReady: "open_play_enabled" in data,
  };
});
export const getSession = cache(async () => {
  return readSessionAccess(await createClient());
});

export const getWorkspaceRole = cache(async () => {
  return (await getSession()).role;
});
