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
import { WorkspaceSkeleton } from "./workspace-skeleton";
import { ConsoleFrame } from "./console-frame";
import { demoData } from "@/lib/demo";
import { applyDemoCommand } from "@/lib/demo-command";
import { WorkspacePageHeading } from "./workspace-page-heading";
import { useWorkspace } from "./workspace-context";
import { reservationsForDateHref, workspaceTab, workspaceTabs, type WorkspaceTab as Tab } from "@/lib/workspace";
import { activeCourts, calendarCourts, courtName, defaultCourts } from "@/lib/courts";
import { formatHour } from "@/lib/booking";
import {
  cartTotal,
  centavos,
  collectionsCsv,
  dayKey,
  peso,
  reportFor,
  type PosData,
  type Product,
  type Sale,
  type PosBooking,
} from "@/lib/pos";
import { toCsv } from "@/lib/finance";
import { posCommand, type PosCommand } from "@/app/(workspace)/staff/actions";
import { useAnimatedModal } from "./use-animated-modal";
import { TablePagination, useTablePage } from "./table-pagination";
import { OnDutyControl, RegisterControl, RegisterShiftDialog } from "./register-day";
import { OverviewMetricValue } from "./overview-metric-value";
import { ProductPhoto, ProductPhotoField } from "./product-photo";
import { prepareProductPhoto, previewProductPhoto, productPhotoUrl } from "@/lib/product-photo";
import type { RegisterDay as RegisterData } from "@/lib/register";
import { BalancePaymentModal } from "./balance-payment-modal";
import { StaffCancelBookingModal } from "./staff-cancel-booking-modal";
type Modal =
  | "checkout"
  | "product"
  | "stock"
  | "open"
  | "close"
  | "refund"
  | "balance"
  | "verify"
  | "newbooking"
  | "reject-payment"
  | "receipt";
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
  initialDate = dayKey(),
  initialTab = "overview",
  register = null,
  followToday = false,
  operator = "Demo operator",
  canAssign = false,
}: {
  demo?: boolean;
  initial?: PosData;
  initialDate?: string;
  initialTab?: Tab;
  register?: RegisterData | null;
  followToday?: boolean;
  operator?: string;
  canAssign?: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const workspace = useWorkspace();
  const [sample, setData] = useState(() => initial ?? demoData());
  const [mobile, setMobile] = useState(false);
  const data = demo ? sample : initial ?? sample;
  const tab = workspaceTab(params.get("tab") ?? initialTab);
  const reservationQuery = tab === "bookings" ? params.get("q")?.slice(0, 100) ?? "" : "";
  const [isNavigating, startNavigation] = useTransition();
  const [selectedDate, setDate] = useState(initialDate);
  const date = demo || isNavigating ? selectedDate : initialDate;
  const [search, setSearch] = useState(reservationQuery);
  const [category, setCategory] = useState("All items");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [modal, setModal, modalClosing] = useAnimatedModal<Modal>();
  const [reservationAction, setReservationAction, reservationActionClosing] =
    useAnimatedModal<{ kind: "cancel" | "balance"; booking: PosBooking }>();
  const [selected, setSelected] = useState<Product | Sale | PosBooking | null>(
    null,
  );
  const [receipt, setReceipt] = useState<Sale | null>(null);
  const [busy, setBusy] = useState(false);
  const [productPhoto, setProductPhoto] = useState<string | null>();
  const [preparingPhoto, setPreparingPhoto] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [method, setMethod] = useState<"cash" | "gcash">("cash");
  const [cash, setCash] = useState("");
  const checkoutKey = useRef<string | null>(null);
  useEffect(() => {
    setDate(initialDate);
  }, [initialDate]);
  useEffect(() => {
    setSearch(reservationQuery);
    setCategory("All items");
  }, [tab, reservationQuery]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!modal || modal === "open" || modal === "close") return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>(".console-modal");
    const controls = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
        ) ?? [],
      );
    const first = controls()[0];
    first?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      if (dialog?.inert) {
        event.preventDefault();
        return;
      }
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
  const editedProduct = modal === "product" ? selected as Product | null : null;
  const dialogBusy = busy || preparingPhoto;
  const shift = register ? register.active?.own_shift ?? undefined : data.shifts.find((s) => !s.closed_at);
  const metrics = reportFor(data, date);
  const pending = data.paymentReviews ?? data.bookings.filter(
    (b) => b.status === "awaiting_verification",
  );
  const overdue = data.paymentReviews?.filter((b) => b.overdue).length ?? 0;
  const reviewOnly = params.get("review") === "1";
  const dayOnly = tab === "bookings" && params.get("scope") === "day";
  const reviewingPayment = modal === "verify" || modal === "reject-payment";
  const reservationRows = (reviewOnly ? pending : data.bookings).filter((b) =>
    (reviewOnly || !dayOnly || b.booking_date === initialDate) &&
    `${b.customer_name} ${b.reference}`.toLowerCase().includes(search.toLowerCase()),
  );
  const products = data.products.filter((p) =>
    `${p.name} ${p.sku} ${p.barcode}`.toLowerCase().includes(search.toLowerCase()),
  );
  const transactionRows = data.sales.filter((s) =>
    `${s.number} ${s.customer_name}`.toLowerCase().includes(search.toLowerCase()),
  );
  const dailySales = data.sales.filter((s) => dayKey(s.created_at) === date);
  const reservations = useTablePage(reservationRows.length, `${initialDate}:${tab}:${reviewOnly}:${dayOnly}:${search}`);
  const inventory = useTablePage(products.length, `${tab}:${search}`);
  const transactions = useTablePage(transactionRows.length, `${initialDate}:${tab}:${search}`);
  const recentTransactions = useTablePage(data.sales.length, `${initialDate}:${tab}`, 5);
  const collections = useTablePage(dailySales.length, `${initialDate}:${tab}`);
  const paymentReviews = new Map(data.paymentReviews?.map((b) => [b.id, b]));
  useEffect(() => {
    if (demo || (tab !== "overview" && tab !== "bookings") || modal || reservationAction || isNavigating || !data.ready) return;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 60000);
    return () => clearInterval(interval);
  }, [tab, modal, reservationAction, isNavigating, data.ready, router, demo]);
  const setPendingCount = workspace?.setPendingCount;
  useEffect(() => {
    setPendingCount?.(pending.length);
    return () => setPendingCount?.(0);
  }, [pending.length, setPendingCount]);
  const todayBookings = data.bookings.filter((b) => b.booking_date === date);
  const courtBookings = todayBookings.filter((b) =>
    b.booking_type === "court" && b.status !== "cancelled" && b.status !== "expired",
  );
  const scheduledCourts = calendarCourts(data.courts ?? defaultCourts, courtBookings);
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
  function go(t: Tab, paymentReview = false) {
    setMobile(false);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", t);
    url.searchParams.delete("q");
    if (t !== "bookings") url.searchParams.delete("scope");
    if (paymentReview) url.searchParams.set("review", "1");
    else url.searchParams.delete("review");
    window.history.replaceState(null, "", url);
  }
  function open(type: Modal, item: typeof selected = null) {
    setModal(type);
    setSelected(item);
    setError("");
    setMethod("cash");
    setCash("");
    if (type === "product") setProductPhoto(undefined);
  }
  async function chooseProductPhoto(file: File) {
    setPreparingPhoto(true);
    setError("");
    try {
      setProductPhoto(await prepareProductPhoto(file));
    } catch (error) {
      setError(error instanceof Error ? error.message : "This photo couldn’t be prepared.");
    } finally {
      setPreparingPhoto(false);
    }
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
      const result = demo ? applyDemoCommand(data, command) : await posCommand(command);
      if (demo && "data" in result) setData(result.data);
      if ("error" in result) throw new Error(result.error);
      if (command.op === "checkout") {
        setCart({});
        checkoutKey.current = null;
      }
      if (result.receipt) {
        setReceipt(result.receipt);
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
    const collections = tab === "reports";
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
      ...data.sales.map((s) => [
          dayKey(s.created_at),
          s.number,
          s.customer_name,
          s.kind,
          (s.total_cents / 100).toFixed(2),
          (s.paid_cents / 100).toFixed(2),
          (s.refunded_cents / 100).toFixed(2),
        ]),
    ];
    const csv = collections ? collectionsCsv(data, date) : toCsv(rows);
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `rally-${collections ? "collections" : "transactions"}-${date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setToast(collections ? "Collections export downloaded." : "Transactions export downloaded.");
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (modalClosing || preparingPhoto) return;
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
          const p = editedProduct;
          await run(
            {
              op: "product",
              ...(productPhoto !== undefined && { photo: productPhoto }),
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
        case "reject-payment":
          if (!verified) throw new Error("Confirm that you checked the GCash account.");
          await run(
            { op: "reject_payment", id: selected!.id, reason: text("reason"), verified: true },
            "Payment reference rejected. Availability released.",
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
  const saleStatus = (s: Sale) => s.status === "refunded" ? "Refunded" : s.paid_cents < s.total_cents ? "Part-paid" : "Paid";
  const saleActions = (s: Sale) => (
    <div className="row-actions">
      <button type="button" title="View receipt" aria-label={`View receipt ${s.number}`}
        onClick={() => {
          setReceipt(s);
          open("receipt");
        }}>
        <ReceiptText size={17} />
      </button>
      {manager && s.refunded_cents === 0 && s.paid_cents > 0 && (
        <button type="button" className="refund-link" onClick={() => open("refund", s)}>Refund</button>
      )}
    </div>
  );
  const tableSales = (list: Sale[], anchorId: string, label: string) => (
    <div id={anchorId} className="console-table-wrap" tabIndex={-1} role="region" aria-label={label}>
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
                  {s.kind === "retail" ? "Retail" : s.kind === "membership" ? "Membership" : "Court booking"}
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
                  {saleStatus(s)}
                </span>
              </td>
              <td>{saleActions(s)}</td>
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
        setToast("Sample data reset.");
      }}>
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
                <Link href="/admin" className="console-button primary">
                  Open court calendar <ArrowUpRight size={16} />
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
                      const nextDate = e.target.value;
                      if (!demo) startNavigation(() => router.push(dayOnly ? reservationsForDateHref(nextDate) : `/staff?date=${nextDate}&tab=${tab}`));
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
              {tab === "bookings" && (demo ? (
                <button type="button" className="console-button primary" onClick={() => open("newbooking")}>
                  <Plus size={16} /> Sample booking
                </button>
              ) : (
                <Link className="console-button primary" href={`/admin?date=${date}`}>
                  Court calendar <ArrowUpRight size={16} />
                </Link>
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
            <div className="overview-content">
              {!demo && <div className="console-panel overview-register">
                <RegisterControl data={register} shift={shift} operator={operator} ready={data.ready} />
                <OnDutyControl key={initialDate} data={register} date={initialDate} manager={canAssign} followToday={followToday} />
              </div>}
              <div className="overview-operations">
                <section className="console-panel">
                  <div className="panel-heading">
                    <h2>Needs attention</h2>
                    <span className="attention-count">{pending.length + lowStock.length}</span>
                  </div>
                  <button type="button" className="attention-row" onClick={() => go("bookings", true)}>
                    <span className="attention-icon peach"><QrCode size={17} aria-hidden="true" /></span>
                    <span>
                      <strong>Payments to verify</strong>
                      {overdue > 0 && <small className="review-overdue">{overdue} overdue</small>}
                    </span>
                    <b>{pending.length}</b>
                    <ChevronRight size={15} aria-hidden="true" />
                  </button>
                  <button type="button" className="attention-row" onClick={() => go("inventory")}>
                    <span className="attention-icon lime"><Package size={17} aria-hidden="true" /></span>
                    <span><strong>Low stock</strong></span>
                    <b>{lowStock.length}</b>
                    <ChevronRight size={15} aria-hidden="true" />
                  </button>
                </section>
                <section className="console-panel">
                  <div className="panel-heading">
                    <h2>Court schedule</h2>
                    <Link href={demo ? "/demo?tab=bookings" : `/admin?date=${date}`} className="overview-panel-link"
                      onClick={demo ? (event) => { event.preventDefault(); go("bookings"); } : undefined}>
                      Court calendar <ArrowUpRight size={15} aria-hidden="true" />
                    </Link>
                  </div>
                  <div className="court-timeline">
                    {scheduledCourts.map(({ id, name }) => {
                      const bookings = courtBookings.filter((b) => b.court_id === id);
                      return <div className="timeline-row" key={id}>
                        <div className="timeline-court"><strong>{name}</strong></div>
                        <div className="timeline-blocks">
                          {bookings.map((b) => (
                            <Link key={b.id}
                              className={b.status === "confirmed" ? "block-confirmed" : b.status === "blocked" ? "block-closed" : "block-pending"}
                              href={demo ? "/demo?tab=bookings" : b.status === "blocked" ? `/admin?date=${date}` : reservationsForDateHref(date, b.reference)}
                              onClick={demo ? (event) => { event.preventDefault(); go("bookings"); } : undefined}>
                              <strong>{formatHour(b.start_hour)}–{formatHour(b.start_hour + b.duration)}</strong>
                              <span>{b.customer_name} · {statusName(b.status)}</span>
                            </Link>
                          ))}
                          {!bookings.length && <span className="timeline-empty">No bookings</span>}
                        </div>
                      </div>;
                    })}
                    {data.openPlaySessions?.map(({ start, end, players, capacity }) => (
                      <div className="timeline-row" key={`${start}:${end}`}>
                        <div className="timeline-court">
                          <strong>Open play</strong>
                          <small>{formatHour(start)}–{formatHour(end)}</small>
                        </div>
                        <span className="overview-player-count">
                          {capacity === null ? `${players} reserved` : `${players} / ${capacity} players`}
                        </span>
                      </div>
                    ))}
                    {!data.openPlaySessions && data.ready && <p className="overview-schedule-note">Open-play schedule unavailable.</p>}
                    {scheduledCourts.length === 0 && data.openPlaySessions?.length === 0 &&
                      <p className="overview-schedule-note">No courts scheduled for this date.</p>}
                  </div>
                </section>
              </div>
              <div className="metrics-grid overview-metrics">
                <Metric
                  label="NET COLLECTIONS"
                  value={<OverviewMetricValue value={metrics.net} currency animate={!isNavigating}
                    trend={data.overviewTrends && { values: data.overviewTrends.net, label: "Daily net collections over the seven days ending on the selected date" }} />}
                  hint="Payments received less refunds"
                  icon={<Banknote size={19} />}
                  tone="lime"
                />
                <Metric
                  label="COURT RESERVATIONS"
                  value={<OverviewMetricValue value={todayBookings.filter((b) => b.status === "confirmed").length} animate={!isNavigating}
                    trend={data.overviewTrends && { values: data.overviewTrends.reservations, label: "Daily confirmed reservations over the seven days ending on the selected date" }} />}
                  hint="Confirmed for the selected play date"
                  icon={<CalendarDays size={19} />}
                  tone="lavender"
                />
                <Metric
                  label="RETAIL SALES"
                  value={<OverviewMetricValue value={metrics.retail} currency animate={!isNavigating}
                    trend={data.overviewTrends && { values: data.overviewTrends.retail, label: "Daily retail sales over the seven days ending on the selected date" }} />}
                  hint="Counter sales created on this date"
                  icon={<ShoppingBasket size={19} />}
                  tone="peach"
                />
                <Metric
                  label="BOOKING BALANCES"
                  value={<OverviewMetricValue value={metrics.due} currency animate={!isNavigating}
                    trend={data.overviewTrends && { values: data.overviewTrends.balances, label: "Outstanding balances by play date from the selected date through 30 days ahead" }} />}
                  hint="Confirmed reservations in the next 30 days"
                  icon={<Clock3 size={19} />}
                  tone="blue"
                />
              </div>
              <section className="console-panel">
                <div className="panel-heading">
                  <h2>Recent transactions</h2>
                  <button type="button" className="overview-panel-link" onClick={() => go("transactions")}>
                    View all <ArrowUpRight size={15} aria-hidden="true" />
                  </button>
                </div>
                <div id="recent-transactions" tabIndex={-1} role="region" aria-label="Recent transactions">
                  {data.sales.length ? (
                    <ul className="overview-transactions">
                      {data.sales.slice(recentTransactions.start, recentTransactions.end).map((s) => (
                        <li key={s.id}>
                          <div>
                            <strong>{s.kind === "retail" ? "Counter sale" : s.kind === "membership" ? "Membership" : "Court booking"}</strong>
                            <small>{s.customer_name} · {s.number}</small>
                          </div>
                          <div className="overview-transaction-amount">
                            <strong>{peso(s.total_cents)}</strong>
                            <small>{saleStatus(s)}{s.paid_cents < s.total_cents && ` · ${peso(s.total_cents - s.paid_cents)} outstanding`}</small>
                          </div>
                          {saleActions(s)}
                        </li>
                      ))}
                    </ul>
                  ) : <p className="overview-schedule-note">No transactions for this date.</p>}
                </div>
                <TablePagination {...recentTransactions} label="Recent transaction pages" anchorId="recent-transactions" />
              </section>
            </div>
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
                          <ProductPhoto src={productPhotoUrl(p.photo_version)} className="product-tile-photo"
                            fallback={<ProductArt category={p.category} index={i} />} />
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
                      Open a register shift to accept payments
                    </button>
                  ) : (
                    <span className="cart-secure">
                      <CheckCircle2 size={13} /> Your register shift is active
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
                {dayOnly && !reviewOnly && <Link className="text-link" href={`/staff?tab=bookings&date=${date}`}>
                  Show upcoming reservations
                </Link>}
              </div>
              <div className="category-tabs payment-review-tabs" role="group" aria-label="Reservation views">
                <button type="button" aria-pressed={!reviewOnly} className={!reviewOnly ? "active" : ""}
                  onClick={() => go("bookings")}>
                  {dayOnly ? "Reservations for this date" : "All reservations"}
                </button>
                <button type="button" aria-pressed={reviewOnly} className={reviewOnly ? "active" : ""}
                  onClick={() => go("bookings", true)}>
                  GCash review ({pending.length})
                </button>
              </div>
              {!demo && reviewOnly && !data.paymentReviews && (
                <p className="payment-review-notice" role="status">
                  The full GCash review queue is unavailable. Showing payments from the selected reservation period. Check migration 018 and refresh.
                </p>
              )}
              {reviewOnly && overdue > 0 && (
                <p className="payment-review-notice review-overdue" role="status">
                  {overdue === 1 ? "1 payment review is overdue." : `${overdue} payment reviews are overdue.`} Check your GCash account to verify or reject the references.
                </p>
              )}
              <div id="staff-reservation-table" className="console-table-wrap" tabIndex={-1} role="region" aria-label="Reservations">
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
                    {reservationRows.slice(reservations.start, reservations.end).map((b) => {
                      const review = paymentReviews.get(b.id);
                      return (
                        <tr key={b.id}>
                          <td>
                            <strong>{b.customer_name}</strong>
                            <small>{manager && !demo && b.status !== "blocked"
                              ? <Link className="text-link" href={`/booking/${b.id}`}>{b.reference}</Link>
                              : b.reference}</small>
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
                              {review?.overdue ? "Review overdue" : statusName(b.status)}
                            </span>
                            {reviewOnly && review?.payment_submitted_at && (
                              <small>Submitted {dateLabel(review.payment_submitted_at)}</small>
                            )}
                          </td>
                          <td>
                            <div className="reservation-row-actions">
                            {b.status === "awaiting_verification" ? (
                              <button
                                className="console-button small primary"
                                onClick={() => open("verify", b)}
                              >
                                Review payment
                              </button>
                            ) : b.status === "confirmed" &&
                              Number(b.paid_amount) < Number(b.total_amount) ? (
                              <button
                                className="console-button small"
                                onClick={() => manager && !demo ? setReservationAction({ kind: "balance", booking: b }) : open("balance", b)}
                              >
                                Collect balance
                              </button>
                            ) : (
                              <span className="cell-muted">
                                {b.status === "confirmed" ? "Fully paid" : "—"}
                              </span>
                            )}
                            {manager && !demo && ["awaiting_payment", "awaiting_verification", "confirmed"].includes(b.status) &&
                              <button type="button" className="console-button small"
                                aria-label={`Cancel reservation ${b.reference}`}
                                onClick={() => setReservationAction({ kind: "cancel", booking: b })}>Cancel reservation</button>}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!reservationRows.length && (
                  <Empty
                    title={search ? "No matching reservations" : reviewOnly ? "No GCash payments to review" : "No reservations"}
                    text={search ? "Try a different name or booking reference." : reviewOnly ? "Submitted GCash references will appear here." : "Customer bookings and staff walk-ins appear here."}
                  />
                )}
              </div>
              <TablePagination {...reservations} label={reviewOnly ? "GCash review pages" : "Staff reservation pages"}
                anchorId="staff-reservation-table" />
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
                <div id="inventory-table" className="console-table-wrap" tabIndex={-1} role="region" aria-label="Inventory">
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
                      {products
                        .slice(inventory.start, inventory.end)
                        .map((p) => (
                          <tr key={p.id}>
                            <td>
                              <div className="inventory-product">
                                <div className="product-thumbnail" aria-hidden="true">
                                  <ProductPhoto src={productPhotoUrl(p.photo_version)} fallback={<Package size={16} />} />
                                </div>
                                <div>
                                  <strong>{p.name}</strong>
                                  <small>{p.sku} · {p.barcode || "No barcode"}</small>
                                </div>
                              </div>
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
                  {!products.length && (
                    <Empty
                      title={search ? "No matching products" : "No products"}
                      text={search ? "Try a different product name, SKU, or barcode." : "Add a product to start tracking stock."}
                    />
                  )}
                </div>
                <TablePagination {...inventory} label="Inventory pages" anchorId="inventory-table" />
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
              {tableSales(transactionRows.slice(transactions.start, transactions.end), "transaction-table", "Transactions")}
              <TablePagination {...transactions} label="Transaction pages" anchorId="transaction-table" />
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
                      ["Other methods", metrics.other, "lime"],
                    ].filter(([label, value]) => label !== "Other methods" || value !== 0).map(([label, n, tone]) => (
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
                    its later balance are separate receipts of money. Collections
                    before the POS launch are available in Booking finance.
                    </p>
                  </details>
                </section>
                <section className="console-panel">
                  <div className="panel-heading">
                    <h2>Register shifts</h2>
                    <button
                      disabled={!data.ready || Boolean(register?.active && !shift)}
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
                {tableSales(dailySales.slice(collections.start, collections.end), "collection-sales-table", "Sales for the selected date")}
                <TablePagination {...collections} label="Collection sales pages" anchorId="collection-sales-table" />
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
      {reservationAction?.kind === "balance" && (
        <BalancePaymentModal booking={reservationAction.booking} closing={reservationActionClosing}
          onClose={() => setReservationAction(null)} />
      )}
      {reservationAction?.kind === "cancel" && (
        <StaffCancelBookingModal booking={reservationAction.booking} closing={reservationActionClosing}
          onClose={() => setReservationAction(null)} onSaved={() => {
            setReservationAction(null);
            setToast("Reservation cancelled.");
          }} />
      )}
      {(modal === "open" || modal === "close") && (
        <RegisterShiftDialog key={modal} submitCommand={demo ? (command) => {
          try {
            setData(applyDemoCommand(data, command).data);
            return { ok: true };
          } catch (error) {
            return { error: error instanceof Error ? error.message : "The sample shift couldn’t be saved." };
          }
        } : undefined} shift={modal === "close" ? shift : undefined} operator={operator}
          closing={modalClosing} onClose={() => setModal(null)} onSaved={(message) => {
            setModal(null);
            setToast(message);
          }} />
      )}
      {modal && modal !== "open" && modal !== "close" && (
        <div
          className={`console-modal-backdrop ${modal === "receipt" ? "receipt-backdrop" : ""}`}
          data-closing={modalClosing || undefined}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !dialogBusy && !modalClosing) setModal(null);
          }}
        >
          <div
            className={`console-modal ${modal === "receipt" ? "receipt-modal" : ""}`}
            data-closing={modalClosing || undefined}
            inert={modalClosing}
            role="dialog"
            aria-modal="true"
            aria-label={
              modal === "receipt" ? "Transaction receipt" : reviewingPayment ? "Review GCash payment" : `${modal} form`
            }
            onKeyDown={(e) => {
              if (e.key === "Escape" && !dialogBusy) setModal(null);
            }}
          >
            <button
              className="modal-close"
              aria-label="Close dialog"
              disabled={dialogBusy}
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
                    A record of the transaction. Request the venue’s authorized invoice separately.
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
              <form key={modal} onSubmit={submit}>
                <h2>
                  {
                    (
                      {
                        newbooking: "Sample booking",
                        checkout: "Complete sale",
                        product: selected
                          ? "Edit product"
                          : "Add product",
                        stock: "Adjust stock",
                        refund: "Record refund",
                        balance: "Collect balance",
                        verify: "Verify GCash payment",
                        "reject-payment": "Reject GCash reference",
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
                    {!demo && <ProductPhotoField
                      src={productPhoto ? previewProductPhoto(productPhoto)
                        : productPhoto === null ? undefined : productPhotoUrl(editedProduct?.photo_version)}
                      preparing={preparingPhoto} disabled={dialogBusy || modalClosing}
                      onChoose={chooseProductPhoto} onRemove={() => {
                        setProductPhoto(editedProduct?.photo_version ? null : undefined);
                        setError("");
                      }} />}
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
                        />
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
                {(modal === "balance" || reviewingPayment) && (
                  <>
                    <div className="modal-amount">
                      <span>
                        {(selected as PosBooking).customer_name} ·{" "}
                        {(selected as PosBooking).reference}
                      </span>
                      <strong>
                        {peso(
                          Math.round(
                            (reviewingPayment
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
                    {reviewingPayment ? (
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
                        {modal === "reject-payment" ? (
                          <>
                            <p className="form-note">
                              Rejecting this reference cancels the reservation and releases the court or open-play places.
                            </p>
                            <label>
                              Rejection reason (staff only)
                              <textarea name="reason" required minLength={3} maxLength={200} rows={3} />
                            </label>
                            <Verified text="I checked the GCash account and found no matching incoming payment." />
                          </>
                        ) : (
                          <>
                            <p className="form-note">
                              Match the amount, reference, and recipient against the actual incoming GCash transaction.
                            </p>
                            <Verified text="I verified the incoming payment in the GCash account." />
                          </>
                        )}
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
                            Cash requires an open register shift.
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
                  disabled={dialogBusy || !data.ready}
                  className={`console-button full-width ${modal === "reject-payment" ? "reject-payment-button" : "primary"}`}
                >
                  {busy
                    ? "Saving…"
                    : modal === "checkout"
                      ? `Complete sale · ${peso(total)}`
                      : modal === "verify"
                        ? "Verify payment & confirm booking"
                        : modal === "reject-payment"
                          ? "Reject reference & release reservation"
                        : modal === "refund"
                          ? "Record completed refund"
                          : "Save & continue"}
                  <Check size={17} />
                </button>
                {modal === "verify" && selected && paymentReviews.has(selected.id) && (
                  <button type="button" className="console-button full-width" disabled={busy}
                    onClick={() => open("reject-payment", selected)}>
                    Reject reference
                  </button>
                )}
                <button
                  type="button"
                  className="cancel-button"
                  disabled={dialogBusy}
                  onClick={() => modal === "reject-payment" ? open("verify", selected) : setModal(null)}
                >
                  {modal === "reject-payment" ? "Back to payment review" : "Cancel"}
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
  value: string | React.ReactElement;
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
      {typeof value === "string" ? <strong>{value}</strong> : value}
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
