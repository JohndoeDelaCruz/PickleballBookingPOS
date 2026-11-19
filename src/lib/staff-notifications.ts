import { z } from "zod";
import { accountRolesHref } from "./account-roles";
import { formatDate, formatHour } from "./booking";
import { membershipSectionHref } from "./membership-applications";

export const notificationsPerPage = 15;

const titles = {
  booking_payment: "Booking payment submitted",
  booking_confirmed: "Booking confirmed",
  booking_cancelled: "Booking cancelled",
  membership_payment: "Membership payment submitted",
  membership_activated: "Membership activated",
  account_verified: "New verified account",
};

const rowSchema = z.object({
  id: z.int().positive(),
  kind: z.enum(Object.keys(titles) as (keyof typeof titles)[]),
  subject_id: z.uuid(),
  created_at: z.iso.datetime({ offset: true }),
  is_read: z.boolean(),
  priority: z.boolean(),
  booking_reference: z.string().nullable(),
  booking_date: z.iso.date().nullable(),
  start_hour: z.int().min(0).max(23).nullable(),
  duration: z.int().positive().nullable(),
  court_label: z.string().nullable(),
  plan_name: z.string().nullable(),
  membership_status: z.string().nullable(),
  account_email: z.string().nullable(),
});

export const staffNotificationFeedSchema = z.object({
  unread_count: z.int().nonnegative(),
  total_count: z.int().nonnegative(),
  rows: z.array(rowSchema),
});

export type StaffNotification = z.infer<typeof rowSchema>;
export type StaffNotificationFeed = z.infer<typeof staffNotificationFeedSchema>;

export function staffNotificationContent(row: StaffNotification) {
  const title = titles[row.kind];
  if (row.kind === "account_verified") return { title, detail: row.account_email, href: accountRolesHref(row.account_email ?? "") };
  if (row.kind === "membership_payment" || row.kind === "membership_activated") {
    const section = row.kind === "membership_payment" && row.membership_status === "pending" ? "pending" : "reviewed";
    return { title, detail: row.plan_name,
      href: membershipSectionHref(section, { application: { section, id: row.subject_id } }) };
  }

  const params = new URLSearchParams({ tab: "bookings" });
  if (row.booking_date) params.set("date", row.booking_date);
  if (row.booking_reference) params.set("q", row.booking_reference);
  const time = row.start_hour != null && row.duration != null
    ? `${formatHour(row.start_hour)}–${formatHour(row.start_hour + row.duration)}` : null;
  const detail = [row.court_label, row.booking_date && formatDate(row.booking_date), time].filter(Boolean).join(" · ");
  return { title, detail, href: `/staff?${params}` };
}
