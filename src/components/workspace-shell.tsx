"use client";

import { useMemo, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ManagementSidebar } from "./management-sidebar";
import { WorkspaceNavigation } from "./workspace-navigation";
import { WorkspaceMenuButton } from "./workspace-menu-button";
import { WorkspaceContext } from "./workspace-context";
import { workspaceTab, type WorkspaceTab } from "@/lib/workspace";
import { CashierAccessCheck } from "./cashier-access-check";
import type { WorkspaceRole } from "@/lib/session-access";

export function WorkspaceShell({ children, role, roleLoading = false, courtCount, totalCourtCount }: {
  children: ReactNode; role?: WorkspaceRole; roleLoading?: boolean; courtCount?: number; totalCourtCount?: number;
}) {
  const [mobile, setMobile] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const path = usePathname();
  const params = useSearchParams();
  const consolePage = path === "/staff";
  const tab = workspaceTab(params.get("tab"));
  const context = useMemo(() => ({ courtCount, totalCourtCount, setPendingCount }), [courtCount, totalCourtCount]);
  function selectTab(next: WorkspaceTab) {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    url.searchParams.delete("review");
    url.searchParams.delete("q");
    window.history.replaceState(null, "", url);
    setMobile(false);
  }
  return (
    <WorkspaceContext.Provider value={context}>
    <main id="main" className="club-app workspace-app">
      {role === "cashier" && <CashierAccessCheck />}
      <ManagementSidebar mobileOpen={mobile} onMobileClose={() => setMobile(false)} role={role}>
        <WorkspaceNavigation manager={!roleLoading && role !== "cashier"} onNavigate={() => setMobile(false)}
          canManageAccess={role === "owner" || role === "manager"}
          activeTab={consolePage ? tab : undefined} onSelect={consolePage ? selectTab : undefined} pendingCount={pendingCount} />
      </ManagementSidebar>
      <div className="club-main">
        <WorkspaceMenuButton menuOpen={mobile} onMenuOpen={() => setMobile(true)} />
        <div className={consolePage ? "workspace-console-page" : "console-content workspace-content"}>{children}</div>
      </div>
    </main>
    </WorkspaceContext.Provider>
  );
}
