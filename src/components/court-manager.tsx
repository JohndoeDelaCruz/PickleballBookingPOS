"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, Plus, Save } from "lucide-react";
import { saveCourt } from "@/app/actions";
import { activeCourts, type Court } from "@/lib/courts";

export function CourtManager({ initial, ready, onChange }: {
  initial: Court[]; ready: boolean; onChange: (courts: Court[]) => void;
}) {
  const [courts, setCourts] = useState(initial);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  useEffect(() => { setCourts(initial); }, [initial]);
  function saved(court: Court) {
    const next = courts.some((c) => c.id === court.id)
      ? courts.map((c) => c.id === court.id ? court : c) : [...courts, court];
    setCourts(next);
    onChange(next);
    setMessage(`${court.name} saved. ${activeCourts(next).length} active courts are available.`);
    router.refresh();
  }
  return (
    <section id="venue-courts" className="console-panel settings-card">
      <header className="settings-card-heading">
        <span className="settings-card-icon"><CalendarDays size={20} /></span>
        <div><h2>Courts</h2><p>Add courts, choose their names, and manage availability.</p></div>
        <span className="subtle-pill court-count">{activeCourts(courts).length} active · {courts.length} total</span>
      </header>
      <div className="settings-card-body">
        {!ready && <div className="notice notice-warning" role="status">Court management is awaiting setup. Your existing courts remain available; court changes are disabled for now.</div>}
        <p className="small-print">Active courts appear in booking and the workspace. Inactive courts keep their history. Resolve upcoming court bookings, blocks, and shared open-play reservations before deactivating a court.</p>
        <div className="court-manager-list">
          {courts.map((court) => <CourtRow key={`${court.id}:${court.revision}`} court={court} ready={ready} onSaved={saved} />)}
        </div>
        {!courts.length && <p className="small-print">No courts yet. Add your first court to get started.</p>}
        <form className="court-add-form" onSubmit={(event) => {
          event.preventDefault(); setError(""); setMessage("");
          startTransition(async () => {
            const result = await saveCourt({ id: null, revision: null, name, active: true });
            if (result.error) setError(result.error);
            else if (result.court) { saved(result.court); setName(""); }
          });
        }}>
          <label className="field"><span>New court name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60}
              placeholder={`Court ${Math.max(0, ...courts.map((c) => c.id)) + 1}`} disabled={!ready || pending || courts.length >= 100} />
          </label>
          <button className="console-button primary" disabled={!ready || pending || courts.length >= 100}>
            <Plus size={16} />{pending ? "Adding…" : "Add court"}
          </button>
        </form>
        {error && <div className="error-message" role="alert">{error}</div>}
        {message && <div className="success-message" role="status">{message}</div>}
        <p className="small-print">Court changes save here separately from venue preferences and hours. Open-play player limits stay as configured when courts are added.</p>
      </div>
    </section>
  );
}

function CourtRow({ court, ready, onSaved }: { court: Court; ready: boolean; onSaved: (court: Court) => void }) {
  const [name, setName] = useState(court.name);
  const [active, setActive] = useState(court.active);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const changed = name.trim() !== court.name || active !== court.active;
  return <form className="court-manager-row" onSubmit={(event) => {
    event.preventDefault(); setError("");
    startTransition(async () => {
      const result = await saveCourt({ id: court.id, revision: court.revision, name, active });
      if (result.error) setError(result.error);
      else if (result.court) onSaved(result.court);
    });
  }}>
    <label className="field"><span>Court #{court.id}</span>
      <input aria-label={`Name for court ${court.id}`} value={name} maxLength={60} required
        onChange={(e) => setName(e.target.value)} disabled={!ready || pending} />
    </label>
    <label className="court-active-toggle"><input type="checkbox" checked={active}
      aria-label={`Active court ${court.id}`} onChange={(e) => setActive(e.target.checked)} disabled={!ready || pending} />Active</label>
    <button className="console-button" aria-label={`Save court ${court.id}`} disabled={!ready || pending || !changed}>
      <Save size={15} />{pending ? "Saving…" : "Save court"}
    </button>
    {error && <div className="error-message court-row-error" role="alert">{error}</div>}
  </form>;
}
