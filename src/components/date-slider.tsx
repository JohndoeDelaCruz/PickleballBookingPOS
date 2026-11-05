"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addDays, formatDate } from "@/lib/booking";

export function DateSlider({
  today,
  date,
  onChange,
}: {
  today: string;
  date: string;
  onChange: (date: string) => void;
}) {
  const dates = useMemo(
    () => Array.from({ length: 31 }, (_, index) => addDays(today, index)),
    [today],
  );
  const instructionsId = useId();
  const stripRef = useRef<HTMLDivElement>(null);
  const currentDate = useRef(date);
  const changeRef = useRef(onChange);
  const mounted = useRef(false);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    scrollLeft: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  const selectedIndex = dates.indexOf(date);

  useEffect(() => {
    currentDate.current = date;
    changeRef.current = onChange;
  }, [date, onChange]);

  function dateButton(value: string) {
    return stripRef.current?.querySelector<HTMLButtonElement>(
      `[data-date="${value}"]`,
    );
  }

  function nearestDate() {
    const strip = stripRef.current;
    if (!strip) return date;
    const buttons = Array.from(
      strip.querySelectorAll<HTMLButtonElement>("[data-date]"),
    );
    return buttons.reduce((nearest, button) =>
      Math.abs(button.offsetLeft - strip.scrollLeft) <
      Math.abs(nearest.offsetLeft - strip.scrollLeft)
        ? button
        : nearest,
    ).dataset.date!;
  }

  function chooseDate(value: string, focus = false) {
    if (focus) dateButton(value)?.focus({ preventScroll: true });
    onChange(value);
  }

  useEffect(() => {
    const strip = stripRef.current;
    const button = dateButton(date);
    if (!strip || !button) return;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    strip.scrollTo({
      left: button.offsetLeft,
      behavior: !mounted.current || reduceMotion ? "instant" : "smooth",
    });
    mounted.current = true;
  }, [date]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    let settleTimer: ReturnType<typeof setTimeout>;
    function settle() {
      if (drag.current?.moved) return;
      const value = nearestDate();
      if (value !== currentDate.current) changeRef.current(value);
    }
    function onScroll() {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(settle, 160);
    }
    const resizeObserver = new ResizeObserver(() => {
      const button = dateButton(currentDate.current);
      if (button)
        strip!.scrollTo({ left: button.offsetLeft, behavior: "instant" });
    });
    strip.addEventListener("scroll", onScroll, { passive: true });
    resizeObserver.observe(strip);
    return () => {
      clearTimeout(settleTimer);
      strip.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
    };
  }, [dates]);

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    // Touch and pen use the browser's native scrolling and momentum.
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      scrollLeft: event.currentTarget.scrollLeft,
      moved: false,
    };
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const gesture = drag.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (event.buttons !== 1) {
      finishDrag(event);
      return;
    }
    const distance = event.clientX - gesture.startX;
    if (!gesture.moved && Math.abs(distance) < 6) return;
    if (!gesture.moved) {
      gesture.moved = true;
      suppressClick.current = true;
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    event.currentTarget.scrollLeft = gesture.scrollLeft - distance;
  }

  function finishDrag(event: PointerEvent<HTMLDivElement>) {
    const gesture = drag.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (gesture.moved) {
      const value = nearestDate();
      chooseDate(value);
      // Also snap back when a short drag leaves the same date selected.
      const button = dateButton(value);
      if (button) {
        event.currentTarget.scrollTo({
          left: button.offsetLeft,
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "instant"
            : "smooth",
        });
      }
    }
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const offsets: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      PageUp: -7,
      PageDown: 7,
    };
    let index: number;
    if (event.key === "Home") index = 0;
    else if (event.key === "End") index = dates.length - 1;
    else if (event.key in offsets) index = selectedIndex + offsets[event.key];
    else return;
    event.preventDefault();
    chooseDate(dates[Math.max(0, Math.min(dates.length - 1, index))], true);
  }

  return (
    <div className="date-slider">
      <p className="sr-only" id={instructionsId}>
        Drag or swipe to choose a date. Use the left and right arrow keys to
        change days, or Page Up and Page Down to change weeks.
      </p>
      <button
        type="button"
        className="icon-button date-slider-arrow"
        aria-label="Previous day"
        disabled={selectedIndex === 0}
        onClick={() => chooseDate(dates[selectedIndex - 1])}
      >
        <ChevronLeft size={17} />
      </button>
      <div className="date-slider-viewport">
        <div
          ref={stripRef}
          className={`date-strip${dragging ? " is-dragging" : ""}`}
          role="group"
          aria-label="Choose a booking date"
          aria-describedby={instructionsId}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onLostPointerCapture={finishDrag}
          onKeyDown={onKeyDown}
          onClickCapture={(event) => {
            if (suppressClick.current) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        >
          {dates.map((value) => (
            <button
              type="button"
              className={`date-button${value === date ? " active" : ""}`}
              key={value}
              data-date={value}
              onClick={() => chooseDate(value)}
              aria-label={formatDate(value, {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
              aria-pressed={value === date}
              tabIndex={value === date ? 0 : -1}
            >
              <span>{formatDate(value, { weekday: "short" })}</span>
              <strong>{formatDate(value, { day: "numeric" })}</strong>
            </button>
          ))}
        </div>
      </div>
      <button
        type="button"
        className="icon-button date-slider-arrow"
        aria-label="Next day"
        disabled={selectedIndex === dates.length - 1}
        onClick={() => chooseDate(dates[selectedIndex + 1])}
      >
        <ChevronRight size={17} />
      </button>
    </div>
  );
}
