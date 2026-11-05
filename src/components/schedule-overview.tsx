import Link from "next/link";
import {
  addDays,
  formatDate,
  formatHour,
  localDate,
  money,
  openPlayCapacityLabel,
} from "@/lib/booking";
import {
  daysLabel,
  type ScheduleBlock,
  type ScheduleConfig,
} from "@/lib/schedule";

function ScheduleRows({ blocks }: { blocks: ScheduleBlock[] }) {
  return blocks.length ? (
    <div className="table-scroll">
      <table className="admin-table public-schedule-table">
        <caption className="sr-only">
          Court hours and open-play session rates, Philippine Time
        </caption>
        <thead>
          <tr>
            <th scope="col">Days</th>
            <th scope="col">Time</th>
            <th scope="col">Type</th>
            <th scope="col">Rate</th>
          </tr>
        </thead>
        <tbody>
          {[...blocks]
            .sort(
              (a, b) =>
                Math.min(...a.days) - Math.min(...b.days) || a.start - b.start,
            )
            .map((block) => (
              <tr key={block.id}>
                <td>{daysLabel(block.days)}</td>
                <td>
                  {formatHour(block.start)}–{formatHour(block.end)}
                </td>
                <td>
                  {block.kind === "court" ? "Private booking" : "Open play"}
                  <small>
                    {block.kind === "open_play"
                      ? openPlayCapacityLabel(block.capacity)
                      : `${block.capacity} players per court`}
                  </small>
                </td>
                <td>
                  <strong>{money(block.rate)}</strong>
                  <small>
                    {block.kind === "court"
                      ? "per court / hour"
                      : "per person / session"}
                  </small>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p>No court time is scheduled.</p>
  );
}

export function ScheduleOverview({ config }: { config: ScheduleConfig }) {
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
          <ScheduleRows blocks={active.blocks} />
          <p className="small-print">
            Regular hours resume {formatDate(addDays(active.end_date, 1))}.
          </p>
          <details>
            <summary>Regular weekly schedule</summary>
            <ScheduleRows blocks={config.weekly} />
          </details>
        </>
      ) : (
        <ScheduleRows blocks={config.weekly} />
      )}
      {upcoming && (
        <details>
          <summary>
            {upcoming.name} · {formatDate(upcoming.start_date)}–
            {formatDate(upcoming.end_date)}
          </summary>
          <ScheduleRows blocks={upcoming.blocks} />
        </details>
      )}
      <p className="small-print">
        All times are Philippine Time. Open-play passes cover one selected
        session. Hours without a time block are closed.
      </p>
    </section>
  );
}
