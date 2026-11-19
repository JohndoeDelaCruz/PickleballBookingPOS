import { z } from "zod";

export const pickupOrdersPath = "/staff/pickup-orders";
export const pickupOrderPageSize = 10;
export const pickupOrderPath = (product: string, order?: string) => `/order/${product}${order ? `?order=${order}` : ""}`;

export const pickupOrderSchema = z.object({
  id: z.uuid(),
  product_id: z.uuid(),
  product_name: z.string(),
  customer_name: z.string(),
  quantity: z.int().positive(),
  price_cents: z.int().positive(),
  expires_at: z.iso.datetime({ offset: true }),
  status: z.enum(["pending", "collected", "cancelled", "expired"]),
});
export type PickupOrder = z.infer<typeof pickupOrderSchema>;

export const pickupOrderStatuses = { pending: "Awaiting pickup", collected: "Collected", cancelled: "Cancelled", expired: "Expired" };
export const pickupOrderReference = (id: string) => `AP-${id.replaceAll("-", "").slice(0, 10).toUpperCase()}`;

const pickupTime = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
});
export const pickupDeadline = (time: string) => pickupTime.format(new Date(time));

export type PickupActionResult = { error?: string; success?: boolean };
