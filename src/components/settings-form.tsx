"use client";
import { useEffect, useRef, useState, useTransition, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import { Check, Save, Upload, Building2, Package, QrCode, ShieldCheck, CalendarDays, ArrowUpRight } from "lucide-react";
import { saveVenueSetting, saveSettings } from "@/app/actions";
import { createClient } from "@/lib/supabase/client";
import {
  canBook,
  equipmentPackageLabel,
  openPlayCapacityLabel,
} from "@/lib/booking";
import type { VenueSettings } from "@/lib/types";
import { TypedSettingField } from "./typed-setting-field";
import { ScheduleEditor } from "./schedule-editor";
import { CourtManager } from "./court-manager";
import { activeCourts, defaultCourts } from "@/lib/courts";
import type { IndividualSettingKey } from "@/lib/venue-setting";
import { WorkspacePageHeading } from "./workspace-page-heading";
import { WorkspaceTabs } from "./workspace-tabs";

const sections = [
  { id: "details", label: "Venue details" },
  { id: "courts", label: "Courts" },
  { id: "schedule", label: "Hours & rates" },
  { id: "payments", label: "Payments" },
  { id: "equipment", label: "Rentals & limits" },
  { id: "policy", label: "Booking rules" },
] as const;
type SettingsSection = (typeof sections)[number]["id"];

type SettingFieldOptions = Pick<
  ComponentProps<typeof TypedSettingField>,
  "label" | "kind" | "min" | "max" | "optional" | "hint" | "placeholder"
>;
type FieldFeedback = { error?: string; message?: string };

export function SettingsForm({ initial, courtsReady = false }: { initial: VenueSettings; courtsReady?: boolean }) {
  const [venue, setVenue] = useState(initial);
  const [section, setSection] = useState<SettingsSection>("details");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [uploading, setUploading] = useState(false);
  const [pending, startTransition] = useTransition();
  const [fieldPending, startFieldTransition] = useTransition();
  const [applyingField, setApplyingField] =
    useState<IndividualSettingKey | null>(null);
  const [fieldFeedback, setFieldFeedback] = useState<
    Partial<Record<IndividualSettingKey, FieldFeedback>>
  >({});
  const fieldInputs = useRef<
    Partial<Record<IndividualSettingKey, HTMLInputElement | null>>
  >({});
  const router = useRouter();
  useEffect(() => {
    const syncSection = () => {
      const next = sections.find((item) => `#venue-${item.id}` === window.location.hash);
      setSection(next?.id ?? "details");
    };
    syncSection();
    window.addEventListener("hashchange", syncSection);
    return () => window.removeEventListener("hashchange", syncSection);
  }, []);
  function selectSection(next: SettingsSection) {
    setSection(next);
    const url = new URL(window.location.href);
    url.hash = `venue-${next}`;
    window.history.replaceState(null, "", url);
  }
  function update<K extends keyof VenueSettings>(
    key: K,
    value: VenueSettings[K],
  ) {
    setVenue((old) => ({ ...old, [key]: value }));
    setDirty(true);
    setMessage("");
  }
  async function upload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    setMessage("");
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 2 * 1024 * 1024
    ) {
      setError("Choose a PNG, JPEG, or WebP image up to 2 MB.");
      return;
    }
    setUploading(true);
    try {
      const supabase = createClient();
      const extension =
        file.type === "image/png"
          ? "png"
          : file.type === "image/jpeg"
            ? "jpg"
            : "webp";
      const path = `gcash/${crypto.randomUUID()}.${extension}`;
      const { error } = await supabase.storage
        .from("venue-assets")
        .upload(path, file, { contentType: file.type, upsert: false });
      if (error) throw error;
      const { data } = supabase.storage.from("venue-assets").getPublicUrl(path);
      update("gcash_qr_url", data.publicUrl);
      setMessage("QR uploaded. Save your settings to publish it.");
    } catch {
      setError(
        "We couldn’t upload the QR. Please try again, or paste a direct https:// image URL.",
      );
    } finally {
      setUploading(false);
    }
  }
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || fieldPending || uploading) return;
    // Hidden panels stay mounted to preserve drafts. Reveal invalid fields before
    // asking the browser to focus them, including fields on a different tab.
    const invalid = Array.from(event.currentTarget.elements).find((field) =>
      (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)
      && field.willValidate && !field.validity.valid,
    ) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined;
    if (invalid) {
      const target = invalid.closest<HTMLElement>("[data-settings-section]")?.dataset.settingsSection;
      if (sections.some((item) => item.id === target)) flushSync(() => selectSection(target as SettingsSection));
      invalid.reportValidity();
      return;
    }
    setError("");
    setMessage("");
    startTransition(async () => {
      const result = await saveSettings(venue);
      if (result.error) setError(result.error);
      else {
        setFieldFeedback({});
        setDirty(false);
        setMessage("Settings saved. Your website is up to date.");
        router.refresh();
      }
    });
  }
  function applyField(key: IndividualSettingKey) {
    if (
      pending ||
      fieldPending ||
      uploading ||
      !fieldInputs.current[key]?.reportValidity()
    )
      return;
    const value = venue[key];
    setApplyingField(key);
    setFieldFeedback((old) => ({ ...old, [key]: {} }));
    startFieldTransition(async () => {
      try {
        const result = await saveVenueSetting(key, value);
        if (result.error)
          setFieldFeedback((old) => ({
            ...old,
            [key]: { error: result.error },
          }));
        else
          setFieldFeedback((old) => ({
            ...old,
            [key]: {
              message:
                key === "open_play_capacity"
                  ? `Player limit applied. ${openPlayCapacityLabel(value)}.`
                  : "Applied.",
            },
          }));
      } catch {
        setFieldFeedback((old) => ({
          ...old,
          [key]: {
            error: "This setting could not be applied. Please try again.",
          },
        }));
      } finally {
        setApplyingField(null);
      }
    });
  }
  function numericField(
    key: IndividualSettingKey,
    options: SettingFieldOptions,
  ) {
    if (options.kind === "hour")
      return (
        <TypedSettingField
          key={key}
          {...options}
          value={venue[key]}
          disabled={pending || fieldPending}
          onChange={(value) => update(key, value)}
        />
      );
    const feedback = fieldFeedback[key];
    return (
      <div
        key={key}
        className="applicable-setting"
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            applyField(key);
          }
        }}
      >
        <TypedSettingField
          {...options}
          value={venue[key]}
          inputRef={(input) => {
            fieldInputs.current[key] = input;
          }}
          disabled={pending || fieldPending}
          onDraftChange={() => {
            setDirty(true);
            setFieldFeedback((old) => ({ ...old, [key]: {} }));
          }}
          onChange={(value) => update(key, value)}
          action={
            <button
              type="button"
              className="console-button primary"
              aria-label={
                key === "open_play_capacity"
                  ? "Apply player limit"
                  : `Apply ${options.label}`
              }
              disabled={pending || fieldPending || uploading}
              onClick={() => applyField(key)}
            >
              {fieldPending && applyingField === key ? "Applying…" : "Apply"}
            </button>
          }
        />
        {feedback?.error && (
          <div className="error-message" role="alert">
            {feedback.error}
          </div>
        )}
        {feedback?.message && (
          <div className="success-message" role="status">
            {feedback.message}
          </div>
        )}
      </div>
    );
  }
  const textField = (
    key:
      | "name"
      | "tagline"
      | "address"
      | "city"
      | "phone"
      | "email"
      | "facebook_url"
      | "gcash_name"
      | "gcash_number"
      | "gcash_qr_url",
    label: string,
    placeholder = "",
    type = "text",
  ) => (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={venue[key]}
        onChange={(e) => update(key, e.target.value)}
        placeholder={placeholder}
        maxLength={
          key === "address"
            ? 300
            : key === "gcash_qr_url" || key === "facebook_url"
              ? 2000
              : 180
        }
      />
    </label>
  );
  return (
    <>
      <WorkspacePageHeading title="Venue settings" actions={<>
          <a className="console-button" href="/" target="_blank" rel="noreferrer">View website <ArrowUpRight size={15} /></a>
          {section !== "courts" && section !== "schedule" &&
          <button type="submit" form="venue-settings-form" className="console-button primary" disabled={pending || fieldPending || uploading}>
            <Save size={16} />{pending ? "Saving…" : "Save changes"}
          </button>}
      </>} />
      <div className="settings-status-bar">
        <span><CalendarDays size={16} />{activeCourts(venue.courts).length} active courts</span>
        <span className={dirty ? "settings-unsaved" : ""}>{dirty ? "Unsaved venue changes" : "Saved venue settings"}</span>
      </div>
      <WorkspaceTabs id="settings" label="Venue settings sections" items={sections} value={section} onChange={selectSection} />
      <div className="venue-settings-layout">
        <div className="venue-settings-main">
        <div id="settings-panel-courts" role="tabpanel" aria-labelledby="settings-tab-courts" hidden={section !== "courts"} tabIndex={0}>
        <CourtManager initial={initial.courts ?? defaultCourts} ready={courtsReady}
          onChange={(courts) => setVenue((old) => ({ ...old, courts }))} />
        </div>
        <form id="venue-settings-form" className="venue-settings-form" onSubmit={submit} noValidate hidden={section === "courts" || section === "schedule"}>
          <section id="settings-panel-details" data-settings-section="details" role="tabpanel" aria-labelledby="settings-tab-details" hidden={section !== "details"} tabIndex={0} className="console-panel settings-card">
            <header className="settings-card-heading"><span className="settings-card-icon"><Building2 size={20} /></span><div><h2>Venue details</h2></div></header>
          <div className="settings-card-body">
          <div className="field-grid settings-details-grid">
          {textField("name", "Venue name")}
          {textField("tagline", "A short introduction")}
          {textField(
            "address",
            "Street address",
            "Add your venue address later",
          )}
          </div>
          <div className="field-grid">
            {textField("city", "City / municipality", "Add your city later")}
            {textField(
              "phone",
              "Contact number",
              "Your venue mobile number",
              "tel",
            )}
            {textField(
              "email",
              "Contact email",
              "hello@yourvenue.com",
              "email",
            )}
            {textField(
              "facebook_url",
              "Facebook page",
              "https://facebook.com/yourpage",
              "url",
            )}
          </div>
          </div>
          </section>
          <section id="settings-panel-equipment" data-settings-section="equipment" role="tabpanel" aria-labelledby="settings-tab-equipment" hidden={section !== "equipment"} tabIndex={0} className="console-panel settings-card">
            <header className="settings-card-heading"><span className="settings-card-icon"><Package size={20} /></span><div><h2>Rentals & booking limits</h2></div></header>
          <div className="settings-card-body">
          <div className="field-grid">
            {numericField("equipment_rental_price", {
              label: "Equipment rental package (PHP)",
              min: 0,
              max: 100000,
              hint: `${equipmentPackageLabel(venue.equipment_ball_count)} per set. Price multiplied by the number of sets selected.`,
            })}
            {numericField("equipment_ball_count", {
              label: "Balls per rental paddle",
              kind: "integer",
              min: 1,
              max: 20,
            })}
            {numericField("private_court_capacity", {
              label: "Default private-booking player limit",
              kind: "integer",
              min: 1,
              max: 100,
            })}
            {numericField("hold_minutes", {
              label: "Unpaid hold duration (minutes)",
              kind: "integer",
              min: 15,
              max: 120,
            })}
          </div>
          </div>
          </section>
          <section id="settings-panel-payments" data-settings-section="payments" role="tabpanel" aria-labelledby="settings-tab-payments" hidden={section !== "payments"} tabIndex={0} className="console-panel settings-card">
            <header className="settings-card-heading"><span className="settings-card-icon"><QrCode size={20} /></span><div><h2>GCash payments</h2></div></header>
          <div className="settings-card-body">
          <p className="small-print">
            Upload your GCash QR. Staff must verify incoming payments before confirming bookings.
          </p>
          <div className="field-grid">
            {textField(
              "gcash_name",
              "GCash account name",
              "Name customers should verify",
            )}
            {textField(
              "gcash_number",
              "GCash mobile number (optional)",
              "09XXXXXXXXX",
              "tel",
            )}
          </div>
          {textField(
            "gcash_qr_url",
            "QR image URL",
            "https://… (a direct PNG, JPEG, or WebP link)",
            "url",
          )}
          <label className="field">
            <span>Or upload your QR image</span>
            <div className="settings-qr-upload">
              <Upload size={20} />
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={upload}
                disabled={uploading || pending}
                style={{ padding: 0, border: 0, minHeight: 0 }}
              />
            </div>
            <small>
              {uploading
                ? "Uploading…"
                : "PNG, JPEG, or WebP · up to 2 MB. Save your settings after uploading."}
            </small>
          </label>
          {venue.gcash_qr_url && (
            <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
              <img
                src={venue.gcash_qr_url}
                alt="GCash QR preview"
                style={{
                  width: 130,
                  height: 130,
                  objectFit: "contain",
                  background: "white",
                  border: "1px solid var(--line)",
                  borderRadius: 7,
                }}
              />
              <p className="small-print">
                Check that the QR opens the right GCash account before enabling
                bookings.
              </p>
            </div>
          )}
          </div>
          </section>
          <section id="settings-panel-policy" data-settings-section="policy" role="tabpanel" aria-labelledby="settings-tab-policy" hidden={section !== "policy"} tabIndex={0} className="console-panel settings-card">
            <header className="settings-card-heading"><span className="settings-card-icon"><ShieldCheck size={20} /></span><div><h2>Booking rules</h2></div></header>
          <div className="settings-card-body">
          <label className="field">
            <span>Cancellation & refund policy</span>
            <textarea
              value={venue.cancellation_policy}
              onChange={(e) => update("cancellation_policy", e.target.value)}
              minLength={10}
              maxLength={2000}
              required
            />
            <small>
              Explain cancellations, rescheduling, and refunds. Refunds are
              handled manually through GCash.
            </small>
          </label>
          <label className="toggle-field">
            <input
              type="checkbox"
              checked={venue.booking_enabled}
              onChange={(e) => update("booking_enabled", e.target.checked)}
            />
            <span>
              <strong>Open online reservations</strong>
              <small>
                Enable after setting your rate, opening hours, GCash name, and
                QR. Turning this off stops new reservations. Existing bookings
                remain accessible.
              </small>
            </span>
          </label>
          </div>
          </section>
          {error && (
            <div className="error-message" role="alert">
              {error}
            </div>
          )}
          {message && (
            <div className="success-message" role="status">
              {message}
            </div>
          )}
          <div className="settings-save workspace-save-bar">
            <button
              className="console-button primary"
              disabled={pending || fieldPending || uploading}
            >
              <Save size={16} />
              {pending ? "Saving…" : "Save venue settings"}
            </button>
            <span className="small-print">
              Courts and hours are saved in their own sections.
            </span>
          </div>
        </form>
        <section id="settings-panel-schedule" role="tabpanel" aria-labelledby="settings-tab-schedule" hidden={section !== "schedule"} tabIndex={0} className="venue-schedule-section">
          <ScheduleEditor initial={initial} />
        </section>
        </div>
        <details className="console-panel settings-readiness workspace-disclosure">
          <summary>Booking setup <span className={`status-pill ${canBook(venue) ? "status-ok" : "status-pending"}`}>{canBook(venue) ? "Ready" : "Needs attention"}</span></summary>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {[
              [
                "Court hours & session rates",
                venue.schedule_config
                  ? venue.schedule_config.weekly.length > 0 ||
                    venue.schedule_config.overrides.some(
                      (p) => p.blocks.length > 0,
                    )
                  : Boolean(
                      venue.hourly_rate &&
                        venue.evening_hourly_rate &&
                        venue.opening_hour !== null &&
                        venue.closing_hour !== null,
                    ),
              ],
              ["GCash account name", Boolean(venue.gcash_name)],
              ["GCash QR image", Boolean(venue.gcash_qr_url)],
              ["Venue address", Boolean(venue.address)],
              ["Contact details", Boolean(venue.phone || venue.email)],
            ].map(([label, done]) => (
              <li
                key={String(label)}
                className={done ? "checklist-done" : ""}
              >
                <Check
                  size={16}
                />
                {label}
              </li>
            ))}
          </ul>
          <div
            className={`notice ${canBook(venue) ? "" : "notice-warning"}`}
            style={{ marginTop: 20 }}
          >
            <span>
              {canBook(venue)
                ? "Required details are complete. Save any changes to publish them."
                : "Complete the required details and enable online reservations in Booking rules."}
            </span>
          </div>
          <button type="button" onClick={() => selectSection("schedule")} className="console-button settings-schedule-link">Edit hours & rates <CalendarDays size={16} /></button>
        </details>
      </div>
    </>
  );
}
