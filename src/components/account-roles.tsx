"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { setAccountRole } from "@/app/(workspace)/admin/access/actions";
import { accountRoleLabels, accountRolesHref, type AccountRole, type ManagedAccount } from "@/lib/account-roles";
import { Modal } from "./modal";
import { TablePagination } from "./table-pagination";
import { useAnimatedModal } from "./use-animated-modal";
import { WorkspacePageHeading } from "./workspace-page-heading";
import styles from "./account-roles.module.css";

const descriptions: Record<AccountRole, string> = {
  player: "Customer bookings and open play.",
  cashier: "Register, walk-ins, Paddle Stack, and register expenses.",
  manager: "Venue settings, inventory, finance, and front desk staff access.",
  owner: "Full admin access, including Manager and Owner roles.",
};

type AccountRolesProps = {
  rows: ManagedAccount[];
  count: number;
  page: number;
  pageSize: number;
  query: string;
  owner: boolean;
  userId: string;
};

function AccountSearch({ query }: { query: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const submittedQuery = useRef(query);

  useEffect(() => () => clearTimeout(searchTimeout.current), []);
  useEffect(() => {
    if (query === submittedQuery.current) return;
    clearTimeout(searchTimeout.current);
    submittedQuery.current = query;
    if (input.current) input.current.value = query;
  }, [query]);

  function search(value: string) {
    clearTimeout(searchTimeout.current);
    const nextQuery = value.trim();
    searchTimeout.current = setTimeout(() => {
      if (nextQuery === submittedQuery.current) return;
      submittedQuery.current = nextQuery;
      router.replace(accountRolesHref(nextQuery), { scroll: false });
    }, 250);
  }

  return <div role="search" aria-label="Find accounts" className={styles.search}>
    <label className="field">
      <span className="sr-only">Search by name or email</span>
      <input ref={input} name="q" type="search" defaultValue={query} maxLength={254}
        placeholder="Search by name or email" onChange={(event) => search(event.currentTarget.value)} />
    </label>
  </div>;
}

export function AccountRoles(props: AccountRolesProps) {
  return <>
    <WorkspacePageHeading title="Access" />
    <section className="console-panel" aria-labelledby="account-roles">
      <div className={`panel-heading ${styles.toolbar}`}>
        <h2 id="account-roles">Account roles</h2>
        <AccountSearch query={props.query} />
      </div>
      <AccountRoleResults key={accountRolesHref(props.query, props.page)} {...props} />
    </section>
  </>;
}

function AccountRoleResults({ rows, count, page, pageSize, query, owner, userId }: AccountRolesProps) {
  const [account, setAccount, closing] = useAnimatedModal<ManagedAccount>();
  const [status, setStatus] = useState("");

  return <>
    {status && <p className={`success-message ${styles.status}`} role="status">{status}</p>}
    {rows.length > 0 && (
      <TablePagination count={count} page={page} pageSize={pageSize} label="Account pages" showSinglePage
        href={(nextPage) => accountRolesHref(query, nextPage)} />
    )}
    {rows.length ? (
      <div className="console-table-wrap" tabIndex={0} role="region" aria-labelledby="account-roles">
        <table className={`console-table ${styles.table}`}>
          <thead><tr><th scope="col">Account</th><th scope="col">Role</th><th scope="col">Action</th></tr></thead>
          <tbody>
            {rows.map((row) => {
              const ownAccount = row.id === userId;
              const canEdit = !ownAccount && (owner || row.role === "player" || row.role === "cashier")
                && (row.email_confirmed || row.role !== "player");
              return <tr key={row.id}>
                <td className={styles.email}>
                  <strong>{row.full_name || row.email}</strong>
                  {row.full_name && <small>{row.email}</small>}
                  {ownAccount && <small>Your account</small>}
                  {!row.email_confirmed && <small>Email confirmation pending</small>}
                </td>
                <td>{accountRoleLabels[row.role]}</td>
                <td>{canEdit ? (
                  <button className="button button-outline button-small" type="button"
                    aria-label={`Edit role for ${row.full_name ? `${row.full_name} (${row.email})` : row.email}`}
                    onClick={() => { setStatus(""); setAccount(row); }}>Edit role</button>
                ) : <span className="small-print">
                  {ownAccount ? "Your role" : (row.role === "owner" || row.role === "manager") ? "Owner only" : "Awaiting confirmation"}
                </span>}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    ) : <p className="panel-empty-note">{query ? "No accounts match this search." : "No accounts found."}</p>}
    {account && <RoleDialog key={account.id} account={account} owner={owner} closing={closing}
      onClose={() => setAccount(null)} onSaved={(role) => {
        setStatus(`${account.full_name || account.email} now has ${accountRoleLabels[role]} access.`);
        setAccount(null);
      }} />}
  </>;
}

function RoleDialog({ account, owner, closing, onClose, onSaved }: {
  account: ManagedAccount;
  owner: boolean;
  closing: boolean;
  onClose: () => void;
  onSaved: (role: AccountRole) => void;
}) {
  const [role, setRole] = useState(account.role);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const options: AccountRole[] = account.email_confirmed
    ? owner ? ["player", "cashier", "manager", "owner"] : ["player", "cashier"]
    : ["player", account.role];

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || closing || role === account.role) return;
    setError("");
    startTransition(async () => {
      try {
        const result = await setAccountRole({ id: account.id, current: account.role, next: role });
        if (result.error) setError(result.error);
        else onSaved(role);
      } catch {
        setError("Couldn’t confirm the role change. Refresh Access to check the saved role.");
      }
    });
  }

  return <Modal title="Edit account role" closing={closing} onClose={() => !pending && onClose()}>
    <form className="form-stack" onSubmit={save}>
      <div className={styles.email}>
        <strong>{account.full_name || account.email}</strong>
        {account.full_name && <p className="small-print">{account.email}</p>}
        <p className="small-print">Current role: {accountRoleLabels[account.role]}</p>
      </div>
      <label className="field">
        <span>New role</span>
        <select value={role} disabled={pending} onChange={(event) => {
          const value = options.find((item) => item === event.target.value);
          if (value) setRole(value);
          setError("");
        }}>
          {options.map((option) => <option key={option} value={option}>{accountRoleLabels[option]}</option>)}
        </select>
        <small>{descriptions[role]}</small>
      </label>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className={styles.actions}>
        <button className="button button-outline" type="button" onClick={onClose} disabled={pending || closing}>Cancel</button>
        <button className="button button-dark" disabled={pending || closing || role === account.role}>{pending ? "Saving…" : "Save role"}</button>
      </div>
    </form>
  </Modal>;
}
