import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { getSession } from "@/lib/data";
import { authRedirect } from "@/lib/redirect";
export const metadata: Metadata = { title: "Players’ entrance" };
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
  const { user, staff } = await getSession();
  if (user && !recovery && !params.error)
    redirect(authRedirect(params.next, staff));
  return (
    <main id="main" className="player-entry">
      <div className="player-entry-title">
        <span className="editorial-label">PLAYERS’ ENTRANCE / RALLY CLUB</span>
        <h1>In good company.</h1>
        <p>Your reservations. Your next game. All in one place.</p>
      </div>
      <div className="player-entry-form">
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
      </div>
      <div className="player-entry-return">
        <Link href="/book">← Browse the courts</Link>
        <Link href="/demo">Explore the club demo ↗</Link>
      </div>
    </main>
  );
}
