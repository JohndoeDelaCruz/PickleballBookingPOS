"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getSession } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { pickupOrderPath, pickupOrdersPath, type PickupActionResult } from "@/lib/counter-orders";

const orderInput = z.object({
  id: z.uuid(), product: z.uuid(), quantity: z.coerce.number().int().min(1).max(5),
  price: z.coerce.number().int().positive().max(100000000), name: z.string().trim().min(2).max(100),
});

export async function placePickupOrder(product: string, draftId: string, price: number, _state: PickupActionResult, form: FormData): Promise<PickupActionResult> {
  const input = orderInput.safeParse({ id: draftId, product, price, quantity: form.get("quantity"), name: form.get("name") });
  if (!input.success) return { error: "Enter your pickup name and a valid quantity." };
  const { user } = await getSession();
  if (!user) return { error: "Please sign in again to place your order." };
  const d = input.data;
  const db = await createClient();
  const { data, error } = await db.rpc("place_counter_order", {
    p_id: d.id, p_product: d.product, p_quantity: d.quantity, p_price: d.price, p_name: d.name,
  });
  if (error) return { error: /^Pickup: (.+)$/.exec(error.message)?.[1] ?? "Couldn’t confirm the order. Try again from this form." };
  const saved = z.uuid().safeParse(data);
  if (!saved.success) return { error: "Couldn’t confirm the order. Try again from this form." };
  revalidatePath("/");
  revalidatePath("/order");
  revalidatePath(pickupOrdersPath);
  redirect(pickupOrderPath(d.product, saved.data));
}

export async function cancelPickupOrder(order: string): Promise<PickupActionResult> {
  const id = z.uuid().safeParse(order);
  const { user } = await getSession();
  if (!id.success || !user) return { error: "Sign in to manage this pickup order." };
  const db = await createClient();
  const { error } = await db.rpc("cancel_counter_order", { p_order: id.data });
  if (error) return { error: /^Pickup: (.+)$/.exec(error.message)?.[1] ?? "Couldn’t cancel the order. Refresh and try again." };
  revalidatePath("/");
  revalidatePath("/order");
  revalidatePath(pickupOrdersPath);
  revalidatePath("/order/[product]", "page");
  return { success: true };
}
