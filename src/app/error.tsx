"use client";
import Link from "next/link";
export default function ErrorPage({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <main
      id="main"
      className="container content-page"
      style={{ paddingTop: 65 }}
    >
      <div className="empty-state">
        <h2>Let’s try that again.</h2>
        <p>We couldn’t load this page. Please try again in a moment.</p>
        <button className="button button-dark" onClick={reset}>
          Try again
        </button>
        <Link
          href="/"
          className="button button-outline"
          style={{ marginLeft: 12 }}
        >
          Back to home
        </Link>
      </div>
    </main>
  );
}
