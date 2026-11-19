begin;

create table public.membership_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  plan_id text not null check (plan_id in ('annual', 'six-month')),
  plan_name text not null,
  price_cents integer not null check (price_cents between 1 and 10000000),
  status text not null default 'awaiting_payment' check (status in ('awaiting_payment', 'pending', 'approved', 'rejected')),
  gcash_name text not null,
  gcash_number text not null,
  gcash_qr_url text not null,
  payment_reference text,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  review_note text,
  starts_on date,
  expires_on date,
  check ((status = 'awaiting_payment') = (payment_reference is null)),
  check ((status = 'awaiting_payment') = (submitted_at is null)),
  check ((status in ('approved', 'rejected')) = (reviewed_at is not null)),
  check ((status = 'approved') = (starts_on is not null and expires_on is not null)),
  check (expires_on is null or expires_on > starts_on)
);
create unique index membership_open_application_per_user on public.membership_applications (user_id)
  where status in ('awaiting_payment', 'pending');
create unique index membership_approved_reference on public.membership_applications
  (lower(regexp_replace(payment_reference,'[^a-zA-Z0-9]','','g'))) where status = 'approved';
create index membership_application_history on public.membership_applications (user_id, created_at desc, id);
create index membership_application_queue on public.membership_applications (status, submitted_at, id);
alter table public.membership_applications enable row level security;
revoke all on public.membership_applications from public, anon, authenticated;
grant select on public.membership_applications to authenticated;
create policy "Customers read their membership applications" on public.membership_applications
  for select to authenticated using (user_id = (select auth.uid()));

-- Only verified membership payments participate in the shared reference guard.
create or replace function private.pos_check_reference(p_reference text,p_booking uuid default null) returns void language plpgsql security definer set search_path='' as $$
declare normalized text;begin
 if p_reference is null or p_reference !~ '^[a-zA-Z0-9 -]{6,40}$' then raise exception 'POS: Enter a valid GCash reference (6–40 characters).';end if;
 normalized:=lower(regexp_replace(p_reference,'[^a-zA-Z0-9]','','g'));
 if length(normalized)<6 then raise exception 'POS: Enter a valid GCash reference.';end if;
 perform pg_advisory_xact_lock(hashtextextended('rally-payment:'||normalized,0));
 if exists(select 1 from public.pos_payments where method='gcash' and lower(regexp_replace(reference,'[^a-zA-Z0-9]','','g'))=normalized)
 or exists(select 1 from public.bookings where (p_booking is null or id<>p_booking) and
 (lower(regexp_replace(payment_reference,'[^a-zA-Z0-9]','','g'))=normalized or lower(regexp_replace(balance_payment_reference,'[^a-zA-Z0-9]','','g'))=normalized))
 or exists(select 1 from public.membership_applications where status = 'approved' and
    lower(regexp_replace(payment_reference,'[^a-zA-Z0-9]','','g')) = normalized)
 then raise exception 'POS: This GCash reference is already recorded or submitted.';end if;
end;$$;

create function public.start_membership_application(p_plan text, p_expected_revision integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  current_application public.membership_applications%rowtype;
  plan public.membership_settings%rowtype;
  venue public.venue_settings%rowtype;
  application_id uuid;
  fee integer;
  label text;
  today date := (now() at time zone 'Asia/Manila')::date;
begin
  if actor is null then raise exception 'Membership: Sign in to apply.'; end if;
  if p_plan is null or p_plan not in ('annual', 'six-month') then
    raise exception 'Membership: Choose a membership plan.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('rally-membership:' || actor::text, 0));
  select * into current_application from public.membership_applications
    where user_id = actor and status in ('awaiting_payment', 'pending') for update;
  if found then return current_application.id; end if;
  if exists (select 1 from public.membership_applications where user_id = actor and status = 'approved' and expires_on > today) then
    raise exception 'Membership: You already have an active membership.';
  end if;

  select * into plan from public.membership_settings where id = (p_plan = 'annual') for share;
  if not found or plan.details is null then
    raise exception 'Membership: This plan is not available for online applications yet.';
  end if;
  if plan.revision is distinct from p_expected_revision then
    raise exception 'Membership: The plan has changed. Reload this page to check the latest price before paying.';
  end if;
  fee := (plan.details->>'price_cents')::integer;
  label := plan.details->>'plan_name';
  if coalesce(fee, 0) <= 0 then raise exception 'Membership: Contact the venue to apply for this plan.'; end if;

  select * into venue from public.venue_settings where id for share;
  if nullif(btrim(venue.gcash_name), '') is null
    or (nullif(btrim(venue.gcash_number), '') is null and nullif(btrim(venue.gcash_qr_url), '') is null) then
    raise exception 'Membership: GCash payment details are unavailable. Contact the venue before paying.';
  end if;
  insert into public.membership_applications (user_id, plan_id, plan_name, price_cents, gcash_name, gcash_number, gcash_qr_url)
    values (actor, p_plan, label, fee, venue.gcash_name, venue.gcash_number, venue.gcash_qr_url)
    returning id into application_id;
  return application_id;
end;
$$;

create function public.submit_membership_payment(p_application uuid, p_reference text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  application public.membership_applications%rowtype;
  reference text := btrim(p_reference);
  normalized text := lower(regexp_replace(reference,'[^a-zA-Z0-9]','','g'));
begin
  if auth.uid() is null then raise exception 'Membership: Sign in to submit a payment.'; end if;
  if reference is null or reference !~ '^[a-zA-Z0-9 -]{6,40}$' or length(normalized) < 6 then
    raise exception 'Membership: Enter a valid GCash reference number.';
  end if;
  select * into application from public.membership_applications
    where id = p_application and user_id = auth.uid() for update;
  if not found then raise exception 'Membership: Application could not be found.'; end if;
  if application.status in ('pending', 'approved') and
    lower(regexp_replace(application.payment_reference,'[^a-zA-Z0-9]','','g')) = normalized then return; end if;
  if application.status <> 'awaiting_payment' then
    raise exception 'Membership: This application has already been submitted.';
  end if;
  update public.membership_applications set status = 'pending', payment_reference = reference, submitted_at = now()
    where id = application.id;
end;
$$;

create function public.cancel_membership_application(p_application uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Membership: Sign in to manage your application.'; end if;
  delete from public.membership_applications where id = p_application and user_id = auth.uid() and status = 'awaiting_payment';
  if not found and exists (select 1 from public.membership_applications where id = p_application and user_id = auth.uid()) then
    raise exception 'Membership: This application already has a payment under review.';
  end if;
end;
$$;

create function public.review_membership_payment(p_application uuid, p_approve boolean, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  application public.membership_applications%rowtype;
  reason text := btrim(p_reason);
  today date := (now() at time zone 'Asia/Manila')::date;
begin
  perform private.pos_require_staff();
  if p_approve is null or (not p_approve and (reason is null or char_length(reason) not between 3 and 200)) then
    raise exception 'Membership: Enter a rejection reason between 3 and 200 characters.';
  end if;
  select * into application from public.membership_applications where id = p_application for update;
  if not found then raise exception 'Membership: Application could not be found.'; end if;
  if (p_approve and application.status = 'approved') or (not p_approve and application.status = 'rejected') then return; end if;
  if application.status <> 'pending' then raise exception 'Membership: This application is no longer pending.'; end if;

  if p_approve then
    if application.user_id is null then raise exception 'Membership: This customer account has been removed.'; end if;
    perform private.pos_check_reference(application.payment_reference);
    update public.membership_applications set status = 'approved', starts_on = today,
      expires_on = (today + make_interval(months => case when application.plan_id = 'annual' then 12 else 6 end))::date,
      reviewed_at = now(), reviewed_by = auth.uid()
      where id = application.id;
  else
    update public.membership_applications set status = 'rejected', review_note = reason, reviewed_at = now(), reviewed_by = auth.uid()
      where id = application.id;
  end if;
end;
$$;

create function public.list_membership_applications(p_reviewed boolean, p_page integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.pos_require_staff();
  if p_reviewed is null or p_page is null or p_page < 1 then raise exception 'Membership: Choose a valid review page.'; end if;
  return (
    with filtered as (
      select a.id, a.plan_name, a.price_cents, a.payment_reference, a.status, a.submitted_at, a.reviewed_at,
        a.review_note, a.starts_on, a.expires_on, a.gcash_name, a.gcash_number,
        u.email, nullif(left(btrim(u.raw_user_meta_data->>'full_name'), 100), '') as full_name
      from public.membership_applications a left join auth.users u on u.id = a.user_id
      where (not p_reviewed and a.status = 'pending') or (p_reviewed and a.status in ('approved', 'rejected'))
    ), page as (
      select * from filtered
      order by coalesce(reviewed_at, submitted_at) desc, id desc
      limit 10 offset (p_page::bigint - 1) * 10
    )
    select jsonb_build_object('row_count', (select count(*) from filtered),
      'rows', coalesce((select jsonb_agg(to_jsonb(page) order by coalesce(reviewed_at, submitted_at) desc, id desc) from page), '[]'::jsonb))
  );
end;
$$;

revoke all on function public.start_membership_application(text, integer),
  public.submit_membership_payment(uuid, text), public.cancel_membership_application(uuid),
  public.review_membership_payment(uuid, boolean, text), public.list_membership_applications(boolean, integer)
  from public, anon, authenticated;
grant execute on function public.start_membership_application(text, integer),
  public.submit_membership_payment(uuid, text), public.cancel_membership_application(uuid),
  public.review_membership_payment(uuid, boolean, text), public.list_membership_applications(boolean, integer)
  to authenticated;
notify pgrst, 'reload schema';
commit;
