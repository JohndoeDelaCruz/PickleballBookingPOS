begin;

alter table public.bookings
  add column payment_submitted_at timestamptz,
  add column payment_rejected_at timestamptz;

create function private.stamp_gcash_submission() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'awaiting_verification' and new.payment_reference is not null then
    if tg_op = 'INSERT' or old.status <> 'awaiting_verification'
      or old.payment_reference is distinct from new.payment_reference then
      new.payment_submitted_at := now();
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.stamp_gcash_submission() from public, anon, authenticated;

create trigger stamp_gcash_submission
before insert or update of status, payment_reference on public.bookings
for each row execute function private.stamp_gcash_submission();

create index pending_gcash_review_age on public.bookings
  ((coalesce(payment_submitted_at, hold_expires_at, created_at)), id)
  where status = 'awaiting_verification' and payment_reference is not null;

create function public.pos_payment_reviews()
returns table (
  id uuid, reference text, customer_name text, booking_date date,
  start_hour smallint, duration smallint, court_id smallint, booking_type text,
  status text, total_amount numeric, paid_amount numeric, initial_payment_amount numeric,
  payment_reference text, payment_option text, payment_submitted_at timestamptz,
  overdue boolean
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.pos_require_staff();
  -- For legacy submissions, the original hold deadline is the latest time a
  -- reference could have been accepted. Keep the exact submission time unknown.
  return query select
    b.id, b.reference, b.customer_name, b.booking_date, b.start_hour, b.duration,
    b.court_id, b.booking_type, b.status, b.total_amount, b.paid_amount,
    b.initial_payment_amount, b.payment_reference, b.payment_option, b.payment_submitted_at,
    coalesce(b.payment_submitted_at, b.hold_expires_at, b.created_at) <= now() - interval '30 minutes'
  from public.bookings b
  where b.status = 'awaiting_verification' and b.payment_reference is not null
  order by coalesce(b.payment_submitted_at, b.hold_expires_at, b.created_at), b.id;
end;
$$;

create function public.pos_reject_booking_payment(p_booking uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings%rowtype;
  reason text := btrim(p_reason);
begin
  perform private.pos_require_staff();
  if reason is null or char_length(reason) not between 3 and 200 then
    raise exception 'POS: Enter a rejection reason between 3 and 200 characters.';
  end if;

  -- Verification locks the same booking before marking it paid. A stale
  -- rejection cannot release a slot once payment is verified.
  select * into b from public.bookings where id = p_booking for update;
  if not found or b.status <> 'awaiting_verification'
    or b.payment_reference is null or b.paid_amount <> 0 then
    raise exception 'POS: Only an unpaid booking with a GCash reference under review can be rejected.';
  end if;

  update public.bookings
    set status = 'cancelled', payment_reference = null, payment_rejected_at = now()
    where id = b.id;
  insert into public.pos_audit(actor_id, action, entity_id, detail)
    values (auth.uid(), 'booking.payment.reject', b.id, jsonb_build_object(
      'reference', b.payment_reference,
      'amount', b.initial_payment_amount,
      'reason', reason
    ));
end;
$$;

revoke all on function public.pos_payment_reviews(), public.pos_reject_booking_payment(uuid, text)
  from public, anon, authenticated;
grant execute on function public.pos_payment_reviews(), public.pos_reject_booking_payment(uuid, text)
  to authenticated;

notify pgrst, 'reload schema';
commit;
