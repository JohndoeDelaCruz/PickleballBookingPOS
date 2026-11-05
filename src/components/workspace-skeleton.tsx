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
    <div className={styles.heading}><Block className={styles.kicker} /><Block className={styles.title} /><Block className={styles.description} /></div>
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
function Finance({ courtCount = 2 }: { courtCount?: number }) {
  return <><Toolbar /><Stats count={6} finance /><Block className={styles.reportNote} /><Table columns={Math.min(12, courtCount * 2 + 6)} rows={6} /></>;
}
function Settings({ totalCourtCount = 2 }: { totalCourtCount?: number }) {
  return <><Stats settings /><div className="settings-section-nav">{Array.from({ length: 6 }, (_, index) => <Block className={styles.tab} key={index} />)}</div>
    <div className="venue-settings-layout"><div className={styles.stack}>
      <Panel><Block className={styles.description} />
        {Array.from({ length: Math.min(3, totalCourtCount) }, (_, index) => <div className={styles.courtRow} key={index}>
          <div className={styles.field}><Block className={styles.label} /><Block className={styles.input} /></div>
          <Block className={styles.toggle} /><Block className={styles.courtButton} />
        </div>)}
        <div className={styles.courtAdd}><Block className={styles.input} /><Block className={styles.courtButton} /></div>
        <Block className={styles.line} />
      </Panel>
      <Panel><Fields /></Panel>
    </div><Panel><Block className={styles.line} />{Array.from({ length: 5 }, (_, index) => <div className={styles.checklist} key={index}><Block className={styles.dot} /><Block /></div>)}<Block className={styles.notice} /></Panel></div>
  </>;
}
function Account() {
  return <div className="workspace-account-grid"><Panel><Block className={styles.line} /><div className={styles.stack}>{Array.from({ length: 3 }, (_, index) => <div className={styles.field} key={index}><Block className={styles.label} /><Block className={styles.input} /></div>)}</div><Block className={styles.button} /></Panel>
    <Panel><Block className={styles.label} /><Block className={styles.line} /><Block className={styles.description} /></Panel></div>;
}
function Reports() {
  return <><Stats /><div className="overview-grid"><Panel><div className={styles.chart}>{Array.from({ length: 7 }, (_, index) => <Block key={index} className={styles.bar} />)}</div></Panel><Panel><Block className={styles.notice} /><Block className={styles.line} /><Block className={styles.line} /></Panel></div><Table rows={3} /></>;
}

export function WorkspaceSkeleton({ view, heading = true, courtCount, totalCourtCount }: {
  view: WorkspaceView; heading?: boolean; courtCount?: number; totalCourtCount?: number;
}) {
  return <>
    <p className="sr-only" role="status">Loading {labels[view]}…</p>
    <section className={styles.content} aria-busy="true" aria-label={`Loading ${labels[view]}`} data-workspace-skeleton={view}>
    <div aria-hidden="true">
      {heading && <Heading />}
      {view === "overview" ? <Overview courtCount={courtCount} />
        : view === "pos" ? <PointOfSale />
        : view === "calendar" ? <Calendar courtCount={courtCount} />
        : view === "finance" ? <Finance courtCount={courtCount} />
        : view === "settings" ? <Settings totalCourtCount={totalCourtCount} />
        : view === "account" ? <Account />
        : view === "reports" ? <Reports />
        : <>{view === "inventory" && <div className={styles.summary}><Block /><Block /><Block /></div>}<Toolbar /><Table columns={view === "inventory" ? 6 : 5} /></>}
    </div>
  </section></>;
}
