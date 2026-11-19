"use client";

import { useState, useTransition, type FormEvent } from "react";
import { membershipApplicationAction } from "@/app/membership/apply/actions";
import { money } from "@/lib/booking";
import type { MembershipPlanId, MembershipPlan } from "@/lib/membership";
import { membershipTerms, type MembershipApplication } from "@/lib/membership-applications";
import { Modal } from "./modal";

export function MembershipApplicationForm({ plans, selected, application, paymentsReady }: {
  plans: MembershipPlan[];
  selected: MembershipPlanId;
  application: MembershipApplication | null;
  paymentsReady: boolean;
}) {
  const [planId, setPlanId] = useState(selected);
  const [reference, setReference] = useState("");
  const [error, setError] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [pending, startTransition] = useTransition();
  const plan = plans.find(({ id }) => id === planId);
  const revision = plan?.revision;
  const canStart = paymentsReady && plan && revision != null && plan.details.price_cents > 0;

  function run(input: unknown) {
    if (pending) return;
    setError("");
    startTransition(async () => {
      const result = await membershipApplicationAction(input);
      if ("error" in result) setError(result.error);
      else {
        setReference("");
        setConfirmCancel(false);
      }
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (application) run({ action: "submit", id: application.id, reference });
    else if (canStart) run({ action: "start", plan: planId, revision });
  }

  return <section className="panel" aria-labelledby="membership-payment-heading">
    <h2 id="membership-payment-heading">{application ? "Pay with GCash" : "Choose a plan"}</h2>
    {application && <>
      <dl className="membership-payment-details">
        <div><dt>Plan</dt><dd>{application.plan_name}</dd></div>
        <div><dt>Term from activation</dt><dd>{membershipTerms[application.plan_id]}</dd></div>
        <div><dt>Amount due</dt><dd>{money(application.price_cents / 100)}</dd></div>
        <div><dt>GCash account name</dt><dd>{application.gcash_name}</dd></div>
        {application.gcash_number && <div><dt>GCash number</dt><dd>{application.gcash_number}</dd></div>}
      </dl>
      {application.gcash_qr_url && <a href={application.gcash_qr_url} target="_blank" rel="noreferrer" aria-label="Open GCash QR image">
        <img className="qr-image" src={application.gcash_qr_url} alt="Venue GCash payment QR" />
        <span className="text-link membership-open-qr">Open QR image</span>
      </a>}
      <p>Send the exact amount in GCash, then enter the reference from your transaction receipt.</p>
    </>}
    <form className="form-stack" onSubmit={submit}>
      {application ? <label className="field">
        <span>GCash reference number</span>
        <input required minLength={6} maxLength={40} autoComplete="off" value={reference} disabled={pending}
          onChange={(event) => setReference(event.target.value)} />
      </label> : <label className="field">
        <span>Membership plan</span>
        <select value={planId} disabled={pending} onChange={(event) => { setPlanId(event.target.value as MembershipPlanId); setError(""); }}>
          {plans.map(({ id, details }) => <option key={id} value={id}>
            {details.plan_name} · {money(details.price_cents / 100)} for {membershipTerms[id]}
          </option>)}
        </select>
      </label>}
      {!application && !canStart && <p className="notice notice-warning">Online payment is unavailable for this plan. Contact the venue to apply.</p>}
      {error && !confirmCancel && <p className="error-message" role="alert">{error}</p>}
      <button className="button button-dark" disabled={pending || (!application && !canStart)}>
        {pending ? "Please wait…" : application ? "Submit payment reference" : "Continue to GCash"}
      </button>
      {application && <button type="button" className="button button-outline" disabled={pending}
        onClick={() => { setError(""); setConfirmCancel(true); }}>Cancel unpaid application</button>}
    </form>
    {confirmCancel && application && <Modal title="Cancel this application?" onClose={() => !pending && setConfirmCancel(false)}>
      <p>Cancel only if you haven’t sent the GCash payment.</p>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="membership-plan-actions">
        <button type="button" className="button button-dark" disabled={pending} onClick={() => run({ action: "cancel", id: application.id })}>Cancel application</button>
        <button type="button" className="button button-outline" disabled={pending} onClick={() => setConfirmCancel(false)}>Keep application</button>
      </div>
    </Modal>}
  </section>;
}
