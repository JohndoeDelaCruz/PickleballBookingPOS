import type { PostgrestError } from "@supabase/supabase-js";
import { createClient } from "./supabase/server";
import { dayKey, type OverviewOpenPlaySession, type OverviewTrends, type PosBooking, type PosData, type PosPaymentReview, type Sale, type SaleItem } from "./pos";
import { getCourtInventory, getVenue } from "./data";
import { resolveSchedule } from "./schedule";
import type { CalendarBooking } from "./types";

async function readPosRows<Row>(read: (start: number, end: number) => PromiseLike<{
  data: Row[] | null;
  error: PostgrestError | null;
}>) {
  const batchSize = 500;
  const rows: Row[] = [];
  for (let start = 0; ; start += batchSize) {
    const { data, error } = await read(start, start + batchSize - 1);
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
    if (!data || data.length < batchSize) return { data: rows, error: null };
  }
}

export async function getPosData(day = dayKey()): Promise<PosData> {
  const inventory = await getCourtInventory();
  const empty: PosData = {
    courts: inventory.courts,
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
  if (!inventory.loaded) return { ...empty, error: "Court details could not be loaded. Please refresh before continuing." };
  try {
    const db = await createClient();
    const venueRequest = getVenue();
    const start = `${day}T00:00:00+08:00`;
    const end = new Date(new Date(start).getTime() + 86400000).toISOString();
    const [products, payments, refunds, shifts, movements, bookings, role, reviews, trends] = await Promise.all([
      readPosRows((start, end) => db.from("pos_products").select("*").order("name").order("id").range(start, end)),
      db
        .from("pos_payments")
        .select("*")
        .gte("created_at", start)
        .lt("created_at", end)
        .order("created_at", { ascending: false })
        .limit(2000),
      db
        .from("pos_refunds")
        .select("*")
        .gte("created_at", start)
        .lt("created_at", end)
        .limit(2000),
      db.rpc("pos_shift_summary"),
      db
        .from("pos_stock_movements")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50),
      readPosRows<PosBooking>((start, end) => db.rpc("pos_reservations", { p_date: day }).range(start, end)),
      db.rpc("club_role"),
      readPosRows<PosPaymentReview>((start, end) => db.rpc("pos_payment_reviews").range(start, end)),
      db.rpc("pos_overview_trends", { p_date: day }),
    ]);
    if ([products, payments, refunds, shifts, movements, bookings, role].some((r) => r.error))
      return {
        ...empty,
        error:
          "The staff workspace could not load. Confirm that the staff workspace migrations are applied, then refresh.",
      };
    if (
      [products, payments, refunds].some((r) => Array.isArray(r.data) && r.data.length >= 1000)
    )
      return {
        ...empty,
        error:
          "This report exceeds the first-release record limit. Export or narrow the reporting period before continuing.",
      };
    const ids = [
      ...new Set(
        [...(payments.data ?? []), ...(refunds.data ?? [])].map(
          (p: { sale_id: string }) => p.sale_id,
        ),
      ),
    ];
    const filter = `and(created_at.gte.${start},created_at.lt.${end})${ids.length ? `,id.in.(${ids.join(",")})` : ""}`;
    const [{ data: sales, error }, openPlaySessions] = await Promise.all([
      readPosRows((start, end) => db
        .from("pos_sales")
        .select("*,items:pos_sale_items(*)")
        .or(filter)
        .order("created_at", { ascending: false })
        .order("id")
        .range(start, end)),
      readOverviewOpenPlay(db, day, venueRequest, bookings.data ?? []),
    ]);
    if (error)
      return {
        ...empty,
        error: "Sales could not be loaded. Check permissions and refresh.",
      };
    const normalized = (sales ?? []).map((s) => ({
      ...s,
      items: s.items as SaleItem[],
      paid_cents: s.paid_cents,
      refunded_cents: s.refunded_cents,
    })) as Sale[];
    return {
      courts: inventory.courts,
      products: products.data ?? [],
      sales: normalized,
      payments: payments.data ?? [],
      refunds: refunds.data ?? [],
      shifts: shifts.data ?? [],
      movements: movements.data ?? [],
      bookings: bookings.data ?? [],
      paymentReviews: reviews.error ? undefined : (reviews.data ?? []),
      overviewTrends: trends.error ? undefined : (trends.data as OverviewTrends | null) ?? undefined,
      openPlaySessions,
      role: role.data ?? "cashier",
      ready: true,
    };
  } catch {
    return {
      ...empty,
      error:
        "Unable to reach the database. Refresh when your connection is restored.",
    };
  }
}

async function readOverviewOpenPlay(
  db: Awaited<ReturnType<typeof createClient>>,
  date: string,
  venueRequest: ReturnType<typeof getVenue>,
  reservations: PosBooking[],
): Promise<OverviewOpenPlaySession[] | undefined> {
  try {
    const { venue, ready } = await venueRequest;
    if (!ready) return undefined;
    const sessions = resolveSchedule(venue, date).blocks
      .filter(({ kind }) => kind === "open_play")
      .map(({ start, end, capacity }) => ({ start, end, capacity, players: 0 }));
    const occupying = ["awaiting_payment", "awaiting_verification", "confirmed"];
    if (!reservations.some((b) => b.booking_date === date && b.booking_type === "open_play" && occupying.includes(b.status))) {
      return sessions;
    }

    // The calendar RPC includes group sizes and accepts historical staff report dates.
    type OpenPlayBooking = Pick<CalendarBooking, "start_hour" | "duration" | "participant_count">;
    const { data, error } = await readPosRows<OpenPlayBooking>(
      async (start, end) => {
        const { data, error } = await db.rpc("pos_calendar_reservations", { p_date: date })
          .select("start_hour,duration,participant_count")
          .eq("booking_type", "open_play")
          .in("status", occupying)
          .order("id")
          .range(start, end);
        if (!error && !Array.isArray(data)) throw new Error("Unexpected calendar rows.");
        return { data: Array.isArray(data) ? data : null, error };
      },
    );
    if (error) return undefined;
    const byTime = new Map(sessions.map((session) => [`${session.start}:${session.end}`, session]));
    for (const booking of data) {
      const start = booking.start_hour;
      const end = start + booking.duration;
      const key = `${start}:${end}`;
      const session = byTime.get(key) ?? { start, end, capacity: null, players: 0 };
      session.players += booking.participant_count;
      byTime.set(key, session);
    }
    return [...byTime.values()].sort((a, b) => a.start - b.start || a.end - b.end);
  } catch {
    return undefined;
  }
}
