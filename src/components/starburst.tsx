import type { SVGProps } from "react";

export function Starburst(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 32 32"
      width="24"
      height="24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        d="M16 2v28M2 16h28M6 6l20 20M6 26 26 6"
        stroke="currentColor"
        strokeWidth="2.4"
      />
    </svg>
  );
}
