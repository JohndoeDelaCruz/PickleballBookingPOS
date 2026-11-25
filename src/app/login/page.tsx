import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { getSession, getVenueSettings } from "@/lib/data";
import { authRedirect } from "@/lib/redirect";
import { defaultVenue } from "@/lib/types";

export const metadata: Metadata = { title: "Your account" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    next?: string | string[];
    recovery?: string;
    error?: string;
  }>;
}) {
  const params = await searchParams;
  const recovery = params.recovery === "true";
  const [{ user, staff }, settings] = await Promise.all([
    getSession(),
    getVenueSettings(),
  ]);
  if (user && !recovery && !params.error)
    redirect(authRedirect(params.next, staff));
  const venueName = settings?.name?.trim() || defaultVenue.name;
  const wordmark = (
    <Link href="/" aria-label={`${venueName} home`} className="club-wordmark" title={venueName}>
      <span className="club-wordmark-name">
        {venueName}<span className="wordmark-dot" aria-hidden="true">.</span>
      </span>
    </Link>
  );

  return (
    <main id="main" className="player-entry">
      <div className="auth-visual">
        <div className="auth-visual-photo">
          <Image
            src="/images/rally-detail.webp"
            alt=""
            fill
            sizes="(min-width: 850px) 50vw, 100vw"
            loading="eager"
          />
        </div>
        <div className="auth-visual-brand">{wordmark}</div>
        <p>In good<br />company.</p>
      </div>
      <div className="auth-panel">
        <div className="auth-panel-brand">{wordmark}</div>
        <AuthForm
          next={typeof params.next === "string" ? params.next : undefined}
          recovery={recovery}
          initialError={
            params.error === "access"
              ? "You’re signed in, but we couldn’t load your account access. Please try again."
              : params.error
                ? "That sign-in link couldn’t restore your session. If you confirmed your email, try logging in with your email and password."
                : undefined
          }
        />
        <footer className="auth-panel-footer">
          <span>© {new Date().getFullYear()} {venueName}</span>
          <div>
            <Link href="/book">Browse courts</Link>
            <Link href="/privacy">Privacy policy</Link>
          </div>
        </footer>
      </div>
    </main>
  );
}
