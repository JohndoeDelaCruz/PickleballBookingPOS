import Link from "next/link";
import { formatDate, money } from "@/lib/booking";
import { membershipApplyPath, membershipStatus, type MembershipApplication } from "@/lib/membership-applications";

export function MembershipStatus({ application, account = false }: { application: MembershipApplication | null; account?: boolean }) {
  const status = application ? membershipStatus(application) : null;
  const tone = status === "Active" ? "status-ok" : status === "Expired" || status === "Payment rejected" || status === "Refunded"
    ? "status-cancelled" : "status-pending";

  return <section className="panel membership-account-status" aria-labelledby="account-membership-heading">
    <div className="membership-status-heading">
      <h2 id="account-membership-heading">{application?.plan_name ?? "Membership"}</h2>
      {status && <span className={`status-pill ${tone}`}>{status}</span>}
    </div>
    {application && <p className="small-print">{money(application.price_cents / 100)}</p>}
    {application?.status === "pending" && <p>Staff will check your GCash payment before activating your membership.</p>}
    {application?.status === "rejected" && <>
      <p>{application.review_note}</p>
      <p className="small-print">If you already sent a payment, contact the venue before paying again.</p>
    </>}
    {application?.status === "approved" && application.starts_on && application.expires_on && <dl className="membership-payment-details">
      <div><dt>Started</dt><dd>{formatDate(application.starts_on)}</dd></div>
      <div><dt>{status === "Expired" ? "Expired on" : "Expires on"}</dt><dd>{formatDate(application.expires_on)}</dd></div>
    </dl>}
    {!application && <p>Choose a plan to apply for a membership.</p>}
    {account && status === "Awaiting payment" && <Link className="button button-dark" href={membershipApplyPath}>Continue payment</Link>}
    {account && (!status || status === "Expired" || status === "Payment rejected" || status === "Refunded") && (
      <Link className="button button-outline" href="/membership">View membership plans</Link>
    )}
    {!account && <Link className="text-link" href="/account">View my account</Link>}
  </section>;
}
