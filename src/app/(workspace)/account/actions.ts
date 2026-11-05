"use server";

import { createClient } from "@/lib/supabase/server";
import { changeAccountPassword } from "@/lib/password";
import { turnstileSiteKey } from "@/lib/captcha";

export async function changePassword(input: unknown) {
  const supabase = await createClient();
  return changeAccountPassword(supabase.auth, input, Boolean(turnstileSiteKey));
}
