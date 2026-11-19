"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, ShoppingBasket, CalendarDays, Package, ReceiptText,
  ChartNoAxesCombined, Settings2, ListOrdered, Wallet, ShieldCheck, IdCard, ShoppingBag,
  type LucideIcon,
} from "lucide-react";
import { workspaceTabs, type WorkspaceTab } from "@/lib/workspace";
import { paddleStackPath } from "@/lib/paddle-stack";
import { expensesPath } from "@/lib/expenses";
import { accountRolesPath } from "@/lib/account-roles";
import { membershipReviewPath } from "@/lib/membership-applications";
import { pickupOrdersPath } from "@/lib/counter-orders";

const icons = {
  overview: LayoutDashboard, pos: ShoppingBasket, bookings: CalendarDays,
  inventory: Package, transactions: ReceiptText, reports: ChartNoAxesCombined,
};
type PageItem = { href: string; label: string; icon: LucideIcon; requires?: "manager" | "access" };
type NavigationGroup = { label: string; items: (PageItem | { tab: WorkspaceTab })[]; standalone?: boolean };

const groups: NavigationGroup[] = [
  { label: "Overview", standalone: true, items: [{ tab: "overview" }] },
  { label: "Courts", items: [
    { href: "/admin", label: "Court calendar", icon: CalendarDays },
    { tab: "bookings" },
    { href: paddleStackPath, label: "Paddle Stack", icon: ListOrdered },
  ] },
  { label: "Front desk", items: [
    { tab: "pos" },
    { href: pickupOrdersPath, label: "Pickup orders", icon: ShoppingBag },
    { tab: "inventory" },
    { href: membershipReviewPath, label: "Memberships", icon: IdCard },
  ] },
  { label: "Finance", items: [
    { tab: "transactions" },
    { href: expensesPath, label: "Expenses", icon: Wallet },
    { tab: "reports" },
    { href: "/admin/finance", label: "Booking finance", icon: ChartNoAxesCombined, requires: "manager" },
  ] },
  { label: "Administration", items: [
    { href: "/admin/settings", label: "Venue settings", icon: Settings2, requires: "manager" },
    { href: accountRolesPath, label: "Access", icon: ShieldCheck, requires: "access" },
  ] },
];

export function WorkspaceNavigation({
  activeTab, onSelect, onNavigate, manager = true, canManageAccess = false, pendingCount = 0, demo = false,
}: {
  activeTab?: WorkspaceTab;
  onSelect?: (tab: WorkspaceTab) => void;
  onNavigate: () => void;
  manager?: boolean;
  canManageAccess?: boolean;
  demo?: boolean;
  pendingCount?: number;
}) {
  const path = usePathname();
  return (
    <>
      {groups.map(({ label, items, standalone }) => {
        const visibleItems = items.filter((item) =>
          "tab" in item || (!demo && (!item.requires || (item.requires === "manager" ? manager : canManageAccess))));
        if (!visibleItems.length) return null;

        return <div className="management-nav-group" key={label}>
          {!standalone && <span className="management-nav-heading">{label}</span>}
          <nav aria-label={label}>
            {visibleItems.map((item) => {
              const tab = "tab" in item ? item.tab : undefined;
              const { href, label, icon: Icon } = "tab" in item ? {
                href: `/staff?tab=${item.tab}`,
                label: workspaceTabs.find(({ id }) => id === item.tab)!.label,
                icon: icons[item.tab],
              } : item;
              const selected = tab ? activeTab === tab : path === href;
              const props = {
                className: selected ? "selected" : "",
                "aria-current": selected ? "page" as const : undefined,
                "aria-label": label,
                title: label,
              };
              const content = <>
                <Icon size={19} aria-hidden="true" />
                <span className="management-label">{label}</span>
                {tab === "bookings" && pendingCount > 0 && <span className="nav-count">{pendingCount}</span>}
              </>;
              return tab && onSelect ? (
                <button key={href} type="button" {...props} onClick={() => onSelect(tab)}>{content}</button>
              ) : (
                <Link key={href} href={href} {...props} onNavigate={onNavigate}>{content}</Link>
              );
            })}
          </nav>
        </div>;
      })}
    </>
  );
}
