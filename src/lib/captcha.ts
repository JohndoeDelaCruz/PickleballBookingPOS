import { z } from "zod";

// A Turnstile sitekey is public. The secret key belongs in Supabase Auth settings.
export const defaultTurnstileSiteKey = "";

export function resolveTurnstileSiteKey(override?: string, production = false) {
  const key = override?.trim() || defaultTurnstileSiteKey;
  // Cloudflare's dummy keys are for isolated development/testing only.
  return production && /^[123]x0{18,}/.test(key) ? null : key;
}

export const turnstileSiteKey = resolveTurnstileSiteKey(
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
  process.env.NODE_ENV === "production",
);

export const captchaTokenSchema = z
  .string()
  .trim()
  .min(1, "Complete the security check before continuing.")
  .max(2048, "Please refresh the security check.");

export function captchaOptions(token: unknown) {
  return { captchaToken: captchaTokenSchema.parse(token) };
}
