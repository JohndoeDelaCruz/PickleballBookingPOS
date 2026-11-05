import { z } from "zod";
import { captchaTokenSchema } from "./captcha";

export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password.").max(128),
    newPassword: z
      .string()
      .min(8, "Use at least 8 characters for your new password.")
      .max(128),
    confirmPassword: z.string().min(1, "Confirm your new password.").max(128),
    captchaToken: captchaTokenSchema,
  })
  .superRefine((value, context) => {
    if (value.newPassword !== value.confirmPassword)
      context.addIssue({
        code: "custom",
        path: ["confirmPassword"],
        message: "Your new passwords do not match.",
      });
    if (value.currentPassword === value.newPassword)
      context.addIssue({
        code: "custom",
        path: ["newPassword"],
        message: "Choose a password different from your current password.",
      });
  });

type AuthError = { code?: string; message: string };
export type PasswordAuth = {
  getUser(): Promise<{
    data: { user: { email?: string } | null };
    error: AuthError | null;
  }>;
  signInWithPassword(credentials: {
    email: string;
    password: string;
    options?: { captchaToken?: string };
  }): Promise<{ error: AuthError | null }>;
  updateUser(attributes: {
    password: string;
    current_password: string;
  }): Promise<{ error: AuthError | null }>;
};

export async function changeAccountPassword(
  auth: PasswordAuth,
  input: unknown,
  requireCaptcha = true,
) {
  const candidate = !requireCaptcha && typeof input === "object" && input !== null
    ? { ...input, captchaToken: "project-captcha-not-configured" } : input;
  const parsed = passwordChangeSchema.safeParse(candidate);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const {
      data: { user },
      error: sessionError,
    } = await auth.getUser();
    if (sessionError || !user?.email)
      return {
        error:
          "Your session has expired. Please log in again before changing your password.",
      };

    // Reauthenticate the verified session owner, regardless of the project's password policy.
    // This also refreshes the session for Supabase's secure password-change requirement.
    const { error: currentError } = await auth.signInWithPassword({
      email: user.email,
      password: parsed.data.currentPassword,
      options: requireCaptcha ? { captchaToken: parsed.data.captchaToken } : undefined,
    });
    if (currentError)
      return {
        error:
          currentError.code === "captcha_failed"
            ? "The security check couldn’t be verified. Please try again."
            : currentError.code === "invalid_credentials"
              ? "Your current password is incorrect."
              : "We couldn’t verify your current password. Please try again in a moment.",
      };

    const { error } = await auth.updateUser({
      password: parsed.data.newPassword,
      current_password: parsed.data.currentPassword,
    });
    if (error) {
      if (error.code === "weak_password") return { error: error.message };
      if (error.code === "same_password")
        return {
          error: "Choose a password different from your current password.",
        };
      return { error: "We couldn’t change your password. Please try again." };
    }
    return { success: true as const };
  } catch {
    return {
      error: "We couldn’t reach the account service. Please try again.",
    };
  }
}
