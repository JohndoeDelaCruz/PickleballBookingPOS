"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSession } from "@/lib/data";
import { posMessage } from "@/lib/pos-message";
import { createClient } from "@/lib/supabase/server";

const assignmentSchema = z.object({ date: z.iso.date(), expected: z.uuid().nullable(), cashier: z.uuid().nullable() });

export async function assignCashier(input: unknown) {
  const parsed = assignmentSchema.safeParse(input);
  if (!parsed.success) return { error: "Choose a valid date and staff member." };
  try {
    const { role, verificationUnavailable } = await getSession();
    if (verificationUnavailable) return { error: "Sign-in verification is temporarily unavailable. Try again in a moment." };
    if (role !== "owner" && role !== "manager") return { error: "Manager authorization is required." };
    const db = await createClient();
    const { date, expected, cashier } = parsed.data;
    const { error } = await db.rpc("pos_assign_cashier", { p_date: date, p_expected: expected, p_cashier: cashier });
    if (error) return { error: error.message.startsWith("POS: ") ? posMessage(error.message.slice(5)) : "The staff assignment could not be saved." };
    revalidatePath("/staff");
    revalidatePath("/admin");
    return { ok: true };
  } catch {
    return { error: "Couldn’t confirm the assignment. Refresh to see who’s on duty." };
  }
}
