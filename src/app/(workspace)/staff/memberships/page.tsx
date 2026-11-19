import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { ActiveMembersTable } from "@/components/active-members-table";
import { MembershipReviewTable } from "@/components/membership-review-table";
import { MembershipSale } from "@/components/membership-sale";
import { WorkspacePageHeading } from "@/components/workspace-page-heading";
import { getMembershipPlans, getSession, getVenueSettings } from "@/lib/data";
import { isPublishedMembershipPlan } from "@/lib/membership";
import { membershipSectionHref, membershipSections, membershipReviewPageSize, membershipReviewPath,
  type ActiveMembershipRow, type MembershipApplicationFocus, type MembershipPages, type MembershipReviewRow,
  type MembershipSection } from "@/lib/membership-applications";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Memberships", robots: { index: false, follow: false } };

type Query = {
  [Key in `${MembershipSection}Page` | "view" | "page" | "application"]?: string | string[];
};
type MembershipList<Row> = { row_count: number; rows: Row[] };

function pageNumber(value: Query["page"]) {
  const page = typeof value === "string" ? Number(value) : 1;
  return Number.isInteger(page) && page >= 1 && page <= 2147483647 ? page : 1;
}

function MembershipSectionCard({ section, count, children, action }: {
  section: MembershipSection; count?: number; children: ReactNode; action?: ReactNode;
}) {
  const { id, label } = membershipSections[section];
  return <section id={id} className="console-panel" aria-labelledby={`${id}-heading`}
    data-needs-review={section === "pending" && Boolean(count) ? "" : undefined}>
    <div className="panel-heading">
      <h2 id={`${id}-heading`}>{label}{count !== undefined && <span className="membership-section-count">{count}</span>}</h2>
      {action}
    </div>
    {children}
  </section>;
}

export default async function MembershipReviewPage({ searchParams }: { searchParams: Promise<Query> }) {
  const { user, staff, verificationUnavailable } = await getSession();
  if (verificationUnavailable) throw new Error("Unable to verify the staff session. Please try again.");
  if (!user) redirect(`/login?next=${membershipReviewPath}`);
  if (!staff) redirect("/my-bookings");
  const params = await searchParams;
  const legacySection = params.view === "active" || params.view === "reviewed" ? params.view : "pending";
  const applicationId = z.uuid().safeParse(params.application);
  const focus: MembershipApplicationFocus | undefined = legacySection !== "active" && applicationId.success
    ? { section: legacySection, id: applicationId.data } : undefined;
  const pages: MembershipPages = {
    pending: focus?.section === "pending" ? 1 : pageNumber(params.pendingPage ?? (legacySection === "pending" ? params.page : undefined)),
    active: pageNumber(params.activePage ?? (legacySection === "active" ? params.page : undefined)),
    reviewed: focus?.section === "reviewed" ? 1 : pageNumber(params.reviewedPage ?? (legacySection === "reviewed" ? params.page : undefined)),
  };
  const db = await createClient();
  const listApplications = (section: MembershipApplicationFocus["section"]) =>
    db.rpc("list_membership_applications", { p_reviewed: section === "reviewed", p_page: pages[section],
      ...(focus?.section === section && { p_application: focus.id }) });
  const [pending, active, reviewed, plans, venue] = await Promise.all([
    listApplications("pending"),
    db.rpc("list_active_memberships", { p_page: pages.active }),
    listApplications("reviewed"),
    getMembershipPlans(),
    getVenueSettings(),
  ]);
  const pendingList = pending.error ? null : pending.data as MembershipList<MembershipReviewRow> | null;
  const activeList = active.error ? null : active.data as MembershipList<ActiveMembershipRow> | null;
  const reviewedList = reviewed.error ? null : reviewed.data as MembershipList<MembershipReviewRow> | null;
  if (focus?.section === "pending" && pendingList?.row_count === 0) {
    redirect(membershipSectionHref("reviewed", { pages: { ...pages, reviewed: 1 }, application: { ...focus, section: "reviewed" } }));
  }
  const counts = { pending: pendingList?.row_count, active: activeList?.row_count, reviewed: reviewedList?.row_count };
  let resetSection: MembershipSection | undefined;
  for (const section of ["pending", "active", "reviewed"] as const) {
    const count = counts[section];
    if (count !== undefined && pages[section] > 1 && (pages[section] - 1) * membershipReviewPageSize >= count) {
      pages[section] = 1;
      resetSection ??= section;
    }
  }
  if (resetSection) redirect(membershipSectionHref(resetSection, { pages, application: focus }));

  const salePlans = plans.filter(isPublishedMembershipPlan).flatMap(({ id, details, revision }) => details.price_cents > 0
    ? [{ id, name: details.plan_name, price: details.price_cents, revision }] : []);
  const gcashName = venue?.gcash_name?.trim();
  const gcashNumber = venue?.gcash_number?.trim();
  const gcash = gcashName && (gcashNumber || venue?.gcash_qr_url?.trim())
    ? [gcashName, gcashNumber].filter(Boolean).join(" · ") : null;
  const allApplications = focus && <Link className="button button-small button-outline"
    href={membershipSectionHref(focus.section, { pages })}>{focus.section === "pending" ? "Show all pending" : "Show full history"}</Link>;
  const applicationsError = <p className="error-message membership-review-message" role="alert">
    Membership applications couldn’t be loaded. Check that migration 033 is applied, then refresh.
  </p>;
  return <>
    <WorkspacePageHeading title="Memberships" actions={<MembershipSale plans={salePlans} gcash={gcash} />} />
    <div className="membership-sections">
      <MembershipSectionCard section="pending" count={counts.pending} action={focus?.section === "pending" && allApplications}>
        {pendingList ? <MembershipReviewTable rows={pendingList.rows} count={pendingList.row_count} pages={pages} focus={focus} reviewed={false} />
          : applicationsError}
      </MembershipSectionCard>
      <MembershipSectionCard section="active" count={counts.active}>
        {activeList ? <ActiveMembersTable rows={activeList.rows} count={activeList.row_count} pages={pages} application={focus} />
          : <p className="error-message membership-review-message" role="alert">{active.error?.code === "PGRST202"
            ? "Apply migration 037 to view active members." : "Active members couldn’t be loaded. Please refresh and try again."}</p>}
      </MembershipSectionCard>
      <MembershipSectionCard section="reviewed" count={counts.reviewed} action={focus?.section === "reviewed" && allApplications}>
        {reviewedList ? <MembershipReviewTable rows={reviewedList.rows} count={reviewedList.row_count} pages={pages} focus={focus} reviewed />
          : applicationsError}
      </MembershipSectionCard>
    </div>
  </>;
}
