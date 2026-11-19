"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { KeyRound, Save, Users } from "lucide-react";
import { saveMembershipDiscounts } from "@/app/(workspace)/admin/settings/membership-actions";
import { maxMembershipPrice, type MembershipCourtDiscount, type MembershipOpenPlayDiscount, type MembershipPlan } from "@/lib/membership";
import { parseSettingNumber } from "@/lib/settings-input";
import styles from "./membership-editor.module.css";

function courtDraft(settings: MembershipCourtDiscount | null) {
  return settings && { ...settings, amount: settings.enabled ? String(settings.amountCents / 100) : "" };
}

function openPlayDraft(settings?: MembershipOpenPlayDiscount | null) {
  return settings ? { ...settings, amount: settings.enabled ? String(settings.amountCents / 100) : "",
    floor: settings.enabled ? String(settings.floorCents / 100) : "" } : null;
}

function parseDiscountAmount(amount: string, fallback: number | null) {
  const { value } = parseSettingNumber(amount, { min: 0.01, max: maxMembershipPrice });
  return value == null ? fallback : Math.round(value * 100);
}

export function MembershipDiscountEditor({ plan }: { plan: MembershipPlan }) {
  const [court, setCourt] = useState(() => courtDraft(plan.courtDiscount));
  const [openPlay, setOpenPlay] = useState(() => openPlayDraft(plan.openPlayDiscount));
  const [feedback, setFeedback] = useState<{ error: string } | { message: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const heading = `membership-discounts-${plan.id}`;
  const courtHeading = `${heading}-court`;
  const openPlayHeading = `${heading}-open-play`;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || (!court && !openPlay)) return;
    setFeedback(null);

    let courtSettings: MembershipCourtDiscount | null = null;
    if (court) {
      const amountCents = parseDiscountAmount(court.amount, court.enabled ? null : court.amountCents);
      if (amountCents === null) {
        setFeedback({ error: "Enter a valid private court discount." });
        return;
      }
      courtSettings = { enabled: court.enabled, amountCents, minHours: court.minHours, revision: court.revision };
    }

    let openPlaySettings: MembershipOpenPlayDiscount | null = null;
    if (openPlay) {
      const amountCents = parseDiscountAmount(openPlay.amount, openPlay.enabled ? null : openPlay.amountCents);
      const floorCents = parseDiscountAmount(openPlay.floor, openPlay.enabled ? null : openPlay.floorCents);
      if (amountCents === null || floorCents === null) {
        setFeedback({ error: "Enter a valid open-play discount and minimum discounted price." });
        return;
      }
      openPlaySettings = { enabled: openPlay.enabled, amountCents, floorCents, revision: openPlay.revision };
    }

    startTransition(async () => {
      try {
        const result = await saveMembershipDiscounts(plan.id, { court: courtSettings, openPlay: openPlaySettings });
        if ("error" in result) {
          setFeedback(result);
          return;
        }
        setCourt(courtDraft(result.discounts.court));
        setOpenPlay(openPlayDraft(result.discounts.openPlay));
        setFeedback({ message: "Booking discounts saved." });
      } catch {
        setFeedback({ error: "Booking discounts couldn’t be saved. Please try again." });
      }
    });
  }

  return <section className={`console-panel settings-card ${styles.discounts}`} aria-labelledby={heading}>
    <header className={styles.discountHeader}>
      <h2 id={heading}>Booking discounts</h2>
      <p>Online bookings and linked walk-ins</p>
    </header>

    <form onSubmit={submit} onChange={() => setFeedback(null)} aria-label="Booking discounts" aria-busy={pending}>
      <section className={styles.discountRule} aria-labelledby={courtHeading}>
        <div className={styles.discountIdentity}>
          <span className="settings-card-icon"><KeyRound size={16} aria-hidden="true" /></span>
          <div>
            <h3 id={courtHeading}>Private court</h3>
            <p>Once per eligible booking</p>
            {court && <label className={styles.discountToggle}>
              <input type="checkbox" checked={court.enabled} disabled={pending} aria-label="Enable private court discount"
                onChange={(event) => setCourt({ ...court, enabled: event.target.checked })} /> Enabled
            </label>}
          </div>
        </div>
        {court ? <fieldset className={styles.discountFields} disabled={pending || !court.enabled} aria-labelledby={courtHeading}>
          <DiscountAmountField label="Discount per booking" value={court.amount}
            onChange={(amount) => setCourt({ ...court, amount })} />
          <label className="field"><span>Minimum duration</span>
            <select value={court.minHours} onChange={(event) => setCourt({ ...court, minHours: Number(event.target.value) })}>
              {[1, 2, 3, 4].map((hours) => <option key={hours} value={hours}>{hours} {hours === 1 ? "hour" : "hours"}</option>)}
            </select>
          </label>
        </fieldset> : <p>Apply migration {plan.id === "annual" ? "039" : "041"} to edit the private court discount.</p>}
      </section>

      <section className={styles.discountRule} aria-labelledby={openPlayHeading}>
        <div className={styles.discountIdentity}>
          <span className="settings-card-icon"><Users size={16} aria-hidden="true" /></span>
          <div>
            <h3 id={openPlayHeading}>Open play</h3>
            <p>One member pass per session</p>
            {openPlay && <label className={styles.discountToggle}>
              <input type="checkbox" checked={openPlay.enabled} disabled={pending} aria-label="Enable open-play discount"
                onChange={(event) => setOpenPlay({ ...openPlay, enabled: event.target.checked })} /> Enabled
            </label>}
          </div>
        </div>
        {openPlay ? <fieldset className={styles.discountFields} disabled={pending || !openPlay.enabled} aria-labelledby={openPlayHeading}>
          <DiscountAmountField label="Discount per member pass" value={openPlay.amount}
            onChange={(amount) => setOpenPlay({ ...openPlay, amount })} />
          <DiscountAmountField label="Minimum discounted price" value={openPlay.floor}
            onChange={(floor) => setOpenPlay({ ...openPlay, floor })} help="Lower-priced sessions keep their regular rate." />
        </fieldset> : <p>Apply migration 046 to edit the open-play discount.</p>}
      </section>

      {(court || openPlay) && <footer className={styles.discountFooter}>
        {feedback && ("error" in feedback
          ? <p className="error-message" role="alert">{feedback.error}</p>
          : <p className="success-message" role="status">{feedback.message}</p>)}
        <button className="console-button primary" disabled={pending} type="submit">
          <Save size={16} aria-hidden="true" />{pending ? "Saving…" : "Save discounts"}
        </button>
      </footer>}
    </form>
  </section>;
}

function DiscountAmountField({ label, value, onChange, help }: {
  label: string; value: string; onChange: (value: string) => void; help?: string;
}) {
  const helpId = useId();
  return <label className="field">
    <span>{label}</span>
    <span className={styles.discountMoney}>
      <span aria-hidden="true">₱</span>
      <input required inputMode="decimal" maxLength={9} value={value} aria-label={`${label} in pesos`}
        aria-describedby={help ? helpId : undefined} onChange={(event) => onChange(event.target.value)} />
    </span>
    {help && <small id={helpId}>{help}</small>}
  </label>;
}
