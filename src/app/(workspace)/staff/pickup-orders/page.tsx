import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { PickupOrderQueue } from "@/components/pickup-order-queue";
import { WorkspacePageHeading } from "@/components/workspace-page-heading";
import { pickupOrderPageSize, pickupOrderSchema, pickupOrdersPath } from "@/lib/counter-orders";
import { getSession } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Pickup orders", robots: { index: false, follow: false } };
const orderPage = z.object({ count: z.int().nonnegative(), rows: z.array(pickupOrderSchema) });

export default async function StaffPickupOrders({ searchParams }: { searchParams: Promise<{ page?: string; view?: string }> }) {
  const { user, staff, verificationUnavailable } = await getSession();
  if (verificationUnavailable) throw new Error("Unable to verify the staff session. Please try again.");
  if (!user) redirect(`/login?next=${pickupOrdersPath}`);
  if (!staff) redirect("/my-bookings");
  const query = await searchParams;
  const selectedPage = Number(query.page);
  const page = Number.isInteger(selectedPage) && selectedPage >= 1 && selectedPage <= 2147483647 ? selectedPage : 1;
  const history = query.view === "history";
  const db = await createClient();
  const { data, error } = await db.rpc("list_counter_orders", { p_page: page, p_history: history });
  const list = orderPage.safeParse(data).data;
  if (list && page > 1 && (page - 1) * pickupOrderPageSize >= list.count) redirect(`${pickupOrdersPath}${history ? "?view=history" : ""}`);

  return <>
    <WorkspacePageHeading title="Pickup orders" actions={<Link href="/staff?tab=pos" className="console-button">Point of sale</Link>} />
    <nav className="membership-review-filters" aria-label="Pickup order views">
      <Link href={pickupOrdersPath} aria-current={!history ? "page" : undefined} className={`button button-small ${history ? "button-outline" : "button-dark"}`}>Awaiting pickup</Link>
      <Link href={`${pickupOrdersPath}?view=history`} aria-current={history ? "page" : undefined} className={`button button-small ${history ? "button-dark" : "button-outline"}`}>History</Link>
    </nav>
    {list ? <PickupOrderQueue rows={list.rows} count={list.count} page={page} history={history} />
      : <p className="error-message" role="alert">{error?.code === "PGRST202" ? "Apply migration 044 to enable pickup orders." : "Pickup orders couldn’t be loaded. Refresh and try again."}</p>}
  </>;
}
