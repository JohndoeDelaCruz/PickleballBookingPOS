import { cache } from "react";
import { createClient } from "./supabase/server";
import { defaultVenue, type VenueResult } from "./types";
import { defaultCourts, type Court } from "./courts";
import { readSessionAccess } from "./session-access";
import { emptyMembershipDetails, membershipCourtDiscountStateSchema, membershipOpenPlayDiscountSchema, membershipDetailsSchema, membershipPlanIds, type MembershipPlan } from "./membership";
import type { MembershipApplication } from "./membership-applications";

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

export const getVenueSettings = cache(async () => {
  try {
    const db = await createClient();
    const { data, error } = await db.from("venue_settings").select("*").eq("id", true).single();
    return error ? null : data;
  } catch {
    return null;
  }
});

export const getMembershipPlans = cache(async (): Promise<MembershipPlan[]> => {
  const fallback: MembershipPlan[] = membershipPlanIds.map((id) => ({
    id, details: emptyMembershipDetails(id), revision: null, published: false, courtDiscount: null,
  }));
  try {
    const db = await createClient();
    const { data, error } = await db.from("membership_settings").select("*");
    if (error || !data) return fallback;
    return fallback.map((plan) => {
      const row = data.find(({ id }) => id === (plan.id === "annual"));
      if (!row || !Number.isInteger(row.revision)) return plan;
      const parsed = membershipDetailsSchema.safeParse(row.details);
      const perBooking = plan.id === "annual" || row.court_booking_discount_cents !== undefined;
      const discount = membershipCourtDiscountStateSchema.safeParse({ enabled: row.court_discount_enabled,
        amountCents: row.court_booking_discount_cents ?? row.court_discount_cents,
        minHours: row.court_discount_min_hours, revision: row.court_discount_revision });
      const openPlay = membershipOpenPlayDiscountSchema.safeParse({
        enabled: row.open_play_discount_enabled, amountCents: row.open_play_discount_cents,
        floorCents: row.open_play_member_floor_cents, revision: row.open_play_discount_revision,
      });
      return { ...plan, details: parsed.success ? parsed.data : plan.details, revision: row.revision, published: parsed.success,
        courtDiscount: perBooking && discount.success ? discount.data : null,
        ...(openPlay.success && { openPlayDiscount: openPlay.data }),
        ...(!perBooking && discount.success && { legacyCourtRates: {
          daytime: row.court_daytime_cap_cents ?? null,
          evening: discount.data.enabled ? discount.data.amountCents : null,
        } }),
      };
    });
  } catch {
    return fallback;
  }
});

export const getVenue = cache(async (): Promise<VenueResult> => {
  const [inventory, data] = await Promise.all([getCourtInventory(), getVenueSettings()]);
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

export const getCurrentMembership = cache(async (userId: string): Promise<MembershipApplication | null | undefined> => {
  try {
    const db = await createClient();
    const { data, error } = await db.from("membership_applications")
      .select("id, plan_id, plan_name, price_cents, status, gcash_name, gcash_number, gcash_qr_url, payment_reference, submitted_at, starts_on, expires_on, review_note")
      .eq("user_id", userId).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
    return error ? undefined : data as MembershipApplication | null;
  } catch {
    return undefined;
  }
});
