import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getSession, getVenue } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { BookingDetail } from "@/components/booking-detail";
import type { Booking } from "@/lib/types";
export const metadata: Metadata = { title: "Booking details" };
export default async function BookingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { user } = await getSession();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/booking/${id}`)}`);
  const { venue, ready } = await getVenue();
  if (!ready) notFound();
  const supabase = await createClient();
  await supabase.rpc("expire_unpaid_holds");
  const { data, error } = await supabase
    .from("bookings")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !data) notFound();
  const b = data as Booking;
  return (
    <main id="main" className="container content-page">
      <div className="page-heading">
        <Link href="/my-bookings" className="breadcrumb">
          <ArrowLeft size={13} />
          My bookings
        </Link>
        <span className="eyebrow">ONE STEP CLOSER TO GAME ON</span>
        <h1>YOUR RESERVATION.</h1>
        <p>
          Everything you need to know about your court time, all in one place.
        </p>
      </div>
      <BookingDetail booking={b} venue={venue} owner={b.user_id === user.id} />
    </main>
  );
}
