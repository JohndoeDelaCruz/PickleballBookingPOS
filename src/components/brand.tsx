import Link from "next/link";

export function Brand({
  light = false,
  compact = false,
}: {
  light?: boolean;
  compact?: boolean;
}) {
  return (
    <Link
      href="/"
      className={`brand rally-brand ${light ? "brand-light" : ""} ${compact ? "brand-compact" : ""}`}
      aria-label="Rally Club home"
    >
      <svg className="rally-symbol" viewBox="0 0 32 32" aria-hidden="true">
        <path
          d="M3 5h15q9 0 9 8 0 5-5 7l7 8H18l-8-10v10H3z"
          fill="currentColor"
        />
        <path d="M10 11h7q3 0 3 2t-3 2h-7z" fill="var(--cream)" />
      </svg>
      <span>
        rally.<span className="brand-subtitle">PICKLEBALL SOCIAL CLUB</span>
      </span>
    </Link>
  );
}
