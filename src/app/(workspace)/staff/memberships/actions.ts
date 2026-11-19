"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSession } from "@/lib/data";
import { membershipApplyPath, membershipPlanIdSchema, membershipReferenceSchema, membershipReviewPath } from "@/lib/membership-applications";
import { posMessage } from "@/lib/pos-message";
import { createClient } from "@/lib/supabase/server";

const customerSchema = z.object({
  id: z.uuid(), full_name: z.string().nullable(), email: z.string(),
  availability: z.enum(["available", "active", "pending"]),
});
const receiptSchema = z.object({
  receipt_number: z.string(), plan_name: z.string(), price_cents: z.int().positive(),
  starts_on: z.iso.date(), expires_on: z.iso.date(), status: z.enum(["approved", "refunded"]),
});
const saleFields = {
  key: z.uuid(), customer: z.uuid(), plan: membershipPlanIdSchema,
  revision: z.int().min(0).max(2147483647), received: z.int().min(1).max(100000000),
};
const saleSchema = z.discriminatedUnion("method", [
  z.object({ ...saleFields, method: z.literal("cash") }),
  z.object({ ...saleFields, method: z.literal("gcash"), reference: membershipReferenceSchema, verified: z.literal(true) }),
]);

export type MembershipCustomer = z.infer<typeof customerSchema>;
export type MembershipSaleReceipt = z.infer<typeof receiptSchema>;

async function staffAccessError() {
  const unavailable = "Sign-in verification is temporarily unavailable. Please try again.";
  try {
    const { staff, verificationUnavailable } = await getSession();
    if (verificationUnavailable) return unavailable;
    return staff ? null : "Authorized staff access is required.";
  } catch { return unavailable; }
}

function rpcMessage(error: { code: string; message: string } | null, fallback: string) {
  if (error?.code === "PGRST202") return "Apply migration 036 to enable walk-in membership sales.";
  const message = /^(?:Membership|POS): (.+)$/.exec(error?.message ?? "")?.[1];
  return message ? posMessage(message) : fallback;
}

export async function findMembershipCustomers(input: unknown): Promise<{ customers: MembershipCustomer[] } | { error: string }> {
  const query = z.string().trim().min(2).max(254).safeParse(input);
  if (!query.success) return { error: "Enter at least two characters of a name or the full email address." };
  const accessError = await staffAccessError();
  if (accessError) return { error: accessError };

  const fallback = "Customer search is temporarily unavailable. Please try again.";
  try {
    const db = await createClient();
    const { data, error } = await db.rpc("pos_find_membership_customers", { p_query: query.data });
    if (error) return { error: rpcMessage(error, fallback) };
    const result = z.array(customerSchema).safeParse(data);
    return result.success ? { customers: result.data } : { error: fallback };
  } catch { return { error: fallback }; }
}

export async function sellMembership(input: unknown): Promise<{ receipt: MembershipSaleReceipt } | { error: string }> {
  const parsed = saleSchema.safeParse(input);
  if (!parsed.success) return { error: "Check the customer, plan, and payment details." };
  const accessError = await staffAccessError();
  if (accessError) return { error: accessError };

  const sale = parsed.data;
  const fallback = "The sale could not be confirmed. Retry with the same details or check Transactions before collecting again.";
  try {
    const db = await createClient();
    const { data, error } = await db.rpc("pos_sell_membership", {
      p_key: sale.key, p_customer: sale.customer, p_plan: sale.plan, p_revision: sale.revision,
      p_method: sale.method, p_received: sale.received,
      p_reference: sale.method === "gcash" ? sale.reference : null,
      p_verified: sale.method === "gcash" && sale.verified,
    }).single();
    if (error) return { error: rpcMessage(error, fallback) };
    const receipt = receiptSchema.safeParse(data);
    if (!receipt.success) return { error: fallback };
    revalidatePath(membershipReviewPath);
    revalidatePath(membershipApplyPath);
    revalidatePath("/account");
    revalidatePath("/book");
    revalidatePath("/staff");
    return { receipt: receipt.data };
  } catch { return { error: fallback }; }
}
