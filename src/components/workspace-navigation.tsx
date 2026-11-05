"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, ShoppingBasket, CalendarDays, Package, ReceiptText,
  ChartNoAxesCombined, Settings2, KeyRound,
} from "lucide-react";
import { workspaceTabs, type WorkspaceTab } from "@/lib/workspace";

const icons = {
  overview: LayoutDashboard, pos: ShoppingBasket, bookings: CalendarDays,
  inventory: Package, transactions: ReceiptText, reports: ChartNoAxesCombined,
};
const venueItems = [
  { href: "/admin", label: "Court calendar", icon: CalendarDays },
  { href: "/admin/finance", label: "Booking finance", icon: ChartNoAxesCombined },
  { href: "/admin/settings", label: "Venue settings", icon: Settings2 },
];

export function WorkspaceNavigation({
  activeTab, onSelect, onNavigate, manager = true, demo = false, pendingCount = 0,
}: {
  activeTab?: WorkspaceTab;
  onSelect?: (tab: WorkspaceTab) => void;
  onNavigate: () => void;
  manager?: boolean;
  demo?: boolean;
  pendingCount?: number;
}) {
  const path = usePathname();
  return (
    <>
      <nav aria-label="Club management">
        {workspaceTabs.map(({ id, label }) => {
          const Icon = icons[id];
          const content = <>
            <Icon size={19} aria-hidden="true" />
            <span className="management-label">{label}</span>
            {id === "bookings" && pendingCount > 0 && <span className="nav-count">{pendingCount}</span>}
          </>;
          const props = {
            className: activeTab === id ? "selected" : "",
            "aria-current": activeTab === id ? "page" as const : undefined,
            "aria-label": label,
            title: label,
          };
          return onSelect ? (
            <button key={id} type="button" {...props} onClick={() => onSelect(id)}>{content}</button>
          ) : (
            <Link key={id} {...props} href={`/staff?tab=${id}`} onNavigate={onNavigate}>{content}</Link>
          );
        })}
      </nav>
      {!demo && <>
        <span className="console-kicker management-nav-heading management-section-heading">Your venue</span>
        <nav aria-label="Venue administration">
          {manager && venueItems.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} title={label} aria-label={label}
              className={path === href ? "selected" : ""}
              aria-current={path === href ? "page" : undefined} onNavigate={onNavigate}>
              <Icon size={19} aria-hidden="true" />
              <span className="management-label">{label}</span>
            </Link>
          ))}
          <Link href="/account" title="Account settings" aria-label="Account settings"
            className={path === "/account" ? "selected" : ""}
            aria-current={path === "/account" ? "page" : undefined} onNavigate={onNavigate}>
            <KeyRound size={19} aria-hidden="true" />
            <span className="management-label">Account settings</span>
          </Link>
        </nav>
      </>}
    </>
  );
}
