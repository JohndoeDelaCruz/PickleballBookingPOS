"use client";

import { ChevronRight, Menu } from "lucide-react";

export function WorkspaceTopbar({
  title,
  demo = false,
  menuOpen,
  onMenuOpen,
}: {
  title: string;
  demo?: boolean;
  menuOpen: boolean;
  onMenuOpen: () => void;
}) {
  return (
    <header className="club-topbar">
      <div>
        <button
          type="button"
          className="mobile-menu"
          aria-label="Open management menu"
          aria-expanded={menuOpen}
          onClick={onMenuOpen}
        >
          <Menu size={20} aria-hidden="true" />
        </button>
        <span className="workspace-crumb">Workspace</span>
        <ChevronRight size={13} aria-hidden="true" />
        <strong>{title}</strong>
      </div>
      <div>
        <span className={`environment-pill ${demo ? "demo-pill" : ""}`}>
          <span />{demo ? "Presentation mode" : "Live workspace"}
        </span>
        <span className="topbar-avatar" aria-label="Rally Club account">RC</span>
      </div>
    </header>
  );
}
