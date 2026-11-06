"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowUpRight, LogOut, Menu, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { isLandingReloadPending, LANDING_START_READY } from "@/lib/landing-startup";

export function Header({
  signedIn,
  staff,
}: {
  signedIn: boolean;
  staff: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const menuButton = useRef<HTMLButtonElement>(null);
  const header = useRef<HTMLElement>(null);
  const landing = pathname === "/";
  const [tone, setTone] = useState({ solid: false, overDark: true });
  useEffect(() => {
    setOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!landing) return;
    let lastY = window.scrollY;
    let solid = !isLandingReloadPending() && lastY > 12;
    let frame = 0;
    const update = () => {
      frame = 0;
      const y = Math.max(0, window.scrollY);
      const delta = y - lastY;
      const starting = isLandingReloadPending();
      if (starting || y <= 12) {
        solid = false;
        lastY = starting ? 0 : y;
      } else if (Math.abs(delta) >= 6) {
        solid = delta > 0;
        lastY = y;
      }
      const sampleY = (header.current?.offsetHeight ?? 88) / 2;
      const sections = document.querySelectorAll(
        ".club-hero, .club-manifesto, .club-footer",
      );
      const overDark = starting || Array.from(sections).some((section) => {
        const rect = section.getBoundingClientRect();
        return rect.top <= sampleY && rect.bottom > sampleY;
      });
      setTone((previous) =>
        previous.solid === solid && previous.overDark === overDark
          ? previous
          : { solid, overDark },
      );
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener(LANDING_START_READY, schedule);
    // The streamed hero can arrive after this persistent header mounts.
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true });
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener(LANDING_START_READY, schedule);
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [landing]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open]);
  if (pathname.startsWith("/demo") || pathname.startsWith("/staff") || pathname.startsWith("/admin") || (pathname === "/account" && staff))
    return null;
  if (pathname === "/login") return (
    <header className="club-header club-header-auth">
      <Link href="/" aria-label="Rally Club home" className="club-wordmark">
        rally<span className="wordmark-dot">.</span>
        <small>PICKLEBALL<br />SOCIAL CLUB</small>
      </Link>
      <Link className="auth-header-link" href="/book">
        Browse courts <ArrowUpRight size={16} aria-hidden="true" />
      </Link>
    </header>
  );
  const links = [
    { href: "/#play", label: "The game" },
    { href: "/#club", label: "The club" },
    { href: "/#journal", label: "Courtside" },
  ];
  const account = staff ? "/staff" : signedIn ? "/my-bookings" : "/login";
  async function signOut() {
    await createClient().auth.signOut();
    setOpen(false);
    router.push("/");
    router.refresh();
  }
  return (
    <header
      ref={header}
      className={`club-header${landing ? " club-header-home" : ""}`}
      data-surface={
        !landing || open || tone.solid
          ? "solid"
          : tone.overDark ? "transparent-light" : "transparent-dark"
      }
    >
      <Link href="/" aria-label="Rally Club home" className="club-wordmark">
        rally<span className="wordmark-dot">.</span>
        <small>
          PICKLEBALL
          <br />
          SOCIAL CLUB
        </small>
      </Link>
      <nav className="club-desktop-links" aria-label="Main navigation">
        {links.map((l) => (
          <Link key={l.href} href={l.href}>
            {l.label}
          </Link>
        ))}
      </nav>
      <div className="club-header-actions">
        <Link className="club-account-link" href={account}>
          {staff ? "Workspace" : signedIn ? "My bookings" : "Player login"}
        </Link>
        {signedIn && (
          <button
            className="club-signout"
            aria-label="Sign out"
            title="Sign out"
            onClick={signOut}
          >
            <LogOut size={16} />
          </button>
        )}
        <Link className="club-reserve-link club-reserve-desktop" href="/book">
          Reserve a court <ArrowUpRight size={16} />
        </Link>
        <Link className="club-reserve-link club-mobile-account-link" href={account}>
          {staff ? "Workspace" : signedIn ? "My bookings" : "Login"}
          <ArrowUpRight size={16} aria-hidden="true" />
        </Link>
        <button
          ref={menuButton}
          className="club-menu-toggle"
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          aria-controls="club-mobile-links"
          onClick={() => setOpen(!open)}
        >
          {open ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>
      {open && (
        <nav
          id="club-mobile-links"
          className="club-mobile-links"
          aria-label="Mobile navigation"
        >
          {links.map((l, i) => (
            <Link key={l.href} href={l.href} onClick={() => setOpen(false)}>
              <span>0{i + 1}</span>
              {l.label}
              <ArrowUpRight size={22} />
            </Link>
          ))}
          <Link href={account} onClick={() => setOpen(false)}>
            <span>04</span>
            {staff ? "Workspace" : signedIn ? "My bookings" : "Login"}
            <ArrowUpRight size={22} />
          </Link>
          <Link
            className="mobile-reserve"
            href="/book"
            onClick={() => setOpen(false)}
          >
            Your next game starts here <ArrowUpRight size={22} />
          </Link>
          {signedIn && (
            <button onClick={signOut}>
              <LogOut size={15} />
              Sign out
            </button>
          )}
        </nav>
      )}
    </header>
  );
}
