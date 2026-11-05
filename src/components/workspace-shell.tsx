"use client";

import { useMemo, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ManagementSidebar } from "./management-sidebar";
import { WorkspaceNavigation } from "./workspace-navigation";
import { WorkspaceTopbar } from "./workspace-topbar";
import { WorkspaceContext } from "./workspace-context";
import { workspaceTab, workspaceTabs, type WorkspaceTab } from "@/lib/workspace";

const pageNames: Record<string, string> = {
  "/admin": "Court calendar",
  "/admin/finance": "Booking finance",
  "/admin/settings": "Venue settings",
  "/account": "Account settings",
};

export function WorkspaceShell({ children, role, roleLoading = false, courtCount, totalCourtCount }: {
  children: ReactNode; role?: string; roleLoading?: boolean; courtCount?: number; totalCourtCount?: number;
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
    window.history.replaceState(null, "", url);
    setMobile(false);
  }
  return (
    <WorkspaceContext.Provider value={context}>
    <main id="main" className="club-app workspace-app">
      <ManagementSidebar mobileOpen={mobile} onMobileClose={() => setMobile(false)} role={role}>
        <WorkspaceNavigation manager={!roleLoading && role !== "cashier"} onNavigate={() => setMobile(false)}
          activeTab={consolePage ? tab : undefined} onSelect={consolePage ? selectTab : undefined} pendingCount={pendingCount} />
      </ManagementSidebar>
      <div className="club-main">
        <WorkspaceTopbar title={consolePage ? workspaceTabs.find((item) => item.id === tab)!.label : pageNames[path] ?? "Club management"} menuOpen={mobile} onMenuOpen={() => setMobile(true)} />
        <div className={consolePage ? "workspace-console-page" : "console-content workspace-content"}>{children}</div>
      </div>
    </main>
    </WorkspaceContext.Provider>
  );
}
