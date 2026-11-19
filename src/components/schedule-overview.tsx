import Link from "next/link";
import { addDays, formatDate, localDate } from "@/lib/booking";
import type { ScheduleConfig } from "@/lib/schedule";
import { ScheduleRows } from "./schedule-rows";

export function ScheduleOverview({ config, courtCount }: { config: ScheduleConfig; courtCount: number }) {
  const today = localDate();
  const active = config.overrides.find(
    (p) => today >= p.start_date && today <= p.end_date,
  );
  const upcoming = [...config.overrides]
    .filter((p) => p.start_date > today)
    .sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
  return (
    <section
      className="panel public-schedule"
      aria-label="Play schedule"
      data-reveal=""
    >
      <div className="schedule-editor-heading">
        <div>
          <span className="eyebrow">PLAN YOUR NEXT GAME</span>
          <h3>Play schedule</h3>
        </div>
        <Link href="/book" className="button button-dark button-small">
          View availability
        </Link>
      </div>
      {active ? (
        <>
          <p>
            <strong>{active.name}</strong> · {formatDate(active.start_date)}–
            {formatDate(active.end_date)}
          </p>
          <ScheduleRows blocks={active.blocks} courtCount={courtCount} label={active.name} />
          <p className="small-print">
            Regular hours resume {formatDate(addDays(active.end_date, 1))}.
          </p>
          <details>
            <summary>Regular weekly schedule</summary>
            <ScheduleRows blocks={config.weekly} courtCount={courtCount} label="Regular weekly schedule" />
          </details>
        </>
      ) : (
        <ScheduleRows blocks={config.weekly} courtCount={courtCount} label="Regular weekly schedule" />
      )}
      {upcoming && (
        <details>
          <summary>
            {upcoming.name} · {formatDate(upcoming.start_date)}–
            {formatDate(upcoming.end_date)}
          </summary>
          <ScheduleRows blocks={upcoming.blocks} courtCount={courtCount} label={upcoming.name} />
        </details>
      )}
    </section>
  );
}
