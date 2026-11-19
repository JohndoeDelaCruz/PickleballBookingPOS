import { authRedirect } from "./redirect";
import { readStaffMembership } from "./session-access";

export type AuthCallbackClient = {
  auth: {
    exchangeCodeForSession: (
      code: string,
      options?: { flowId?: string },
    ) => PromiseLike<{ error: unknown }>;
  };
  rpc: (name: "is_club_staff" | "is_staff") => PromiseLike<{ data: unknown; error: unknown }>;
};

export async function authCallbackDestination(
  params: URLSearchParams,
  client: AuthCallbackClient,
) {
  const code = params.get("code");
  if (!code) return "/login?error=callback";
  const flowId = params.get("sb_flow_id");
  try {
    const { error } = await client.auth.exchangeCodeForSession(
      code,
      flowId ? { flowId } : undefined,
    );
    if (error) return "/login?error=callback";
  } catch {
    return "/login?error=callback";
  }

  try {
    return authRedirect(params.get("next"), await readStaffMembership(client));
  } catch {
    return "/login?error=access";
  }
}
