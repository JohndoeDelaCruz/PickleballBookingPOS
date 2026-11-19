"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function CashierAccessCheck() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (pathname !== "/staff" && !pathname.startsWith("/staff/") && pathname !== "/admin" && !pathname.startsWith("/admin/")) return;
    let active = true;
    let checking = false;
    async function check() {
      if (document.visibilityState !== "visible" || checking) return;
      checking = true;
      try {
        const { data, error } = await createClient().rpc("is_club_staff");
        if (active && !error && data === false) router.replace("/my-bookings");
      } catch {
        // The next check retries. Database permissions still apply to requests.
      } finally {
        checking = false;
      }
    }
    void check();
    const timer = window.setInterval(check, 30_000);
    document.addEventListener("visibilitychange", check);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [pathname, router]);

  return null;
}
