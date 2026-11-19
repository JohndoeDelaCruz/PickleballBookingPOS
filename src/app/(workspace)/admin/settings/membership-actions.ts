"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSession } from "@/lib/data";
import { membershipCourtDiscountStateSchema, membershipOpenPlayDiscountSchema, membershipDetailsSchema, type MembershipPlanId } from "@/lib/membership";
import { createClient } from "@/lib/supabase/server";

export async function saveMembershipDetails(plan: MembershipPlanId, input: unknown, revision: number) {
  if (plan !== "annual" && plan !== "six-month") return { error: "Choose a membership plan." };
  const parsed = membershipDetailsSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  if (!Number.isInteger(revision) || revision < 0 || revision > 2147483647)
    return { error: "Reload the membership settings before saving." };

  try {
    const { role, verificationUnavailable } = await getSession();
    if (verificationUnavailable) return { error: "Sign-in verification is temporarily unavailable. Please try again." };
    if (role !== "owner" && role !== "manager") return { error: "Manager or owner access is required." };

    const db = await createClient();
    const params = {
      p_details: parsed.data,
      p_expected_revision: revision,
    };
    const { data, error } = plan === "annual"
      ? await db.rpc("save_membership_details", params)
      : await db.rpc("save_membership_plan", { ...params, p_plan: plan });
    if (error?.message.startsWith("Membership: ")) return { error: error.message.slice("Membership: ".length) };
    if (error || typeof data !== "number") return { error: "Membership details couldn’t be saved. Please try again." };

    revalidatePath("/admin/settings");
    revalidatePath("/membership");
    revalidatePath("/");
    return { revision: data, details: parsed.data };
  } catch {
    return { error: "Membership details couldn’t be saved. Please try again." };
  }
}

const discountsSchema = z.object({
  court: membershipCourtDiscountStateSchema.nullable(),
  openPlay: membershipOpenPlayDiscountSchema.nullable(),
}).refine(({ court, openPlay }) => Boolean(court || openPlay));
const revisionSchema = z.int().min(0).max(2147483647);
const revisionsSchema = z.object({ courtRevision: revisionSchema, openPlayRevision: revisionSchema });
const discountSaveFailed = "Booking discounts couldn’t be saved. Please try again.";

function discountSaveError(error: { code: string; message: string } | null, migration: string) {
  if (error?.code === "PGRST202") return { error: `Apply migration ${migration} to save these booking discounts.` };
  if (error?.message.startsWith("Membership: ")) return { error: error.message.slice("Membership: ".length) };
  return { error: discountSaveFailed };
}

export async function saveMembershipDiscounts(plan: MembershipPlanId, input: unknown): Promise<
  { discounts: z.infer<typeof discountsSchema> } | { error: string }
> {
  if (plan !== "annual" && plan !== "six-month") return { error: "Choose a membership plan." };
  const parsed = discountsSchema.safeParse(input);
  if (!parsed.success) return { error: "Enter valid booking discount settings." };

  try {
    const { role, verificationUnavailable } = await getSession();
    if (verificationUnavailable) return { error: "Sign-in verification is temporarily unavailable. Please try again." };
    if (role !== "owner" && role !== "manager") return { error: "Manager or owner access is required." };

    const { court, openPlay } = parsed.data;
    const discounts = { court, openPlay };
    const db = await createClient();
    if (court && openPlay) {
      const { data, error } = await db.rpc("save_membership_discounts", {
        p_plan: plan,
        p_court_enabled: court.enabled, p_court_amount_cents: court.amountCents,
        p_court_min_hours: court.minHours, p_court_revision: court.revision,
        p_open_play_enabled: openPlay.enabled, p_open_play_amount_cents: openPlay.amountCents,
        p_open_play_floor_cents: openPlay.floorCents, p_open_play_revision: openPlay.revision,
      });
      const revisions = revisionsSchema.safeParse(data);
      if (error || !revisions.success) return discountSaveError(error, "048");
      discounts.court = { ...court, revision: revisions.data.courtRevision };
      discounts.openPlay = { ...openPlay, revision: revisions.data.openPlayRevision };
    } else if (court) {
      const rpc = plan === "annual" ? "save_membership_court_discount" : "save_membership_booking_discount";
      const { data, error } = await db.rpc(rpc, { p_plan: plan, p_enabled: court.enabled,
        p_amount_cents: court.amountCents, p_min_hours: court.minHours, p_expected_revision: court.revision });
      const revision = revisionSchema.safeParse(data);
      if (error || !revision.success) return discountSaveError(error, plan === "annual" ? "039" : "041");
      discounts.court = { ...court, revision: revision.data };
    } else if (openPlay) {
      const { data, error } = await db.rpc("save_membership_open_play_discount", {
        p_plan: plan, p_enabled: openPlay.enabled, p_amount_cents: openPlay.amountCents,
        p_floor_cents: openPlay.floorCents, p_expected_revision: openPlay.revision,
      });
      const revision = revisionSchema.safeParse(data);
      if (error || !revision.success) return discountSaveError(error, "046");
      discounts.openPlay = { ...openPlay, revision: revision.data };
    }
    for (const path of ["/admin/settings", "/membership", "/", "/book"]) revalidatePath(path);
    return { discounts };
  } catch {
    return { error: discountSaveFailed };
  }
}
