import { createClient } from "./supabase/server";
import type { RegisterDay } from "./register";

export async function getRegisterDay(date: string): Promise<RegisterDay | null> {
  try {
    const db = await createClient();
    const { data, error } = await db.rpc("pos_register_day", { p_date: date });
    return error ? null : data as RegisterDay | null;
  } catch {
    return null;
  }
}
