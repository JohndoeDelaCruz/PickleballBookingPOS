"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { accountRoleLabels, accountRolesPath } from "@/lib/account-roles";
import { getSession } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";

const roleSchema = z.enum(Object.keys(accountRoleLabels));
const changeSchema = z.object({ id: z.uuid(), current: roleSchema, next: roleSchema });

export async function setAccountRole(input: unknown) {
  const parsed = changeSchema.safeParse(input);
  if (!parsed.success) return { error: "Choose a valid account and role." };

  try {
    const { role, verificationUnavailable } = await getSession();
    if (verificationUnavailable) return { error: "Sign-in verification is temporarily unavailable. Try again in a moment." };
    if (role !== "owner" && role !== "manager") return { error: "Manager or owner authorization is required." };

    const db = await createClient();
    const { error } = await db.rpc("admin_set_account_role", {
      p_user_id: parsed.data.id,
      p_expected_role: parsed.data.current,
      p_role: parsed.data.next,
    });
    if (error) return {
      error: error.message.startsWith("Access: ") ? error.message.slice(8) : "The role could not be saved. Refresh Access and try again.",
    };
    revalidatePath(accountRolesPath);
    return { ok: true };
  } catch {
    return { error: "Couldn’t confirm the role change. Refresh Access to check the saved role." };
  }
}
