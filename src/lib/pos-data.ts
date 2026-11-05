import { createClient } from "./supabase/server";
import { dayKey, type PosData, type Sale, type SaleItem } from "./pos";
import { getCourtInventory } from "./data";
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
    const start = `${day}T00:00:00+08:00`;
    const end = new Date(new Date(start).getTime() + 86400000).toISOString();
    const results = await Promise.all([
      db.from("pos_products").select("*").order("name").limit(1000),
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
      db
        .from("bookings")
        .select(
          "id,reference,customer_name,booking_date,start_hour,duration,court_id,booking_type,status,total_amount,paid_amount,initial_payment_amount,payment_reference,payment_option",
        )
        .gte("booking_date", day)
        .lte(
          "booking_date",
          dayKey(new Date(new Date(start).getTime() + 30 * 86400000)),
        )
        .order("booking_date")
        .order("start_hour")
        .limit(1000),
      db.rpc("club_role"),
    ]);
    if (results.some((r) => r.error))
      return {
        ...empty,
        error:
          "The club database needs setup. Apply supabase/setup.sql, then reload. The presentation demo is available now.",
      };
    if (
      results
        .slice(0, 3)
        .some((r) => Array.isArray(r.data) && r.data.length >= 1000)
    )
      return {
        ...empty,
        error:
          "This report exceeds the first-release record limit. Export or narrow the reporting period before continuing.",
      };
    const [products, payments, refunds, shifts, movements, bookings, role] =
      results.map((r) => r.data);
    const ids = [
      ...new Set(
        [...(payments ?? []), ...(refunds ?? [])].map(
          (p: { sale_id: string }) => p.sale_id,
        ),
      ),
    ];
    const filter = `and(created_at.gte.${start},created_at.lt.${end})${ids.length ? `,id.in.(${ids.join(",")})` : ""}`;
    const { data: sales, error } = await db
      .from("pos_sales")
      .select("*,items:pos_sale_items(*)")
      .or(filter)
      .order("created_at", { ascending: false })
      .limit(1000);
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
      products: products ?? [],
      sales: normalized,
      payments: payments ?? [],
      refunds: refunds ?? [],
      shifts: shifts ?? [],
      movements: movements ?? [],
      bookings: bookings ?? [],
      role: role ?? "cashier",
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
