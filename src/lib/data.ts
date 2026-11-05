import { cache } from "react";
import { createClient } from "./supabase/server";
import { defaultVenue, type VenueResult } from "./types";
import { defaultCourts, type Court } from "./courts";

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
  const inventory = await getCourtInventory();
  const defaults = { ...defaultVenue, courts: inventory.courts };
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("venue_settings")
      .select("*")
      .eq("id", true)
      .single();
    if (error || !data)
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
  } catch {
    return { venue: defaults, ready: false, openPlayReady: false, courtsReady: inventory.ready };
  }
});
export const getSession = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, staff: false };
  const { data, error } = await supabase.rpc("is_club_staff");
  if (!error) return { user, staff: data === true };
  const fallback = await supabase.rpc("is_staff");
  return { user, staff: fallback.data === true };
});

export const getWorkspaceRole = cache(async () => {
  const supabase = await createClient();
  const { data } = await supabase.rpc("club_role");
  return data === "owner" || data === "manager" || data === "cashier" ? data : undefined;
});
