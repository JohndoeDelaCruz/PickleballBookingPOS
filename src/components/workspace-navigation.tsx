"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, ShoppingBasket, CalendarDays, Package, ReceiptText,
  ChartNoAxesCombined, Settings2,
} from "lucide-react";
import { workspaceTabs, type WorkspaceTab } from "@/lib/workspace";

const icons = {
  overview: LayoutDashboard, pos: ShoppingBasket, bookings: CalendarDays,
  inventory: Package, transactions: ReceiptText, reports: ChartNoAxesCombined,
};
const groups = [
  { label: "Operations", tabs: ["overview", "pos", "bookings", "inventory"] as const,
    page: { href: "/admin", label: "Court calendar", icon: CalendarDays } },
  { label: "Finance", tabs: ["transactions", "reports"] as const,
    page: { href: "/admin/finance", label: "Booking finance", icon: ChartNoAxesCombined } },
  { label: "Settings", tabs: [] as const,
    page: { href: "/admin/settings", label: "Venue settings", icon: Settings2 } },
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
      {groups.map((group) => {
        const tabs = group.tabs.map((id) => workspaceTabs.find((tab) => tab.id === id)!);
        const showPage = !demo && manager;
        if (!tabs.length && !showPage) return null;
        const PageIcon = group.page.icon;
        return <div className={`management-nav-group${group.label === "Settings" ? " management-settings-group" : ""}`} key={group.label}>
        {tabs.length > 0 && <span className="management-nav-heading">{group.label}</span>}
        <nav aria-label={group.label}>
        {tabs.map(({ id, label }) => {
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
        {showPage && <Link href={group.page.href} title={group.page.label} aria-label={group.page.label}
            className={path === group.page.href ? "selected" : ""}
            aria-current={path === group.page.href ? "page" : undefined} onNavigate={onNavigate}>
            <PageIcon size={19} aria-hidden="true" />
            <span className="management-label">{group.page.label}</span>
          </Link>
        }
        </nav>
        </div>;
      })}
    </>
  );
}
