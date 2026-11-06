"use client";

import { Menu } from "lucide-react";

export function WorkspaceMenuButton({ menuOpen, onMenuOpen }: {
  menuOpen: boolean;
  onMenuOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="workspace-menu-button"
      aria-label="Open management menu"
      aria-expanded={menuOpen}
      onClick={onMenuOpen}
    >
      <Menu size={20} aria-hidden="true" />
      <span>Menu</span>
    </button>
  );
}
