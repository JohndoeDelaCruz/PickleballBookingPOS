import { isAuthRetryableFetchError, type User } from "@supabase/supabase-js";

export type WorkspaceRole = "owner" | "manager" | "cashier";
type SessionClient = {
  auth: { getUser(): PromiseLike<{ data: { user: User | null }; error: unknown }> };
  rpc(name: "club_role" | "is_club_staff" | "is_staff"): PromiseLike<{ data: unknown; error: unknown }>;
};

export async function readVerifiedUser(auth: SessionClient["auth"]) {
  const result = await auth.getUser();
  return isAuthRetryableFetchError(result.error) ? auth.getUser() : result;
}

export async function readStaffMembership(client: Pick<SessionClient, "rpc">) {
  const membership = await client.rpc("is_club_staff");
  const result = membership.error ? await client.rpc("is_staff") : membership;
  if (result.error) throw result.error;
  return result.data === true;
}

// Read the current user from Auth, then get membership and role in one RPC.
// React's request-scoped cache in data.ts shares this result across layouts/pages.
export async function readSessionAccess(client: SessionClient): Promise<{
  user: User | null; staff: boolean; role: WorkspaceRole | undefined;
  verificationUnavailable?: true;
  offDuty?: true;
}> {
  const { data: { user }, error } = await readVerifiedUser(client.auth);
  if (isAuthRetryableFetchError(error)) {
    return { user: null, staff: false, role: undefined, verificationUnavailable: true };
  }
  if (error || !user) return { user: null, staff: false, role: undefined };
  const role = await client.rpc("club_role");
  if (!role.error) {
    const value = role.data === "owner" || role.data === "manager" || role.data === "cashier"
      ? role.data : undefined;
    if (value === "cashier") {
      const access = await client.rpc("is_club_staff");
      if (access.error || typeof access.data !== "boolean")
        return { user, staff: false, role: value, verificationUnavailable: true };
      if (!access.data) return { user, staff: false, role: value, offDuty: true };
    }
    return { user, staff: value !== undefined, role: value };
  }
  // Preserve access for databases that have not yet received the POS role RPC.
  const membership = await client.rpc("is_club_staff");
  if (!membership.error) return { user, staff: membership.data === true, role: undefined };
  const legacy = await client.rpc("is_staff");
  return { user, staff: !legacy.error && legacy.data === true, role: undefined };
}
