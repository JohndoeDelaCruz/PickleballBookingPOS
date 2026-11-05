export const workspaceTabs = [
  { id: "overview", label: "Overview" },
  { id: "pos", label: "Point of sale" },
  { id: "bookings", label: "Reservations" },
  { id: "inventory", label: "Inventory" },
  { id: "transactions", label: "Transactions" },
  { id: "reports", label: "Reports" },
] as const;

export type WorkspaceTab = (typeof workspaceTabs)[number]["id"];
export type WorkspaceView = WorkspaceTab | "calendar" | "finance" | "settings" | "account";

export function workspaceTab(value: unknown): WorkspaceTab {
  return workspaceTabs.find((tab) => tab.id === value)?.id ?? "overview";
}

export function workspaceView(path: string, tab?: unknown): WorkspaceView {
  if (path === "/admin/settings") return "settings";
  if (path === "/admin/finance") return "finance";
  if (path.startsWith("/admin")) return "calendar";
  if (path === "/account") return "account";
  return workspaceTab(tab);
}
