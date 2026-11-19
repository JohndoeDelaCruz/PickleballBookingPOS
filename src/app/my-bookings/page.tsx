import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { CurrentMatches } from "@/components/current-matches";
import { getSession } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { OffDutyCloseout } from "@/components/off-duty-closeout";
import type { Shift } from "@/lib/pos";

export const metadata: Metadata = { title: "My bookings" };

export default async function MyBookings() {
  const { user, offDuty } = await getSession();
  if (!user) redirect("/login?next=/my-bookings");
  let openShift: Shift | null = null;
  if (offDuty) {
    const db = await createClient();
    const { data } = await db.rpc("pos_own_open_shift").maybeSingle();
    openShift = data as Shift | null;
  }

  return (
    <main id="main" className="container content-page">
      <div className="page-heading">
        <h1>YOUR COURT TIME.</h1>
        <Link href="/account" className="text-link account-link">
          Account settings / Change password <ArrowUpRight size={17} aria-hidden="true" />
        </Link>
      </div>
      {offDuty && (
        <div className="notice" role="status">
          <span>Another front desk staff member is on duty today. If you’re covering the shift, ask a manager to update today’s assignment.</span>
        </div>
      )}
      {openShift && <OffDutyCloseout shift={openShift} operator={user.email ?? "Signed-in staff"} />}
      <CurrentMatches />
      <div className="pickup-actions">
        <Link href="/my-bookings/all" prefetch={false} className="button button-outline button-small">
          See all bookings <ArrowRight size={17} aria-hidden="true" />
        </Link>
        <Link href="/order" prefetch={false} className="button button-outline button-small">My pickup orders</Link>
      </div>
    </main>
  );
}
