"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowUpRight, Eye, EyeOff, UserRound } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { authRedirect, safeRedirect } from "@/lib/redirect";
import { readStaffMembership } from "@/lib/session-access";
import { authCallbackUrl } from "@/lib/site-url";
import { captchaOptions, captchaTokenSchema, turnstileSiteKey } from "@/lib/captcha";
import { TurnstileCheck } from "./turnstile-check";

export function AuthForm({
  next,
  recovery = false,
  initialError = "",
}: {
  next?: string;
  recovery?: boolean;
  initialError?: string;
}) {
  const [mode, setMode] = useState<"login" | "signup" | "forgot" | "reset">(
    recovery ? "reset" : "login",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [message, setMessage] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaRevision, setCaptchaRevision] = useState(0);
  const needsCaptcha = mode !== "reset" && Boolean(turnstileSiteKey);
  const router = useRouter();
  const safeNext = safeRedirect(next, "");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (needsCaptcha && !captchaTokenSchema.safeParse(captchaToken).success) {
      setError("Complete the security check before continuing.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const supabase = createClient();
      async function finishSignIn() {
        let staff: boolean;
        try {
          staff = await readStaffMembership(supabase);
        } catch {
          throw new Error(
            "You’re signed in, but we couldn’t load your account access. Please try again.",
          );
        }
        router.replace(authRedirect(next, staff));
        router.refresh();
      }
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
          options: needsCaptcha ? captchaOptions(captchaToken) : undefined,
        });
        if (error) throw error;
        await finishSignIn();
      } else if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            ...(needsCaptcha ? captchaOptions(captchaToken) : {}),
            data: { full_name: name },
            emailRedirectTo: authCallbackUrl(window.location.origin, safeNext),
          },
        });
        if (error) throw error;
        if (data.session) {
          await finishSignIn();
        } else
          setMessage(
            "Check your email to confirm your account, then come back and sign in. If you already have an account, use Log in.",
          );
      } else if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          ...(needsCaptcha ? captchaOptions(captchaToken) : {}),
          redirectTo: authCallbackUrl(
            window.location.origin,
            "/login?recovery=true",
          ),
        });
        if (error) throw error;
        setMessage(
          "If an account exists for that email, we’ve sent a password reset link.",
        );
      } else {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        await finishSignIn();
      }
    } catch (err) {
      setError(
        (err as { code?: string }).code === "captcha_failed"
          ? "The security check couldn’t be verified. Please try again."
          : (err as Error).message || "Something went wrong. Please try again.",
      );
    } finally {
      if (needsCaptcha) {
        setCaptchaToken("");
        setCaptchaRevision((value) => value + 1);
      }
      setBusy(false);
    }
  }
  function changeMode(value: typeof mode) {
    setMode(value);
    setPasswordVisible(false);
    setCaptchaToken("");
    setCaptchaRevision((revision) => revision + 1);
    setError("");
    setMessage("");
  }
  return (
    <form className="auth-form" method="post" onSubmit={submit}>
      <div className="auth-intro">
        <h1>
          {mode === "signup"
            ? "Create an account"
            : mode === "forgot"
              ? "Reset your password"
              : mode === "reset"
                ? "Choose a new password"
                : "Log in"}
        </h1>
        {mode === "forgot" && (
          <p>Enter your email and we’ll send a link to reset your password.</p>
        )}
        {mode !== "reset" && (
          <div className="auth-mode-switch">
            {mode !== "forgot" && (
              <span>{mode === "login" ? "New here?" : "Already have an account?"}</span>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => changeMode(mode === "login" ? "signup" : "login")}
            >
              <UserRound size={16} aria-hidden="true" />
              {mode === "login" ? "Create account" : "Log in"}
            </button>
          </div>
        )}
      </div>
      <div className="auth-fields">
        {mode === "signup" && (
          <label className="field">
            <span>Full name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              name="name"
              autoComplete="name"
              placeholder="Your full name"
              required
              minLength={2}
              maxLength={100}
            />
          </label>
        )}
        {mode !== "reset" && (
          <label className="field">
            <span>Email address</span>
            <input
              type="email"
              name="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="you@example.com"
              required
            />
          </label>
        )}
        {mode !== "forgot" && (
          <div className="field">
            <label htmlFor="auth-password">{mode === "reset" ? "New password" : "Password"}</label>
            <div className="password-input">
              <input
                id="auth-password"
                name="password"
                type={passwordVisible ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                placeholder={mode === "login" ? "Your password" : "At least 8 characters"}
                required
                minLength={mode === "login" ? 1 : 8}
                maxLength={128}
              />
              <button
                type="button"
                aria-label={passwordVisible ? "Hide password" : "Show password"}
                onClick={() => setPasswordVisible((visible) => !visible)}
              >
                {passwordVisible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
              </button>
            </div>
          </div>
        )}
      </div>
      {mode === "login" && (
        <button type="button" className="auth-forgot" disabled={busy} onClick={() => changeMode("forgot")}>
          Forgot password?
        </button>
      )}
      {needsCaptcha && (
        <TurnstileCheck
          key={mode}
          action={mode === "forgot" ? "password_reset" : mode}
          revision={captchaRevision}
          onToken={setCaptchaToken}
        />
      )}
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="success-message" role="status">
          {message}
        </div>
      )}
      <button
        className="button button-lime"
        disabled={busy || (needsCaptcha && !captchaToken)}
      >
        {busy
          ? "One moment…"
          : mode === "signup"
            ? "Create account"
            : mode === "forgot"
              ? "Send reset link"
              : mode === "reset"
                ? "Update password"
                : "Log in"}
        <ArrowUpRight size={18} aria-hidden="true" />
      </button>
      {mode === "signup" && (
        <p className="small-print auth-privacy">
          By creating an account, you agree to our <Link href="/privacy">privacy policy</Link>.
          We use your details to manage your reservations.
        </p>
      )}
    </form>
  );
}
