"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowUpRight, ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { authRedirect, safeRedirect } from "@/lib/redirect";
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
        const { data: staff, error } = await supabase.rpc("is_club_staff");
        if (error)
          throw new Error(
            "You’re signed in, but we couldn’t load your account access. Please try again.",
          );
        router.replace(authRedirect(next, staff === true));
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
    setCaptchaToken("");
    setCaptchaRevision((revision) => revision + 1);
    setError("");
    setMessage("");
  }
  return (
    <div className="auth-form">
      <div className="auth-intro">
        <span className="eyebrow">YOUR NEXT SESSION STARTS HERE</span>
        <h2>
          {mode === "signup"
            ? "Join the club."
            : mode === "forgot"
              ? "Reset your password."
              : mode === "reset"
                ? "A fresh start."
                : "Welcome back."}
        </h2>
        <p>
          {mode === "signup"
            ? "Create your account and make room for more court time."
            : mode === "forgot"
              ? "Enter your email and we’ll send a link to reset your password."
              : mode === "reset"
                ? "Choose a new password for your Rally account."
                : "Log in to reserve a court and keep track of your next game."}
        </p>
      </div>
      <div className="auth-tabs">
        {(mode === "login" || mode === "signup") && (
          <>
            <button
              className={mode === "login" ? "active" : ""}
              disabled={busy}
              onClick={() => changeMode("login")}
            >
              Log in
            </button>
            <button
              className={mode === "signup" ? "active" : ""}
              disabled={busy}
              onClick={() => changeMode("signup")}
            >
              Create account
            </button>
          </>
        )}
      </div>
      <form className="auth-fields-form" onSubmit={submit}>
        <div className="auth-fields">
          {mode === "signup" && (
            <label className="field">
              <span>Full name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
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
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                placeholder="you@example.com"
                required
              />
            </label>
          )}
          {mode !== "forgot" && (
            <label className="field">
              <span>{mode === "reset" ? "New password" : "Password"}</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
                placeholder={
                  mode === "signup" ? "At least 8 characters" : "Your password"
                }
                required
                minLength={mode === "login" ? 1 : 8}
                maxLength={128}
              />
            </label>
          )}
        </div>
        {needsCaptcha && (
          <TurnstileCheck
            key={mode}
            action={mode === "forgot" ? "password_reset" : mode}
            revision={captchaRevision}
            onToken={setCaptchaToken}
          />
        )}
        <div className="auth-feedback">
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
        </div>
        <button
          className="button button-dark"
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
                  : "Let’s play"}
          <ArrowUpRight size={18} />
        </button>
      </form>
      <div className="auth-bottom">
        <Link href="/book">
          <ArrowLeft size={12} style={{ display: "inline", marginRight: 5 }} />
          Browse courts
        </Link>
        {mode === "login" ? (
          <button onClick={() => changeMode("forgot")}>Forgot password?</button>
        ) : (
          mode === "forgot" && (
            <button onClick={() => changeMode("login")}>Back to log in</button>
          )
        )}
      </div>
      <div className="auth-privacy">
        {mode === "signup" && (
          <p className="small-print">
            By creating an account, you agree to our{" "}
            <Link href="/privacy" style={{ textDecoration: "underline" }}>
              privacy policy
            </Link>
            . We use your details to manage your reservations.
          </p>
        )}
      </div>
    </div>
  );
}
