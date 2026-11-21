import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { addDays, formatDate, localDate } from "@/lib/booking";
import type { ScheduleConfig } from "@/lib/schedule";
import { ScheduleRows } from "./schedule-rows";

export function ScheduleOverview({ config, courtCount }: { config: ScheduleConfig | null; courtCount: number }) {
  const today = localDate();
  const active = config?.overrides.find(
    (p) => today >= p.start_date && today <= p.end_date,
  );
  const upcoming = config?.overrides
    .filter((p) => p.start_date > today)
    .sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
  return (
    <section className="public-schedule" aria-labelledby="play-schedule-title">
      <div className="public-schedule-heading">
        <div>
          <h2 id="play-schedule-title">Play schedule</h2>
          {config && <p>Philippine time</p>}
        </div>
        <Link href="/book" className="button button-lime public-schedule-link">
          View availability <ArrowUpRight size={18} aria-hidden="true" />
        </Link>
      </div>
      {!config ? <p>Play schedule is currently unavailable.</p> : active ? (
        <>
          <p>
            <strong>{active.name}</strong> · {formatDate(active.start_date)}–{formatDate(active.end_date)}
          </p>
          <ScheduleRows blocks={active.blocks} courtCount={courtCount} label={active.name} />
          <p className="small-print">Regular hours resume {formatDate(addDays(active.end_date, 1))}.</p>
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
