import Lenis from "lenis";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

/** Eased document scrolling, scoped to the public landing page. */
export function createLandingSmoothScroll() {
  const lenis = new Lenis({
    lerp: 0.085,
    smoothWheel: true,
    syncTouch: false,
    autoRaf: false,
    respectReducedMotion: true,
    // Next links and plain anchors share the handler below, without a native
    // hash jump competing with the animated scroll.
    anchors: false,
    prevent: (node) => node.classList.contains("club-mobile-links"),
    virtualScroll: ({ deltaX, deltaY, event }) =>
      !event.shiftKey && Math.abs(deltaY) >= Math.abs(deltaX),
  });
  const update = () => ScrollTrigger.update();
  const tick = (time: number) => lenis.raf(time * 1000);
  lenis.on("scroll", update);
  gsap.ticker.lagSmoothing(0);
  gsap.ticker.add(tick);

  let focusTarget: HTMLElement | null = null;
  const releaseFocusTarget = () => {
    if (!focusTarget) return;
    focusTarget.removeEventListener("blur", releaseFocusTarget);
    focusTarget.removeAttribute("tabindex");
    focusTarget = null;
  };
  const interrupt = () => lenis.scrollTo(window.scrollY, { immediate: true });
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      (event.target instanceof Element &&
        event.target.closest(
          "input, select, textarea, button, [contenteditable], [role='tab']",
        ))
    ) {
      return;
    }
    if (
      ["Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", " "].includes(event.key)
    ) {
      interrupt();
    }
  };
  const onClick = (event: MouseEvent) => {
    if (
      event.defaultPrevented || event.button !== 0 ||
      event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
    ) {
      return;
    }
    const link = event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>("a[href]")
      : null;
    if (
      !link || link.hasAttribute("download") ||
      (link.target && link.target !== "_self")
    ) {
      return;
    }
    const url = new URL(link.href);
    if (url.origin !== window.location.origin) return;
    if (
      url.pathname !== window.location.pathname ||
      url.search !== window.location.search || !url.hash
    ) {
      interrupt();
      return;
    }
    let id: string;
    try {
      id = decodeURIComponent(url.hash.slice(1));
    } catch {
      return;
    }
    const target = document.getElementById(id);
    if (!target) return;
    event.preventDefault();
    if (window.location.hash !== url.hash) {
      window.history.pushState(null, "", url.hash);
    }
    // Lenis reads scroll-padding and scroll-margin, including the sticky header.
    lenis.scrollTo(target, {
      lerp: 0,
      duration: 1.1,
      easing: (t) => 1 - Math.pow(1 - t, 4),
      onComplete: () => {
        if (!target.isConnected) return;
        releaseFocusTarget();
        if (!target.hasAttribute("tabindex")) {
          target.setAttribute("tabindex", "-1");
          focusTarget = target;
          target.addEventListener("blur", releaseFocusTarget, { once: true });
        }
        target.focus({ preventScroll: true });
      },
    });
  };
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("focusin", interrupt);
  window.addEventListener("popstate", interrupt);

  return () => {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("focusin", interrupt);
    window.removeEventListener("popstate", interrupt);
    releaseFocusTarget();
    gsap.ticker.remove(tick);
    lenis.off("scroll", update);
    lenis.destroy();
    gsap.ticker.lagSmoothing(500, 33);
  };
}
