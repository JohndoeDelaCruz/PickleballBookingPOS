"use client";

import { useEffect, useState } from "react";

// Keep the dialog mounted through the CSS exit animation in globals.css.
const exitDuration = 180;

export function useAnimatedModal<T>() {
  const [state, setState] = useState<{ value: T; closing: boolean } | null>(null);

  useEffect(() => {
    if (!state?.closing) return;
    const timer = window.setTimeout(() => {
      setState((current) => current === state ? null : current);
    }, exitDuration);
    return () => window.clearTimeout(timer);
  }, [state]);

  function setValue(value: T | null) {
    if (value !== null) {
      setState({ value, closing: false });
    } else if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setState(null);
    } else {
      setState((current) => current && !current.closing ? { ...current, closing: true } : current);
    }
  }

  return [state?.value ?? null, setValue, state?.closing ?? false] as const;
}
