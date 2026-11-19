"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSession } from "@/lib/data";
import { expenseCategories, expensePaymentMethods, expensesPath } from "@/lib/expenses";
import { centavos } from "@/lib/pos";
import { posMessage } from "@/lib/pos-message";
import { createClient } from "@/lib/supabase/server";

const recordSchema = z.object({
  id: z.uuid(),
  date: z.iso.date().nullable(),
  category: z.enum(Object.keys(expenseCategories)),
  description: z.string().trim().min(2, "Enter a description.").max(200),
  amount: z.string(),
  method: z.enum(Object.keys(expensePaymentMethods)),
  shift: z.uuid().nullable(),
});

function expenseError(message: string) {
  return { error: message.startsWith("POS: ") ? posMessage(message.slice(5)) : "The expense could not be saved. Check your connection and try again." };
}

export async function recordExpense(input: unknown) {
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) return { error: "Check the expense fields and try again." };
  const expense = parsed.data;
  let amount: number;
  try {
    amount = centavos(expense.amount);
  } catch {
    return { error: "Enter a valid amount with at most two decimals." };
  }
  if (amount < 1 || amount > 100000000) return { error: "Enter an amount from ₱0.01 to ₱1,000,000." };

  try {
    const { staff, role, verificationUnavailable } = await getSession();
    if (verificationUnavailable) return { error: "Sign-in verification is temporarily unavailable. Try again in a moment." };
    if (!staff || (!expense.shift && role !== "owner" && role !== "manager"))
      return { error: "You don’t have permission to record this expense." };

    const db = await createClient();
    const { data, error } = await db.rpc("pos_record_expense", {
      p_id: expense.id,
      p_date: expense.date,
      p_category: expense.category,
      p_description: expense.description,
      p_amount: amount,
      p_method: expense.method,
      p_shift: expense.shift,
    });
    if (error) return expenseError(error.message);
    revalidatePath(expensesPath);
    if (expense.shift) revalidatePath("/staff");
    return { date: data as string };
  } catch {
    return { error: "Connection interrupted. Retry the same expense to confirm it was saved." };
  }
}

export async function voidExpense(input: unknown) {
  const parsed = z.object({
    id: z.uuid(), reason: z.string().trim().min(3).max(200),
  }).safeParse(input);
  if (!parsed.success) return { error: "Enter a reason from 3 to 200 characters." };

  try {
    const { role, verificationUnavailable } = await getSession();
    if (verificationUnavailable) return { error: "Sign-in verification is temporarily unavailable. Try again in a moment." };
    if (role !== "owner" && role !== "manager") return { error: "Manager authorization is required." };

    const db = await createClient();
    const { error } = await db.rpc("pos_void_expense", { p_id: parsed.data.id, p_reason: parsed.data.reason });
    if (error) return expenseError(error.message);
    revalidatePath(expensesPath);
    revalidatePath("/staff");
    return { ok: true };
  } catch {
    return { error: "Connection interrupted. Retry to confirm the expense was voided." };
  }
}
