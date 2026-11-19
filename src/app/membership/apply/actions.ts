"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSession } from "@/lib/data";
import { membershipApplyPath, membershipPlanIdSchema, membershipReferenceSchema, membershipReviewPath } from "@/lib/membership-applications";
import { createClient } from "@/lib/supabase/server";

const applicationId = z.uuid();
const customerActionSchema = z.object({ action: z.enum(["start", "submit", "cancel"]) });
const customerRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), plan: membershipPlanIdSchema, revision: z.int().min(0).max(2147483647) }),
  z.object({ action: z.literal("submit"), id: applicationId, reference: membershipReferenceSchema }),
  z.object({ action: z.literal("cancel"), id: applicationId }),
]);
const reviewSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), id: applicationId, verified: z.literal(true) }),
  z.object({ action: z.literal("reject"), id: applicationId, reason: z.string().trim().min(3).max(200) }),
]);
const responseSchema = z.union([z.object({ error: z.string().min(1) }), z.object({ success: z.literal(true) })]);
const invalidRequest = "Check the application details and try again.";
const updateFailed = "The membership application couldn’t be updated. Please try again.";

export async function membershipApplicationAction(input: unknown): Promise<{ success: true } | { error: string }> {
  const customerAction = customerActionSchema.safeParse(input);
  const review = reviewSchema.safeParse(input);
  if (!customerAction.success && !review.success) return { error: invalidRequest };
  try {
    const { user, staff, verificationUnavailable } = await getSession();
    if (verificationUnavailable) return { error: "Sign-in verification is temporarily unavailable. Please try again." };
    if (!user) return { error: "Please sign in again." };
    const db = await createClient();
    if (customerAction.success) {
      const request = customerRequestSchema.safeParse(input);
      const { data, error } = await db.rpc("request_customer_membership", {
        p_action: customerAction.data.action,
        p_input: request.success ? request.data : null,
      });
      if (error?.code === "PGRST202") return { error: "Online membership applications are being updated. Please try again shortly." };
      if (error) return { error: updateFailed };
      const response = responseSchema.safeParse(data);
      if (!response.success) return { error: updateFailed };
      if ("error" in response.data) return { error: response.data.error };
      if (!request.success) return { error: invalidRequest };
    } else if (review.success) {
      if (!staff) return { error: "Authorized staff access is required." };
      const command = review.data;
      const { error } = await db.rpc("review_membership_payment", {
        p_application: command.id, p_approve: command.action === "approve", p_reason: command.action === "reject" ? command.reason : "",
      });
      if (error) return { error: /^(?:Membership|POS): (.+)$/.exec(error.message)?.[1] ?? updateFailed };
    }
    revalidatePath(membershipApplyPath);
    revalidatePath(membershipReviewPath);
    revalidatePath("/account");
    return { success: true };
  } catch {
    return { error: "Couldn’t confirm the update. Check your application before trying again." };
  }
}
