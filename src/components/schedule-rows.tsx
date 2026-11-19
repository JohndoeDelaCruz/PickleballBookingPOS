"use client";

import { useId } from "react";
import { formatHour, money, openPlayCapacityLabel } from "@/lib/booking";
import { daysLabel, type ScheduleBlock } from "@/lib/schedule";
import { TablePagination, useTablePage } from "./table-pagination";

export function ScheduleRows({ blocks, courtCount, label }: {
  blocks: ScheduleBlock[];
  courtCount: number;
  label: string;
}) {
  const anchorId = useId();
  const page = useTablePage(blocks.length);
  const ordered = [...blocks].sort(
    (a, b) => Math.min(...a.days) - Math.min(...b.days) || a.start - b.start,
  );

  if (!blocks.length) return <p>No court time is scheduled.</p>;

  return (
    <>
      <div id={anchorId} className="table-scroll" tabIndex={-1} role="region" aria-label={label}>
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
            {ordered.slice(page.start, page.end).map((block) => (
              <tr key={block.id}>
                <td>{daysLabel(block.days)}</td>
                <td>{formatHour(block.start)}–{formatHour(block.end)}</td>
                <td>
                  {block.kind === "court" ? "Private booking" : "Open play"}
                  <small>
                    {block.kind === "open_play"
                      ? openPlayCapacityLabel(block.capacity, courtCount)
                      : `${block.capacity} players per court`}
                  </small>
                </td>
                <td>
                  <strong>{money(block.rate)}</strong>
                  <small>{block.kind === "court" ? "per court / hour" : "per person / session"}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TablePagination {...page} label={`${label} pages`} anchorId={anchorId} />
    </>
  );
}
