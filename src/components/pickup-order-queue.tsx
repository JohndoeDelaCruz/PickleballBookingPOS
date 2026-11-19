"use client";

import { useState, useTransition } from "react";
import { collectPickupOrder } from "@/app/(workspace)/staff/pickup-orders/actions";
import { pickupDeadline, pickupOrderPageSize, pickupOrderReference, pickupOrderStatuses, pickupOrdersPath, type PickupOrder } from "@/lib/counter-orders";
import { peso } from "@/lib/pos";
import { CancelPickupOrder } from "./pickup-order-form";
import { Modal } from "./modal";
import { TablePagination } from "./table-pagination";
import { useAnimatedModal } from "./use-animated-modal";

export function PickupOrderQueue({ rows, count, page, history }: { rows: PickupOrder[]; count: number; page: number; history: boolean }) {
  const [selected, setSelected, closing] = useAnimatedModal<PickupOrder>();
  return <>
    {rows.length > 0 ? <div className="console-table-wrap" tabIndex={0} role="region" aria-label="Pickup orders">
      <table className="console-table">
        <thead><tr><th>Reference</th><th>Customer</th><th>Product</th><th>Total</th><th>Pickup deadline</th><th>Status</th>{!history && <th>Action</th>}</tr></thead>
        <tbody>{rows.map((order) => <tr key={order.id}>
          <td>{pickupOrderReference(order.id)}</td><td>{order.customer_name}</td><td>{order.quantity} × {order.product_name}</td>
          <td>{peso(order.quantity * order.price_cents)}</td><td>{pickupDeadline(order.expires_at)}</td><td>{pickupOrderStatuses[order.status]}</td>
          {!history && <td><button type="button" className="console-button small" onClick={() => setSelected(order)}>Open order</button></td>}
        </tr>)}</tbody>
      </table>
    </div> : <p className="panel">{history ? "No completed, cancelled, or expired orders yet." : "No orders awaiting pickup."}</p>}
    <TablePagination label="Pickup order pages" count={count} page={page} pageSize={pickupOrderPageSize}
      href={(page) => `${pickupOrdersPath}?view=${history ? "history" : "pending"}&page=${page}`} />
    {selected && <PickupCheckout key={selected.id} order={selected} closing={closing} close={() => setSelected(null)} />}
  </>;
}

function PickupCheckout({ order, closing, close }: { order: PickupOrder; closing: boolean; close: () => void }) {
  const [method, setMethod] = useState("cash");
  const [cash, setCash] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const total = order.quantity * order.price_cents;
  return <Modal title={pickupOrderReference(order.id)} closing={closing} onClose={() => { if (!pending) close(); }}>
    <p>{order.customer_name} · {order.quantity} × {order.product_name}</p>
    <form className="form-stack" onSubmit={(event) => {
      event.preventDefault();
      if (pending || closing) return;
      const form = new FormData(event.currentTarget);
      setError("");
      startTransition(async () => {
        const result = await collectPickupOrder(order.id, form);
        if (result.success) close();
        else setError(result.error ?? "Couldn’t confirm payment.");
      });
    }}>
      <div className="pickup-total"><span>Amount due</span><strong>{peso(total)}</strong></div>
      <label className="field">Payment method
        <select name="method" value={method} onChange={(event) => setMethod(event.target.value)}>
          <option value="cash">Cash</option><option value="gcash">GCash</option>
        </select>
      </label>
      {method === "cash" ? <label className="field">Cash received (₱)
        <input name="cash" type="number" step="0.01" min={(total / 100).toFixed(2)} max="1000000" required
          value={cash} onChange={(event) => setCash(event.target.value)} />
        <small>Change due {peso(Math.max(0, Math.round(Number(cash) * 100) - total))}</small>
      </label> : <label className="field">Verified GCash reference
        <input name="reference" minLength={6} maxLength={40} required />
      </label>}
      <label className="toggle-field"><input key={method} type="checkbox" name="verified" required /><span>I received and verified the payment.</span></label>
      {error && <p className="error-message" role="alert">{error}</p>}
      <button type="submit" className="button button-dark" disabled={pending || closing}>{pending ? "Recording…" : "Record payment and complete pickup"}</button>
    </form>
    <div className="pickup-actions"><CancelPickupOrder id={order.id} onCancelled={close} disabled={pending || closing} /></div>
  </Modal>;
}
