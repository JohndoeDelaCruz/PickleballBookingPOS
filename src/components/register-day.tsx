"use client";

import { useEffect, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Banknote, Check, ClipboardList, UserRound } from "lucide-react";
import { assignCashier } from "@/app/(workspace)/staff/register-actions";
import { posCommand, type PosCommand } from "@/app/(workspace)/staff/actions";
import { addDays, formatDate, localDate } from "@/lib/booking";
import { centavos, peso, type Shift } from "@/lib/pos";
import type { RegisterDay as RegisterData } from "@/lib/register";
import { Modal } from "./modal";
import { useAnimatedModal } from "./use-animated-modal";
import styles from "./register-day.module.css";

export function OnDutyControl({ data, date, manager, followToday }: {
  data: RegisterData | null; date: string; manager: boolean; followToday: boolean;
}) {
  const router = useRouter();
  const [expired, setExpired] = useState(false);
  const [editing, setEditing, editClosing] = useAnimatedModal<true>();
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!followToday) return;
    const midnight = Date.parse(`${addDays(date, 1)}T00:00:00+08:00`);
    function refreshAfterMidnight() {
      if (Date.now() < midnight) return;
      setExpired(true);
      router.refresh();
    }
    const timer = window.setTimeout(refreshAfterMidnight, Math.max(0, midnight - Date.now()));
    function onVisibilityChange() {
      if (document.visibilityState === "visible") refreshAfterMidnight();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router, date, followToday]);

  const waiting = followToday && expired;
  const assignment = data?.assignment;
  return <div className={styles.row} role="group" aria-label="Staff on duty">
    <span className={styles.rowIcon}><UserRound size={16} aria-hidden="true" /></span>
    <div className={styles.identity}>
      <h2>Staff on duty</h2>
      {data && !waiting ? <>
        <p>{assignment?.name || assignment?.label || "Unassigned"}</p>
        {assignment && !assignment.eligible && <small>No longer eligible</small>}
        {data.operators.length > 0 && <small>Opened register: {data.operators.join(", ")}</small>}
        {status && <small className={styles.saved} role="status">{status}</small>}
      </> : <p role="status">{waiting ? "Checking the new day’s assignment…" : "Staff assignment unavailable"}</p>}
    </div>
    {data && manager && !waiting && <button type="button" className="console-button small" aria-haspopup="dialog"
      onClick={() => { setStatus(""); setEditing(true); }}>
      {assignment ? "Edit assignment" : "Assign staff"}
    </button>}
    {data && !waiting && editing && <AssignmentDialog data={data} date={date} closing={editClosing} onClose={() => setEditing(null)}
      onSaved={(message) => { setStatus(message); setEditing(null); }} />}
  </div>;
}

function AssignmentDialog({ data, date, closing, onClose, onSaved }: {
  data: RegisterData; date: string; closing: boolean; onClose: () => void; onSaved: (message: string) => void;
}) {
  const [original] = useState(data.assignment);
  const [selected, setSelected] = useState(original?.id ?? "");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const unchanged = selected === (original?.id ?? "");

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (unchanged || pending || closing) return;
    setError("");
    startTransition(async () => {
      try {
        const result = await assignCashier({ date, expected: original?.id ?? null, cashier: selected || null });
        if (result.error) setError(result.error);
        else onSaved(selected ? "Staff assignment saved." : "Staff assignment cleared.");
      } catch {
        setError("Couldn’t confirm the assignment. Refresh to see who’s on duty.");
      }
    });
  }

  return <Modal title="Staff on duty" closing={closing} onClose={() => !pending && onClose()}>
    <form className={styles.form} onSubmit={save}>
      <p className={styles.note}>{formatDate(date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p>
      <label className="field">
        <span>Front desk staff member</span>
        <select value={selected} disabled={pending} onChange={(event) => setSelected(event.target.value)}>
          <option value="">Unassigned</option>
          {original && !data.cashiers.some((cashier) => cashier.id === original.id) && (
            <option value={original.id} disabled>{original.label} · Ineligible</option>
          )}
          {data.cashiers.map((cashier) => <option key={cashier.id} value={cashier.id}>
            {cashier.name ? `${cashier.name} (${cashier.label})` : cashier.label}
          </option>)}
        </select>
        {data.cashiers.length === 0 && <small>Give a confirmed account the Front Desk Staff role under Access first.</small>}
      </label>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className={styles.actions}>
        <button type="button" className="button button-outline" onClick={onClose} disabled={pending || closing}>Cancel</button>
        <button className="button button-dark" disabled={unchanged || pending || closing}>{pending ? "Saving…" : "Save assignment"}</button>
      </div>
    </form>
  </Modal>;
}

export function RegisterControl({ data, shift, operator, ready, compact = false }: {
  data: RegisterData | null; shift?: Shift; operator: string; ready: boolean; compact?: boolean;
}) {
  const [dialog, setDialog, closing] = useAnimatedModal<true>();
  const [status, setStatus] = useState("");
  const someoneElse = shift ? null : data?.active;
  return <div className={compact ? styles.compact : styles.row} role="group" aria-label="Front desk register">
    {!compact && <span className={styles.rowIcon}><Banknote size={16} aria-hidden="true" /></span>}
    <div className={styles.identity}>
      {!compact && <h2>Front desk register</h2>}
      <p><span className={`${styles.dot} ${shift || someoneElse ? styles.active : ""}`} />
        {shift ? (compact ? "Register open" : "Shift open")
          : someoneElse ? `Open · ${someoneElse.label}` : compact ? "Register closed" : "Shift closed"}</p>
      {status && <small className={styles.saved} role="status">{status}</small>}
    </div>
    {!someoneElse && <button type="button" className="console-button small" disabled={!ready} aria-haspopup="dialog"
      onClick={() => { setStatus(""); setDialog(true); }}>
      {shift ? "Close shift" : "Open shift"}
    </button>}
    {dialog && <RegisterShiftDialog shift={shift} operator={operator} closing={closing} onClose={() => setDialog(null)}
      onSaved={(message) => { setStatus(message); setDialog(null); }} />}
  </div>;
}

export function RegisterShiftDialog({ shift, operator, closing, onClose, onSaved, submitCommand = posCommand }: {
  submitCommand?: (command: PosCommand) => { ok: true } | { error: string } | Promise<{ ok: true } | { error: string }>;
  shift?: Shift; operator: string; closing: boolean; onClose: () => void; onSaved: (message: string) => void;
}) {
  const [currentShift] = useState(shift);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const moneyInput = /^\d{1,8}(\.\d{1,2})?$/.test(amount.trim()) ? centavos(amount) : null;
  const valid = moneyInput !== null && moneyInput <= 100_000_000;
  const variance = currentShift && valid ? moneyInput - currentShift.expected_cents : null;
  const unit = currentShift ? "Cash counted" : "Opening cash";
  const timestamp = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || closing) return;
    if (!valid) {
      setError("Enter an amount from ₱0 to ₱1,000,000 with up to two decimal places.");
      return;
    }
    setError("");
    startTransition(async () => {
      try {
        const result = await submitCommand(currentShift
          ? { op: "close", id: currentShift.id, amount: moneyInput }
          : { op: "open", amount: moneyInput });
        if ("error" in result) setError(result.error);
        else onSaved(currentShift ? "Shift closed. Cash count recorded." : "Register shift opened.");
      } catch {
        setError("Couldn’t confirm the shift status. Refresh the register to check.");
      }
    });
  }

  return <Modal title={currentShift ? "Close register shift" : "Open register shift"} className={styles.shiftModal}
    closing={closing} onClose={() => !pending && onClose()}>
    <form onSubmit={submit} className={styles.form}>
      <div className={styles.context}>
        <span className={styles.icon}>{currentShift ? <ClipboardList size={21} aria-hidden="true" /> : <Banknote size={21} aria-hidden="true" />}</span>
        <div className={styles.identity}>
          <strong>Front desk register</strong>
          <small>{operator} · {currentShift
            ? `Opened ${timestamp.format(new Date(currentShift.opened_at))}`
            : formatDate(localDate())}</small>
        </div>
      </div>
      {currentShift && <dl className={styles.amounts}>
        <div><dt>Opening cash</dt><dd>{peso(currentShift.opening_cents)}</dd></div>
        <div><dt>Expected cash in drawer</dt><dd><strong>{peso(currentShift.expected_cents)}</strong></dd></div>
      </dl>}
      <label className={`field ${styles.moneyField}`}>
        <span>{unit}</span>
        <span className={styles.input}>
          <span aria-hidden="true">₱</span>
          <input aria-label={`${unit} (PHP)`} type="text" inputMode="decimal" value={amount} placeholder="0.00" required
            disabled={pending} onChange={(event) => { setAmount(event.target.value); setError(""); }} />
        </span>
        <small>{currentShift ? "Count the bills and coins in the drawer before closing." : "Count the starting cash before you take your first payment."}</small>
      </label>
      {currentShift && <div className={styles.variance} data-mismatch={variance !== null && variance !== 0} aria-live="polite">
        <span>{variance === null ? "Cash difference" : variance === 0 ? "Cash count matches" : variance > 0 ? "Over by" : "Short by"}</span>
        <strong>{variance === null ? "—" : peso(Math.abs(variance))}</strong>
      </div>}
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className={styles.actions}>
        <button className="button button-outline" type="button" disabled={pending || closing} onClick={onClose}>Cancel</button>
        <button className="button button-dark" disabled={pending || closing}>
          {pending ? "Saving…" : currentShift ? "Close shift" : "Open shift"} <Check size={16} aria-hidden="true" />
        </button>
      </div>
    </form>
  </Modal>;
}
