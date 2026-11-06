"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowLeft,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Settings2,
  X,
} from "lucide-react";
import { Brand } from "./brand";
import { createClient } from "@/lib/supabase/client";

const preferenceKey = "rally:sidebar-collapsed";

export function ManagementSidebar({
  children,
  mobileOpen,
  onMobileClose,
  demo = false,
  role,
  onReset,
}: {
  children: ReactNode;
  mobileOpen: boolean;
  onMobileClose: () => void;
  demo?: boolean;
  role?: string;
  onReset?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeMobile = useRef(onMobileClose);
  closeMobile.current = onMobileClose;
  const contentId = useId();
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(preferenceKey) === "true");
    } catch {
      // Sidebar controls also work when browser storage is unavailable.
    }
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const mobile = window.matchMedia("(max-width: 650px)");
    if (!mobile.matches) {
      closeMobile.current();
      return;
    }
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const closeOnDesktop = () => {
      if (!mobile.matches) closeMobile.current();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMobile.current();
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(
        sidebar.current?.querySelectorAll<HTMLElement>(
          "a[href], button:not(:disabled)",
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    mobile.addEventListener("change", closeOnDesktop);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", handleKey);
      mobile.removeEventListener("change", closeOnDesktop);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [mobileOpen]);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(preferenceKey, String(next));
    } catch {
      // Keep the control usable without persisting the preference.
    }
  }

  return (
    <>
      {mobileOpen && (
        <button
          className="management-backdrop"
          aria-label="Close management menu"
          tabIndex={-1}
          onClick={onMobileClose}
        />
      )}
      <aside
        ref={sidebar}
        className={`club-sidebar management-sidebar${collapsed ? " is-collapsed" : ""}${mobileOpen ? " sidebar-open" : ""}`}
        aria-label="Management sidebar"
      >
        <div className="management-sidebar-heading">
          <Brand />
          <button
            type="button"
            className="management-collapse-toggle"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            aria-controls={contentId}
            onClick={toggleCollapsed}
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
          <button
            ref={closeButton}
            type="button"
            className="management-close-toggle"
            aria-label="Close management menu"
            onClick={onMobileClose}
          >
            <X size={21} aria-hidden="true" />
          </button>
        </div>
        <div id={contentId} className="management-sidebar-scroll">
          {children}
        </div>
        <div className="management-sidebar-bottom">
          {demo && onReset ? (
            <button className="sidebar-utility" title="Reset sample data" onClick={onReset}>
              <RefreshCw size={17} aria-hidden="true" />
              <span className="management-label">Reset sample data</span>
            </button>
          ) : null}
          <Link href="/" className="sidebar-utility" title="Back to website" onNavigate={onMobileClose}>
            <ArrowLeft size={18} aria-hidden="true" />
            <span className="management-label">Back to website</span>
          </Link>
          {!demo && (
            <button
              className="sidebar-utility"
              title="Sign out"
              onClick={async () => {
                await createClient().auth.signOut();
                router.push("/");
                router.refresh();
              }}
            >
              <LogOut size={17} aria-hidden="true" />
              <span className="management-label">Sign out</span>
            </button>
          )}
          {demo ? <div className="sidebar-profile">
            <span aria-hidden="true">RC</span>
            <div className="management-label"><strong>Demo workspace</strong><small>Sample data</small></div>
          </div> : <Link href="/account" className="sidebar-profile" title="Account settings" aria-current={path === "/account" ? "page" : undefined} onNavigate={onMobileClose}>
            <span aria-hidden="true">RC</span>
            <div className="management-label">
              <strong>{role ?? "Staff"}</strong>
              <small>Account settings</small>
            </div>
            <Settings2 size={16} className="management-label sidebar-account-icon" aria-hidden="true" />
          </Link>}
        </div>
      </aside>
    </>
  );
}
