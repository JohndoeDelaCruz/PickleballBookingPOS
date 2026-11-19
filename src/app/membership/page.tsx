import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import { benefitIcons } from "@/components/membership-benefit-icons";
import { getMembershipPlans, getSession, getVenueSettings } from "@/lib/data";
import { money } from "@/lib/booking";
import { membershipApplyPath } from "@/lib/membership-applications";
import { isPublishedMembershipPlan, publishedMembershipDetails } from "@/lib/membership";
import styles from "./membership.module.css";

export const metadata: Metadata = {
  title: "Membership plans",
  description: "Explore venue membership plans, prices, and player benefits.",
};

export default async function MembershipPage() {
  const [plans, venue, { role }] = await Promise.all([getMembershipPlans(), getVenueSettings(), getSession()]);
  const facebook = venue?.facebook_url;
  const publishedPlans = plans.filter(isPublishedMembershipPlan)
    .map((plan) => ({ id: plan.id, details: publishedMembershipDetails(plan) }));
  return (
    <main id="main" className={styles.page}>
      <header className={styles.heading}>
        <h1>Membership plans</h1>
        {(role === "owner" || role === "manager") && (
          <Link href="/admin/settings#venue-membership" className="text-link">
            Edit membership details <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
        )}
      </header>
      {!publishedPlans.length && <p className="notice">Membership plans are currently unavailable.</p>}
      <div className={styles.plans}>
        {publishedPlans.map(({ id, details }) => (
          <section key={id} className={styles.plan} data-annual={id === "annual" || undefined} aria-labelledby={`${id}-membership-price`}>
            <h2 id={`${id}-membership-price`}>{details.plan_name}</h2>
            <p className={styles.price}><strong>{money(details.price_cents / 100)}</strong><span>/ {details.price_period}</span></p>
            {details.price_cents > 0 && <Link href={`${membershipApplyPath}?plan=${id}`} className={`${styles.apply} button button-small button-dark`}
              aria-label={`Apply now for ${details.plan_name}`}>
              Apply now <ArrowUpRight size={16} aria-hidden="true" />
            </Link>}
            <div className={styles.benefits} id={`${id}-membership-benefits`}>
              {details.benefits.length > 0 && <>
                <h3>What’s included</h3>
                <ul role="list">
                  {details.benefits.map(({ icon, title, description }, index) => {
                    const { Icon } = benefitIcons[icon];
                    return <li key={index}>
                      <details className={styles.benefit}>
                        <summary><Icon size={18} aria-hidden="true" /> <span>{title}</span> <ChevronDown size={15} aria-hidden="true" /></summary>
                        <p>{description}</p>
                      </details>
                    </li>;
                  })}
                </ul>
              </>}
            </div>
            <details className={styles.terms}>
              <summary>Plan details <ChevronDown size={16} aria-hidden="true" /></summary>
              <h3 id={`${id}-membership-heading`}>{details.heading}</h3>
              <p>{details.introduction}</p>
              <p>{details.validity}</p>
              <p>{details.redemption}</p>
            </details>
          </section>
        ))}
      </div>
      <div className={styles.help}>
        <p>Questions about enrollment?{" "}
          <a href={facebook || "/#visit"} target={facebook ? "_blank" : undefined} rel={facebook ? "noreferrer" : undefined} className="text-link">
            Contact the venue <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        </p>
        <Link href="/court-rules" className="text-link">Read the court rules <ArrowUpRight size={14} aria-hidden="true" /></Link>
      </div>
    </main>
  );
}
