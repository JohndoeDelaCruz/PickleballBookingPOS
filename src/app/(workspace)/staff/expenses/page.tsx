import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ExpenseTracker } from "@/components/expense-tracker";
import { WorkspacePageHeading } from "@/components/workspace-page-heading";
import { localDate } from "@/lib/booking";
import { expensesPageSize, expensesPath, type ExpenseReport } from "@/lib/expenses";
import { isReportMonth } from "@/lib/finance";
import { getSession } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Expenses",
  robots: { index: false, follow: false },
};

export default async function ExpensesPage({ searchParams }: {
  searchParams: Promise<{ month?: string; page?: string }>;
}) {
  const { user, staff, role, verificationUnavailable } = await getSession();
  if (verificationUnavailable) throw new Error("Unable to verify the staff session. Try again in a moment.");
  if (!user) redirect(`/login?next=${expensesPath}`);
  if (!staff) redirect("/my-bookings");

  const params = await searchParams;
  const today = localDate();
  const month = isReportMonth(params.month) ? params.month : today.slice(0, 7);
  const requestedPage = Number(params.page);
  const page = Number.isInteger(requestedPage) && requestedPage >= 1 && requestedPage <= 2147483647 ? requestedPage : 1;
  const db = await createClient();
  const { data, error } = await db.rpc("pos_expense_report", { p_month: `${month}-01`, p_page: page });
  if (error || !data) return <>
    <WorkspacePageHeading title="Expenses" />
    <p className="error-message" role="alert">
      Expenses could not be loaded. Check that migration 020 is applied, then refresh.
    </p>
  </>;

  const report = data as ExpenseReport;
  if (page > 1 && (page - 1) * expensesPageSize >= report.row_count)
    redirect(`${expensesPath}?month=${month}`);

  return <ExpenseTracker report={report} month={month} page={page} today={today}
    manager={role === "owner" || role === "manager"} />;
}
