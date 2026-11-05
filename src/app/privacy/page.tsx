import type { Metadata } from "next";
import { getVenue } from "@/lib/data";
export const metadata: Metadata = { title: "Privacy policy" };
export default async function Privacy() {
  const { venue } = await getVenue();
  return (
    <main id="main" className="container content-page narrow">
      <div className="page-heading">
        <span className="eyebrow">YOUR DETAILS, HANDLED WITH CARE</span>
        <h1>PRIVACY POLICY.</h1>
        <p>
          How Rally Club uses information you share through this website.
        </p>
      </div>
      <div className="prose">
        <h2>Information we collect</h2>
        <p>
          When you create an account, we collect your email address and name.
          When you reserve a court, we also collect your mobile number,
          reservation details, and any GCash payment reference you submit. Staff
          also records payment methods, worker names, and operational notes for
          the venue’s private daily logs and finance reports.
        </p>
        <h2>How we use your information</h2>
        <p>
          We use these details to manage accounts, reserve court time, verify
          payments, provide booking updates, and respond to questions. Payment
          records also support staff sales reports and recordkeeping. Payment
          verification is performed by venue staff. The website does not collect
          card information, GCash PINs, or one-time passwords.
        </p>
        <h2>Storage and access</h2>
        <p>
          Account and booking information is stored using Supabase. You can
          access your own reservations. Authorized venue staff can access
          reservation details to operate the courts and verify payments. Session
          cookies keep you signed in.
        </p>
        <h2>Your choices</h2>
        <p>
          You can request access to, correction of, or deletion of your account
          information by contacting Rally staff. Some reservation or payment
          records may need to be retained for operational or recordkeeping
          purposes.
        </p>
        <h2>Contact</h2>
        <p>
          {venue.email ? (
            <>
              For privacy questions and account requests, email{" "}
              <a
                href={`mailto:${venue.email}`}
                style={{ textDecoration: "underline" }}
              >
                {venue.email}
              </a>
              .
            </>
          ) : (
            "Please contact Rally staff directly for privacy questions or account requests. Contact details will be added here before reservations open."
          )}
        </p>
      </div>
    </main>
  );
}
