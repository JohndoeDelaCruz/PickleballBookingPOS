import { z } from "zod";
import { createClient } from "./supabase/server";

const counterProduct = z.object({
  name: z.string(),
  category: z.string(),
  price_cents: z.int().positive(),
  photo_version: z.uuid().nullable(),
});

const pickupProduct = counterProduct.extend({ id: z.uuid(), max_quantity: z.int().min(0).max(5) });
export type PickupProduct = z.infer<typeof pickupProduct>;
export type CounterProduct = z.infer<typeof counterProduct> & { id?: string };

export async function getCounterProducts() {
  try {
    const db = await createClient();
    const { data, error } = await db.rpc("list_pickup_products");
    if (error?.code === "PGRST202") {
      const legacy = await db.rpc("list_counter_products");
      return z.array(counterProduct).safeParse(legacy.data).data ?? [];
    }
    return z.array(pickupProduct).safeParse(data).data ?? [];
  } catch {
    return [];
  }
}

export async function getPickupProduct(id: string) {
  const db = await createClient();
  const { data, error } = await db.rpc("list_pickup_products", { p_product: id }).maybeSingle();
  return { product: pickupProduct.safeParse(data).data, unavailable: Boolean(error) };
}
