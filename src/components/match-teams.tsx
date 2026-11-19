import type { ReactNode } from "react";
import type { MatchScore } from "@/lib/paddle-stack";
import styles from "./paddle-stack.module.css";

export function MatchTeams({ game, scoreAction }: {
  game: MatchScore;
  scoreAction?: (side: "a" | "b") => ReactNode;
}) {
  return (
    <div className={styles.teams}>
      {(["a", "b"] as const).map((side, index) => {
        const label = `Team ${side.toUpperCase()}`;
        const score = game[`team_${side}`];
        return (
          <div className={styles.team} key={side}>
            <span>{label}</span>
            <strong className={styles.score} aria-label={`${label} score ${score}`}>{score}</strong>
            <p>{game.players.slice(index * 2, index * 2 + 2).join(" & ")}</p>
            {scoreAction?.(side)}
          </div>
        );
      })}
    </div>
  );
}
