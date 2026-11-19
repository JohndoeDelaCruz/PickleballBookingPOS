"use client";

import { useActionState, useState, useTransition } from "react";
import { cancelPickupOrder, placePickupOrder } from "@/app/order/[product]/actions";
import { money } from "@/lib/booking";
import type { PickupProduct } from "@/lib/counter-products";

export function PickupOrderForm({ product, draftId, initialName }: { product: PickupProduct; draftId: string; initialName: string }) {
  const [quantity, setQuantity] = useState(1);
  const [name, setName] = useState(initialName);
  const [state, submit, pending] = useActionState(placePickupOrder.bind(null, product.id, draftId, product.price_cents), {});

  return <form className="pickup-form" action={submit}>
    <label className="field">Pickup name
      <input name="name" autoComplete="name" minLength={2} maxLength={100} required value={name} onChange={(event) => setName(event.target.value)} />
    </label>
    <label className="field">Quantity
      <select name="quantity" value={quantity} onChange={(event) => setQuantity(Number(event.target.value))}>
        {Array.from({ length: product.max_quantity }, (_, index) => index + 1).map((amount) => <option key={amount}>{amount}</option>)}
      </select>
    </label>
    <div className="pickup-total"><span>Due at pickup</span><strong>{money(product.price_cents * quantity / 100)}</strong></div>
    {state.error && <p className="error-message" role="alert">{state.error}</p>}
    <button className="button button-dark" disabled={pending}>{pending ? "Reserving…" : "Reserve for pickup"}</button>
  </form>;
}

export function CancelPickupOrder({ id, onCancelled, disabled }: { id: string; onCancelled?: () => void; disabled?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  return <div>
    <button type="button" className="button button-outline button-small" disabled={pending || disabled} onClick={() => startTransition(async () => {
      const result = await cancelPickupOrder(id);
      setError(result.error ?? "");
      if (result.success) onCancelled?.();
    })}>{pending ? "Cancelling…" : "Cancel order"}</button>
    {error && <p className="error-message" role="alert">{error}</p>}
  </div>;
}
