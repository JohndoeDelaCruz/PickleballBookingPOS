import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { CancelPickupOrder, PickupOrderForm } from "@/components/pickup-order-form";
import { money } from "@/lib/booking";
import { getPickupProduct } from "@/lib/counter-products";
import { pickupDeadline, pickupOrderPath, pickupOrderReference, pickupOrderSchema, pickupOrderStatuses } from "@/lib/counter-orders";
import { getSession } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Pickup order", robots: { index: false, follow: false } };

export default async function PickupPage({ params, searchParams }: {
  params: Promise<{ product: string }>;
  searchParams: Promise<{ order?: string }>;
}) {
  const productId = z.uuid().safeParse((await params).product);
  if (!productId.success) notFound();
  const orderId = z.uuid().safeParse((await searchParams).order);
  const { user } = await getSession();

  if (orderId.success) {
    if (!user) redirect(`/login?next=${encodeURIComponent(pickupOrderPath(productId.data, orderId.data))}`);
    const db = await createClient();
    const { data } = await db.rpc("get_counter_order", { p_order: orderId.data });
    const saved = pickupOrderSchema.safeParse(data);
    if (!saved.success || saved.data.product_id !== productId.data) notFound();
    const order = saved.data;
    return <main id="main" className="container pickup-page">
      <div className="page-heading"><Link href="/order" className="text-link">My pickup orders</Link><h1>Pickup order</h1></div>
      <section className="panel pickup-confirmation">
        <p>{pickupOrderStatuses[order.status]}</p>
        <h2>{pickupOrderReference(order.id)}</h2>
        <p>{order.quantity} × {order.product_name} · {money(order.price_cents * order.quantity / 100)}</p>
        {order.status === "pending" && <>
          <p>Pick up by <strong>{pickupDeadline(order.expires_at)}</strong>. Bring your order reference and pay at the counter.</p>
          <div className="pickup-actions"><Link href="/#visit" className="button button-dark button-small">Find the venue</Link><CancelPickupOrder id={order.id} /></div>
        </>}
        {order.status !== "pending" && <Link href={pickupOrderPath(order.product_id)} className="text-link">View product</Link>}
      </section>
    </main>;
  }

  const { product, unavailable } = await getPickupProduct(productId.data);
  if (!product && !unavailable) notFound();
  return <main id="main" className="container pickup-page">
    <div className="page-heading"><h1>Order for pickup</h1>{user && <Link href="/order" className="text-link">My pickup orders</Link>}</div>
    {product ? <section className="panel pickup-product">
      {product.photo_version && <div className="pickup-photo">
        <Image src={`/product-photo/${product.photo_version}.jpg`} alt="" fill unoptimized loading="eager" />
      </div>}
      <header className="pickup-details">
        <p>{product.category}</p>
        <h2>{product.name}</h2>
        <strong>{money(product.price_cents / 100)} each</strong>
      </header>
      <div className="pickup-options">
        {product.max_quantity > 0 ? <>
          <p>Reserve for 24 hours and pay at the counter when you collect your order.</p>
          {user ? <PickupOrderForm product={product} initialName={typeof user.user_metadata.full_name === "string" ? user.user_metadata.full_name.slice(0, 100) : ""} draftId={randomUUID()} />
            : <Link href={`/login?next=${encodeURIComponent(pickupOrderPath(product.id))}`} className="button button-dark">Log in to order</Link>}
        </> : <p role="status">Currently unavailable for pickup.</p>}
      </div>
    </section> : <p className="notice" role="status">Online pickup orders are temporarily unavailable.</p>}
  </main>;
}
