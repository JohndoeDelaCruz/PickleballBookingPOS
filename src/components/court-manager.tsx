"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, Plus, Save, Trash2 } from "lucide-react";
import { deleteCourt, saveCourt } from "@/app/actions";
import { activeCourts, type Court } from "@/lib/courts";
import { Modal } from "./modal";

export function CourtManager({ initial, ready, onChange }: {
  initial: Court[]; ready: boolean; onChange: (courts: Court[]) => void;
}) {
  const [courts, setCourts] = useState(initial);
  const currentCourts = useRef(initial);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  useEffect(() => { currentCourts.current = initial; setCourts(initial); }, [initial]);
  function saved(court: Court) {
    const next = currentCourts.current.some((c) => c.id === court.id)
      ? currentCourts.current.map((c) => c.id === court.id ? court : c) : [...currentCourts.current, court];
    currentCourts.current = next;
    setCourts(next);
    onChange(next);
    setMessage(`${court.name} saved. ${activeCourts(next).length} active courts are available.`);
    router.refresh();
  }
  function deleted(court: Court) {
    const next = currentCourts.current.filter((c) => c.id !== court.id);
    currentCourts.current = next;
    setCourts(next);
    onChange(next);
    setMessage(`${court.name} deleted.`);
    router.refresh();
  }
  return (
    <section id="venue-courts" className="console-panel settings-card">
      <header className="settings-card-heading">
        <span className="settings-card-icon"><CalendarDays size={20} /></span>
        <div><h2>Courts</h2></div>
        <span className="subtle-pill court-count">{activeCourts(courts).length} active · {courts.length} total</span>
      </header>
      <div className="settings-card-body">
        {!ready && <div className="notice notice-warning" role="status">Court management is awaiting setup. Your existing courts remain available; court changes are disabled for now.</div>}
        <div className="court-manager-list">
          {courts.map((court) => <CourtRow key={`${court.id}:${court.revision}`} court={court} ready={ready} onSaved={saved} onDeleted={deleted} />)}
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
        <details className="workspace-disclosure">
          <summary>About deactivating and deleting courts</summary>
          <p className="small-print">Inactive courts keep their booking history. Resolve upcoming bookings, blocks, and shared open-play reservations before deactivating. Only courts without booking or block records can be deleted. Adding courts does not change open-play player limits.</p>
        </details>
      </div>
    </section>
  );
}

function CourtRow({ court, ready, onSaved, onDeleted }: {
  court: Court; ready: boolean; onSaved: (court: Court) => void; onDeleted: (court: Court) => void;
}) {
  const [name, setName] = useState(court.name);
  const [active, setActive] = useState(court.active);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const changed = name.trim() !== court.name || active !== court.active;
  return <><form className="court-manager-row" onSubmit={(event) => {
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
    <div className="court-row-actions">
      <button className="console-button" aria-label={`Save court ${court.id}`} disabled={!ready || pending || !changed}>
        <Save size={15} />{pending && !confirming ? "Saving…" : "Save"}
      </button>
      <button type="button" className="console-button court-delete-button" aria-label={`Delete court ${court.id}`}
        disabled={!ready || pending} onClick={() => { setError(""); setConfirming(true); }}>
        <Trash2 size={15} />Delete
      </button>
    </div>
    {error && !confirming && <div className="error-message court-row-error" role="alert">{error}</div>}
  </form>
    {confirming && <Modal title="Delete court?" onClose={() => { if (!pending) { setConfirming(false); setError(""); } }}>
      <p>Delete <strong>{court.name}</strong> (Court #{court.id})? This permanently removes the court. Courts with booking or block history must be deactivated instead.</p>
      {error && <div className="error-message" role="alert">{error}</div>}
      <div className="court-delete-actions">
        <button type="button" className="console-button" disabled={pending} onClick={() => { setConfirming(false); setError(""); }}>Cancel</button>
        <button type="button" className="console-button court-delete-button" disabled={pending} onClick={() => {
          setError("");
          startTransition(async () => {
            const result = await deleteCourt({ id: court.id, revision: court.revision });
            if (result.error) setError(result.error);
            else if (result.deletedId === court.id) onDeleted(court);
          });
        }}><Trash2 size={15} />{pending ? "Deleting…" : "Delete court"}</button>
      </div>
    </Modal>}
  </>;
}
