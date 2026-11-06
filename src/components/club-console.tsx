"use client";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ShoppingBasket,
  ChevronRight,
  CalendarDays,
  Package,
  ReceiptText,
  ChartNoAxesCombined,
  ArrowUpRight,
  Plus,
  Minus,
  Search,
  X,
  Banknote,
  QrCode,
  Check,
  Download,
  Printer,
  RefreshCw,
  Clock3,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import { ConsoleFrame } from "./console-frame";
import { WorkspaceSkeleton } from "./workspace-skeleton";
import { WorkspacePageHeading } from "./workspace-page-heading";
import { useWorkspace } from "./workspace-context";
import { workspaceTab, workspaceTabs, type WorkspaceTab as Tab } from "@/lib/workspace";
import { activeCourts, calendarCourts, courtName, defaultCourts } from "@/lib/courts";
import { demoData } from "@/lib/demo";
import { applyDemoCommand } from "@/lib/demo-command";
import {
  cartTotal,
  centavos,
  dayKey,
  peso,
  reportFor,
  type PosData,
  type Product,
  type Sale,
  type PosBooking,
} from "@/lib/pos";
import { posCommand, type PosCommand } from "@/app/(workspace)/staff/actions";
const empty: PosData = {
  products: [],
  sales: [],
  payments: [],
  refunds: [],
  shifts: [],
  movements: [],
  bookings: [],
  role: "cashier",
  ready: false,
};
type Modal =
  | "checkout"
  | "product"
  | "stock"
  | "open"
  | "close"
  | "refund"
  | "balance"
  | "verify"
  | "receipt"
  | "newbooking"
  | null;
const dateLabel = (value: string) =>
  new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
const statusName = (s: string) =>
  ({
    confirmed: "Confirmed",
    awaiting_payment: "Awaiting payment",
    awaiting_verification: "Payment review",
    cancelled: "Cancelled",
    expired: "Expired",
    blocked: "Blocked",
  })[s] ?? s;
const hourLabel = (n: number) => `${n % 12 || 12}${n < 12 ? "am" : "pm"}`;
export function ClubConsole({
  demo = false,
  initial,
  initialDate,
  initialTab = "overview",
}: {
  demo?: boolean;
  initial?: PosData;
  initialDate?: string;
  initialTab?: Tab;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const workspace = useWorkspace();
  const [clientData, setData] = useState<PosData>(() =>
    demo ? demoData() : (initial ?? empty),
  );
  const data = demo ? clientData : (initial ?? empty);
  const [demoTab, setTab] = useState<Tab>(initialTab);
  const tab = demo ? demoTab : workspaceTab(params.get("tab") ?? initialTab);
  const [isNavigating, startNavigation] = useTransition();
  const [selectedDate, setDate] = useState(initialDate ?? dayKey());
  const date = demo || isNavigating ? selectedDate : (initialDate ?? selectedDate);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All items");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [modal, setModal] = useState<Modal>(null);
  const [selected, setSelected] = useState<Product | Sale | PosBooking | null>(
    null,
  );
  const [receipt, setReceipt] = useState<Sale | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [method, setMethod] = useState<"cash" | "gcash">("cash");
  const [cash, setCash] = useState("");
  const [mobile, setMobile] = useState(false);
  const checkoutKey = useRef<string | null>(null);
  useEffect(() => {
    if (!demo && initialDate) setDate(initialDate);
  }, [demo, initialDate]);
  useEffect(() => {
    setSearch("");
    setCategory("All items");
  }, [tab]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>(".console-modal");
    const controls = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]",
        ) ?? [],
      );
    const first = controls()[0];
    first?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const list = controls();
      const a = list[0],
        b = list[list.length - 1];
      if (event.shiftKey && document.activeElement === a) {
        event.preventDefault();
        b?.focus();
      } else if (!event.shiftKey && document.activeElement === b) {
        event.preventDefault();
        a?.focus();
      }
    };
    document.addEventListener("keydown", trap);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", trap);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [modal]);
  const manager = data.role === "owner" || data.role === "manager";
  const shift = data.shifts.find((s) => !s.closed_at);
  const metrics = reportFor(data, date);
  const pending = data.bookings.filter(
    (b) => b.status === "awaiting_verification",
  );
  const setPendingCount = workspace?.setPendingCount;
  useEffect(() => {
    setPendingCount?.(pending.length);
    return () => setPendingCount?.(0);
  }, [pending.length, setPendingCount]);
  const todayBookings = data.bookings.filter((b) => b.booking_date === date);
  const lowStock = data.products.filter(
    (p) => p.active && p.stock <= p.reorder_level,
  );
  const cartItems = Object.entries(cart)
    .map(([id, quantity]) => {
      const p = data.products.find((p) => p.id === id);
      return p ? { ...p, quantity } : null;
    })
    .filter((p): p is Product & { quantity: number } => !!p);
  const total = cartTotal(cartItems);
  const activeProducts = data.products.filter((p) => p.active);
  const categories = [
    "All items",
    ...new Set(activeProducts.map((p) => p.category)),
  ];
  function go(t: Tab) {
    setTab(t);
    setSearch("");
    setCategory("All items");
    setMobile(false);
    if (!demo) {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", t);
      window.history.replaceState(null, "", url);
    }
  }
  function open(type: Modal, item: typeof selected = null) {
    setModal(type);
    setSelected(item);
    setError("");
    setMethod("cash");
    setCash("");
  }
  function add(p: Product) {
    if ((cart[p.id] ?? 0) >= p.stock) {
      setToast("No more stock available for this item.");
      return;
    }
    setCart((c) => ({ ...c, [p.id]: (c[p.id] ?? 0) + 1 }));
  }
  function quantity(id: string, d: number) {
    setCart((c) => {
      const next = { ...c, [id]: (c[id] ?? 0) + d };
      if (next[id] <= 0) delete next[id];
      return next;
    });
  }
  async function run(command: PosCommand, message: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      let output: Sale | undefined;
      if (demo) {
        const result = applyDemoCommand(data, command);
        setData(result.data);
        output = result.receipt;
      } else {
        const result = await posCommand(command);
        if ("error" in result) throw new Error(result.error);
        output = result.receipt;
        startNavigation(() => router.refresh());
      }
      if (command.op === "checkout") {
        setCart({});
        checkoutKey.current = null;
      }
      if (output) {
        setReceipt(output);
        setModal("receipt");
      } else setModal(null);
      setToast(message);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The request could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }
  function exportCsv() {
    const rows = [
      [
        "Date",
        "Sale",
        "Customer",
        "Type",
        "Amount PHP",
        "Received PHP",
        "Refunded PHP",
      ],
      ...data.sales
        .filter((s) => dayKey(s.created_at) === date)
        .map((s) => [
          date,
          s.number,
          s.customer_name,
          s.kind,
          (s.total_cents / 100).toFixed(2),
          (s.paid_cents / 100).toFixed(2),
          (s.refunded_cents / 100).toFixed(2),
        ]),
    ];
    const csv = rows
      .map((r) =>
        r
          .map(
            (c) =>
              `"${String(c)
                .replace(/^[=+@-]/, "'$&")
                .replaceAll('"', '""')}"`,
          )
          .join(","),
      )
      .join("\r\n");
    const url = URL.createObjectURL(
      new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `rally-sales-${date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setToast("Sales export downloaded.");
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const text = (key: string) => String(f.get(key) ?? "");
    const verified = f.get("verified") === "on";
    try {
      switch (modal) {
        case "checkout":
          if (!verified)
            throw new Error(
              "Confirm that you received and verified the payment.",
            );
          checkoutKey.current ??= crypto.randomUUID();
          await run(
            {
              op: "checkout",
              payload: {
                key: checkoutKey.current,
                items: cartItems.map((i) => ({
                  product_id: i.id,
                  quantity: i.quantity,
                  price_cents: i.price_cents,
                })),
                method,
                reference: text("reference"),
                tendered_cents:
                  method === "cash" ? centavos(text("cash")) : total,
                customer_name: text("customer") || "Walk-in customer",
                verified: true,
              },
            },
            "Sale completed. Stock and payment recorded.",
          );
          break;
        case "product": {
          const p = selected as Product | null;
          await run(
            {
              op: "product",
              payload: {
                ...(p ? { id: p.id } : {}),
                name: text("name"),
                sku: text("sku"),
                barcode: text("barcode"),
                category: text("category"),
                price_cents: centavos(text("price")),
                cost_cents: centavos(text("cost")),
                reorder_level: Number(text("reorder")),
                revision: p?.revision ?? 0,
                active: f.get("active") === "on",
              },
            },
            "Product saved.",
          );
          break;
        }
        case "stock":
          await run(
            {
              op: "stock",
              id: selected!.id,
              quantity: Number(text("quantity")),
              reason: text("reason"),
            },
            "Stock movement recorded.",
          );
          break;
        case "open":
          await run(
            { op: "open", amount: centavos(text("amount")) },
            "Cashier shift opened.",
          );
          break;
        case "close":
          await run(
            { op: "close", id: shift!.id, amount: centavos(text("amount")) },
            "Shift closed. Cash count recorded.",
          );
          break;
        case "refund":
          if (!verified)
            throw new Error("Confirm the money was returned to the customer.");
          await run(
            {
              op: "refund",
              id: selected!.id,
              method,
              reason: text("reason"),
              restock: f.get("restock") === "on",
              verified: true,
            },
            "Manual refund recorded. Original sale preserved.",
          );
          break;
        case "verify":
          if (!verified)
            throw new Error(
              "Check the actual incoming GCash transaction first.",
            );
          await run(
            { op: "verify", id: selected!.id, verified: true },
            "Payment verified. Booking confirmed.",
          );
          break;
        case "balance":
          if (!verified)
            throw new Error("Confirm receipt of the outstanding balance.");
          await run(
            {
              op: "balance",
              id: selected!.id,
              method,
              reference: text("reference"),
              verified: true,
            },
            "Booking balance collected.",
          );
          break;
        case "newbooking": {
          if (!demo) break;
          const duration = Number(text("duration"));
          const dateValue = text("date");
          const hour = Number(text("hour"));
          const court = Number(text("court"));
          if (hour + duration > 22)
            throw new Error("The booking must end by 10pm.");
          if (
            data.bookings.some(
              (b) =>
                b.booking_date === dateValue &&
                b.court_id === court &&
                !["cancelled", "expired"].includes(b.status) &&
                hour < b.start_hour + b.duration &&
                hour + duration > b.start_hour,
            )
          )
            throw new Error("That court already has a booking at this time.");
          const due = duration * 200;
          const half = text("option") === "reservation_fee";
          const booking: PosBooking = {
            id: crypto.randomUUID(),
            reference: `RC-DEMO${data.bookings.length + 1001}`,
            customer_name: text("name"),
            booking_date: dateValue,
            start_hour: hour,
            duration,
            court_id: court,
            booking_type: "court",
            status: "awaiting_verification",
            total_amount: due,
            paid_amount: 0,
            initial_payment_amount: half ? due / 2 : due,
            payment_reference: `DEMO-${Date.now()}`,
            payment_option: half ? "reservation_fee" : "full",
          };
          setData((d) => ({ ...d, bookings: [...d.bookings, booking] }));
          setModal(null);
          setToast(
            "Sample GCash reference submitted. Verify it in Reservations.",
          );
          break;
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please check the form.");
    }
  }
  const tableSales = (list: Sale[]) => (
    <div className="console-table-wrap">
      <table className="console-table">
        <thead>
          <tr>
            <th>TRANSACTION</th>
            <th>CUSTOMER</th>
            <th>TYPE</th>
            <th>AMOUNT</th>
            <th>STATUS</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((s) => (
            <tr key={s.id}>
              <td>
                <strong>{s.number}</strong>
                <small>{dateLabel(s.created_at)}</small>
              </td>
              <td>{s.customer_name}</td>
              <td>
                <span className="subtle-pill">
                  {s.kind === "retail" ? "Retail" : "Court booking"}
                </span>
              </td>
              <td>
                <strong>{peso(s.total_cents)}</strong>
                {s.paid_cents < s.total_cents && (
                  <small>
                    {peso(s.total_cents - s.paid_cents)} outstanding
                  </small>
                )}
              </td>
              <td>
                <span
                  className={`status-pill ${s.status === "refunded" ? "status-muted" : "status-ok"}`}
                >
                  {s.status === "refunded"
                    ? "Refunded"
                    : s.paid_cents < s.total_cents
                      ? "Part-paid"
                      : "Paid"}
                </span>
              </td>
              <td>
                <div className="row-actions">
                  <button
                    title="View receipt"
                    aria-label={`View receipt ${s.number}`}
                    onClick={() => {
                      setReceipt(s);
                      open("receipt");
                    }}
                  >
                    <ReceiptText size={17} />
                  </button>
                  {manager && s.refunded_cents === 0 && s.paid_cents > 0 && (
                    <button
                      className="refund-link"
                      onClick={() => open("refund", s)}
                    >
                      Refund
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!list.length && (
        <Empty
          title="No transactions yet"
          text="Completed checkouts and verified booking payments appear here."
        />
      )}
    </div>
  );
  return (
    <ConsoleFrame demo={demo} tab={tab} mobile={mobile} setMobile={setMobile} go={go}
        onReset={() => {
          setData(demoData());
          setCart({});
          checkoutKey.current = null;
          setToast("Presentation data reset.");
        }}
      >
        {demo && (
          <div className="presentation-banner">
            <span>
              <span className="demo-dot" /> CLIENT PREVIEW
            </span>
            <p>
              Explore with sample data. No live bookings or payments are
              created.
            </p>
            <Link href="/">
              View website <ArrowUpRight size={14} />
            </Link>
          </div>
        )}
        <div
          className={`console-content ${tab === "pos" ? "pos-content" : ""}`}
        >
          {!data.ready && (
            <div className="console-setup">
              <AlertTriangle size={24} />
              <div>
                <h2>Let’s connect your club.</h2>
                <p>
                  {data.error ??
                    "Database setup is required before live transactions."}
                </p>
                <Link href="/demo" className="console-button primary">
                  Open presentation demo <ArrowUpRight size={16} />
                </Link>
              </div>
            </div>
          )}
          <WorkspacePageHeading title={workspaceTabs.find((item) => item.id === tab)!.label} actions={<>
              {["overview", "transactions", "reports", "bookings"].includes(
                tab,
              ) && (
                <label className="console-date">
                  <CalendarDays size={16} />
                  <input
                    type="date"
                    aria-label="Report date"
                    value={date}
                    onChange={(e) => {
                      if (!e.target.value) return;
                      setDate(e.target.value);
                      if (!demo) startNavigation(() => router.push(`/staff?date=${e.target.value}&tab=${tab}`));
                    }}
                  />
                </label>
              )}
              {tab === "overview" && (
                <button
                  className="console-button primary"
                  onClick={() => go("pos")}
                >
                  <Plus size={17} />
                  New sale
                </button>
              )}
              {tab === "inventory" && manager && (
                <button
                  className="console-button primary"
                  disabled={!data.ready}
                  onClick={() => open("product")}
                >
                  <Plus size={16} />
                  Add product
                </button>
              )}
              {tab === "bookings" &&
                (demo ? (
                  <button
                    className="console-button primary"
                    onClick={() => open("newbooking")}
                  >
                    <Plus size={16} />
                    Sample booking
                  </button>
                ) : (
                  manager && (
                    <Link className="console-button primary" href="/admin">
                      Court calendar <ArrowUpRight size={16} />
                    </Link>
                  )
                ))}
              {["reports", "transactions"].includes(tab) && (
                <button className="console-button" onClick={exportCsv}>
                  <Download size={16} />
                  Export CSV
                </button>
              )}
            </>} />
          {isNavigating && <WorkspaceSkeleton view={tab} heading={false}
            courtCount={activeCourts(data.courts).length} />}
          <div hidden={isNavigating}>
          {tab === "overview" && (
            <>
              <div className="metrics-grid">
                <Metric
                  label="NET COLLECTIONS"
                  value={peso(metrics.net)}
                  hint="Payments received less refunds"
                  icon={<Banknote size={19} />}
                  tone="lime"
                />
                <Metric
                  label="COURT RESERVATIONS"
                  value={String(
                    todayBookings.filter((b) => b.status === "confirmed")
                      .length,
                  )}
                  hint={`${pending.length} payment${pending.length === 1 ? "" : "s"} to verify`}
                  icon={<CalendarDays size={19} />}
                  tone="lavender"
                />
                <Metric
                  label="RETAIL SALES"
                  value={peso(metrics.retail)}
                  hint="Counter sales created on this date"
                  icon={<ShoppingBasket size={19} />}
                  tone="peach"
                />
                <Metric
                  label="BOOKING BALANCES"
                  value={peso(metrics.due)}
                  hint="Confirmed reservations in the next 30 days"
                  icon={<Clock3 size={19} />}
                  tone="blue"
                />
              </div>
              <div className="overview-grid">
                <section className="console-panel">
                  <div className="panel-heading">
                    <h2>
                      Court schedule{" "}
                      <span className="subtle-pill">
                        {todayBookings.length}
                      </span>
                    </h2>
                    <button onClick={() => go("bookings")}>
                      All reservations <ArrowUpRight size={15} />
                    </button>
                  </div>
                  <div className="court-timeline">
                    {calendarCourts(data.courts ?? defaultCourts, todayBookings).map(({ id: n, name }, index) => (
                      <div className="timeline-row" key={n}>
                        <div className={`court-icon court-icon-${index % 2 + 1}`}>
                          <span />
                          <b>{String(n).padStart(2, "0")}</b>
                        </div>
                        <div className="timeline-court">
                          <strong>{name}</strong>
                          <small>
                            {
                              todayBookings.filter(
                                (b) =>
                                  b.court_id === n && b.status === "confirmed",
                              ).length
                            }{" "}
                            confirmed sessions
                          </small>
                        </div>
                        <div className="timeline-blocks">
                          {todayBookings
                            .filter(
                              (b) =>
                                b.court_id === n &&
                                !["cancelled", "expired"].includes(b.status),
                            )
                            .map((b) => (
                              <button
                                key={b.id}
                                className={
                                  b.status === "confirmed"
                                    ? "block-confirmed"
                                    : "block-pending"
                                }
                                onClick={() => {
                                  go("bookings");
                                  setSearch(b.customer_name);
                                }}
                              >
                                <strong>
                                  {hourLabel(b.start_hour)}–
                                  {hourLabel(b.start_hour + b.duration)}
                                </strong>
                                <span>{b.customer_name}</span>
                              </button>
                            ))}
                          {!todayBookings.some((b) => b.court_id === n) && (
                            <span className="timeline-empty">
                              No bookings
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="timeline-legend">
                    <span>
                      <i />
                      Confirmed
                    </span>
                    <span>
                      <i />
                      Payment pending
                    </span>
                  </div>
                </section>
                <section className="console-panel review-panel">
                  <div className="panel-heading">
                    <h2>Needs attention</h2>
                    <span className="attention-count">
                      {pending.length + lowStock.length}
                    </span>
                  </div>
                  <button
                    className="attention-row"
                    onClick={() => go("bookings")}
                  >
                    <span className="attention-icon lavender">
                      <QrCode size={20} />
                    </span>
                    <span>
                      <strong>Payments to verify</strong>
                    </span>
                    <b>{pending.length}</b>
                    <ChevronRight size={15} />
                  </button>
                  <button
                    className="attention-row"
                    onClick={() => go("inventory")}
                  >
                    <span className="attention-icon peach">
                      <Package size={20} />
                    </span>
                    <span>
                      <strong>Low stock</strong>
                    </span>
                    <b>{lowStock.length}</b>
                    <ChevronRight size={15} />
                  </button>
                  <div className="shift-summary">
                    <span className="live-dot" />
                    <span>
                      {shift
                        ? "Shift open"
                        : "Shift closed"}
                    </span>
                    <button onClick={() => open(shift ? "close" : "open")}>
                      {shift ? "Close shift" : "Open shift"}
                      <ArrowUpRight size={13} />
                    </button>
                  </div>
                </section>
              </div>
              <section className="console-panel">
                <div className="panel-heading">
                  <h2>Recent transactions</h2>
                  <button onClick={() => go("transactions")}>
                    View all <ArrowUpRight size={15} />
                  </button>
                </div>
                {tableSales(data.sales.slice(0, 5))}
              </section>
            </>
          )}
          {tab === "pos" && (
            <div className="pos-layout">
              <section className="pos-catalog">
                <div className="catalog-search">
                  <Search size={18} />
                  <input
                    aria-label="Search products or scan barcode"
                    placeholder="Search products or scan a barcode…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const p = activeProducts.find(
                          (p) =>
                            p.barcode === search ||
                            p.sku.toLowerCase() === search.toLowerCase(),
                        );
                        if (p) {
                          add(p);
                          setSearch("");
                        }
                      }
                    }}
                  />
                  <span>↵</span>
                </div>
                <div className="category-tabs">
                  {categories.map((c) => (
                    <button
                      key={c}
                      className={category === c ? "active" : ""}
                      onClick={() => setCategory(c)}
                    >
                      {c}
                    </button>
                  ))}
                </div>
                <div className="product-grid">
                  {activeProducts
                    .filter(
                      (p) =>
                        (category === "All items" || p.category === category) &&
                        `${p.name} ${p.sku} ${p.barcode}`
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                    )
                    .map((p, i) => (
                      <button
                        className="product-tile"
                        key={p.id}
                        disabled={p.stock <= 0 || !data.ready}
                        onClick={() => add(p)}
                      >
                        <div
                          className={`product-art product-art-${p.category.toLowerCase()}`}
                        >
                          <ProductArt category={p.category} index={i} />
                          <span className="product-add">
                            <Plus size={16} />
                          </span>
                        </div>
                        <div className="product-tile-copy">
                          <span>{p.category}</span>
                          <h3>{p.name}</h3>
                          <div>
                            <strong>{peso(p.price_cents)}</strong>
                            <small
                              className={
                                p.stock <= p.reorder_level ? "low-stock" : ""
                              }
                            >
                              {p.stock} in stock
                            </small>
                          </div>
                        </div>
                      </button>
                    ))}
                </div>
                {!activeProducts.length && (
                  <Empty
                    title="No products available"
                    text="Add products and stock in Inventory."
                  />
                )}
              </section>
              <aside id="pos-cart" tabIndex={-1} aria-label="Current order" className="cart-panel">
                <div className="cart-heading">
                  <h2>
                    Current order{" "}
                    <span className="subtle-pill">
                      {cartItems.reduce((s, p) => s + p.quantity, 0)}
                    </span>
                  </h2>
                  <button
                    disabled={!cartItems.length}
                    onClick={() => {
                      setCart({});
                      checkoutKey.current = null;
                    }}
                    title="Clear cart"
                  >
                    Clear
                  </button>
                </div>
                <div className="cart-customer">
                  <span>W</span>
                  <div>
                    <strong>Walk-in customer</strong>
                  </div>
                </div>
                <div className="cart-lines">
                  {cartItems.map((p) => (
                    <div className="cart-line" key={p.id}>
                      <div>
                        <strong>{p.name}</strong>
                        <small>{peso(p.price_cents)} each</small>
                        <div className="quantity-control">
                          <button
                            aria-label={`Remove one ${p.name}`}
                            onClick={() => quantity(p.id, -1)}
                          >
                            <Minus size={13} />
                          </button>
                          <span>{p.quantity}</span>
                          <button
                            aria-label={`Add one ${p.name}`}
                            onClick={() => add(p)}
                          >
                            <Plus size={13} />
                          </button>
                        </div>
                      </div>
                      <div>
                        <b>{peso(p.price_cents * p.quantity)}</b>
                        <button
                          aria-label={`Remove ${p.name}`}
                          onClick={() =>
                            setCart((c) => {
                              const n = { ...c };
                              delete n[p.id];
                              return n;
                            })
                          }
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                  {!cartItems.length && (
                    <div className="empty-cart">
                      <ShoppingBasket size={38} strokeWidth={1.2} />
                      <h3>Cart is empty</h3>
                      <p>Select a product to start a sale.</p>
                    </div>
                  )}
                </div>
                <div className="cart-totals">
                  <div className="cart-grand-total">
                    <span>Total</span>
                    <strong>{peso(total)}</strong>
                  </div>
                  <button
                    className="console-button primary checkout-button"
                    disabled={!cartItems.length || !shift || !data.ready}
                    onClick={() => open("checkout")}
                  >
                    Charge {peso(total)} <ArrowUpRight size={19} />
                  </button>
                  {!shift ? (
                    <button
                      className="open-shift-link"
                      onClick={() => open("open")}
                    >
                      Open a cashier shift to accept payments
                    </button>
                  ) : (
                    <span className="cart-secure">
                      <CheckCircle2 size={13} /> Your cashier shift is active
                    </span>
                  )}
                </div>
              </aside>
              {cartItems.length > 0 && <a href="#pos-cart" className="pos-mobile-cart">
                <ShoppingBasket size={19} aria-hidden="true" />
                <span>View cart · {cartItems.reduce((sum, item) => sum + item.quantity, 0)}</span>
                <strong>{peso(total)}</strong>
                <ArrowUpRight size={18} aria-hidden="true" />
              </a>}
            </div>
          )}
          {tab === "bookings" && (
            <section className="console-panel">
              <div className="panel-heading">
                <div className="inline-search">
                  <Search size={17} />
                  <input
                    aria-label="Search reservations"
                    placeholder="Search name or booking reference"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <span className="subtle-pill">{pending.length} to verify</span>
              </div>
              <div className="console-table-wrap">
                <table className="console-table">
                  <thead>
                    <tr>
                      <th>RESERVATION</th>
                      <th>COURT & TIME</th>
                      <th>PAYMENT</th>
                      <th>STATUS</th>
                      <th>ACTION</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.bookings
                      .filter((b) =>
                        `${b.customer_name} ${b.reference}`
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                      )
                      .map((b) => (
                        <tr key={b.id}>
                          <td>
                            <strong>{b.customer_name}</strong>
                            <small>{b.reference}</small>
                          </td>
                          <td>
                            {b.booking_type === "open_play"
                              ? "Open play"
                              : courtName(data.courts, b.court_id)}
                            <small>
                              {b.booking_date} · {hourLabel(b.start_hour)}–
                              {hourLabel(b.start_hour + b.duration)}
                            </small>
                          </td>
                          <td>
                            <strong>
                              {peso(Math.round(Number(b.paid_amount) * 100))} /{" "}
                              {peso(Math.round(Number(b.total_amount) * 100))}
                            </strong>
                            <small>
                              {b.payment_option === "reservation_fee"
                                ? "50% reservation fee"
                                : "Full payment"}
                            </small>
                          </td>
                          <td>
                            <span
                              className={`status-pill ${b.status === "confirmed" ? "status-ok" : b.status.includes("awaiting") ? "status-pending" : "status-muted"}`}
                            >
                              {statusName(b.status)}
                            </span>
                          </td>
                          <td>
                            {b.status === "awaiting_verification" ? (
                              <button
                                className="console-button small primary"
                                onClick={() => open("verify", b)}
                              >
                                Verify payment
                              </button>
                            ) : b.status === "confirmed" &&
                              Number(b.paid_amount) < Number(b.total_amount) ? (
                              <button
                                className="console-button small"
                                onClick={() => open("balance", b)}
                              >
                                Collect balance
                              </button>
                            ) : (
                              <span className="cell-muted">
                                {b.status === "confirmed" ? "Fully paid" : "—"}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {!data.bookings.length && (
                  <Empty
                    title="No reservations"
                    text="Customer bookings and staff walk-ins appear here."
                  />
                )}
              </div>
            </section>
          )}
          {tab === "inventory" && (
            <>
              <div className="inventory-summary">
                <span>
                  <Package size={17} />
                  <strong>{data.products.length}</strong> products
                </span>
                <span>
                  <AlertTriangle size={17} />
                  <strong>{lowStock.length}</strong> running low
                </span>
                <span>
                  Stock value at cost{" "}
                  <strong>
                    {peso(
                      data.products.reduce(
                        (s, p) => s + p.stock * p.cost_cents,
                        0,
                      ),
                    )}
                  </strong>
                </span>
              </div>
              <section className="console-panel">
                <div className="panel-heading">
                  <div className="inline-search">
                    <Search size={17} />
                    <input
                      aria-label="Search inventory"
                      placeholder="Search products, SKU, or barcode"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                </div>
                <div className="console-table-wrap">
                  <table className="console-table">
                    <thead>
                      <tr>
                        <th>PRODUCT</th>
                        <th>CATEGORY</th>
                        <th>SELLING PRICE</th>
                        <th>ON HAND</th>
                        <th>STATUS</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.products
                        .filter((p) =>
                          `${p.name} ${p.sku} ${p.barcode}`
                            .toLowerCase()
                            .includes(search.toLowerCase()),
                        )
                        .map((p) => (
                          <tr key={p.id}>
                            <td>
                              <strong>{p.name}</strong>
                              <small>
                                {p.sku} · {p.barcode || "No barcode"}
                              </small>
                            </td>
                            <td>{p.category}</td>
                            <td>{peso(p.price_cents)}</td>
                            <td>
                              <strong>{p.stock}</strong>
                              <small>Alert at {p.reorder_level}</small>
                            </td>
                            <td>
                              <span
                                className={`status-pill ${!p.active ? "status-muted" : p.stock <= p.reorder_level ? "status-pending" : "status-ok"}`}
                              >
                                {!p.active
                                  ? "Archived"
                                  : p.stock <= p.reorder_level
                                    ? "Low stock"
                                    : "In stock"}
                              </span>
                            </td>
                            <td>
                              {manager && (
                                <div className="row-actions">
                                  <button
                                    className="console-button small"
                                    onClick={() => open("stock", p)}
                                  >
                                    Adjust stock
                                  </button>
                                  <button
                                    className="text-action"
                                    onClick={() => open("product", p)}
                                  >
                                    Edit
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  {!data.products.length && (
                    <Empty
                      title="No products"
                      text="Add a product to start tracking stock."
                    />
                  )}
                </div>
              </section>
              <section className="console-panel movement-panel">
                <div className="panel-heading">
                  <h2>Latest stock movements</h2>
                </div>
                {data.movements.slice(0, 8).map((m) => (
                  <div className="movement-row" key={m.id}>
                    <span className={m.quantity > 0 ? "movement-positive" : ""}>
                      {m.quantity > 0 ? "+" : ""}
                      {m.quantity}
                    </span>
                    <div>
                      <strong>
                        {data.products.find((p) => p.id === m.product_id)
                          ?.name ?? "Product"}
                      </strong>
                      <small>{m.reason}</small>
                    </div>
                    <time>{dateLabel(m.created_at)}</time>
                  </div>
                ))}
                {!data.movements.length && (
                  <p className="panel-empty-note">
                    Sales, returns, and stock adjustments will appear here.
                  </p>
                )}
              </section>
            </>
          )}
          {tab === "transactions" && (
            <section className="console-panel">
              <div className="panel-heading">
                <div className="inline-search">
                  <Search size={17} />
                  <input
                    aria-label="Search transactions"
                    placeholder="Search transaction or customer"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <span className="subtle-pill">{data.sales.length} records</span>
              </div>
              {tableSales(
                data.sales.filter((s) =>
                  `${s.number} ${s.customer_name}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                ),
              )}
            </section>
          )}
          {tab === "reports" && (
            <>
              <div className="metrics-grid">
                <Metric
                  label="MONEY RECEIVED"
                  value={peso(metrics.collected)}
                  hint="Verified payments on the selected date"
                  icon={<Banknote size={19} />}
                  tone="lime"
                />
                <Metric
                  label="REFUNDS RETURNED"
                  value={peso(metrics.refunded)}
                  hint="Manual refunds recorded on this date"
                  icon={<RefreshCw size={19} />}
                  tone="peach"
                />
                <Metric
                  label="NET COLLECTIONS"
                  value={peso(metrics.net)}
                  hint="Money received minus refunds"
                  icon={<ChartNoAxesCombined size={19} />}
                  tone="lavender"
                />
                <Metric
                  label="OUTSTANDING BALANCES"
                  value={peso(metrics.due)}
                  hint="Confirmed bookings in the next 30 days"
                  icon={<Clock3 size={19} />}
                  tone="blue"
                />
              </div>
              <div className="overview-grid">
                <section className="console-panel">
                  <div className="panel-heading">
                    <h2>Payment methods</h2>
                    <span className="subtle-pill">Net of refunds</span>
                  </div>
                  <div className="payment-breakdown">
                    {[
                      ["Cash", metrics.cash, "lime"],
                      ["GCash", metrics.gcash, "lavender"],
                    ].map(([label, n, tone]) => (
                      <div key={String(label)}>
                        <div>
                          <strong>{String(label)}</strong>
                          <b>{peso(Number(n))}</b>
                        </div>
                        <div className="report-bar">
                          <i
                            className={String(tone)}
                            style={{
                              width: `${Math.max(0, Math.min(100, (Number(n) / Math.max(metrics.collected, 1)) * 100))}%`,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <details className="workspace-disclosure report-note">
                    <summary>How collections are counted</summary>
                    <p>
                    Collections follow the payment date. A reservation fee and
                    its later balance are separate receipts of money.
                    </p>
                  </details>
                </section>
                <section className="console-panel">
                  <div className="panel-heading">
                    <h2>Cashier shifts</h2>
                    <button
                      disabled={!data.ready}
                      onClick={() => open(shift ? "close" : "open")}
                    >
                      {shift ? "Close shift" : "Open shift"}
                      <ArrowUpRight size={15} />
                    </button>
                  </div>
                  {data.shifts.slice(0, 5).map((s) => (
                    <div className="shift-report" key={s.id}>
                      <div>
                        <strong>
                          {s.closed_at ? "Closed shift" : "Active shift"}
                        </strong>
                        <small>{dateLabel(s.opened_at)}</small>
                      </div>
                      <div>
                        <span>Expected cash</span>
                        <b>{peso(s.expected_cents)}</b>
                      </div>
                      <div>
                        <span>
                          {s.closed_at ? "Cash variance" : "Opening float"}
                        </span>
                        <b>
                          {peso(
                            s.closed_at
                              ? (s.counted_cents ?? 0) - s.expected_cents
                              : s.opening_cents,
                          )}
                        </b>
                      </div>
                    </div>
                  ))}
                  {!data.shifts.length && (
                    <p className="panel-empty-note">
                      Open a shift to start cash reconciliation.
                    </p>
                  )}
                </section>
              </div>
              <section className="console-panel">
                <div className="panel-heading">
                  <h2>Sales created on {date}</h2>
                  <button onClick={exportCsv}>
                    <Download size={15} />
                    Export
                  </button>
                </div>
                {tableSales(
                  data.sales.filter((s) => dayKey(s.created_at) === date),
                )}
              </section>
            </>
          )}
          </div>
        </div>
      {toast && (
        <div className="console-toast" role="status">
          <CheckCircle2 size={18} />
          {toast}
          <button
            onClick={() => setToast("")}
            aria-label="Dismiss notification"
          >
            <X size={15} />
          </button>
        </div>
      )}
      {modal && (
        <div
          className={`console-modal-backdrop ${modal === "receipt" ? "receipt-backdrop" : ""}`}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setModal(null);
          }}
        >
          <div
            className={`console-modal ${modal === "receipt" ? "receipt-modal" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={
              modal === "receipt" ? "Transaction receipt" : `${modal} form`
            }
            onKeyDown={(e) => {
              if (e.key === "Escape" && !busy) setModal(null);
            }}
          >
            <button
              className="modal-close"
              aria-label="Close dialog"
              disabled={busy}
              onClick={() => setModal(null)}
            >
              <X size={20} />
            </button>
            {modal === "receipt" && receipt ? (
              <>
                <div className="print-area">
                  <div className="receipt-brand">RALLY CLUB</div>
                  <p className="receipt-subtitle">
                    {demo ? "DEMONSTRATION RECEIPT" : "TRANSACTION SLIP"}
                    <br />
                    NOT A TAX INVOICE
                  </p>
                  <div className="receipt-meta">
                    <span>{receipt.number}</span>
                    <span>{dateLabel(receipt.created_at)}</span>
                  </div>
                  <p>{receipt.customer_name}</p>
                  <div className="receipt-items">
                    {receipt.items.map((i, n) => (
                      <div key={n}>
                        <span>
                          {i.quantity} × {i.name}
                        </span>
                        <b>{peso(i.price_cents * i.quantity)}</b>
                      </div>
                    ))}
                  </div>
                  <div className="receipt-total">
                    <span>Total</span>
                    <b>{peso(receipt.total_cents)}</b>
                  </div>
                  <div className="receipt-pair">
                    <span>Payments recorded</span>
                    <b>{peso(receipt.paid_cents)}</b>
                  </div>
                  {receipt.refunded_cents > 0 && (
                    <div className="receipt-pair">
                      <span>Refunds recorded</span>
                      <b>{peso(receipt.refunded_cents)}</b>
                    </div>
                  )}
                  <div className="receipt-pair">
                    <span>Balance due</span>
                    <b>
                      {peso(
                        receipt.status === "refunded"
                          ? 0
                          : receipt.total_cents - receipt.paid_cents,
                      )}
                    </b>
                  </div>
                  <p className="receipt-thanks">
                    Good games. Great company.
                    <br />
                    See you at the net.
                  </p>
                  <small className="receipt-disclaimer">
                    {demo
                      ? "Sample only. No money has been collected."
                      : "A record of the transaction. Request the venue’s authorized invoice separately."}
                  </small>
                </div>
                <button
                  className="console-button primary full-width no-print"
                  onClick={() => window.print()}
                >
                  <Printer size={17} />
                  Print transaction slip
                </button>
                <button
                  className="console-button full-width no-print"
                  onClick={() => setModal(null)}
                >
                  Back to the club
                </button>
              </>
            ) : (
              <form onSubmit={submit}>
                {demo && <span className="console-kicker">DEMO</span>}
                <h2>
                  {
                    (
                      {
                        checkout: "Complete sale",
                        product: selected
                          ? "Edit product"
                          : "Add product",
                        stock: "Adjust stock",
                        open: "Open shift",
                        close: "Close shift",
                        refund: "Record refund",
                        balance: "Collect balance",
                        verify: "Verify GCash payment",
                        newbooking: "Sample booking",
                      } as Record<string, string>
                    )[modal]
                  }
                </h2>
                {modal === "checkout" && (
                  <>
                    <div className="modal-amount">
                      <span>{cartItems.length} products · amount due</span>
                      <strong>{peso(total)}</strong>
                    </div>
                    <label>
                      Customer name
                      <input
                        name="customer"
                        maxLength={100}
                        placeholder="Walk-in customer"
                      />
                    </label>
                    <PaymentChoice method={method} change={setMethod} />
                    {method === "cash" ? (
                      <>
                        <label>
                          Cash received (PHP)
                          <input
                            name="cash"
                            type="number"
                            step="0.01"
                            min={(total / 100).toFixed(2)}
                            required
                            value={cash}
                            onChange={(e) => setCash(e.target.value)}
                            autoFocus
                          />
                        </label>
                        <div className="change-line">
                          <span>Change</span>
                          <strong>
                            {peso(
                              Math.max(
                                0,
                                Math.round(Number(cash) * 100) - total,
                              ),
                            )}
                          </strong>
                        </div>
                      </>
                    ) : (
                      <label>
                        Verified GCash reference
                        <input
                          name="reference"
                          required
                          minLength={6}
                          maxLength={40}
                          placeholder="From the incoming transaction"
                        />
                      </label>
                    )}
                    <Verified
                      text={
                        method === "cash"
                          ? "I received the cash and checked the amount."
                          : "I checked this payment in the actual GCash account."
                      }
                    />
                  </>
                )}
                {modal === "product" && (
                  <>
                    <div className="form-two">
                      <label>
                        Product name
                        <input
                          name="name"
                          required
                          minLength={2}
                          maxLength={100}
                          defaultValue={(selected as Product)?.name}
                        />
                      </label>
                      <label>
                        Category
                        <input
                          name="category"
                          required
                          maxLength={40}
                          defaultValue={
                            (selected as Product)?.category ?? "Drinks"
                          }
                          list="categories"
                        />
                        <datalist id="categories">
                          {["Drinks", "Snacks", "Gear", "Merch"].map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </datalist>
                      </label>
                      <label>
                        SKU
                        <input
                          name="sku"
                          required
                          minLength={2}
                          maxLength={40}
                          defaultValue={(selected as Product)?.sku}
                        />
                      </label>
                      <label>
                        Barcode (optional)
                        <input
                          name="barcode"
                          maxLength={50}
                          defaultValue={(selected as Product)?.barcode}
                        />
                      </label>
                      <label>
                        Selling price (PHP)
                        <input
                          name="price"
                          required
                          type="number"
                          step="0.01"
                          min="0.01"
                          defaultValue={
                            ((selected as Product)?.price_cents ?? 0) / 100
                          }
                        />
                      </label>
                      <label>
                        Unit cost (PHP)
                        <input
                          name="cost"
                          required
                          type="number"
                          step="0.01"
                          min="0"
                          defaultValue={
                            ((selected as Product)?.cost_cents ?? 0) / 100
                          }
                        />
                      </label>
                      <label>
                        Low-stock alert at
                        <input
                          name="reorder"
                          required
                          type="number"
                          min="0"
                          step="1"
                          defaultValue={
                            (selected as Product)?.reorder_level ?? 5
                          }
                        />
                      </label>
                    </div>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        name="active"
                        defaultChecked={(selected as Product)?.active ?? true}
                      />
                      Available at the counter
                    </label>
                    <p className="form-note">
                      New products start at zero stock. Record a stock-in after
                      saving.
                    </p>
                  </>
                )}
                {modal === "stock" && (
                  <>
                    <div className="modal-amount">
                      <span>{(selected as Product).name}</span>
                      <strong>{(selected as Product).stock} on hand</strong>
                    </div>
                    <label>
                      Quantity change
                      <input
                        name="quantity"
                        required
                        type="number"
                        step="1"
                        min={-(selected as Product).stock}
                        max={100000}
                        placeholder="e.g. 24 to add, -2 to remove"
                      />
                    </label>
                    <label>
                      Reason
                      <input
                        name="reason"
                        required
                        minLength={3}
                        maxLength={200}
                        placeholder="Delivery, damage, stock count…"
                      />
                    </label>
                    <p className="form-note">
                      Every adjustment is saved in the stock ledger.
                    </p>
                  </>
                )}
                {modal === "open" && (
                  <>
                    <p>Count the starting cash float before accepting sales.</p>
                    <label>
                      Opening cash (PHP)
                      <input
                        name="amount"
                        type="number"
                        min="0"
                        step="0.01"
                        required
                        defaultValue="1000"
                      />
                    </label>
                  </>
                )}
                {modal === "close" && shift && (
                  <>
                    <div className="modal-amount">
                      <span>Expected cash in drawer</span>
                      <strong>{peso(shift.expected_cents)}</strong>
                    </div>
                    <p className="form-note">
                      Opening float + cash collections − cash refunds. GCash
                      stays separate.
                    </p>
                    <label>
                      Actual cash counted (PHP)
                      <input
                        name="amount"
                        type="number"
                        min="0"
                        step="0.01"
                        required
                      />
                    </label>
                  </>
                )}
                {modal === "refund" && (
                  <>
                    <div className="modal-amount">
                      <span>
                        {(selected as Sale).number} · full collected amount
                      </span>
                      <strong>{peso((selected as Sale).paid_cents)}</strong>
                    </div>
                    <p className="form-note">
                      Return the money outside the system first. This records
                      the completed refund. A booking refund also cancels the
                      booking.
                    </p>
                    <PaymentChoice method={method} change={setMethod} />
                    <label>
                      Reason
                      <input
                        name="reason"
                        required
                        minLength={3}
                        maxLength={200}
                      />
                    </label>
                    {(selected as Sale).kind === "retail" && (
                      <label className="checkbox-label">
                        <input name="restock" type="checkbox" defaultChecked />
                        Items were returned and can be restocked
                      </label>
                    )}
                    <Verified text="I have returned the full collected amount to the customer." />
                  </>
                )}
                {(modal === "balance" || modal === "verify") && (
                  <>
                    <div className="modal-amount">
                      <span>
                        {(selected as PosBooking).customer_name} ·{" "}
                        {(selected as PosBooking).reference}
                      </span>
                      <strong>
                        {peso(
                          Math.round(
                            (modal === "verify"
                              ? Number(
                                  (selected as PosBooking)
                                    .initial_payment_amount,
                                )
                              : Number((selected as PosBooking).total_amount) -
                                Number((selected as PosBooking).paid_amount)) *
                              100,
                          ),
                        )}
                      </strong>
                    </div>
                    {modal === "verify" ? (
                      <>
                        <p className="payment-reference-box">
                          <QrCode size={20} />
                          <span>
                            SUBMITTED REFERENCE
                            <strong>
                              {(selected as PosBooking).payment_reference}
                            </strong>
                          </span>
                        </p>
                        <p className="form-note">
                          Match the amount, reference, and recipient against the
                          actual incoming GCash transaction.
                        </p>
                        <Verified text="I verified the incoming payment in the GCash account." />
                      </>
                    ) : (
                      <>
                        <PaymentChoice method={method} change={setMethod} />
                        {method === "gcash" && (
                          <label>
                            GCash reference
                            <input
                              name="reference"
                              required
                              minLength={6}
                              maxLength={40}
                            />
                          </label>
                        )}
                        <Verified text="I received and checked the complete outstanding balance." />
                        {!shift && (
                          <p className="form-note">
                            Cash requires an open cashier shift.
                          </p>
                        )}
                      </>
                    )}
                  </>
                )}
                {modal === "newbooking" && (
                  <>
                    <p className="form-note">
                      Simulate a customer who selected a court, paid by GCash,
                      and submitted a reference. No real reservation or payment
                      is created.
                    </p>
                    <label>
                      Customer name
                      <input
                        name="name"
                        required
                        minLength={2}
                        maxLength={100}
                        placeholder="Your sample customer"
                      />
                    </label>
                    <div className="form-two">
                      <label>
                        Date
                        <input
                          name="date"
                          required
                          type="date"
                          defaultValue={date}
                        />
                      </label>
                      <label>
                        Court
                        <select name="court">
                          {activeCourts(data.courts).map((court) => <option key={court.id} value={court.id}>{court.name}</option>)}
                        </select>
                      </label>
                      <label>
                        Start time
                        <select name="hour">
                          {Array.from({ length: 16 }, (_, i) => i + 6).map(
                            (h) => (
                              <option key={h} value={h}>
                                {hourLabel(h)}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                      <label>
                        Duration
                        <select name="duration">
                          {[1, 2, 3, 4].map((h) => (
                            <option key={h} value={h}>
                              {h} hour{h > 1 ? "s" : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <label>
                      Payment option
                      <select name="option">
                        <option value="reservation_fee">
                          50% reservation fee
                        </option>
                        <option value="full">Full payment</option>
                      </select>
                    </label>
                    <p className="form-note">
                      Sample court rate: ₱200/hour. Submitted payments await
                      staff verification.
                    </p>
                  </>
                )}
                {error && (
                  <div className="console-form-error" role="alert">
                    {error}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={busy || !data.ready}
                  className="console-button primary full-width"
                >
                  {busy
                    ? "Saving…"
                    : modal === "checkout"
                      ? `Complete sale · ${peso(total)}`
                      : modal === "verify"
                        ? "Verify payment & confirm booking"
                        : modal === "refund"
                          ? "Record completed refund"
                          : modal === "close"
                            ? "Close shift & record cash count"
                            : modal === "newbooking"
                              ? "Submit sample GCash reference"
                              : "Save & continue"}
                  <Check size={17} />
                </button>
                <button
                  type="button"
                  className="cancel-button"
                  disabled={busy}
                  onClick={() => setModal(null)}
                >
                  Cancel
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </ConsoleFrame>
  );
}
function Metric({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ReactNode;
  tone: string;
}) {
  return (
    <article className={`metric-card ${tone}`}>
      <div>
        <span>{label.charAt(0) + label.slice(1).toLowerCase()}</span>
        {icon}
      </div>
      <strong>{value}</strong>
      <p>{hint}</p>
    </article>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="console-empty">
      <Package size={28} strokeWidth={1.2} />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function Verified({ text }: { text: string }) {
  return (
    <label className="checkbox-label verify-checkbox">
      <input name="verified" type="checkbox" required />
      {text}
    </label>
  );
}
function PaymentChoice({
  method,
  change,
}: {
  method: "cash" | "gcash";
  change: (m: "cash" | "gcash") => void;
}) {
  return (
    <div className="payment-methods">
      <button
        type="button"
        className={method === "cash" ? "active" : ""}
        onClick={() => change("cash")}
      >
        <Banknote size={20} />
        Cash{method === "cash" && <Check size={15} />}
      </button>
      <button
        type="button"
        className={method === "gcash" ? "active" : ""}
        onClick={() => change("gcash")}
      >
        <QrCode size={20} />
        GCash{method === "gcash" && <Check size={15} />}
      </button>
    </div>
  );
}
function ProductArt({ category, index }: { category: string; index: number }) {
  if (category === "Drinks")
    return (
      <svg viewBox="0 0 160 130" aria-hidden="true">
        <ellipse cx="80" cy="115" rx="24" ry="5" fill="#183d3512" />
        <g transform={`rotate(${index % 2 ? 9 : -8} 80 65)`}>
          <rect
            x="67"
            y="12"
            width="26"
            height="15"
            rx="4"
            fill={index % 3 === 1 ? "#d48b44" : "#335a50"}
          />
          <path
            d="M67 26h26l4 12v65q0 9-9 9H72q-9 0-9-9V38z"
            fill={index % 3 === 1 ? "#efb667" : "#d4e5da"}
          />
          <path
            d="M66 51h28v37H66z"
            fill={index % 3 === 1 ? "#f7d5a2" : "#f7f8ef"}
          />
          <text
            x="80"
            y="67"
            textAnchor="middle"
            fontSize="7"
            fontWeight="800"
            fill="#183d35"
          >
            RALLY
          </text>
          <circle
            cx="80"
            cy="76"
            r="4"
            fill={index % 3 === 1 ? "#bd743e" : "#8ba99a"}
          />
          <path
            d="M70 31v15"
            stroke="white"
            strokeWidth="3"
            strokeLinecap="round"
            opacity=".5"
          />
        </g>
      </svg>
    );
  if (category === "Snacks")
    return (
      <svg viewBox="0 0 160 130" aria-hidden="true">
        <g transform="rotate(-18 80 65)">
          <path d="M50 25h60l-3 9 3 9-3 60H50l3-9-3-9z" fill="#cfb5a2" />
          <path d="M50 30h60M51 98h56" stroke="#a7836a" strokeWidth="3" />
          <rect x="51" y="46" width="57" height="37" fill="#f2e8d8" />
          <text
            x="80"
            y="63"
            textAnchor="middle"
            fontSize="10"
            fontWeight="700"
            fill="#5c5340"
          >
            ENERGY
          </text>
          <text x="80" y="75" textAnchor="middle" fontSize="8" fill="#5c5340">
            GOOD TO GO.
          </text>
        </g>
      </svg>
    );
  if (category === "Merch")
    return (
      <svg viewBox="0 0 160 130" aria-hidden="true">
        <path
          d="M57 24l-25 18 14 24 13-7v49h43V59l13 7 14-24-26-18q-23 17-46 0"
          fill="#c4b8dc"
        />
        <path
          d="M66 29q14 15 28 0"
          fill="none"
          stroke="#a18fb7"
          strokeWidth="3"
        />
        <text
          x="80"
          y="65"
          textAnchor="middle"
          fontSize="11"
          fontWeight="800"
          fill="#314e42"
        >
          RALLY
        </text>
        <text x="80" y="74" textAnchor="middle" fontSize="5" fill="#314e42">
          CLUB ESSENTIALS
        </text>
      </svg>
    );
  return (
    <svg viewBox="0 0 160 130" aria-hidden="true">
      {index % 2 === 0 ? (
        <g fill="#d9ef95" stroke="#9cba68" strokeWidth="1">
          <circle cx="61" cy="76" r="24" />
          <circle cx="99" cy="76" r="24" />
          <circle cx="80" cy="46" r="24" />
          {[
            [72, 39],
            [88, 45],
            [78, 56],
            [53, 70],
            [67, 78],
            [56, 87],
            [92, 69],
            [106, 78],
            [96, 88],
          ].map(([x, y]) => (
            <ellipse
              key={`${x}${y}`}
              cx={x}
              cy={y}
              rx="3"
              ry="2.5"
              fill="#87a74d"
              stroke="none"
            />
          ))}
        </g>
      ) : (
        <g transform="rotate(-25 80 65)">
          <rect x="72" y="76" width="17" height="41" rx="5" fill="#c4b8dc" />
          <rect x="48" y="13" width="65" height="76" rx="22" fill="#345b4c" />
          <path d="M57 30l46 39M57 43l43 35" stroke="#bed48b" strokeWidth="2" />
          <text
            x="80"
            y="55"
            fontSize="9"
            fontWeight="800"
            textAnchor="middle"
            fill="#d9ef95"
          >
            R
          </text>
        </g>
      )}
    </svg>
  );
}
