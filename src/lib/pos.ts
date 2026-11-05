import { z } from "zod";
import type { Court } from "./courts";

export type Product = {
  id: string;
  name: string;
  sku: string;
  barcode: string;
  category: string;
  price_cents: number;
  cost_cents: number;
  stock: number;
  reorder_level: number;
  active: boolean;
  revision: number;
};
export type SaleItem = {
  product_id: string | null;
  name: string;
  quantity: number;
  price_cents: number;
  cost_cents: number;
};
export type Sale = {
  id: string;
  number: string;
  kind: "retail" | "booking";
  booking_id: string | null;
  customer_name: string;
  total_cents: number;
  paid_cents: number;
  refunded_cents: number;
  status: "completed" | "refunded";
  created_at: string;
  items: SaleItem[];
  method?: string;
};
export type Payment = {
  id: string;
  sale_id: string;
  amount_cents: number;
  method: "cash" | "gcash";
  reference: string | null;
  created_at: string;
  shift_id: string | null;
};
export type Refund = {
  id: string;
  sale_id: string;
  amount_cents: number;
  method: "cash" | "gcash";
  reason: string;
  created_at: string;
  shift_id: string | null;
};
export type Shift = {
  id: string;
  opened_at: string;
  closed_at: string | null;
  opening_cents: number;
  expected_cents: number;
  counted_cents: number | null;
  cashier_id: string;
};
export type Movement = {
  id: string;
  product_id: string;
  quantity: number;
  reason: string;
  created_at: string;
};
export type PosBooking = {
  id: string;
  reference: string;
  customer_name: string;
  booking_date: string;
  start_hour: number;
  duration: number;
  court_id: number | null;
  booking_type: string;
  status: string;
  total_amount: number;
  paid_amount: number;
  initial_payment_amount: number;
  payment_reference: string | null;
  payment_option: string;
};
export type PosData = {
  courts?: Court[];
  products: Product[];
  sales: Sale[];
  payments: Payment[];
  refunds: Refund[];
  shifts: Shift[];
  movements: Movement[];
  bookings: PosBooking[];
  role: string;
  ready: boolean;
  error?: string;
};
export const peso = (cents: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(
    cents / 100,
  );
export const dayKey = (date: string | Date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(date));
export const centavos = (value: string | number) => {
  const n = String(value).trim();
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(n))
    throw new Error("Enter a valid amount with at most two decimals.");
  const [a, b = ""] = n.split(".");
  return Number(a) * 100 + Number(b.padEnd(2, "0"));
};
export function cartTotal(items: { quantity: number; price_cents: number }[]) {
  return items.reduce((sum, p) => sum + p.quantity * p.price_cents, 0);
}
export function cashExpected(
  shift: Shift,
  payments: Payment[],
  refunds: Refund[],
) {
  return (
    shift.opening_cents +
    payments
      .filter((p) => p.shift_id === shift.id && p.method === "cash")
      .reduce((s, p) => s + p.amount_cents, 0) -
    refunds
      .filter((p) => p.shift_id === shift.id && p.method === "cash")
      .reduce((s, p) => s + p.amount_cents, 0)
  );
}
export function reportFor(data: PosData, day: string) {
  const payments = data.payments.filter((p) => dayKey(p.created_at) === day);
  const refunds = data.refunds.filter((p) => dayKey(p.created_at) === day);
  const sales = data.sales.filter((p) => dayKey(p.created_at) === day);
  const collected = payments.reduce((s, p) => s + p.amount_cents, 0);
  const refunded = refunds.reduce((s, p) => s + p.amount_cents, 0);
  return {
    collected,
    refunded,
    net: collected - refunded,
    cash:
      payments
        .filter((p) => p.method === "cash")
        .reduce((s, p) => s + p.amount_cents, 0) -
      refunds
        .filter((p) => p.method === "cash")
        .reduce((s, p) => s + p.amount_cents, 0),
    gcash:
      payments
        .filter((p) => p.method === "gcash")
        .reduce((s, p) => s + p.amount_cents, 0) -
      refunds
        .filter((p) => p.method === "gcash")
        .reduce((s, p) => s + p.amount_cents, 0),
    sales: sales.length,
    retail: sales
      .filter((p) => p.kind === "retail")
      .reduce((s, p) => s + p.total_cents, 0),
    due: data.bookings
      .filter((b) => b.status === "confirmed")
      .reduce(
        (s, b) =>
          s +
          Math.round((Number(b.total_amount) - Number(b.paid_amount)) * 100),
        0,
      ),
  };
}
export const productSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(2).max(100),
  sku: z.string().trim().min(2).max(40),
  barcode: z.string().trim().max(50).default(""),
  category: z.string().trim().min(1).max(40),
  price_cents: z.int().min(1).max(100000000),
  cost_cents: z.int().min(0).max(100000000),
  reorder_level: z.int().min(0).max(100000),
  revision: z.int().min(0).default(0),
  active: z.boolean().default(true),
});
export const checkoutSchema = z
  .object({
    key: z.uuid(),
    items: z
      .array(
        z.object({
          product_id: z.uuid(),
          quantity: z.int().min(1).max(999),
          price_cents: z.int().min(1),
        }),
      )
      .min(1)
      .max(100),
    method: z.enum(["cash", "gcash"]),
    reference: z.string().trim().max(40).default(""),
    tendered_cents: z.int().min(0).max(100000000),
    customer_name: z.string().trim().max(100).default("Walk-in customer"),
    verified: z.literal(true),
  })
  .refine(
    (v) => v.method !== "gcash" || /^[a-zA-Z0-9 -]{6,40}$/.test(v.reference),
    {
      message: "Enter the verified GCash transaction reference.",
      path: ["reference"],
    },
  );
