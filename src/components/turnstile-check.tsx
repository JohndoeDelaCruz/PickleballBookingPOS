"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";
import { turnstileSiteKey } from "@/lib/captcha";

type WidgetSize = "flexible" | "compact";
type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      theme: "light";
      size: WidgetSize;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "timeout-callback": () => void;
      "error-callback": () => void;
      "refresh-expired": "auto";
      "response-field": false;
    },
  ) => string;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export function TurnstileCheck({
  action,
  revision,
  onToken,
}: {
  action: "login" | "signup" | "password_reset" | "password_change";
  revision: number;
  onToken: (token: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [size, setSize] = useState<WidgetSize | null>(null);
  const [retry, setRetry] = useState(0);
  const [status, setStatus] = useState<"loading" | "verified" | "error">(
    "loading",
  );

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () =>
      setSize(element.clientWidth < 300 ? "compact" : "flexible");
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!ready || !size || !container.current || !turnstileSiteKey) return;
    const api = window.turnstile;
    if (!api) {
      setStatus("error");
      onToken("");
      return;
    }
    let active = true;
    let widget: string | undefined;
    onToken("");
    setStatus("loading");
    const invalidate = () => {
      if (active) {
        onToken("");
        setStatus("loading");
      }
    };
    try {
      widget = api.render(container.current, {
        sitekey: turnstileSiteKey,
        action,
        size,
        theme: "light",
        "refresh-expired": "auto",
        "response-field": false,
        callback: (token) => {
          if (active) {
            onToken(token);
            setStatus("verified");
          }
        },
        "expired-callback": invalidate,
        "timeout-callback": invalidate,
        "error-callback": () => {
          if (active) {
            onToken("");
            setStatus("error");
          }
        },
      });
    } catch {
      onToken("");
      setStatus("error");
    }
    return () => {
      active = false;
      if (widget !== undefined) api.remove(widget);
    };
  }, [ready, size, action, revision, retry, onToken]);

  function refresh() {
    onToken("");
    if (window.turnstile) {
      setReady(true);
      setRetry((value) => value + 1);
    } else window.location.reload();
  }

  return (
    <div className="captcha-field">
      <span className="captcha-label">Security check</span>
      {turnstileSiteKey && (
        <Script
          id="cloudflare-turnstile"
          src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
          strategy="afterInteractive"
          onReady={() => setReady(true)}
          onError={() => {
            onToken("");
            setStatus("error");
          }}
        />
      )}
      <div
        ref={container}
        className={`captcha-widget${size === "compact" ? " captcha-widget-compact" : ""}`}
      />
      {!turnstileSiteKey || status === "error" ? (
        <div className="error-message" role="alert">
          The security check couldn’t load. Check your connection and try again.
          <button type="button" className="text-link" onClick={refresh}>
            Refresh security check
          </button>
        </div>
      ) : (
        <p
          className={status === "verified" ? "sr-only" : "small-print"}
          role="status"
        >
          {status === "verified"
            ? "Security check completed."
            : "Waiting for security verification…"}
        </p>
      )}
    </div>
  );
}
