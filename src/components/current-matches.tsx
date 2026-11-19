"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { playerBoardPath, type CurrentMatch } from "@/lib/paddle-stack";
import { createClient } from "@/lib/supabase/client";
import { MatchTeams } from "./match-teams";
import styles from "./paddle-stack.module.css";

export function CurrentMatches() {
  const [matches, setMatches] = useState<CurrentMatch[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const db = createClient();
    const controller = new AbortController();
    let reading = false;

    async function refresh() {
      if (reading || document.hidden) return;
      reading = true;
      try {
        const { data, error } = await db.rpc("current_paddle_stack_matches")
          .abortSignal(controller.signal);
        if (error) throw error;
        if (controller.signal.aborted) return;
        setMatches((data ?? []) as CurrentMatch[]);
        setUnavailable(false);
      } catch {
        if (!controller.signal.aborted) setUnavailable(true);
      } finally {
        reading = false;
      }
    }

    void refresh();
    const timer = window.setInterval(refresh, 5000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  return (
    <section className={styles.currentMatches} aria-labelledby="current-matches-title">
      <h2 id="current-matches-title">Current matches</h2>
      {unavailable ? (
        <p className={styles.muted} role="status">Live scores are temporarily unavailable. Reconnecting…</p>
      ) : matches === null ? (
        <p className={styles.muted} role="status">Loading current matches…</p>
      ) : matches.length === 0 ? (
        <p className={styles.muted}>No open-play matches are in progress.</p>
      ) : null}
      {!!matches?.length && (
        <div className={styles.courts}>
          {matches.map(({ session_id, court_name, game }) => (
            <article className={`panel ${styles.panel}`} key={game.id}>
              <div className={styles.courtHeading}>
                <h3>{court_name}</h3>
                {!unavailable && <span className={styles.status}>Live</span>}
              </div>
              <MatchTeams game={game} />
              <Link className="text-link" href={playerBoardPath(session_id)} prefetch={false}
                aria-label={`Open player board for ${court_name}`}>
                Player board <ArrowUpRight size={16} aria-hidden="true" />
              </Link>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
