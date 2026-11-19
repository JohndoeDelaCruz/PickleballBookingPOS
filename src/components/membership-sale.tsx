"use client";

import { useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { findMembershipCustomers, sellMembership, type MembershipCustomer, type MembershipSaleReceipt } from "@/app/(workspace)/staff/memberships/actions";
import { formatDate } from "@/lib/booking";
import { membershipReferenceSchema, membershipTerms } from "@/lib/membership-applications";
import type { MembershipPlanId } from "@/lib/membership";
import { centavos, peso } from "@/lib/pos";
import { Modal } from "./modal";
import { useAnimatedModal } from "./use-animated-modal";

type SalePlan = { id: MembershipPlanId; name: string; price: number; revision: number };
type SaleOptions = { plans: SalePlan[]; gcash: string | null };

export function MembershipSale(options: SaleOptions) {
  const [key, setKey, closing] = useAnimatedModal<string>();
  return <>
    <button type="button" className="console-button primary" onClick={() => setKey(crypto.randomUUID())}>
      <Plus size={16} /> Sell membership
    </button>
    {key && <MembershipSaleDialog key={key} saleKey={key} closing={closing} onClose={() => setKey(null)} {...options} />}
  </>;
}

function MembershipSaleDialog({ plans, gcash, saleKey, closing, onClose }: SaleOptions & {
  saleKey: string; closing: boolean; onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MembershipCustomer[] | null>(null);
  const [customer, setCustomer] = useState<MembershipCustomer | null>(null);
  const [receipt, setReceipt] = useState<MembershipSaleReceipt | null>(null);
  const [error, setError] = useState("");
  const [pending, run] = useTransition();

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || closing || query.trim().length < 2) return;
    setError("");
    setResults(null);
    run(async () => {
      const result = await findMembershipCustomers(query);
      if ("error" in result) setError(result.error);
      else setResults(result.customers);
    });
  }

  return <Modal title={receipt ? "Membership sale recorded" : "Sell membership"} closing={closing} onClose={() => !pending && onClose()}>
    {receipt ? <div className="form-stack">
      <p role="status" className="success-message">{receipt.status === "approved"
        ? `${receipt.plan_name} is active for ${customer?.full_name || customer?.email}.`
        : "This membership sale was refunded."}</p>
      <dl className="membership-payment-details">
        <div><dt>Receipt</dt><dd>{receipt.receipt_number}</dd></div>
        <div><dt>Amount</dt><dd>{peso(receipt.price_cents)}</dd></div>
        {receipt.status === "approved" && <div><dt>Expires on</dt><dd>{formatDate(receipt.expires_on)}</dd></div>}
      </dl>
      <div className="membership-plan-actions">
        <Link className="console-button primary" href="/staff?tab=transactions">View transactions</Link>
        <button type="button" className="console-button" onClick={onClose}>Done</button>
      </div>
    </div> : plans.length === 0 ? <p role="alert" className="error-message">Membership prices are unavailable. Refresh the page before taking payment.</p>
      : customer ? <MembershipSalePayment plans={plans} gcash={gcash} customer={customer} saleKey={saleKey}
        disabled={pending || closing} pending={pending} error={error} onBack={() => { setCustomer(null); setError(""); }}
        onSubmit={(payment) => {
          setError("");
          run(async () => {
            const result = await sellMembership(payment);
            if ("error" in result) setError(result.error);
            else setReceipt(result.receipt);
          });
        }} /> : <div className="form-stack">
        <form className="form-stack" onSubmit={search}>
          <label className="field"><span>Customer name or full email address</span>
            <input type="search" autoFocus value={query} onChange={(event) => { setQuery(event.target.value); setResults(null); setError(""); }}
              required minLength={2} maxLength={254} disabled={pending || closing} />
          </label>
          <div><button className="console-button primary" disabled={pending || closing || query.trim().length < 2}>
            <Search size={16} /> {pending ? "Searching…" : "Find customer"}
          </button></div>
        </form>
        {error && <p className="error-message" role="alert">{error}</p>}
        {results?.length === 0 && <p role="status">No confirmed accounts found. The customer can sign up and confirm their email first.</p>}
        {results && results.length > 0 && <ul className="membership-customer-results" aria-label="Matching customer accounts">
          {results.map((result) => <li key={result.id}>
            <button type="button" className="console-button membership-customer-result"
              disabled={closing || result.availability !== "available"} onClick={() => setCustomer(result)}>
              {result.full_name && <strong>{result.full_name}</strong>}
              <span>{result.email}</span>
              {result.availability === "active" && <small>Already has an active membership</small>}
              {result.availability === "pending" && <small>Online payment awaiting verification</small>}
            </button>
          </li>)}
        </ul>}
      </div>}
  </Modal>;
}

type SalePayment = { key: string; customer: string; plan: MembershipPlanId; revision: number; received: number }
  & ({ method: "cash" } | { method: "gcash"; reference: string; verified: boolean });

function MembershipSalePayment({ plans, gcash, customer, saleKey, disabled, pending, error, onBack, onSubmit }: SaleOptions & {
  customer: MembershipCustomer; saleKey: string; disabled: boolean; pending: boolean; error: string;
  onBack: () => void; onSubmit: (payment: SalePayment) => void;
}) {
  const [selected, setSelected] = useState("");
  const [method, setMethod] = useState<"cash" | "gcash">("cash");
  const [cash, setCash] = useState("");
  const [reference, setReference] = useState("");
  const [verified, setVerified] = useState(false);
  const plan = plans.find(({ id }) => id === selected);
  let received = 0;
  if (method === "cash") {
    try { received = centavos(cash); } catch { received = 0; }
  } else if (plan) received = plan.price;
  const ready = plan && (method === "cash" ? received >= plan.price && received <= 100000000
    : gcash && verified && membershipReferenceSchema.safeParse(reference).success);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !plan || !ready) return;
    const fields = { key: saleKey, customer: customer.id, plan: plan.id, revision: plan.revision, received };
    onSubmit(method === "cash" ? { ...fields, method } : { ...fields, method, reference, verified });
  }

  return <form className="form-stack" onSubmit={submit}>
    <dl className="membership-payment-details">
      <div><dt>Customer</dt><dd>{customer.full_name && <strong>{customer.full_name} · </strong>}{customer.email}</dd></div>
      {plan && <div><dt>Amount due</dt><dd><strong>{peso(plan.price)}</strong></dd></div>}
    </dl>
    <label className="field"><span>Membership plan</span>
      <select autoFocus required disabled={disabled} value={selected}
        onChange={(event) => { setSelected(event.target.value); setVerified(false); }}>
        <option value="" disabled>Choose a plan</option>
        {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name} · {membershipTerms[plan.id]} · {peso(plan.price)}</option>)}
      </select>
    </label>
    {plan && <>
      <label className="field"><span>Payment method</span>
        <select disabled={disabled} value={method} onChange={(event) => {
          setMethod(event.target.value === "gcash" ? "gcash" : "cash"); setVerified(false);
        }}>
          <option value="cash">Cash</option>
          <option value="gcash" disabled={!gcash}>GCash</option>
        </select>
      </label>
      {method === "cash" ? <label className="field"><span>Cash received (₱)</span>
        <input required inputMode="decimal" maxLength={11} value={cash} disabled={disabled} onChange={(event) => setCash(event.target.value)} />
        <small>{received >= plan.price ? `Change due ${peso(received - plan.price)}` : "Open your register shift before collecting cash."}</small>
      </label> : <>
        <label className="field"><span>GCash reference</span>
          <input required maxLength={40} value={reference} disabled={disabled} onChange={(event) => { setReference(event.target.value); setVerified(false); }} />
        </label>
        <label className="toggle-field">
          <input type="checkbox" required checked={verified} disabled={disabled} onChange={(event) => setVerified(event.target.checked)} />
          <span>I verified the reference and {peso(plan.price)} payment in {gcash}.</span>
        </label>
      </>}
    </>}
    {error && <p className="error-message" role="alert">{error}</p>}
    <div className="membership-plan-actions">
      <button type="button" className="console-button" disabled={disabled} onClick={onBack}>Back</button>
      <button className="console-button primary" disabled={disabled || !ready}>{pending ? "Recording sale…" : "Record sale and activate"}</button>
    </div>
  </form>;
}
