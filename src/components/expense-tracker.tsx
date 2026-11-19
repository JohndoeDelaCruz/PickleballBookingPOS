"use client";

import { useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { recordExpense, voidExpense } from "@/app/(workspace)/staff/expenses/actions";
import { formatDate } from "@/lib/booking";
import { expenseCategories, expensePaymentMethods, expensesPageSize, expensesPath, type Expense, type ExpenseReport } from "@/lib/expenses";
import { peso } from "@/lib/pos";
import { Modal } from "./modal";
import { useAnimatedModal } from "./use-animated-modal";
import { WorkspacePageHeading } from "./workspace-page-heading";
import { TablePagination } from "./table-pagination";
import styles from "./expense-tracker.module.css";

const reportHref = (month: string, page = 1) =>
  `${expensesPath}?month=${month}${page > 1 ? `&page=${page}` : ""}`;

export function ExpenseTracker({ report, month, page, today, manager }: {
  report: ExpenseReport;
  month: string;
  page: number;
  today: string;
  manager: boolean;
}) {
  const router = useRouter();
  const [dialog, setDialog, closing] = useAnimatedModal<
    { kind: "record"; id: string; shift: string | null } | { kind: "void"; expense: Expense }
  >();
  const [status, setStatus] = useState("");
  const close = () => setDialog(null);

  return <>
    <WorkspacePageHeading title="Expenses" actions={(
      <>
        <label className="field">
          <span>Report month</span>
          <input type="month" value={month} min="2000-01" max={today.slice(0, 7)}
            onChange={(event) => {
              if (event.target.value) router.push(reportHref(event.target.value));
            }} />
        </label>
        <button type="button" className="button button-dark" disabled={!manager && !report.active_shift}
          onClick={() => setDialog({ kind: "record", id: crypto.randomUUID(), shift: report.active_shift })}>
          <Plus size={17} aria-hidden="true" /> Add expense
        </button>
      </>
    )} />
    {!manager && !report.active_shift && (
      <p className="notice"><span><Link href="/staff?tab=reports" className="text-link">Open your shift</Link> to record cash expenses from the register.</span></p>
    )}
    {status && <p className="notice" role="status">{status}</p>}
    <dl className={styles.totals}>
      <div className="panel">
        <dt>{manager ? "Total expenses" : "Your drawer expenses"}</dt>
        <dd>{peso(report.total_cents)}</dd>
      </div>
      {manager && <>
        <div className="panel"><dt>Paid from register</dt><dd>{peso(report.drawer_cents)}</dd></div>
        <div className="panel"><dt>Paid outside register</dt><dd>{peso(report.total_cents - report.drawer_cents)}</dd></div>
      </>}
    </dl>
    <section className="console-panel" aria-labelledby="expense-log">
      <div className="panel-heading">
        <h2 id="expense-log">{formatDate(`${month}-01`, { month: "long", year: "numeric" })} expense log</h2>
      </div>
      {report.rows.length ? (
        <div className="console-table-wrap" tabIndex={0} role="region" aria-labelledby="expense-log">
          <table className={`console-table ${styles.table}`}>
            <thead>
              <tr>
                <th scope="col">Date paid</th>
                <th scope="col">Description</th>
                <th scope="col">Category</th>
                <th scope="col">Payment</th>
                <th scope="col">Amount</th>
                {manager && <th scope="col">Action</th>}
              </tr>
            </thead>
            <tbody>
              {report.rows.map((expense) => (
                <tr key={expense.id}>
                  <td>{formatDate(expense.expense_date, { month: "short", day: "numeric" })}</td>
                  <td className={styles.description}>
                    <strong>{expense.description}</strong>
                    {expense.void_reason && <small>Voided · {expense.void_reason}</small>}
                  </td>
                  <td>{expenseCategories[expense.category]}</td>
                  <td>{expense.shift_id ? "Register cash" : expensePaymentMethods[expense.payment_method]}</td>
                  <td>{peso(expense.amount_cents)}</td>
                  {manager && <td>
                    {!expense.voided_at && <button type="button" className="button button-small"
                      aria-label={`Void ${expense.description}`}
                      onClick={() => setDialog({ kind: "void", expense })}>Void</button>}
                  </td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="panel-empty-note">No expenses recorded for this month.</p>}
      <TablePagination count={report.row_count} page={page} pageSize={expensesPageSize} label="Expense pages"
        href={(nextPage) => `${reportHref(month, nextPage)}#expense-log`} />
    </section>
    {dialog?.kind === "record" && <RecordExpenseDialog key={dialog.id} id={dialog.id} shift={dialog.shift}
      today={today} manager={manager} closing={closing} onClose={close} onSaved={(date) => {
        close();
        setStatus("Expense recorded.");
        if (date.slice(0, 7) !== month || page !== 1) router.push(reportHref(date.slice(0, 7)));
      }} />}
    {dialog?.kind === "void" && <VoidExpenseDialog key={dialog.expense.id} expense={dialog.expense}
      closing={closing} onClose={close} onSaved={() => {
        close();
        setStatus("Expense voided.");
      }} />}
  </>;
}

function RecordExpenseDialog({ id, shift, today, manager, closing, onClose, onSaved }: {
  id: string; shift: string | null; today: string; manager: boolean; closing: boolean;
  onClose: () => void; onSaved: (date: string) => void;
}) {
  const [payment, setPayment] = useState(manager ? "" : "drawer");
  const [date, setDate] = useState(today);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const drawer = payment === "drawer";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setError("");
    startTransition(async () => {
      try {
        const result = await recordExpense({
          id, date: drawer ? null : date, category: fields.get("category"),
          description: fields.get("description"), amount: fields.get("amount"),
          method: drawer ? "cash" : payment, shift: drawer ? shift : null,
        });
        if ("date" in result && result.date) onSaved(result.date);
        else if ("error" in result && result.error) setError(result.error);
      } catch {
        setError("Connection interrupted. Retry the same expense to confirm it was saved.");
      }
    });
  }

  return <Modal title="Add expense" closing={closing} onClose={() => !pending && onClose()}>
    <form className="form-stack" onSubmit={submit}>
      <label className="field">
        <span>Description</span>
        <input name="description" required minLength={2} maxLength={200} disabled={pending} autoFocus />
      </label>
      <div className="field-grid">
        <label className="field">
          <span>Category</span>
          <select name="category" required defaultValue="" disabled={pending}>
            <option value="" disabled>Select category</option>
            {Object.entries(expenseCategories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Amount (PHP)</span>
          <input name="amount" inputMode="decimal" required maxLength={10} disabled={pending} />
        </label>
      </div>
      <div className="field-grid">
        <label className="field">
          <span>Paid with</span>
          <select required value={payment} disabled={pending} onChange={(event) => setPayment(event.target.value)}>
            {manager && <option value="" disabled>Select payment method</option>}
            {shift && <option value="drawer">Cash from register</option>}
            {manager && !shift && <option value="drawer" disabled>Cash from register (open shift required)</option>}
            {manager && Object.entries(expensePaymentMethods).map(([value, label]) => (
              <option key={value} value={value}>{value === "cash" ? "Cash outside register" : label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Date paid</span>
          <input type="date" value={drawer ? today : date} min="2000-01-01" max={today}
            required disabled={pending || drawer} onChange={(event) => setDate(event.target.value)} />
        </label>
      </div>
      {drawer && <p className={styles.help}>This amount will be deducted from your shift’s expected cash.</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      <button type="submit" className="button button-dark" disabled={pending}>
        {pending ? "Saving…" : "Record expense"}
      </button>
    </form>
  </Modal>;
}

function VoidExpenseDialog({ expense, closing, onClose, onSaved }: {
  expense: Expense; closing: boolean; onClose: () => void; onSaved: () => void;
}) {
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = new FormData(event.currentTarget).get("reason");
    setError("");
    startTransition(async () => {
      try {
        const result = await voidExpense({ id: expense.id, reason });
        if ("error" in result) setError(result.error);
        else onSaved();
      } catch {
        setError("Connection interrupted. Retry to confirm the expense was voided.");
      }
    });
  }

  return <Modal title="Void expense" closing={closing} onClose={() => !pending && onClose()}>
    <form className="form-stack" onSubmit={submit}>
      <p className={styles.help}>{expense.description} · {peso(expense.amount_cents)}</p>
      {expense.shift_closed && <p className={styles.help}>The closed shift keeps its original cash reconciliation.</p>}
      <label className="field">
        <span>Reason for voiding</span>
        <input name="reason" required minLength={3} maxLength={200} disabled={pending} autoFocus />
      </label>
      {error && <p className="error-message" role="alert">{error}</p>}
      <button type="submit" className="button button-dark" disabled={pending}>
        {pending ? "Voiding…" : "Void expense"}
      </button>
    </form>
  </Modal>;
}
