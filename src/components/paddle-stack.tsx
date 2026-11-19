"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Copy, ExternalLink, ListOrdered, QrCode, Shuffle, UserPlus } from "lucide-react";
import { z } from "zod";
import { formatDate, formatHour, isPastSlot } from "@/lib/booking";
import { createClient } from "@/lib/supabase/client";
import {
  playerBoardPath,
  stackError,
  stackSkillLabels,
  type ScoreAction,
  type StackBoard,
  type StackCourt,
  type StackGame,
  type StackPlayer,
  type StackSession,
  type StackSkill,
} from "@/lib/paddle-stack";
import { Modal } from "./modal";
import { MatchTeams } from "./match-teams";
import { useAnimatedModal } from "./use-animated-modal";
import styles from "./paddle-stack.module.css";

const sessionHours = (session: Pick<StackSession, "start_hour" | "end_hour">) =>
  `${formatHour(session.start_hour)}–${formatHour(session.end_hour)}`;
const sessionStatus: Record<StackBoard["status"], string> = {
  check_in: "Check-in open",
  playing: "Open play live",
  ending: "Finishing games",
  closed: "Session closed",
};

function useStackBoard(session: string, staff = false, key: string | null = null) {
  const [board, setBoard] = useState<StackBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectionLost, setConnectionLost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const updating = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(false);

  const read = useCallback(async () => {
    const { data, error } = await createClient().rpc("get_paddle_stack", {
      p_session: session, p_key: key, p_staff: staff,
    });
    if (error) throw error;
    return data as StackBoard | null;
  }, [session, key, staff]);

  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let reading = false;
    async function refresh() {
      if (reading || updating.current || document.hidden) return;
      reading = true;
      const revision = generation.current;
      try {
        const next = await read();
        if (!stopped && revision === generation.current) {
          setBoard(next);
          setConnectionLost(false);
        }
      } catch {
        if (!stopped && revision === generation.current) setConnectionLost(true);
      } finally {
        if (!stopped && revision === generation.current) setLoading(false);
        reading = false;
      }
    }
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      stopped = true;
      mounted.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [read]);

  async function run(rpc: string, args: Record<string, unknown>) {
    if (updating.current) return null;
    updating.current = true;
    const revision = ++generation.current;
    setBusy(true);
    setError("");
    let result: { data: unknown } | null = null;
    try {
      const { data, error } = await createClient().rpc(rpc, { p_session: session, ...args });
      if (error) throw error;
      result = { data };
    } catch (error) {
      if (mounted.current) setError(stackError(error, "We couldn’t confirm the update. Check the board before trying again."));
    }
    try {
      const next = await read();
      if (mounted.current && revision === generation.current) {
        setBoard(next);
        setConnectionLost(false);
      }
    } catch {
      if (mounted.current) setConnectionLost(true);
    } finally {
      updating.current = false;
      if (mounted.current) setBusy(false);
    }
    return result;
  }

  const score = (game: StackGame, action: ScoreAction) =>
    run("paddle_stack_score", {
      p_game: game.id, p_revision: game.revision, p_action: action, p_key: key,
    });
  return { board, loading, connectionLost, busy, error, run, score };
}

function StackFeedback({ loading, connectionLost, error }: Pick<
  ReturnType<typeof useStackBoard>, "loading" | "connectionLost" | "error"
>) {
  return <>
    {loading && <p role="status">Loading the live board…</p>}
    {connectionLost && <p className="notice" role="status">Live updates are paused. Reconnecting…</p>}
    {error && <p className="error-message" role="alert">{error}</p>}
  </>;
}

function BoardHeading({ board }: { board: StackBoard }) {
  return (
    <div className={styles.boardHeading}>
      <div>
        <h2>{sessionHours(board)}</h2>
        <p>{formatDate(board.play_date)} · Philippine time</p>
      </div>
      <span className={styles.status}>{sessionStatus[board.status]}</span>
    </div>
  );
}

function PlayerOrder({
  waiting,
  nextPlayers,
  queueControl,
  actions,
}: {
  waiting: StackPlayer[];
  nextPlayers?: string[];
  queueControl?: React.ReactNode;
  actions?: (player: StackPlayer) => React.ReactNode;
}) {
  const next = new Set(nextPlayers ?? waiting.slice(0, 4).map((player) => player.id));
  return (
    <section className={`panel ${styles.panel}`} aria-label="Waiting queue">
      <div className={styles.queueHeading}>
        <h2><ListOrdered size={20} aria-hidden="true" /> Up next</h2>
        {queueControl}
      </div>
      {waiting.length ? (
        <ol className={styles.players}>
          {waiting.map((player, index) => (
            <li key={player.id} className={next.has(player.id) ? styles.nextPlayer : undefined}>
              <span className={styles.position}>{index + 1}</span>
              <strong>{player.name}</strong>
              {next.has(player.id) && <span className="sr-only">Next match</span>}
              {actions?.(player)}
            </li>
          ))}
        </ol>
      ) : <p className={styles.muted}>No players are waiting.</p>}
    </section>
  );
}

function SkillOptions() {
  return <>
    <option value="">Unrated</option>
    {Object.entries(stackSkillLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
  </>;
}

function CourtScore({
  court,
  onScore,
  busy = false,
  children,
}: {
  court: StackCourt;
  onScore?: (game: StackGame, action: ScoreAction) => Promise<unknown>;
  busy?: boolean;
  children?: React.ReactNode;
}) {
  const [confirmGame, setConfirmGame] = useState<string | null>(null);
  const game = court.game;
  const live = game && !game.finished_at;
  const scoring = Boolean(live && onScore);
  const confirmFinish = game?.id === confirmGame;
  return (
    <section className={`panel ${styles.panel} ${styles.court}`}>
      <div className={styles.courtHeading}>
        <h2>{court.name}</h2>
        <span className={styles.status}>{live ? "On court" : court.active ? "Court free" : "Inactive"}</span>
      </div>
      {game ? (
        <>
          <p className={styles.muted}>{live ? "Current game" : "Last final score"}</p>
          <MatchTeams game={game} scoreAction={scoring ? (side) => (
            <button type="button" className="button button-dark"
              aria-label={`Add a point for Team ${side.toUpperCase()} on ${court.name}`}
              disabled={busy || confirmFinish}
              onClick={() => void onScore?.(game, `point_${side}`)}>
              +1 point
            </button>
          ) : undefined} />
          {scoring && (
            <div className={styles.controls}>
              {confirmFinish ? (
                <>
                  <p>Save {game.team_a}–{game.team_b} as the final score?</p>
                  <button className="button button-dark button-small" disabled={busy} onClick={async () => {
                    await onScore?.(game, "finish");
                    setConfirmGame(null);
                  }}>Save final score</button>
                  <button className="button button-small" disabled={busy} onClick={() => setConfirmGame(null)}>Keep playing</button>
                </>
              ) : (
                <>
                  <button className="button button-small" disabled={busy || !game.can_undo}
                    onClick={() => void onScore?.(game, "undo")}>Undo last point</button>
                  <button className="button button-small" disabled={busy} onClick={() => setConfirmGame(game.id)}>Finish game</button>
                </>
              )}
            </div>
          )}
        </>
      ) : <p className={styles.muted}>Waiting for a game.</p>}
      {children}
    </section>
  );
}

function BoardShare({ path, scorekeeper, onClose, closing }: { path: string; scorekeeper: boolean; onClose: () => void; closing: boolean }) {
  const url = new URL(path, window.location.origin).href;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  const [qrFailed, setQrFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void import("qrcode").then(({ toCanvas }) => {
      if (active && canvas.current) return toCanvas(canvas.current, url, { width: 208, margin: 4 });
    }).catch(() => { if (active) setQrFailed(true); });
    return () => { active = false; };
  }, [url]);
  return (
    <Modal title={scorekeeper ? "Scorekeeper link" : "Player board QR code"} onClose={onClose} closing={closing}>
      <div className={styles.share}>
        <p>{scorekeeper ? "Share this link with the designated scorekeeper for this court." : "Players can scan this code to see scores and who’s up next."}</p>
        {qrFailed ? <p>Use the link below to open the board.</p> :
          <canvas ref={canvas} role="img" aria-label={scorekeeper ? "Scorekeeper QR code" : "Player board QR code"} />}
        <label className="field">
          <span>Link</span>
          <input value={url} readOnly onFocus={(event) => event.target.select()} />
        </label>
        <div className={styles.controls}>
          <button className="button button-dark button-small" onClick={async () => {
            try { await navigator.clipboard.writeText(url); setCopied(true); }
            catch { setCopied(false); }
          }}>
            <Copy size={16} aria-hidden="true" /> {copied ? "Copied" : "Copy link"}
          </button>
          <a href={path} className="button button-small" target="_blank" rel="noreferrer">
            Open link <ExternalLink size={15} aria-hidden="true" />
          </a>
        </div>
      </div>
    </Modal>
  );
}

export function PaddleStackStaff({
  sessions: initialSessions,
  initialId,
}: {
  sessions: StackSession[];
  initialId?: string;
}) {
  const [sessions, setSessions] = useState(initialSessions);
  const [selection, setSelection] = useState(() => {
    const selected = initialSessions.findIndex((slot) => slot.id === initialId);
    if (selected >= 0) return selected;
    return Math.max(0, initialSessions.findIndex((slot) => !slot.closed_at && !isPastSlot(slot.play_date, slot.end_hour)));
  });
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const slot = sessions[selection];

  function select(index: number, id: string | null) {
    setSelection(index);
    setError("");
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("session", id);
    else url.searchParams.delete("session");
    window.history.replaceState(null, "", url);
  }

  async function openSession() {
    if (opening || !slot) return;
    setOpening(true);
    setError("");
    try {
      const { data, error } = await createClient().rpc("paddle_stack_open", {
        p_start: slot.start_hour, p_end: slot.end_hour,
      });
      if (error) throw error;
      const id = z.uuid().parse(data);
      setSessions((current) => current.map((session, index) => index === selection ? { ...session, id } : session));
      select(selection, id);
    } catch (error) {
      setError(stackError(error, "The session couldn’t be opened. Try again."));
    } finally {
      setOpening(false);
    }
  }

  if (!slot) return <p className="notice">There are no open-play sessions left on today’s schedule.</p>;
  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}>
        <label className="field">
          <span>Open-play session</span>
          <select value={selection} disabled={opening} onChange={(event) => {
            const index = Number(event.target.value);
            select(index, sessions[index].id);
          }}>
            {sessions.map((session, index) => (
              <option value={index} key={`${session.play_date}:${session.start_hour}:${session.end_hour}`}>
                {formatDate(session.play_date, { month: "short", day: "numeric" })} · {sessionHours(session)}
              </option>
            ))}
          </select>
        </label>
        {!slot.id && (
          <button className="button button-dark" disabled={opening} onClick={() => void openSession()}>
            {opening ? "Opening…" : "Open check-in"}
          </button>
        )}
      </div>
      {error && <p role="alert" className="error-message">{error}</p>}
      {slot.id ? <StaffBoard session={slot.id} key={slot.id} /> : (
        <p className="notice">Open check-in to start the queue for this session.</p>
      )}
    </div>
  );
}

function StaffBoard({ session }: { session: string }) {
  const state = useStackBoard(session, true);
  const { board, busy, run, score } = state;
  const [name, setName] = useState("");
  const [skill, setSkill] = useState<StackSkill | "">("");
  const checkInId = useRef<string | null>(null);
  const [share, setShare, shareClosing] = useAnimatedModal<{ path: string; scorekeeper: boolean }>();
  const [confirmClose, setConfirmClose] = useState(false);
  const manage = (action: string, args: Record<string, unknown> = {}) =>
    run("paddle_stack_manage", { p_action: action, ...args });

  async function checkIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    checkInId.current ??= crypto.randomUUID();
    if (await manage("check_in", {
      p_player: checkInId.current, p_name: name.trim(), ...(skill ? { p_skill: skill } : {}),
    })) {
      setName("");
      setSkill("");
      checkInId.current = null;
    }
  }

  if (!board) return <>
    <StackFeedback {...state} />
    {!state.loading && !state.connectionLost && <p className="notice">This session is unavailable.</p>}
  </>;

  const canCheckIn = board.status === "check_in" || board.status === "playing";
  const isClosed = board.status === "closed";
  const full = board.capacity !== null && board.checked_in >= board.capacity;
  const nextFour = board.next_players ?? board.waiting.slice(0, 4).map((player) => player.id);
  const liveGame = board.courts.some((court) => court.game && !court.game.finished_at);
  const playerActions = (player: StackPlayer, waiting: boolean) => (
    <div className={styles.playerActions}>
      {canCheckIn && board.next_players && (
        <select className={styles.skillSelect} aria-label={`Skill level for ${player.name}`}
          value={player.skill_level ?? ""} disabled={busy || state.connectionLost}
          onChange={(event) => void manage("set_skill", { p_player: player.id, p_skill: event.target.value || null })}>
          <SkillOptions />
        </select>
      )}
      {(waiting || canCheckIn) && <button className="button button-small" disabled={busy}
        aria-label={`${waiting ? "Sit out" : "Requeue"} ${player.name}`}
        onClick={() => void manage(waiting ? "pause" : "rejoin", { p_player: player.id })}>
        {waiting ? "Sit out" : "Requeue"}
      </button>}
      <button className="button button-small" disabled={busy}
        aria-label={`Check out ${player.name}`} onClick={() => void manage("leave", { p_player: player.id })}>
        Check out
      </button>
    </div>
  );

  return (
    <>
      <BoardHeading board={board} />
      <StackFeedback {...state} />
      <div className={styles.controls}>
        <button className="button button-dark button-small" onClick={() => setShare({ path: playerBoardPath(session), scorekeeper: false })}>
          <QrCode size={17} aria-hidden="true" /> Player board QR
        </button>
        <Link className="button button-small" href={playerBoardPath(session)} target="_blank" rel="noreferrer">
          Open player board <ExternalLink size={15} aria-hidden="true" />
        </Link>
        {!isClosed && <button className="button button-small" disabled={busy || liveGame} onClick={() => setConfirmClose(true)}>
          Close session
        </button>}
      </div>
      {confirmClose && !isClosed && (
        <div className={styles.controls}>
          <p>Close check-in and the waiting queue for this session?</p>
          <button className="button button-dark button-small" disabled={busy} onClick={async () => {
            await manage("close");
            setConfirmClose(false);
          }}>Close this session</button>
          <button className="button button-small" disabled={busy} onClick={() => setConfirmClose(false)}>Keep open</button>
        </div>
      )}
      {canCheckIn && (
        <form onSubmit={checkIn} className={`panel ${styles.panel} ${styles.checkIn}`}>
          <div>
            <h2>Check in a player</h2>
            <p className={styles.muted}>{board.checked_in}{board.capacity !== null ? ` / ${board.capacity}` : ""} checked in{full ? " · Session full" : ""}</p>
          </div>
          <label className="field">
            <span>Display name</span>
            <input placeholder="First name or nickname" value={name} maxLength={40} minLength={2} required
              disabled={busy || full} onChange={(event) => {
                setName(event.target.value);
                checkInId.current = null;
              }} />
          </label>
          {board.next_players && <label className="field">
            <span>Skill level</span>
            <select value={skill} disabled={busy || full} onChange={(event) => {
              setSkill(event.target.value as StackSkill | "");
              checkInId.current = null;
            }}>
              <SkillOptions />
            </select>
          </label>}
          <button className="button button-dark" disabled={busy || full || name.trim().length < 2}>
            <UserPlus size={17} aria-hidden="true" /> Add to queue
          </button>
        </form>
      )}
      <div className={styles.courts}>
        {board.courts.map((court) => (
          <CourtScore key={court.id} court={court} busy={busy || state.connectionLost} onScore={isClosed ? undefined : score}>
            {!isClosed && (
              <div className={styles.controls}>
                <button className="button button-dark button-small"
                  disabled={busy || state.connectionLost || board.status !== "playing" || !court.active ||
                    nextFour.length < 4 || Boolean(court.game && !court.game.finished_at)}
                  onClick={() => void manage("call", { p_court: court.id, p_expected: nextFour })}>
                  Call next 4
                </button>
                <button className="button button-small" disabled={busy || !court.active} onClick={async () => {
                  const result = await manage("assign", { p_court: court.id });
                  if (typeof result?.data === "string")
                    setShare({ path: `${playerBoardPath(session)}#score=${result.data}`, scorekeeper: true });
                }}>{court.has_scorekeeper ? "Replace scorer link" : "Assign scorekeeper"}</button>
                {court.has_scorekeeper && <button className="button button-small" disabled={busy}
                  onClick={() => void manage("revoke", { p_court: court.id })}>Revoke scorer link</button>}
              </div>
            )}
          </CourtScore>
        ))}
      </div>
      {!isClosed && (
        <div className={styles.queues}>
          <PlayerOrder waiting={board.waiting} nextPlayers={nextFour} actions={(player) => playerActions(player, true)}
            queueControl={canCheckIn && (
              <button type="button" className="button button-small"
                disabled={busy || state.connectionLost || board.waiting.length < 2}
                onClick={() => void run("paddle_stack_shuffle", { p_expected: board.waiting.map((player) => player.id) })}>
                <Shuffle size={16} aria-hidden="true" /> Shuffle queue
              </button>
            )} />
          <section className={`panel ${styles.panel}`}>
            <h2>Sitting out</h2>
            {board.resting.length ? (
              <ul className={styles.players}>
                {board.resting.map((player) => <li key={player.id}><strong>{player.name}</strong>{playerActions(player, false)}</li>)}
              </ul>
            ) : <p className={styles.muted}>Use Sit out to give a player a break. Select Requeue when they’re ready.</p>}
          </section>
        </div>
      )}
      {board.results.length > 0 && (
        <section className={`panel ${styles.panel}`}>
          <h2>Recent results</h2>
          <ul className={styles.results}>
            {board.results.map((game) => (
              <li key={game.id}>
                <span>{game.court_name}</span>
                <span>{game.players.slice(0, 2).join(" & ")}</span>
                <strong>{game.team_a}–{game.team_b}</strong>
                <span>{game.players.slice(2).join(" & ")}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {share && <BoardShare {...share} onClose={() => setShare(null)} closing={shareClosing} />}
    </>
  );
}

export function PaddleStackLive({ session }: { session: string }) {
  const [scorer, setScorer] = useState<string | null>(null);
  const [scorerRequested, setScorerRequested] = useState(false);
  useEffect(() => {
    function readHash() {
      const key = new URLSearchParams(window.location.hash.slice(1)).get("score");
      const valid = z.uuid().safeParse(key);
      setScorer(valid.success ? valid.data : null);
      setScorerRequested(key !== null);
    }
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, []);
  return <LiveBoard session={session} scorer={scorer} scorerRequested={scorerRequested} key={scorer ?? session} />;
}

function LiveBoard({ session, scorer, scorerRequested }: {
  session: string;
  scorer: string | null;
  scorerRequested: boolean;
}) {
  const state = useStackBoard(session, false, scorer);
  const { board, busy, score } = state;
  return (
    <div className={styles.stack}>
      <StackFeedback {...state} />
      {!board ? (!state.loading && !state.connectionLost && <p className="notice">This live board has expired or is unavailable.</p>) : (
        <>
          <BoardHeading board={board} />
          {scorerRequested && (
            <p className="notice" role="status">
              {board.score_court === null
                ? "This scorekeeper link has expired. Ask staff for a new one."
                : `You’re keeping score for ${board.courts.find((court) => court.id === board.score_court)?.name}.`}
            </p>
          )}
          <div className={styles.courts}>
            {board.courts.map((court) => (
              <CourtScore key={court.id} court={court} busy={busy || state.connectionLost}
                onScore={court.id === board.score_court ? score : undefined} />
            ))}
          </div>
          {(board.status === "check_in" || board.status === "playing") && <PlayerOrder waiting={board.waiting} nextPlayers={board.next_players} />}
        </>
      )}
    </div>
  );
}
