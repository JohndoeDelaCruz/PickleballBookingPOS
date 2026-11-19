import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { PaddleStackStaff } from "@/components/paddle-stack";
import { WorkspacePageHeading } from "@/components/workspace-page-heading";
import { paddleStackPath, type StackSession } from "@/lib/paddle-stack";

export const metadata: Metadata = {
  title: "Paddle Stack",
  robots: { index: false, follow: false },
};

export default async function PaddleStackPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  const { user, staff } = await getSession();
  if (!user) redirect(`/login?next=${paddleStackPath}`);
  if (!staff) redirect("/my-bookings");

  const [db, params] = await Promise.all([createClient(), searchParams]);
  const { data, error } = await db.rpc("paddle_stack_sessions");

  return (
    <>
      <WorkspacePageHeading title="Paddle Stack" description="Check players in, call the next four, and keep score." />
      {error ? (
        <p className="error-message" role="alert">
          Paddle Stack is unavailable. Refresh to try again.
        </p>
      ) : (
        <PaddleStackStaff sessions={(data ?? []) as StackSession[]} initialId={params.session} />
      )}
    </>
  );
}
