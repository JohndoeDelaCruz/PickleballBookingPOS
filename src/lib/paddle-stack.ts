export const paddleStackPath = "/staff/paddle-stack";
export const playerBoardPath = (session: string) => `/paddle-stack/${session}`;

export type StackSession = {
  id: string | null;
  play_date: string;
  start_hour: number;
  end_hour: number;
  closed_at: string | null;
};

export const stackSkillLabels = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
} as const;

export type StackSkill = keyof typeof stackSkillLabels;
export type StackPlayer = { id: string; name: string; skill_level?: StackSkill };

export type StackGame = {
  id: string;
  revision: number;
  finished_at: string | null;
  team_a: number;
  team_b: number;
  can_undo: boolean;
  players: [string, string, string, string];
};

export type MatchScore = Pick<StackGame, "id" | "team_a" | "team_b" | "players">;

export type CurrentMatch = {
  session_id: string;
  court_name: string;
  game: MatchScore;
};

export type StackCourt = {
  id: number;
  name: string;
  active: boolean;
  has_scorekeeper: boolean;
  game: StackGame | null;
};

export type StackBoard = {
  id: string;
  play_date: string;
  start_hour: number;
  end_hour: number;
  capacity: number | null;
  status: "check_in" | "playing" | "ending" | "closed";
  score_court: number | null;
  checked_in: number;
  next_players?: string[];
  waiting: StackPlayer[];
  resting: StackPlayer[];
  courts: StackCourt[];
  results: (StackGame & { court_name: string })[];
};

export type ScoreAction = "point_a" | "point_b" | "undo" | "finish";

export function stackError(error: unknown, fallback: string) {
  const message = (error as { message?: string } | null)?.message;
  return message?.startsWith("Paddle Stack: ")
    ? message.slice("Paddle Stack: ".length)
    : fallback;
}
