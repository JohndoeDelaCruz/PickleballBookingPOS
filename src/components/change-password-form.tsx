"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { changePassword } from "@/app/(workspace)/account/actions";
import { TurnstileCheck } from "./turnstile-check";
import { turnstileSiteKey } from "@/lib/captcha";

const fields = [
  {
    name: "currentPassword",
    label: "Current password",
    autoComplete: "current-password",
  },
  { name: "newPassword", label: "New password", autoComplete: "new-password" },
  {
    name: "confirmPassword",
    label: "Confirm new password",
    autoComplete: "new-password",
  },
] as const;
const emptyPasswords = {
  currentPassword: "",
  newPassword: "",
  confirmPassword: "",
};

export function ChangePasswordForm() {
  const [passwords, setPasswords] = useState(emptyPasswords);
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaRevision, setCaptchaRevision] = useState(0);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (turnstileSiteKey && !captchaToken) {
      setError("Complete the security check before continuing.");
      return;
    }
    setError("");
    setMessage("");
    startTransition(async () => {
      try {
        const result = await changePassword({ ...passwords, captchaToken });
        if (result.error) setError(result.error);
        else {
          setPasswords(emptyPasswords);
          setVisible({});
          setMessage(
            "Your password has been changed. Use your new password the next time you log in.",
          );
          router.refresh();
        }
      } catch {
        setError("We couldn’t change your password. Please try again.");
      } finally {
        setCaptchaToken("");
        setCaptchaRevision((value) => value + 1);
      }
    });
  }

  return (
    <form className="panel form-stack password-form" onSubmit={submit}>
      <div>
        <h2 className="form-section-title">Change password</h2>
        <p className="small-print" id="password-requirements">
          Use at least 8 characters for your new password.
        </p>
      </div>
      <fieldset disabled={pending} className="password-fields">
        {fields.map(({ name, label, autoComplete }) => (
          <div className="field" key={name}>
            <label htmlFor={name}>{label}</label>
            <div className="password-input">
              <input
                id={name}
                name={name}
                type={visible[name] ? "text" : "password"}
                autoComplete={autoComplete}
                value={passwords[name]}
                onChange={(event) =>
                  setPasswords({ ...passwords, [name]: event.target.value })
                }
                minLength={name === "currentPassword" ? 1 : 8}
                maxLength={128}
                aria-describedby={
                  name === "newPassword" ? "password-requirements" : undefined
                }
                required
              />
              <button
                type="button"
                aria-label={`${visible[name] ? "Hide" : "Show"} ${label.toLowerCase()}`}
                aria-pressed={Boolean(visible[name])}
                onClick={() =>
                  setVisible({ ...visible, [name]: !visible[name] })
                }
              >
                {visible[name] ? <EyeOff size={19} /> : <Eye size={19} />}
              </button>
            </div>
          </div>
        ))}
      </fieldset>
      {turnstileSiteKey && <TurnstileCheck
        action="password_change"
        revision={captchaRevision}
        onToken={setCaptchaToken}
      />}
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
        className="button button-dark"
        disabled={pending || Boolean(turnstileSiteKey && !captchaToken)}
      >
        <KeyRound size={18} />{" "}
        {pending ? "Updating password…" : "Update password"}
      </button>
    </form>
  );
}
