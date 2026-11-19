"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Bell } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { notificationsPerPage, staffNotificationContent, staffNotificationFeedSchema,
  type StaffNotification, type StaffNotificationFeed } from "@/lib/staff-notifications";
import { Modal } from "./modal";
import { useAnimatedModal } from "./use-animated-modal";
import { useWorkspace } from "./workspace-context";

const notificationTime = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

export function StaffNotifications() {
  const workspace = useWorkspace();
  return workspace ? <NotificationBell /> : null;
}

function NotificationBell() {
  const db = useMemo(createClient, []);
  const [open, setOpen, closing] = useAnimatedModal<true>();
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{ page: number; feed: StaffNotificationFeed }>();
  const [loadError, setLoadError] = useState("");
  const [readError, setReadError] = useState("");
  const [markingAll, setMarkingAll] = useState(false);
  const generation = useRef(0);
  const unread = result?.feed.unread_count ?? 0;
  const feed = result?.page === page ? result.feed : undefined;
  const pageCount = Math.max(1, Math.ceil((feed?.total_count ?? 0) / notificationsPerPage));

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    const failed = "Notifications couldn’t be loaded.";
    try {
      const { data, error } = await db.rpc("staff_notification_feed", { p_page: page });
      if (request !== generation.current) return;
      if (error) {
        setResult(undefined);
        setLoadError(error.code === "PGRST202" ? "Apply database migration 042 to enable notifications." : failed);
        return;
      }
      const parsed = staffNotificationFeedSchema.safeParse(data);
      if (!parsed.success) throw new Error(failed);
      setResult({ page, feed: parsed.data });
      setLoadError("");
    } catch {
      if (request !== generation.current) return;
      setResult(undefined);
      setLoadError(failed);
    }
  }, [db, page]);

  useEffect(() => {
    const whileVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    void refresh();
    const timer = window.setInterval(whileVisible, 30000);
    window.addEventListener("focus", whileVisible);
    document.addEventListener("visibilitychange", whileVisible);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
      window.removeEventListener("focus", whileVisible);
      document.removeEventListener("visibilitychange", whileVisible);
    };
  }, [refresh]);

  async function markRead(id: number | null) {
    if (id === null) setMarkingAll(true);
    setReadError("");
    try {
      const { error } = await db.rpc("mark_staff_notifications_read", { p_notification_id: id });
      if (error) throw error;
      await refresh();
    } catch { setReadError("The read status couldn’t be saved. Try again."); }
    finally { if (id === null) setMarkingAll(false); }
  }

  function openFeed() {
    setReadError("");
    setOpen(true);
    if (page === 1) void refresh();
    else setPage(1);
  }

  function follow(row: StaffNotification) {
    if (!row.is_read) void markRead(row.id);
    setOpen(null);
  }

  return <div className="staff-notifications">
    <button type="button" className="icon-button staff-notification-bell" onClick={openFeed}
      aria-haspopup="dialog" aria-expanded={Boolean(open && !closing)} aria-label={`Notifications, ${unread} unread`}>
      <Bell size={19} aria-hidden="true" />
      {unread > 0 && <span className="staff-notification-count" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
    </button>
    {open && <Modal title="Notifications" className="staff-notifications-dialog" closing={closing} onClose={() => setOpen(null)}>
      <div className="staff-notification-toolbar">
        <span>{unread} unread</span>
        <button type="button" className="console-button small" disabled={markingAll || unread === 0} onClick={() => void markRead(null)}>
          {markingAll ? "Saving…" : "Mark all as read"}
        </button>
      </div>
      {readError && <p className="error-message" role="alert">{readError}</p>}
      {loadError ? <div className="staff-notification-message" role="status">
        <p>{loadError}</p><button type="button" className="console-button small" onClick={() => void refresh()}>Retry</button>
      </div> : !feed ? <p className="staff-notification-message" role="status">Loading notifications…</p>
        : feed.rows.length === 0 ? <p className="staff-notification-message">No notifications yet.</p>
          : <ul className="staff-notification-list">
            {feed.rows.map((row) => {
              const { title, detail, href } = staffNotificationContent(row);
              return <li key={row.id}>
                <Link href={href} prefetch={false} onClick={() => follow(row)} className="staff-notification-row" data-unread={!row.is_read || undefined}>
                  <span className="staff-notification-dot" aria-hidden="true" />
                  <span className="staff-notification-copy">
                    <strong>{title}{!row.is_read && <span className="sr-only">, unread</span>}</strong>
                    {detail && <span>{detail}</span>}
                    <small><time dateTime={row.created_at}>{notificationTime.format(new Date(row.created_at))}</time>
                      {row.priority && <span className="staff-notification-priority">Needs attention</span>}</small>
                  </span>
                  <ArrowUpRight className="staff-notification-arrow" size={15} aria-hidden="true" />
                </Link>
              </li>;
            })}
          </ul>}
      {feed && pageCount > 1 && <nav className="staff-notification-toolbar staff-notification-pager" aria-label="Notification pages">
        <button type="button" className="console-button small" disabled={markingAll || page === 1} onClick={() => setPage(page - 1)}>Newer</button>
        <span>Page {page} of {pageCount}</span>
        <button type="button" className="console-button small" disabled={markingAll || page >= pageCount} onClick={() => setPage(page + 1)}>Older</button>
      </nav>}
    </Modal>}
  </div>;
}
