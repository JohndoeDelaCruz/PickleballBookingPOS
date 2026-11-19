import { paddleStackPath } from "./paddle-stack";
import { expensesPath } from "./expenses";
import { accountRolesPath } from "./account-roles";
import { membershipReviewPath } from "./membership-applications";
import { pickupOrdersPath } from "./counter-orders";

export const workspaceTabs = [
  { id: "overview", label: "Overview" },
  { id: "pos", label: "Point of sale" },
  { id: "bookings", label: "Reservations" },
  { id: "inventory", label: "Inventory" },
  { id: "transactions", label: "Transactions" },
  { id: "reports", label: "Collections report" },
] as const;

export type WorkspaceTab = (typeof workspaceTabs)[number]["id"];
export type WorkspaceView = WorkspaceTab | "calendar" | "finance" | "expenses" | "settings" | "account" | "access" | "memberships";

export function isWorkspacePath(path: string) {
  return path === "/staff" || path === paddleStackPath || path === expensesPath || path === membershipReviewPath || path === pickupOrdersPath || path === "/admin" || path.startsWith("/admin/") || path === "/account";
}

export function workspaceTab(value: unknown): WorkspaceTab {
  return workspaceTabs.find((tab) => tab.id === value)?.id ?? "overview";
}

export function reservationsForDateHref(date: string, reference?: string) {
  const query = new URLSearchParams({ tab: "bookings", date, scope: "day" });
  if (reference) query.set("q", reference);
  return `/staff?${query}`;
}

export function workspaceView(path: string, tab?: unknown): WorkspaceView {
  if (path === "/admin/settings") return "settings";
  if (path === "/admin/finance") return "finance";
  if (path === expensesPath) return "expenses";
  if (path === membershipReviewPath) return "memberships";
  if (path === accountRolesPath) return "access";
  if (path.startsWith("/admin")) return "calendar";
  if (path === "/account") return "account";
  return workspaceTab(tab);
}
