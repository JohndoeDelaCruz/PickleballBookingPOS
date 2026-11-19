import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { MembershipApplicationForm } from "@/components/membership-application-form";
import { MembershipStatus } from "@/components/membership-status";
import { getCurrentMembership, getMembershipPlans, getSession, getVenueSettings } from "@/lib/data";
import { isPublishedMembershipPlan } from "@/lib/membership";
import { membershipApplyPath, membershipPlanIdSchema, membershipStatus } from "@/lib/membership-applications";

export const metadata: Metadata = { title: "Apply for membership", robots: { index: false, follow: false } };

export default async function ApplyMembershipPage({ searchParams }: { searchParams: Promise<{ plan?: string | string[] }> }) {
  const { user, verificationUnavailable } = await getSession();
  if (verificationUnavailable) throw new Error("Unable to verify your sign-in. Please try again.");
  const parsedPlan = membershipPlanIdSchema.safeParse((await searchParams).plan);
  const selected = parsedPlan.success ? parsedPlan.data : "annual";
  if (!user) redirect(`/login?next=${encodeURIComponent(`${membershipApplyPath}?plan=${selected}`)}`);

  const [application, plans, venue] = await Promise.all([getCurrentMembership(user.id), getMembershipPlans(), getVenueSettings()]);
  const availablePlans = plans.filter(isPublishedMembershipPlan).filter(({ details }) => details.price_cents > 0);
  const selectedPlan = availablePlans.find(({ id }) => id === selected) ?? availablePlans[0];
  const unpaid = application?.status === "awaiting_payment" ? application : null;
  const status = application ? membershipStatus(application) : null;
  const showCurrentStatus = status === "Pending verification" || status === "Active" || status === "Payment rejected" || status === "Refunded";
  return <main id="main" className="container membership-apply-page">
    <div className="page-heading">
      <Link className="text-link" href="/membership"><ArrowLeft size={16} /> Membership plans</Link>
      <h1>Apply for membership</h1>
    </div>
    {application === undefined ? <p className="notice notice-warning">Online applications are currently unavailable. Contact the venue to apply.</p> : <>
      {showCurrentStatus && <MembershipStatus application={application} />}
      {status !== "Active" && status !== "Pending verification" && (
        unpaid || selectedPlan ? (
          <MembershipApplicationForm key={application?.id ?? selectedPlan?.id} plans={availablePlans} selected={selectedPlan?.id ?? selected}
            application={unpaid}
            paymentsReady={Boolean(venue?.gcash_name?.trim() && (venue.gcash_number?.trim() || venue.gcash_qr_url?.trim()))} />
        ) : <p className="notice">Online membership applications are currently unavailable.</p>
      )}
    </>}
  </main>;
}
