import type { CSSProperties, ReactNode } from "react";
import type { WorkspaceView } from "@/lib/workspace";
import styles from "./workspace-skeleton.module.css";

const labels: Record<WorkspaceView, string> = {
  overview: "club overview", pos: "point of sale", bookings: "reservations",
  inventory: "inventory", transactions: "transactions", reports: "sales reports",
  calendar: "court calendar", finance: "booking finance", settings: "venue settings", account: "account settings",
};
const tones = ["lime", "lavender", "peach", "blue"];

function Block({ className = "" }: { className?: string }) {
  return <span className={`${styles.block} ${className}`} />;
}
function Heading() {
  return <div className="console-page-heading">
    <div className={styles.heading}><Block className={styles.title} /></div>
    <Block className={styles.action} />
  </div>;
}
function Stats({ count = 4, settings = false, finance = false }: { count?: number; settings?: boolean; finance?: boolean }) {
  return <div className={settings ? "settings-metrics" : finance ? "finance-stats" : count === 3 ? "admin-stats" : "metrics-grid"}>
    {Array.from({ length: count }, (_, index) => <div className={`metric-card ${tones[settings ? (index + 3) % 4 : finance ? index % 3 : index % 4]} ${styles.metric}`} key={index}>
      <Block className={styles.label} /><Block className={styles.value} /><Block className={styles.hint} />
    </div>)}
  </div>;
}
function Toolbar() {
  return <div className={styles.toolbar}><Block className={styles.search} /><Block className={styles.action} /></div>;
}
function Panel({ children }: { children: ReactNode }) {
  return <section className="console-panel"><div className="panel-heading"><Block className={styles.label} /></div><div className={styles.panelBody}>{children}</div></section>;
}
function Table({ columns = 5, rows = 5 }: { columns?: number; rows?: number }) {
  return <section className={`console-panel ${styles.tableScroll}`}>
    {Array.from({ length: rows + 1 }, (_, row) => <div key={row} className={`${styles.tableRow} ${row === 0 ? styles.tableHeader : ""}`}
      style={{ "--skeleton-columns": columns } as CSSProperties}>
      {Array.from({ length: columns }, (_, column) => <Block key={column} />)}
    </div>)}
  </section>;
}
function Fields({ count = 4 }: { count?: number }) {
  return <div className={`field-grid ${styles.fields}`}>{Array.from({ length: count }, (_, index) => <div className={styles.field} key={index}><Block className={styles.label} /><Block className={styles.input} /></div>)}</div>;
}
function Overview({ courtCount = 2 }: { courtCount?: number }) {
  return <><Stats /><div className="overview-grid">
    <Panel>{Array.from({ length: Math.min(4, courtCount) }, (_, index) => <div className={styles.timeline} key={index}><Block className={styles.square} /><Block className={styles.label} /><Block className={styles.session} /></div>)}</Panel>
    <Panel><Block className={styles.line} /><Block className={styles.line} /><Block className={styles.line} /></Panel>
  </div><Table rows={3} /></>;
}
function PointOfSale() {
  return <div className="pos-layout">
    <div><Toolbar /><div className="product-grid">{Array.from({ length: 6 }, (_, index) => <div className={`console-panel ${styles.product}`} key={index}>
      <Block className={styles.productImage} /><Block className={styles.line} /><Block className={styles.label} />
    </div>)}</div></div>
    <Panel><Block className={styles.cart} /><Block className={styles.line} /><Block className={styles.line} /><Block className={styles.button} /></Panel>
  </div>;
}
function Calendar({ courtCount = 2 }: { courtCount?: number }) {
  const columns = Math.max(1, courtCount);
  return <><Stats count={3} /><Toolbar /><div className={`console-panel ${styles.tableScroll}`}>
    {Array.from({ length: 9 }, (_, row) => <div className={`${styles.calendarRow} ${row === 0 ? styles.tableHeader : ""}`} key={row}
      style={{ "--skeleton-courts": columns } as CSSProperties}>
      <Block />{Array.from({ length: columns }, (_, court) => <Block key={court} className={styles.slot} />)}
    </div>)}
  </div></>;
}
function Finance({ courtCount = 2, daily = false }: { courtCount?: number; daily?: boolean }) {
  return <><div className="workspace-tabs"><Block className={styles.tab} /><Block className={styles.tab} /></div><Toolbar />
    {daily ? <><div className="finance-day-totals">{Array.from({ length: Math.min(8, courtCount + 2) }, (_, index) => <div key={index}><Block className={styles.label} /><Block className={styles.value} /><Block className={styles.hint} /></div>)}</div><Panel><Fields count={2} /></Panel><Table columns={8} rows={4} /></>
      : <><Stats count={6} finance /><Block className={styles.reportNote} /><Table columns={Math.min(12, courtCount * 2 + 6)} rows={6} /></>}
  </>;
}
function Settings() {
  return <><div className={styles.toolbar}><Block className={styles.label} /><Block className={styles.label} /></div>
    <div className="workspace-tabs">{Array.from({ length: 6 }, (_, index) => <Block className={styles.tab} key={index} />)}</div>
    <div className="venue-settings-layout"><div className={styles.stack}>
      <Panel><Fields count={7} /></Panel><Block className={styles.button} /><Block className={styles.button} />
    </div></div>
  </>;
}
function Account() {
  return <div className="workspace-account-grid"><Panel><Block className={styles.line} /><div className={styles.stack}>{Array.from({ length: 3 }, (_, index) => <div className={styles.field} key={index}><Block className={styles.label} /><Block className={styles.input} /></div>)}</div><Block className={styles.button} /></Panel>
    <Panel><Block className={styles.label} /><Block className={styles.line} /><Block className={styles.description} /></Panel></div>;
}
function Reports() {
  return <><Stats /><div className="overview-grid"><Panel><div className={styles.chart}>{Array.from({ length: 7 }, (_, index) => <Block key={index} className={styles.bar} />)}</div></Panel><Panel><Block className={styles.notice} /><Block className={styles.line} /><Block className={styles.line} /></Panel></div><Table rows={3} /></>;
}

export function WorkspaceSkeleton({ view, heading = true, courtCount, financeView = "month" }: {
  view: WorkspaceView; heading?: boolean; courtCount?: number; totalCourtCount?: number; financeView?: "daily" | "month";
}) {
  return <>
    <p className="sr-only" role="status">Loading {labels[view]}…</p>
    <section className={styles.content} aria-busy="true" aria-label={`Loading ${labels[view]}`} data-workspace-skeleton={view}>
    <div aria-hidden="true">
      {heading && <Heading />}
      {view === "overview" ? <Overview courtCount={courtCount} />
        : view === "pos" ? <PointOfSale />
        : view === "calendar" ? <Calendar courtCount={courtCount} />
        : view === "finance" ? <Finance courtCount={courtCount} daily={financeView === "daily"} />
        : view === "settings" ? <Settings />
        : view === "account" ? <Account />
        : view === "reports" ? <Reports />
        : <>{view === "inventory" && <div className={styles.summary}><Block /><Block /><Block /></div>}<Toolbar /><Table columns={view === "inventory" ? 6 : 5} /></>}
    </div>
  </section></>;
}
