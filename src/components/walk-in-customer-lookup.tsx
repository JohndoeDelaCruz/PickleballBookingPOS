"use client";

import { useState, useTransition } from "react";
import { findWalkInCustomers, type WalkInCustomer } from "@/app/(workspace)/staff/actions";

export function WalkInCustomerLookup({ date, customer, onChange }: {
  date: string;
  customer: WalkInCustomer | null;
  onChange: (customer: WalkInCustomer | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [matches, setMatches] = useState<WalkInCustomer[] | null>(null);
  const [error, setError] = useState("");
  const [searching, startSearch] = useTransition();

  function search(onlyActive = activeOnly) {
    if (query.trim().length < 2 || searching) return;
    setMatches(null);
    setError("");
    startSearch(async () => {
      const result = await findWalkInCustomers({ query, date, activeOnly: onlyActive });
      if ("error" in result) setError(result.error);
      else setMatches(result.customers);
    });
  }

  if (customer) return <div className="court-time-summary walk-in-account-summary">
    <div>
      <strong>{customer.full_name || customer.email}</strong>
      {customer.full_name && <span>{customer.email}</span>}
      {customer.active_membership && <small>Active membership</small>}
    </div>
    <button type="button" className="button button-small button-outline" onClick={() => onChange(null)}>Change account</button>
  </div>;

  return <div className="walk-in-account-lookup">
    <div className="walk-in-account-search">
      <label className="field"><span>Find a customer account</span>
        <input type="search" value={query} maxLength={254} disabled={searching} onChange={(event) => {
          setQuery(event.target.value);
          setMatches(null);
          setError("");
        }} placeholder="Name or full email address" onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          search();
        }} />
      </label>
      <button type="button" className="button button-outline" onClick={() => search()} disabled={searching || query.trim().length < 2}>
        {searching ? "Searching…" : "Find customer"}
      </button>
    </div>
    <label className="walk-in-member-filter">
      <input type="checkbox" checked={activeOnly} disabled={searching} onChange={(event) => {
        const checked = event.target.checked;
        setActiveOnly(checked);
        if (matches !== null) search(checked);
      }} />
      Active members only
    </label>
    {error && <p className="error-message" role="alert">{error}</p>}
    {matches?.length === 0 && <p className="small-print" role="status">
      {activeOnly ? "No members found with an active membership for this date." : "No confirmed customer accounts found."}
    </p>}
    {matches && matches.length > 0 && <ul className="membership-customer-results" aria-label="Matching customer accounts">
      {matches.map((match) => <li key={match.id}>
        <button type="button" className="console-button membership-customer-result" onClick={() => onChange(match)}>
          {match.full_name && <strong>{match.full_name}</strong>}
          <span>{match.email}</span>
          {match.active_membership && <small>Active membership</small>}
        </button>
      </li>)}
    </ul>}
  </div>;
}
