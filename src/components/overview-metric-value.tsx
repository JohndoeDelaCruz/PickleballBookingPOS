"use client";

import { useEffect, useRef } from "react";
import { peso } from "@/lib/pos";

const countFormat = new Intl.NumberFormat("en-PH");
const duration = 620;

export function OverviewMetricValue({ value, currency, animate, trend }: {
  value: number;
  currency?: boolean;
  animate: boolean;
  trend?: { values: number[]; label: string };
}) {
  const number = useRef<HTMLSpanElement>(null);
  const displayed = useRef(0);
  const format = currency ? peso : countFormat.format;
  const formatted = format(value);

  useEffect(() => {
    const node = number.current;
    if (!node || !animate) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const from = displayed.current;
    const started = performance.now();
    let frame = 0;

    function show(amount: number) {
      displayed.current = amount;
      if (node) node.textContent = format(amount);
    }
    function finish() {
      cancelAnimationFrame(frame);
      show(value);
    }
    if (reduced.matches || from === value) show(value);
    else {
      show(from);
      function tick(now: number) {
        const progress = Math.min(1, (now - started) / duration);
        show(Math.round(from + (value - from) * (1 - (1 - progress) ** 3)));
        if (progress < 1) frame = requestAnimationFrame(tick);
      }
      frame = requestAnimationFrame(tick);
    }
    reduced.addEventListener("change", finish);
    return () => {
      cancelAnimationFrame(frame);
      reduced.removeEventListener("change", finish);
    };
  }, [animate, format, value]);

  return <strong className="overview-metric-value">
    <span className="overview-metric-number">
      <span className="sr-only">{formatted}</span>
      <span aria-hidden="true" ref={number}>{formatted}</span>
    </span>
    {trend && trend.values.length > 1 && <Sparkline values={trend.values} label={trend.label} />}
  </strong>;
}

function Sparkline({ values, label }: { values: number[]; label: string }) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const points = values.map((value, i) => [
    3 + (i * 94) / (values.length - 1),
    max === min ? 18 : 30 - ((value - min) * 24) / (max - min),
  ]);
  const path = points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const [lastX, lastY] = points[points.length - 1];
  return <svg className="overview-sparkline" viewBox="0 0 100 36" role="img" aria-label={label}>
    <title>{label}</title>
    <path className="overview-sparkline-fill" d={`M3,34 L${path.replaceAll(" ", " L")} L97,34 Z`} fill="currentColor" />
    <polyline points={path} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx={lastX} cy={lastY} r="2.4" fill="currentColor" />
  </svg>;
}
