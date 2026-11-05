import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getSession } from "@/lib/data";
import { ChangePasswordForm } from "@/components/change-password-form";

export const metadata: Metadata = {
  title: "Account settings",
  robots: { index: false, follow: false },
};

export default async function AccountPage() {
  const { user, staff } = await getSession();
  if (!user) redirect("/login?next=/account");
  if (staff) return (
    <>
      <div className="console-page-heading">
        <div>
          <span className="console-kicker">YOUR ACCOUNT</span>
          <h1>Keep your account secure.</h1>
          <p>Manage the password you use to access your club workspace.</p>
        </div>
      </div>
      <div className="workspace-account-grid">
        <ChangePasswordForm />
        <aside className="console-panel workspace-account-note">
          <span className="console-kicker">SIGNED IN AS</span>
          <strong>{user.email}</strong>
          <p>Use a unique password with at least 8 characters. Your current password is required to save a new one.</p>
        </aside>
      </div>
    </>
  );
  return (
    <main id="main" className="container content-page account-page">
      <div className="page-heading">
        <h1>Account settings</h1>
        <p>{user.email}</p>
        <Link className="text-link" href={staff ? "/admin" : "/my-bookings"}>
          <ArrowLeft size={17} /> {staff ? "Back to dashboard" : "Back to my bookings"}
        </Link>
      </div>
      <ChangePasswordForm />
    </main>
  );
}
