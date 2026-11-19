import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/lib/data";
import { getPosData } from "@/lib/pos-data";
import { dayKey } from "@/lib/pos";
import { isValidDate } from "@/lib/booking";
import { ClubConsole } from "@/components/club-console";
import { workspaceTab } from "@/lib/workspace";
import { getRegisterDay } from "@/lib/register-data";
export const metadata: Metadata = {
  title: "Club management",
  robots: { index: false, follow: false },
};
export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; tab?: string }>;
}) {
  const { user, staff, role, verificationUnavailable } = await getSession();
  if (verificationUnavailable) throw new Error("Unable to verify the staff session. Try again in a moment.");
  if (!user) redirect("/login?next=/staff");
  if (!staff) redirect("/my-bookings");
  const p = await searchParams;
  const reportDate = isValidDate(p.date) && p.date >= "2000-01-01" && p.date <= "2100-12-31" ? p.date : null;
  const date = reportDate ?? dayKey();
  const [data, register] = await Promise.all([getPosData(date), getRegisterDay(date)]);
  return <ClubConsole initial={data} initialDate={date} initialTab={workspaceTab(p.tab)} register={register} followToday={!reportDate}
    operator={user.email ?? "Signed-in staff"} canAssign={role === "owner" || role === "manager"} />;
}
