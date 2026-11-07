"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUp, ArrowUpRight } from "lucide-react";

export function Footer({ staff = false }: { staff?: boolean }) {
  const path = usePathname();
  if (path === "/login" || path.startsWith("/demo") || path.startsWith("/staff") || path.startsWith("/admin") || (path === "/account" && staff)) return null;
  return (
    <footer className="club-footer">
      <div className="club-footer-upper">
        <p>
          A little less online.
          <br />A little more on court.
        </p>
        <div>
          <Link href="/book">
            Make a reservation <ArrowUpRight size={17} />
          </Link>
          <Link href="/court-rules">
            Before you play <ArrowUpRight size={17} />
          </Link>
          <Link href="/demo">
            Explore the management demo <ArrowUpRight size={17} />
          </Link>
        </div>
        <span className="footer-club-label">
          PICKLEBALL.
          <br />
          PEOPLE.
          <br />
          POSSIBILITIES.
        </span>
      </div>
      <Link href="/" className="footer-masthead" aria-label="Rally Club home">
        rally<span><ArrowUpRight aria-hidden="true" focusable="false" strokeWidth={1.5} /></span>
        <i>
          PLAY IS A<br />
          GOOD IDEA.
        </i>
      </Link>
      <div className="club-footer-bottom">
        <span>© {new Date().getFullYear()} RALLY CLUB</span>
        <div>
          <Link href="/privacy">Privacy</Link>
          <Link href="/staff">Staff access</Link>
          <a href="#main">Back to top <ArrowUp size={14} aria-hidden="true" focusable="false" /></a>
        </div>
      </div>
    </footer>
  );
}
