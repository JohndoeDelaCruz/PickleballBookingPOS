"use client";

import { formatDate } from "@/lib/booking";
import { membershipSectionHref, membershipSections, membershipReviewPageSize,
  type ActiveMembershipRow, type MembershipApplicationFocus, type MembershipPages } from "@/lib/membership-applications";
import { TablePagination } from "./table-pagination";

export function ActiveMembersTable({ rows, count, pages, application }: {
  rows: ActiveMembershipRow[]; count: number; pages: MembershipPages; application?: MembershipApplicationFocus;
}) {
  return <>
    {rows.length === 0 ? <p className="panel-empty-note">There are no active members yet.</p> : <>
      <TablePagination count={count} page={pages.active} pageSize={membershipReviewPageSize} label="Active member pages"
        href={(next) => membershipSectionHref("active", { pages: { ...pages, active: next }, application })} />
      <div className="console-table-wrap" role="region" aria-labelledby={`${membershipSections.active.id}-heading`} tabIndex={0}>
        <table className="console-table">
          <thead><tr><th scope="col">Member</th><th scope="col">Plan</th><th scope="col">Starts on</th><th scope="col">Expires on</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id}>
            <td><strong>{row.full_name || row.email || "Member"}</strong>{row.full_name && row.email && <small>{row.email}</small>}</td>
            <td>{row.plan_name}</td>
            <td>{formatDate(row.starts_on)}</td>
            <td>{formatDate(row.expires_on)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </>}
  </>;
}
