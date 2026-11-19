import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getSession } from "@/lib/data";
import { money } from "@/lib/booking";
import { pickupOrderPath, pickupOrderReference, pickupOrderSchema, pickupOrderStatuses } from "@/lib/counter-orders";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "My pickup orders", robots: { index: false, follow: false } };

export default async function MyPickupOrders() {
  const { user } = await getSession();
  if (!user) redirect("/login?next=/order");
  const db = await createClient();
  const { data } = await db.rpc("list_my_counter_orders");
  const orders = z.array(pickupOrderSchema).safeParse(data).data;
  return <main id="main" className="container pickup-page">
    <div className="page-heading"><h1>My pickup orders</h1></div>
    {!orders ? <p className="notice">Pickup orders couldn’t be loaded. Please try again later.</p>
      : orders.length === 0 ? <p>You haven’t placed a pickup order yet.</p>
      : <div className="pickup-history">{orders.map((order) => <Link key={order.id}
        href={pickupOrderPath(order.product_id, order.id)} className="panel">
        <strong>{order.quantity} × {order.product_name}</strong>
        <span>{pickupOrderReference(order.id)} · {pickupOrderStatuses[order.status]} · {money(order.quantity * order.price_cents / 100)}</span>
      </Link>)}</div>}
  </main>;
}
