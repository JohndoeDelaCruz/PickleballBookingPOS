import type { PosCommand } from "@/app/(workspace)/staff/actions";
import {
  cartTotal,
  cashExpected,
  checkoutSchema,
  type PosData,
  type Sale,
  type SaleItem,
} from "./pos";
export function applyDemoCommand(
  current: PosData,
  command: PosCommand,
): { data: PosData; receipt?: Sale } {
  const data = structuredClone(current);
  const now = new Date().toISOString();
  const uid = () => crypto.randomUUID();
  const shift = data.shifts.find((s) => !s.closed_at);
  const requireShift = () => {
    if (!shift) throw new Error("Open a cashier shift first.");
    return shift;
  };
  const reference = (value: string) => {
    if (!/^[a-zA-Z0-9 -]{6,40}$/.test(value))
      throw new Error("Enter a valid GCash reference (6–40 characters).");
    const normalized = value.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (
      data.payments.some(
        (p) =>
          p.reference?.replace(/[^a-z0-9]/gi, "").toLowerCase() === normalized,
      )
    )
      throw new Error("That payment reference has already been recorded.");
  };
  let receipt: Sale | undefined;
  const addPayment = (
    sale: Sale,
    amount: number,
    method: "cash" | "gcash",
    ref: string | null,
  ) => {
    if (method === "cash") requireShift();
    if (method === "gcash") reference(ref ?? "");
    data.payments.unshift({
      id: uid(),
      sale_id: sale.id,
      amount_cents: amount,
      method,
      reference: ref,
      created_at: now,
      shift_id: shift?.id ?? null,
    });
    sale.paid_cents += amount;
  };
  switch (command.op) {
    case "checkout": {
      const p = checkoutSchema.parse(command.payload);
      requireShift();
      const previous = data.sales.find((s) => s.id === p.key);
      if (previous) return { data, receipt: previous };
      if (new Set(p.items.map((i) => i.product_id)).size !== p.items.length)
        throw new Error("Duplicate cart items.");
      const items: SaleItem[] = p.items.map((i) => {
        const product = data.products.find(
          (q) => q.id === i.product_id && q.active,
        );
        if (!product || product.stock < i.quantity)
          throw new Error("An item has insufficient stock.");
        if (product.price_cents !== i.price_cents)
          throw new Error("A product price changed. Refresh the cart.");
        return {
          product_id: product.id,
          name: product.name,
          quantity: i.quantity,
          price_cents: product.price_cents,
          cost_cents: product.cost_cents,
        };
      });
      const total = cartTotal(items);
      if (p.method === "cash" && p.tendered_cents < total)
        throw new Error("Cash received must cover the total.");
      const sale: Sale = {
        id: p.key,
        number: `RC-${String(data.sales.length + 1).padStart(6, "0")}`,
        kind: "retail",
        booking_id: null,
        customer_name: p.customer_name || "Walk-in customer",
        total_cents: total,
        paid_cents: 0,
        refunded_cents: 0,
        status: "completed",
        created_at: now,
        items,
        method: p.method,
      };
      addPayment(
        sale,
        total,
        p.method,
        p.method === "gcash" ? p.reference : null,
      );
      for (const item of items) {
        data.products.find((p) => p.id === item.product_id)!.stock -=
          item.quantity;
        data.movements.unshift({
          id: uid(),
          product_id: item.product_id!,
          quantity: -item.quantity,
          reason: `Sale ${sale.number}`,
          created_at: now,
        });
      }
      data.sales.unshift(sale);
      receipt = sale;
      break;
    }
    case "product": {
      const p = command.payload;
      const old = data.products.find((x) => x.id === p.id);
      if (old) {
        if (old.revision !== p.revision)
          throw new Error("This product was changed. Reload first.");
        Object.assign(old, p, { revision: old.revision + 1 });
      } else data.products.push({ ...p, id: uid(), stock: 0, revision: 0 });
      break;
    }
    case "stock": {
      const p = data.products.find((p) => p.id === command.id);
      if (!p || p.stock + command.quantity < 0)
        throw new Error("Stock cannot fall below zero.");
      p.stock += command.quantity;
      data.movements.unshift({
        id: uid(),
        product_id: p.id,
        quantity: command.quantity,
        reason: command.reason,
        created_at: now,
      });
      break;
    }
    case "open":
      if (shift) throw new Error("You already have an open shift.");
      data.shifts.unshift({
        id: uid(),
        opened_at: now,
        closed_at: null,
        opening_cents: command.amount,
        expected_cents: command.amount,
        counted_cents: null,
        cashier_id: "demo",
      });
      break;
    case "close": {
      const s = requireShift();
      s.expected_cents = cashExpected(s, data.payments, data.refunds);
      s.counted_cents = command.amount;
      s.closed_at = now;
      break;
    }
    case "verify":
    case "balance": {
      const b = data.bookings.find((b) => b.id === command.id);
      if (!b) throw new Error("Booking not found.");
      if (command.op === "verify" && b.status !== "awaiting_verification")
        throw new Error("Only a submitted payment can be verified.");
      if (
        command.op === "balance" &&
        (b.status !== "confirmed" || b.paid_amount >= b.total_amount)
      )
        throw new Error("This booking has no collectible balance.");
      let s = data.sales.find((s) => s.booking_id === b.id);
      if (!s) {
        s = {
          id: uid(),
          number: `RC-${String(data.sales.length + 1).padStart(6, "0")}`,
          kind: "booking",
          booking_id: b.id,
          customer_name: b.customer_name,
          total_cents: b.total_amount * 100,
          paid_cents: 0,
          refunded_cents: 0,
          status: "completed",
          created_at: now,
          items: [
            {
              product_id: null,
              name: `${b.reference} · Court ${b.court_id}`,
              quantity: 1,
              price_cents: b.total_amount * 100,
              cost_cents: 0,
            },
          ],
        };
        data.sales.unshift(s);
      }
      const amount =
        command.op === "verify"
          ? b.initial_payment_amount * 100
          : Math.round((b.total_amount - b.paid_amount) * 100);
      addPayment(
        s,
        amount,
        command.op === "verify" ? "gcash" : command.method,
        command.op === "verify"
          ? b.payment_reference
          : command.reference || null,
      );
      b.paid_amount += amount / 100;
      b.status = "confirmed";
      receipt = s;
      break;
    }
    case "refund": {
      requireShift();
      const s = data.sales.find((s) => s.id === command.id);
      if (!s || s.refunded_cents > 0 || s.paid_cents <= 0)
        throw new Error("This sale cannot be refunded again.");
      data.refunds.unshift({
        id: uid(),
        sale_id: s.id,
        amount_cents: s.paid_cents,
        method: command.method,
        reason: command.reason,
        created_at: now,
        shift_id: shift!.id,
      });
      s.refunded_cents = s.paid_cents;
      s.status = "refunded";
      if (command.restock && s.kind === "retail")
        for (const i of s.items) {
          const p = data.products.find((p) => p.id === i.product_id);
          if (p) {
            p.stock += i.quantity;
            data.movements.unshift({
              id: uid(),
              product_id: p.id,
              quantity: i.quantity,
              reason: `Refund ${s.number}: ${command.reason}`,
              created_at: now,
            });
          }
        }
      if (s.booking_id) {
        const b = data.bookings.find((b) => b.id === s.booking_id);
        if (b) b.status = "cancelled";
      }
      break;
    }
  }
  for (const s of data.shifts.filter((s) => !s.closed_at))
    s.expected_cents = cashExpected(s, data.payments, data.refunds);
  return { data, receipt };
}
