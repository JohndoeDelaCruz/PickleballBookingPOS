"use client";

import type { ReactNode } from "react";
import { ManagementSidebar } from "./management-sidebar";
import { WorkspaceNavigation } from "./workspace-navigation";
import { WorkspaceMenuButton } from "./workspace-menu-button";
import type { WorkspaceTab } from "@/lib/workspace";

export function ConsoleFrame({ children, demo, tab, mobile, setMobile, go, onReset }: {
  children: ReactNode; demo: boolean; tab: WorkspaceTab; mobile: boolean;
  setMobile: (open: boolean) => void; go: (tab: WorkspaceTab) => void; onReset: () => void;
}) {
  // Live pages use the persistent management layout; the standalone demo owns its chrome.
  if (!demo) return children;
  return (
    <main id="main" className="club-app">
      <ManagementSidebar mobileOpen={mobile} onMobileClose={() => setMobile(false)} demo onReset={onReset}>
        <WorkspaceNavigation activeTab={tab} onSelect={go} onNavigate={() => setMobile(false)} demo />
      </ManagementSidebar>
      <div className="club-main">
        <WorkspaceMenuButton menuOpen={mobile} onMenuOpen={() => setMobile(true)} />
        {children}
      </div>
    </main>
  );
}
