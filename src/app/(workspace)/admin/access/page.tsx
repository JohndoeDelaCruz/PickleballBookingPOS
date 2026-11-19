import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AccountRoles } from "@/components/account-roles";
import { WorkspacePageHeading } from "@/components/workspace-page-heading";
import { accountRolesHref, accountRolesPath, type ManagedAccount } from "@/lib/account-roles";
import { getSession } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Access" };

const accountsPerPage = 10;
const databasePageSize = 10;
type AccountListResult = { row_count: number; rows: ManagedAccount[]; page_size?: number };

function AccountLoadError({ code }: { code?: string }) {
  return <>
    <WorkspacePageHeading title="Access" />
    <p className="error-message" role="alert">{code === "PGRST202"
      ? "Apply database migration 024 to manage account access."
      : "Accounts couldn’t be loaded. Please refresh and try again."}</p>
  </>;
}

export default async function AccessPage({ searchParams }: {
  searchParams: Promise<{ q?: string | string[]; page?: string | string[] }>;
}) {
  const { user, staff, role, verificationUnavailable } = await getSession();
  if (verificationUnavailable) throw new Error("Unable to verify the staff session. Try again in a moment.");
  if (!user) redirect(`/login?next=${accountRolesPath}`);
  if (!staff) redirect("/my-bookings");
  if (role !== "owner" && role !== "manager") redirect("/staff");

  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.trim().slice(0, 254) : "";
  const requestedPage = typeof params.page === "string" ? Number(params.page) : 1;
  const page = Number.isInteger(requestedPage) && requestedPage >= 1 && requestedPage <= 2147483647 ? requestedPage : 1;
  const db = await createClient();
  const offset = (page - 1) * accountsPerPage;
  const read = (chunk: number) => db.rpc("admin_list_accounts", { p_query: query, p_page: chunk });
  const initialChunk = Math.floor(offset / databasePageSize) + 1;
  let { data, error } = await read(initialChunk);
  const chunkSize = (data as AccountListResult | null)?.page_size ?? 25;
  const chunk = Math.floor(offset / chunkSize) + 1;
  if (!error && data && chunk !== initialChunk) ({ data, error } = await read(chunk));
  if (error || !data) return <AccountLoadError code={error?.code} />;

  const { row_count: count, rows } = data as AccountListResult;
  if (page > 1 && offset >= count) redirect(accountRolesHref(query));
  const start = offset % chunkSize;
  const pageRows = rows.slice(start, start + accountsPerPage);
  if (start + accountsPerPage > chunkSize && offset + pageRows.length < count) {
    const { data: nextData, error: nextError } = await read(chunk + 1);
    if (nextError || !nextData) return <AccountLoadError code={nextError?.code} />;
    const { rows: nextRows } = nextData as AccountListResult;
    pageRows.push(...nextRows.slice(0, accountsPerPage - pageRows.length));
  }
  return <AccountRoles rows={pageRows} count={count} page={page} pageSize={accountsPerPage}
    query={query} owner={role === "owner"} userId={user.id} />;
}
