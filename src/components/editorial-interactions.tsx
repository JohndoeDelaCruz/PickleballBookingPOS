"use client";
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
} from "lucide-react";
import { addDays, localDate, money } from "@/lib/booking";
import { Starburst } from "./starburst";

export function ClubMarquee() {
  const section = useRef<HTMLElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = section.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => {
      setInView(entry.isIntersecting);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={section}
      className="club-marquee"
      aria-label="The Rally Club spirit"
      data-paused={!inView}
    >
      <div className="club-marquee-window">
        <div className="club-marquee-track">
          {[0, 1].map((copy) => (
            <div
              className="club-marquee-group"
              key={copy}
              aria-hidden={copy === 1 ? true : undefined}
            >
              {["Good games.", "Great company.", "See you on court."].map((line) => (
                <span className="club-marquee-phrase" key={line}>
                  {line}
                  <Starburst className="club-marquee-star" />
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function ReservationLauncher() {
  const today = localDate();
  return (
    <form
      action="/book"
      method="get"
      className="reservation-launcher"
      data-slide="left"
      aria-label="Plan a court session"
    >
      <div className="launcher-intro">
        <span className="editorial-label">A LITTLE TIME WELL SPENT</span>
        <strong>Meet you on court.</strong>
      </div>
      <label className="launcher-date">
        <span>01 / SESSION DATE</span>
        <input
          aria-label="Session date"
          name="date"
          type="date"
          min={today}
          max={addDays(today, 30)}
          defaultValue={today}
          required
        />
      </label>
      <label className="launcher-mode">
        <span>02 / TYPE OF PLAY</span>
        <select name="play" aria-label="Type of play" defaultValue="court">
          <option value="court">Private court</option>
          <option value="open">Open play</option>
        </select>
        <ChevronDown size={15} />
      </label>
      <button type="submit">
        Find my next game <ArrowUpRight size={21} />
      </button>
    </form>
  );
}

export function PlaySelector({
  courtRate,
  openRate,
  ready,
  scheduleConfigured,
}: {
  courtRate: number;
  openRate: number;
  ready: boolean;
  scheduleConfigured: boolean;
}) {
  const [choice, setChoice] = useState<"court" | "open">("court");
  const id = useId();
  return (
    <section className="play-selector" id="play">
      <div className="play-selector-heading" data-slide="left">
        <span className="editorial-label">01 / MAKE IT YOUR GAME</span>
        <h2>
          There’s more than
          <br />
          one way to <em>play.</em>
        </h2>
        <p>
          Bring the people you know.{" "}
          <br />
          Leave knowing a few more.
        </p>
      </div>
      <div className="play-options" data-slide="right">
        <div className="play-tabs" role="tablist" aria-label="Ways to play">
          {[
            ["court", "01", "Your court. Your crew."],
            ["open", "02", "A game. A few new faces."],
          ].map(([key, n, label]) => (
            <button
              id={`${id}-${key}`}
              key={key}
              type="button"
              role="tab"
              aria-selected={choice === key}
              aria-controls={`${id}-panel`}
              tabIndex={choice === key ? 0 : -1}
              onKeyDown={(e) => {
                if (
                  ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
                ) {
                  e.preventDefault();
                  const next =
                    e.key === "Home"
                      ? "court"
                      : e.key === "End"
                        ? "open"
                        : choice === "court"
                          ? "open"
                          : "court";
                  setChoice(next);
                  document.getElementById(`${id}-${next}`)?.focus();
                }
              }}
              onClick={() => setChoice(key as "court" | "open")}
            >
              <span>{n}</span>
              <strong>{label}</strong>
              <span className="play-tab-mark">
                {choice === key ? <ArrowUpRight size={22} /> : <span>+</span>}
              </span>
            </button>
          ))}
        </div>
        <div
          id={`${id}-panel`}
          role="tabpanel"
          aria-labelledby={`${id}-${choice}`}
          className="play-option-detail"
          key={choice}
        >
          <span className="editorial-label">
            {choice === "court"
              ? "PRIVATE COURT RESERVATION"
              : "SHARED OPEN-PLAY SESSION"}
          </span>
          <h3>
            {choice === "court" ? (
              <>
                A little friendly
                <br />
                <em>competition.</em>
              </>
            ) : (
              <>
                New partners.
                <br />
                <em>Same good feeling.</em>
              </>
            )}
          </h3>
          {choice === "open" && (
            <p>
              Join a shared session, rotate between games, and find your next
              favourite doubles partner. Pick a date to see the sessions.
            </p>
          )}
          <div className="play-detail-bottom">
            <div className={`play-rate${scheduleConfigured ? " is-scheduled" : ""}`}>
              <strong>
                {scheduleConfigured
                  ? "By session"
                  : money(choice === "court" ? courtRate : openRate)}
                {!scheduleConfigured && (
                  <span className="play-rate-unit">
                    {choice === "court" ? " / hour" : " / player"}
                  </span>
                )}
              </strong>
              <span>
                {scheduleConfigured
                  ? "See the calendar for current rates"
                  : choice === "court"
                    ? "Starting rate · per court"
                    : "Per session"}
              </span>
            </div>
            <Link
              className="editorial-text-link"
              href={choice === "court" ? "/book" : "/book?play=open"}
            >
              Let’s play <ArrowUpRight size={20} />
            </Link>
          </div>
          <p className="play-policy">
            <Check size={12} /> 50% reservation fee or full payment · Verified
            by our team
          </p>
          {!ready && (
            <small className="editorial-sample">
              Presentation rates. Final schedules and pricing will be set by the
              venue.
            </small>
          )}
        </div>
      </div>
    </section>
  );
}

const frames = [
  {
    src: "/images/rally-community.webp",
    alt: "Friends catching up after a pickleball game",
    n: "01",
    title: "Good company is part of the game.",
    category: "THE PEOPLE",
    className: "journal-people",
  },
  {
    src: "/images/rally-detail.webp",
    alt: "A pickleball paddle and perforated balls at the edge of a court",
    n: "02",
    title: "The details. The feeling. The game.",
    category: "THE LITTLE THINGS",
    className: "journal-detail",
  },
  {
    src: "/images/rally-courts-v2.webp",
    alt: "Pickleball players in the afternoon sun on blue courts",
    n: "03",
    title: "Your kind of afternoon.",
    category: "THE COURT",
    className: "journal-court",
  },
  {
    src: "/images/rally-paddle-tap.webp",
    alt: "Two friends tapping their paddles above the net after a match",
    n: "04",
    title: "One more game? Always.",
    category: "THE GOOD RALLIES",
    className: "journal-friends",
  },
  {
    src: "/images/rally-refreshments.webp",
    alt: "Cold citrus drinks, a paddle, and a towel on a shaded courtside bench",
    n: "05",
    title: "Stay for the slow moments.",
    category: "THE WIND-DOWN",
    className: "journal-refreshments",
  },
];
export function CourtsideJournal() {
  const section = useRef<HTMLElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const position = useRef(frames.length);
  const step = useRef(0);
  const pointerDown = useRef(false);
  const entered = useRef(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [inView, setInView] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const id = useId();

  // Duplicate strips keep the next image ready at either end. After scrolling
  // settles, move to its identical position in the middle strip invisibly.
  useEffect(() => {
    const el = track.current;
    const root = section.current;
    if (!el || !root) return;
    let settleTimer: ReturnType<typeof setTimeout>;
    const settle = () => {
      if (!step.current || pointerDown.current) return;
      const nearest = Math.round(el.scrollLeft / step.current);
      const real = ((nearest % frames.length) + frames.length) % frames.length;
      position.current = frames.length + real;
      if (nearest < frames.length || nearest >= frames.length * 2) {
        el.scrollTo({ left: position.current * step.current, behavior: "instant" });
      }
    };
    const onScroll = () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(settle, 180);
    };
    const measure = () => {
      const card = el.firstElementChild as HTMLElement | null;
      if (!card) return;
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      step.current = card.getBoundingClientRect().width + gap;
      position.current = frames.length + ((position.current % frames.length) + frames.length) % frames.length;
      el.scrollTo({ left: position.current * step.current, behavior: "instant" });
    };
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReducedMotion(motion.matches);
    updateMotion();
    motion.addEventListener("change", updateMotion);
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    const visibility = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      rootMargin: "180px 0px",
      threshold: 0,
    });
    visibility.observe(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    measure();
    return () => {
      clearTimeout(settleTimer);
      resize.disconnect();
      visibility.disconnect();
      motion.removeEventListener("change", updateMotion);
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  function move(direction: number) {
    const el = track.current;
    if (!el || !step.current) return;
    position.current += direction;
    el.scrollTo({
      left: position.current * step.current,
      behavior: reducedMotion ? "instant" : "smooth",
    });
  }

  useEffect(() => {
    if (!inView) {
      entered.current = false;
      return;
    }
    if (focused || dragging || reducedMotion) return;
    // Begin as the photos approach the screen, rather than waiting a full
    // interval after they appear. Keep the usual interval after interactions.
    if (!entered.current) {
      entered.current = true;
      if (document.visibilityState === "visible") move(1);
    }
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") move(1);
    }, 2500);
    return () => clearInterval(timer);
  }, [inView, focused, dragging, reducedMotion]);

  return (
    <section className="courtside-journal" id="journal" ref={section}
      aria-roledescription="carousel" aria-labelledby={`${id}-heading`}
      onFocusCapture={(event) => setFocused(event.target.matches(":focus-visible"))}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}>
      <div className="journal-heading" data-slide="left">
        <div>
          <span className="editorial-label">03 / THE CLUB, IN FRAME</span>
          <h2 id={`${id}-heading`}>
            Life on the <em>sidelines.</em>
          </h2>
        </div>
        <div className="journal-controls">
          <button
            type="button"
            aria-label="Previous club image"
            aria-controls={`${id}-track`}
            onClick={() => move(-1)}
          >
            <ArrowLeft size={19} />
          </button>
          <button
            type="button"
            aria-label="Next club image"
            aria-controls={`${id}-track`}
            onClick={() => move(1)}
          >
            <ArrowRight size={19} />
          </button>
        </div>
      </div>
      <div
        ref={track}
        id={`${id}-track`}
        className="journal-track"
        data-slide="up"
        data-lenis-prevent
        onPointerDown={() => { pointerDown.current = true; setDragging(true); }}
        onPointerUp={() => { pointerDown.current = false; setDragging(false); }}
        onPointerCancel={() => { pointerDown.current = false; setDragging(false); }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          move(event.key === "ArrowLeft" ? -1 : 1);
        }}
        tabIndex={0}
        role="group"
        aria-label="Courtside photo gallery"
      >
        {[0, 1, 2].flatMap((copy) => frames.map((frame) => (
          <article className={`journal-frame ${frame.className}`} key={`${copy}-${frame.n}`}
            aria-hidden={copy !== 1 ? true : undefined} role="group" aria-roledescription="slide"
            aria-label={frame.category}>
            <div className="journal-image">
              <Image
                src={frame.src}
                alt={copy === 1 ? frame.alt : ""}
                fill
                sizes="(max-width: 700px) 85vw, 43vw"
              />
              <span>{frame.n} / RALLY CLUB</span>
            </div>
            <div className="journal-caption">
              <span>{frame.category}</span>
              <h3>{frame.title}</h3>
              <ArrowUpRight size={20} />
            </div>
          </article>
        )))}
      </div>
    </section>
  );
}
