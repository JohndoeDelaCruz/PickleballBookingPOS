"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { pickupOrdersPath, type PickupActionResult } from "@/lib/counter-orders";
import { getSession } from "@/lib/data";
import { centavos } from "@/lib/pos";
import { posMessage } from "@/lib/pos-message";
import { createClient } from "@/lib/supabase/server";

const paymentInput = z.object({ order: z.uuid(), method: z.enum(["cash", "gcash"]), reference: z.string().trim().max(40),
  tendered: z.int().min(0).max(100000000), verified: z.literal(true) });

export async function collectPickupOrder(order: string, form: FormData): Promise<PickupActionResult> {
  let tendered = 0;
  if (form.get("method") === "cash") {
    try { tendered = centavos(String(form.get("cash") ?? "")); }
    catch { return { error: "Enter the cash received." }; }
  }
  const parsed = paymentInput.safeParse({ order, method: form.get("method"), reference: form.get("reference") ?? "",
    tendered, verified: form.get("verified") === "on" });
  if (!parsed.success) return { error: "Check the payment details and confirm that you received the payment." };
  if (!(await getSession()).staff) return { error: "Staff access is required to record pickup payments." };
  const payment = parsed.data;
  const db = await createClient();
  const { error } = await db.rpc("complete_counter_order", {
    p_order: payment.order, p_method: payment.method, p_reference: payment.reference, p_tendered: payment.tendered, p_verified: payment.verified,
  });
  if (error) {
    const message = /^(?:POS|Pickup): (.+)$/.exec(error.message)?.[1];
    return { error: message ? posMessage(message) : "Couldn’t confirm payment. Check the order before retrying." };
  }
  for (const path of ["/", "/order", "/staff", pickupOrdersPath]) revalidatePath(path);
  revalidatePath("/order/[product]", "page");
  return { success: true };
}
