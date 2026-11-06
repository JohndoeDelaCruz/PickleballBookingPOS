"use client";

export function WorkspaceTabs<T extends string>({ id, label, items, value, onChange }: {
  id: string;
  label: string;
  items: readonly { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return <div className="workspace-tabs" role="tablist" aria-label={label}>
    {items.map((item, index) => <button key={item.id} type="button" role="tab"
      id={`${id}-tab-${item.id}`} aria-controls={`${id}-panel-${item.id}`}
      aria-selected={value === item.id} tabIndex={value === item.id ? 0 : -1}
      onClick={() => onChange(item.id)} onKeyDown={(event) => {
        const next = event.key === "ArrowRight" ? (index + 1) % items.length
          : event.key === "ArrowLeft" ? (index + items.length - 1) % items.length
          : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : undefined;
        if (next === undefined) return;
        event.preventDefault();
        onChange(items[next].id);
        document.getElementById(`${id}-tab-${items[next].id}`)?.focus();
      }}>{item.label}</button>)}
  </div>;
}
