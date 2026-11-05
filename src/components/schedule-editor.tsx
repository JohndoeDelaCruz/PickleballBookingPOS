"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Save, Trash2 } from "lucide-react";
import { saveSchedule } from "@/app/actions";
import { addDays, formatDate, localDate } from "@/lib/booking";
import {
  introductoryBlocks,
  legacySchedule,
  scheduleConfigSchema,
  weekDays,
  type ScheduleBlock,
  type ScheduleConfig,
  type ScheduleOverride,
} from "@/lib/schedule";
import type { VenueSettings } from "@/lib/types";
import { TypedSettingField } from "./typed-setting-field";

export function ScheduleEditor({ initial }: { initial: VenueSettings }) {
  const router = useRouter();
  const [saved, setSaved] = useState<ScheduleConfig | null>(
    initial.schedule_config ?? null,
  );
  const [config, setConfig] = useState<ScheduleConfig>(() =>
    structuredClone(initial.schedule_config ?? legacySchedule(initial)),
  );
  const [active, setActive] = useState("weekly");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const ready = "schedule_config" in initial;
  const period = config.overrides.find((p) => p.id === active);
  const blocks = period?.blocks ?? config.weekly;
  const dirty =
    JSON.stringify(config) !== JSON.stringify(saved ?? legacySchedule(initial));
  function change(next: ScheduleConfig) {
    setConfig(next);
    setError("");
    setMessage("");
  }
  function updateBlocks(next: ScheduleBlock[]) {
    change(
      period
        ? {
            ...config,
            overrides: config.overrides.map((p) =>
              p.id === active ? { ...p, blocks: next } : p,
            ),
          }
        : { ...config, weekly: next },
    );
  }
  function updateBlock(id: string, patch: Partial<ScheduleBlock>) {
    updateBlocks(blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }
  function updatePeriod(patch: Partial<ScheduleOverride>) {
    change({
      ...config,
      overrides: config.overrides.map((p) =>
        p.id === active ? { ...p, ...patch } : p,
      ),
    });
  }
  function addPeriod(intro = false) {
    const today = localDate();
    const monday = addDays(
      today,
      -((new Date(`${today}T00:00:00Z`).getUTCDay() || 7) - 1),
    );
    const id = intro ? `intro-${monday}` : crypto.randomUUID();
    if (config.overrides.some((p) => p.id === id)) {
      setActive(id);
      return;
    }
    change({
      ...config,
      overrides: [
        ...config.overrides,
        {
          id,
          name: intro ? "Introductory week" : "Temporary schedule",
          start_date: intro ? monday : today,
          end_date: intro ? addDays(monday, 6) : today,
          blocks: intro ? introductoryBlocks() : structuredClone(config.weekly),
        },
      ],
    });
    setActive(id);
  }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    const parsed = scheduleConfigSchema.safeParse(config);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    startTransition(async () => {
      try {
        const result = await saveSchedule(parsed.data, saved);
        if (result.error) setError(result.error);
        else {
          setConfig(parsed.data);
          setSaved(structuredClone(parsed.data));
          setMessage(
            "Schedule saved. New reservations use these time blocks; existing reservation prices are unchanged.",
          );
          router.refresh();
        }
      } catch {
        setError("The schedule could not be saved. Please try again.");
      }
    });
  }
  return (
    <form className="panel schedule-editor" onSubmit={submit}>
      <div className="schedule-editor-heading">
        <div>
          <h2>Booking schedule</h2>
          <p className="small-print">
            Set private-booking hours and open-play sessions. Hours without a
            time block are closed.
          </p>
        </div>
        <span className="schedule-draft-status">
          {dirty
            ? "Unsaved changes"
            : saved
              ? "Saved schedule"
              : "Current schedule"}
        </span>
      </div>
      {!ready && (
        <div className="notice">
          The schedule database update is required before saving. Your current
          booking schedule continues to run.
        </div>
      )}
      <fieldset key={active} disabled={pending} className="schedule-fields">
        <div className="schedule-editor-toolbar schedule-picker-toolbar">
          <label className="field">
            <span>Edit schedule</span>
            <select value={active} onChange={(e) => setActive(e.target.value)}>
              <option value="weekly">Regular weekly schedule</option>
              {config.overrides.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.start_date} – {p.end_date}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button button-outline button-small"
            disabled={config.overrides.length >= 30}
            onClick={() => addPeriod()}
          >
            <Plus size={16} /> Temporary override
          </button>
          <button
            type="button"
            className="text-link"
            onClick={() => addPeriod(true)}
          >
            Use introductory-week template
          </button>
        </div>
        {period ? (
          <>
            <div className="field-grid schedule-period-fields">
              <label className="field">
                <span>Temporary schedule name</span>
                <input
                  value={period.name}
                  onChange={(e) => updatePeriod({ name: e.target.value })}
                  required
                  maxLength={100}
                />
              </label>
              <label className="field">
                <span>First date</span>
                <input
                  type="date"
                  value={period.start_date}
                  min="2000-01-01"
                  max="2100-12-31"
                  required
                  onChange={(e) => updatePeriod({ start_date: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Last date</span>
                <input
                  type="date"
                  value={period.end_date}
                  min={period.start_date || "2000-01-01"}
                  max="2100-12-31"
                  required
                  onChange={(e) => updatePeriod({ end_date: e.target.value })}
                />
              </label>
            </div>
            <div className="notice schedule-period-notice">
              {period.start_date &&
              period.end_date &&
              period.end_date >= period.start_date
                ? `This schedule replaces the regular schedule from ${formatDate(period.start_date)} through ${formatDate(period.end_date)}. The regular schedule resumes ${formatDate(addDays(period.end_date, 1))}.`
                : "Choose the first and last dates for this temporary schedule."}
            </div>
          </>
        ) : (
          <p className="small-print">
            This repeats every week. Temporary overrides take priority only
            within their date ranges.
          </p>
        )}
        <table className="schedule-table">
          <caption className="sr-only">
            Editable {period ? "temporary" : "weekly"} booking time blocks
          </caption>
          <thead>
            <tr>
              {[
                "Days",
                "Start time",
                "End time",
                "Type",
                "Rate",
                "Player limit",
                "Actions",
              ].map((label) => (
                <th key={label} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {blocks.map((block, index) => (
              <tr key={block.id}>
                <td className="schedule-days-cell">
                  <fieldset className="schedule-day-picker">
                    <legend>Days · block {index + 1}</legend>
                    <div>
                      {weekDays.map((day, dayIndex) => (
                        <label key={day} title={day}>
                          <input
                            type="checkbox"
                            checked={block.days.includes(dayIndex + 1)}
                            aria-label={`${day}, block ${index + 1}`}
                            onChange={(e) =>
                              updateBlock(block.id, {
                                days: e.target.checked
                                  ? [...block.days, dayIndex + 1].sort(
                                      (a, b) => a - b,
                                    )
                                  : block.days.filter(
                                      (d) => d !== dayIndex + 1,
                                    ),
                              })
                            }
                          />
                          <span>{day.slice(0, 2)}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </td>
                <td>
                  <TypedSettingField
                    label="Start time"
                    ariaLabel={`Start time, block ${index + 1}`}
                    kind="hour"
                    min={0}
                    max={23}
                    value={block.start}
                    onChange={(value) =>
                      value !== null && updateBlock(block.id, { start: value })
                    }
                  />
                </td>
                <td>
                  <TypedSettingField
                    label="End time"
                    ariaLabel={`End time, block ${index + 1}`}
                    kind="hour"
                    min={1}
                    max={24}
                    value={block.end}
                    onChange={(value) =>
                      value !== null && updateBlock(block.id, { end: value })
                    }
                  />
                </td>
                <td>
                  <label className="field">
                    <span>Type</span>
                    <select
                      aria-label={`Type, block ${index + 1}`}
                      value={block.kind}
                      onChange={(e) =>
                        updateBlock(block.id, {
                          kind: e.target.value as ScheduleBlock["kind"],
                          capacity:
                            e.target.value === "court"
                              ? initial.private_court_capacity
                              : initial.open_play_capacity,
                        })
                      }
                    >
                      <option value="court">Private booking</option>
                      <option value="open_play">Open play</option>
                    </select>
                  </label>
                </td>
                <td>
                  <TypedSettingField
                    label="Rate"
                    ariaLabel={`Rate, block ${index + 1}`}
                    min={0.01}
                    max={100000}
                    value={block.rate}
                    onChange={(value) =>
                      value !== null && updateBlock(block.id, { rate: value })
                    }
                  />
                  <small>
                    {block.kind === "court"
                      ? "₱ / court / hour"
                      : "₱ / person / session"}
                  </small>
                </td>
                <td>
                  <TypedSettingField
                    key={block.kind}
                    label="Player limit"
                    ariaLabel={`Player limit, block ${index + 1}`}
                    kind="integer"
                    min={1}
                    max={block.kind === "court" ? 100 : 100000}
                    optional={block.kind === "open_play"}
                    value={block.capacity}
                    placeholder="No limit"
                    onChange={(value) =>
                      updateBlock(block.id, { capacity: value })
                    }
                  />
                  <small>
                    {block.kind === "court"
                      ? "per court"
                      : "across active courts"}
                  </small>
                </td>
                <td>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Delete time block ${index + 1}`}
                    onClick={() =>
                      updateBlocks(blocks.filter((b) => b.id !== block.id))
                    }
                  >
                    <Trash2 size={17} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!blocks.length && (
          <div className="notice">
            No time blocks.{" "}
            {period ? "All dates in this override" : "All weekdays"} will be
            closed until you add a block.
          </div>
        )}
        <div className="schedule-editor-toolbar">
          <button
            type="button"
            className="button button-outline button-small"
            disabled={blocks.length >= 100}
            onClick={() =>
              updateBlocks([
                ...blocks,
                {
                  id: crypto.randomUUID(),
                  days: [1, 2, 3, 4, 5, 6, 7],
                  start: 6,
                  end: 8,
                  kind: "court",
                  rate: initial.hourly_rate ?? 100,
                  capacity: initial.private_court_capacity,
                },
              ])
            }
          >
            <Plus size={16} /> Add time block
          </button>
          {period && (
            <button
              type="button"
              className="text-link"
              onClick={() => {
                change({
                  ...config,
                  overrides: config.overrides.filter((p) => p.id !== active),
                });
                setActive("weekly");
              }}
            >
              Remove temporary override
            </button>
          )}
        </div>
      </fieldset>
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
      <div className="schedule-editor-save">
        <button className="button button-dark" disabled={pending || !ready}>
          <Save size={17} />
          {pending ? "Saving schedule…" : "Save schedule"}
        </button>
        <button
          type="button"
          className="text-link"
          disabled={pending}
          onClick={() => window.location.reload()}
        >
          Reload saved schedule
        </button>
        <span className="small-print">
          Saved together after checking overlaps and existing reservations.
        </span>
      </div>
    </form>
  );
}
