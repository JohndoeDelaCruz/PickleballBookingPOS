import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { getSession } from "@/lib/data";
export const metadata: Metadata = {
  title: "Admin Dashboard",
  robots: { index: false, follow: false },
};
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, staff } = await getSession();
  if (!user) redirect("/login?next=/admin");
  if (!staff)
    return (
      <main
        id="main"
        className="container content-page"
        style={{ paddingTop: 60 }}
      >
        <div className="empty-state">
          <ShieldCheck />
          <h2>Staff access only.</h2>
          <p>
            This dashboard is available to authorized Rally staff. If you
            manage the venue, ask the account owner to give your account staff
            access.
          </p>
          <Link href="/my-bookings" className="button button-dark">
            Go to my bookings
          </Link>
        </div>
      </main>
    );
  return children;
}
