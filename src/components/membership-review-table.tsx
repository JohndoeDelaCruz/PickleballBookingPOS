"use client";

import { useState, useTransition, type FormEvent } from "react";
import { membershipApplicationAction } from "@/app/membership/apply/actions";
import { formatDate, localDate, money } from "@/lib/booking";
import { membershipSectionHref, membershipSections, membershipReviewPageSize, membershipStatus,
  type MembershipApplicationFocus, type MembershipPages, type MembershipReviewRow } from "@/lib/membership-applications";
import { Modal } from "./modal";
import { TablePagination } from "./table-pagination";
import { useAnimatedModal } from "./use-animated-modal";

export function MembershipReviewTable({ rows, count, pages, focus, reviewed }: {
  rows: MembershipReviewRow[]; count: number; pages: MembershipPages; focus?: MembershipApplicationFocus; reviewed: boolean;
}) {
  const [application, setApplication, closing] = useAnimatedModal<MembershipReviewRow>();
  const [message, setMessage] = useState("");
  const section = reviewed ? "reviewed" : "pending";
  const emptyMessage = focus?.section === section ? "This application is no longer available in this section."
    : reviewed ? "No applications have been reviewed." : "No applications are waiting for verification.";

  return <>
    {message && <p className="success-message membership-review-message" role="status">{message}</p>}
    {rows.length === 0 ? <p className="panel-empty-note">{emptyMessage}</p> : <>
      <TablePagination count={count} page={pages[section]} pageSize={membershipReviewPageSize}
        label={reviewed ? "Review history pages" : "Pending verification pages"}
        href={(next) => membershipSectionHref(section, { pages: { ...pages, [section]: next }, application: focus })} />
      <div className="console-table-wrap" role="region" aria-labelledby={`${membershipSections[section].id}-heading`} tabIndex={0}>
        <table className="console-table">
          <thead><tr><th scope="col">{reviewed ? "Customer" : "Applicant"}</th><th scope="col">Plan</th>
            <th scope="col">{reviewed ? "Payment" : "GCash reference"}</th>
            <th scope="col">{reviewed ? "Payment date" : "Submitted"}</th><th scope="col">{reviewed ? "Status" : "Action"}</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id}>
            <td><strong>{row.full_name || row.email || "Account removed"}</strong>{row.full_name && row.email && <small>{row.email}</small>}</td>
            <td><strong>{row.plan_name}</strong><small>{money(row.price_cents / 100)}</small></td>
            <td>{reviewed ? <>
              <strong>{row.payment_method === "cash" ? "Cash" : "GCash"}</strong>
              {row.payment_reference && <small>{row.payment_reference}</small>}
              {row.receipt_number && <small>{row.receipt_number}</small>}
            </> : row.payment_reference}</td>
            <td>{row.submitted_at && formatDate(localDate(new Date(row.submitted_at)))}</td>
            <td>{reviewed ? <>
              <strong>{membershipStatus(row)}</strong>
              {row.status === "approved" && row.expires_on && <small>Expiry {formatDate(row.expires_on)}</small>}
              {row.review_note && <small>{row.review_note}</small>}
            </> : <button className="console-button" onClick={() => { setMessage(""); setApplication(row); }}>Review payment</button>}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </>}
    {application && <ReviewMembershipPayment key={application.id} row={application} closing={closing}
      onClose={() => setApplication(null)} onReviewed={(approved) => {
        setMessage(approved ? "Payment verified and membership activated." : "Payment rejected. The applicant can view the reason in their account.");
        setApplication(null);
      }} />}
  </>;
}

function ReviewMembershipPayment({ row, closing, onClose, onReviewed }: {
  row: MembershipReviewRow; closing: boolean; onClose: () => void; onReviewed: (approved: boolean) => void;
}) {
  const [reject, setReject] = useState(false);
  const [verified, setVerified] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const disabled = pending || closing;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || (!reject && !verified)) return;
    setError("");
    startTransition(async () => {
      const result = await membershipApplicationAction(reject
        ? { action: "reject", id: row.id, reason }
        : { action: "approve", id: row.id, verified });
      if ("error" in result) setError(result.error);
      else onReviewed(!reject);
    });
  }

  return <Modal title={reject ? "Reject membership payment" : "Verify membership payment"} closing={closing}
    onClose={() => !pending && onClose()}>
    <dl className="membership-payment-details">
      <div><dt>Applicant</dt><dd>{row.email || "Account removed"}</dd></div>
      <div><dt>Plan</dt><dd>{row.plan_name}</dd></div>
      <div><dt>Amount due</dt><dd>{money(row.price_cents / 100)}</dd></div>
      <div><dt>GCash account</dt><dd>{row.gcash_name}{row.gcash_number && ` · ${row.gcash_number}`}</dd></div>
      <div><dt>GCash reference</dt><dd>{row.payment_reference}</dd></div>
    </dl>
    <form className="form-stack" onSubmit={submit}>
      {reject ? <label className="field">
        <span>Reason for rejection</span><textarea required minLength={3} maxLength={200} value={reason} disabled={disabled}
          onChange={(event) => setReason(event.target.value)} />
      </label> : <label className="toggle-field">
        <input type="checkbox" required checked={verified} disabled={disabled} onChange={(event) => setVerified(event.target.checked)} />
        <span>I matched the reference and full amount to an incoming GCash payment.</span>
      </label>}
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="membership-plan-actions">
        <button className="console-button primary" disabled={disabled || (!reject && !verified)}>
          {pending ? "Saving…" : reject ? "Reject payment" : "Verify and activate"}
        </button>
        <button className="console-button" type="button" disabled={disabled} onClick={() => { setError(""); setReject(!reject); }}>
          {reject ? "Back to verification" : "Reject payment"}
        </button>
      </div>
    </form>
  </Modal>;
}
