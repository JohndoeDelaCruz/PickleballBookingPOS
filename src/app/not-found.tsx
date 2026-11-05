import Link from "next/link";
export default function NotFound() {
  return (
    <main
      id="main"
      className="container content-page"
      style={{ paddingTop: 65 }}
    >
      <div className="empty-state">
        <span
          className="eyebrow"
          style={{ justifyContent: "center", marginBottom: 15 }}
        >
          OUT OF BOUNDS
        </span>
        <h2>This page missed the court.</h2>
        <p>We couldn’t find that page or reservation.</p>
        <Link href="/" className="button button-dark">
          Back to home
        </Link>
      </div>
    </main>
  );
}
