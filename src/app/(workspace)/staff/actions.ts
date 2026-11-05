"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { checkoutSchema, productSchema, type Sale } from "@/lib/pos";
const id = z.uuid();
const cents = z.int().min(0).max(100000000);
const schema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("checkout"), payload: checkoutSchema }),
  z.object({ op: z.literal("product"), payload: productSchema }),
  z.object({
    op: z.literal("stock"),
    id,
    quantity: z
      .int()
      .min(-100000)
      .max(100000)
      .refine((n) => n !== 0),
    reason: z.string().trim().min(3).max(200),
  }),
  z.object({ op: z.literal("open"), amount: cents }),
  z.object({ op: z.literal("close"), id, amount: cents }),
  z.object({ op: z.literal("verify"), id, verified: z.literal(true) }),
  z.object({
    op: z.literal("balance"),
    id,
    method: z.enum(["cash", "gcash"]),
    reference: z.string().max(40),
    verified: z.literal(true),
  }),
  z.object({
    op: z.literal("refund"),
    id,
    method: z.enum(["cash", "gcash"]),
    reason: z.string().trim().min(3).max(200),
    restock: z.boolean(),
    verified: z.literal(true),
  }),
]);
export type PosCommand = z.infer<typeof schema>;
export async function posCommand(
  input: unknown,
): Promise<{ ok: true; receipt?: Sale } | { error: string }> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const db = await createClient();
    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) return { error: "Please sign in again." };
    const { data: allowed } = await db.rpc("is_club_staff");
    if (!allowed) return { error: "Authorized staff access is required." };
    const c = parsed.data;
    let rpc: string;
    let args: Record<string, unknown>;
    switch (c.op) {
      case "checkout":
        rpc = "pos_checkout";
        args = { p_request: c.payload };
        break;
      case "product":
        rpc = "pos_save_product";
        args = { p_product: c.payload };
        break;
      case "stock":
        rpc = "pos_adjust_stock";
        args = { p_product: c.id, p_quantity: c.quantity, p_reason: c.reason };
        break;
      case "open":
        rpc = "pos_open_shift";
        args = { p_opening: c.amount };
        break;
      case "close":
        rpc = "pos_close_shift";
        args = { p_shift: c.id, p_counted: c.amount };
        break;
      case "verify":
        rpc = "pos_verify_booking";
        args = { p_booking: c.id };
        break;
      case "balance":
        rpc = "pos_collect_balance";
        args = {
          p_booking: c.id,
          p_method: c.method,
          p_reference: c.reference,
        };
        break;
      case "refund":
        rpc = "pos_refund";
        args = {
          p_sale: c.id,
          p_method: c.method,
          p_reason: c.reason,
          p_restock: c.restock,
        };
        break;
    }
    const { data, error } = await db.rpc(rpc, args);
    if (error) {
      const match = error.message.match(/(?:POS|Booking):\s*([\s\S]+)/);
      return {
        error: match
          ? match[1]
          : "The operation could not be completed. Check database setup and your permissions. For a checkout retry, keep the same cart.",
      };
    }
    revalidatePath("/staff");
    revalidatePath("/admin");
    revalidatePath("/admin/finance");
    revalidatePath("/my-bookings");
    revalidatePath("/booking/[id]", "page");
    return {
      ok: true,
      ...(c.op === "checkout" ? { receipt: data as Sale } : {}),
    };
  } catch {
    return {
      error:
        "Connection interrupted. Retry the same checkout to check its saved result before starting another sale.",
    };
  }
}
