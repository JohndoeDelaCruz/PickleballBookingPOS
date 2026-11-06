import type { User } from "@supabase/supabase-js";

export type WorkspaceRole = "owner" | "manager" | "cashier";
type SessionClient = {
  auth: { getUser(): PromiseLike<{ data: { user: User | null }; error: unknown }> };
  rpc(name: "club_role" | "is_club_staff" | "is_staff"): PromiseLike<{ data: unknown; error: unknown }>;
};

// Read the current user from Auth, then get membership and role in one RPC.
// React's request-scoped cache in data.ts shares this result across layouts/pages.
export async function readSessionAccess(client: SessionClient): Promise<{
  user: User | null; staff: boolean; role: WorkspaceRole | undefined;
}> {
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) return { user: null, staff: false, role: undefined };
  const role = await client.rpc("club_role");
  if (!role.error) {
    const value = role.data === "owner" || role.data === "manager" || role.data === "cashier"
      ? role.data : undefined;
    return { user, staff: value !== undefined, role: value };
  }
  // Preserve access for databases that have not yet received the POS role RPC.
  const membership = await client.rpc("is_club_staff");
  if (!membership.error) return { user, staff: membership.data === true, role: undefined };
  const legacy = await client.rpc("is_staff");
  return { user, staff: !legacy.error && legacy.data === true, role: undefined };
}
