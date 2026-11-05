declare global {
  interface Window {
    __rallyLandingStart?: { pending: boolean; initialized?: boolean };
  }
}

export const LANDING_START_READY = "rally:landing-start-ready";

// Called synchronously by instrumentation-client before React hydration.
// Only a hard reload of the landing page restarts at the hero. Fresh deep
// links, back/forward navigation, and all other routes keep normal behavior.
export function initializeLandingReload() {
  if (window.__rallyLandingStart) return;
  const navigation = performance.getEntriesByType("navigation")[0] as
    PerformanceNavigationTiming | undefined;
  if (window.location.pathname !== "/" || navigation?.type !== "reload") return;

  const previousRestoration = history.scrollRestoration;
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  const state: NonNullable<Window["__rallyLandingStart"]> = { pending: true };
  window.__rallyLandingStart = state;
  if (window.location.hash) {
    history.replaceState(history.state, "", window.location.pathname + window.location.search);
  }
  const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
  const reset = () => {
    if (state.pending) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  };
  const release = () => {
    if (!state.pending) return;
    state.pending = false;
    window.dispatchEvent(new Event(LANDING_START_READY));
  };
  const complete = () => {
    release();
    if (previousRestoration) history.scrollRestoration = previousRestoration;
    inputs.forEach((type) => window.removeEventListener(type, release, true));
    document.removeEventListener("DOMContentLoaded", reset);
    window.removeEventListener("pageshow", settle);
  };
  const settle = (event?: PageTransitionEvent) => {
    if (event?.persisted) { complete(); return; }
    reset();
    requestAnimationFrame(() => {
      reset();
      requestAnimationFrame(complete);
    });
  };
  // User interaction cancels any remaining startup resets immediately.
  inputs.forEach((type) => window.addEventListener(type, release, {
    capture: true, passive: true
  }));
  reset();
  document.addEventListener("DOMContentLoaded", reset, { once: true });
  if (document.readyState === "complete") settle();
  else window.addEventListener("pageshow", settle, { once: true });
}

export function isLandingReloadPending() {
  return window.__rallyLandingStart?.pending === true;
}

export function prepareLandingStart() {
  const startup = window.__rallyLandingStart ??= { pending: false };
  const firstLandingMount = !startup.initialized;
  startup.initialized = true;
  if (isLandingReloadPending()) {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    return;
  }
  // A fresh fragment link can arrive before the streamed section exists.
  // Resolve it once; subsequent visits and history traversal retain their
  // saved position, including when the user left a section at scrollY = 0.
  const navigation = performance.getEntriesByType("navigation")[0] as
    PerformanceNavigationTiming | undefined;
  if (!firstLandingMount || navigation?.type === "back_forward" || !window.location.hash) return;
  let id: string;
  try {
    id = decodeURIComponent(window.location.hash.slice(1));
  } catch {
    return;
  }
  const target = document.getElementById(id);
  if (!target) return;
  const padding = Number.parseFloat(
    getComputedStyle(document.documentElement).scrollPaddingTop,
  ) || 0;
  const margin = Number.parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
  const top = target.getBoundingClientRect().top + window.scrollY - padding - margin;
  window.scrollTo({ top: Math.max(0, top), left: 0, behavior: "instant" });
}
