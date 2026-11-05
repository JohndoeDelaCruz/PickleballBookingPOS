import { Suspense, type ReactNode } from "react";
import { getCourtInventory, getSession, getWorkspaceRole } from "@/lib/data";
import { activeCourts } from "@/lib/courts";
import { WorkspaceShell } from "@/components/workspace-shell";
import { WorkspaceRouteLoading } from "@/components/workspace-route-loading";

export default async function ManagementLayout({ children }: { children: ReactNode }) {
  const { staff } = await getSession();
  // Customer account pages keep their public layout; each page still checks access.
  if (!staff) return children;
  return (
    <Suspense fallback={<WorkspaceShell roleLoading><WorkspaceRouteLoading /></WorkspaceShell>}>
      <AuthorizedWorkspace>{children}</AuthorizedWorkspace>
    </Suspense>
  );
}

async function AuthorizedWorkspace({ children }: { children: ReactNode }) {
  const [role, inventory] = await Promise.all([getWorkspaceRole(), getCourtInventory()]);
  return (
    <WorkspaceShell role={role} courtCount={activeCourts(inventory.courts).length} totalCourtCount={inventory.courts.length}>
      {children}
    </WorkspaceShell>
  );
}
