import { authRedirect } from "./redirect";

export type AuthCallbackClient = {
  auth: {
    exchangeCodeForSession: (
      code: string,
      options?: { flowId?: string },
    ) => PromiseLike<{ error: unknown }>;
  };
  rpc: (name: "is_club_staff") => PromiseLike<{ data: unknown; error: unknown }>;
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
    const { data: staff, error } = await client.rpc("is_club_staff");
    if (error) return "/login?error=access";
    return authRedirect(params.get("next"), staff === true);
  } catch {
    return "/login?error=access";
  }
}
