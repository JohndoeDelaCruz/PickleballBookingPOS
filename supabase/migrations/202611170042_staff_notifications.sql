begin;

create table private.staff_notifications (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('booking_payment', 'booking_confirmed', 'booking_cancelled',
    'membership_payment', 'membership_activated', 'account_verified')),
  subject_id uuid not null,
  created_at timestamptz not null default clock_timestamp()
);
create unique index staff_notification_verified_account on private.staff_notifications (subject_id)
  where kind = 'account_verified';

create table private.staff_notification_reads (
  user_id uuid not null references auth.users(id) on delete cascade,
  notification_id bigint not null references private.staff_notifications(id) on delete cascade,
  primary key (user_id, notification_id)
);
alter table private.staff_notifications enable row level security;
alter table private.staff_notification_reads enable row level security;
revoke all on private.staff_notifications, private.staff_notification_reads from public, anon, authenticated;

create function private.notify_staff_booking() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  previous_status text;
  previous_reference text;
  event_kind text;
begin
  if tg_op = 'UPDATE' then
    previous_status := old.status;
    previous_reference := old.payment_reference;
  end if;
  if new.status = 'awaiting_verification' and new.payment_reference is not null then
    if previous_status is distinct from new.status or previous_reference is distinct from new.payment_reference then
      event_kind := 'booking_payment';
    end if;
  elsif new.status = 'confirmed' and previous_status is distinct from new.status then
    event_kind := 'booking_confirmed';
  elsif new.status = 'cancelled' and previous_status in ('confirmed', 'awaiting_verification') then
    event_kind := 'booking_cancelled';
  end if;
  if event_kind is not null then
    insert into private.staff_notifications(kind, subject_id) values (event_kind, new.id);
  end if;
  return new;
end;
$$;

create trigger notify_staff_booking after insert or update of status, payment_reference on public.bookings
  for each row execute function private.notify_staff_booking();

create function private.notify_staff_membership() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('pending', 'approved') then
    if tg_op = 'INSERT' or new.status is distinct from old.status then
      insert into private.staff_notifications(kind, subject_id)
        values (case when new.status = 'pending' then 'membership_payment' else 'membership_activated' end, new.id);
    end if;
  end if;
  return new;
end;
$$;

create trigger notify_staff_membership after insert or update of status on public.membership_applications
  for each row execute function private.notify_staff_membership();

create function private.notify_staff_account() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email_confirmed_at is not null and nullif(btrim(new.email), '') is not null then
    if tg_op = 'INSERT' or old.email_confirmed_at is null then
      insert into private.staff_notifications(kind, subject_id) values ('account_verified', new.id)
        on conflict (subject_id) where kind = 'account_verified' do nothing;
    end if;
  end if;
  return new;
end;
$$;

create trigger notify_staff_account after insert or update of email_confirmed_at on auth.users
  for each row execute function private.notify_staff_account();

create function public.staff_notification_feed(p_page integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  manager boolean := public.is_staff();
  today date := (now() at time zone 'Asia/Manila')::date;
begin
  perform private.pos_require_staff();
  if p_page is null or p_page < 1 then raise exception 'Notifications: Choose a valid page.'; end if;

  return (
    with visible as (
      select n.*, r.notification_id is not null as is_read
        from private.staff_notifications n left join private.staff_notification_reads r
          on r.notification_id = n.id and r.user_id = auth.uid()
        where manager or n.kind not in ('account_verified', 'membership_activated')
    ), recent as (
      select * from visible order by id desc limit 15 offset (p_page::bigint - 1) * 15
    ), page as (
      select n.id, n.kind, n.subject_id, n.created_at, n.is_read,
        b.reference as booking_reference, b.booking_date, b.start_hour, b.duration,
        case when b.booking_type = 'open_play' then 'Open play' else coalesce(c.name, 'Court ' || b.court_id) end as court_label,
        m.plan_name, m.status as membership_status, acc.email as account_email,
        coalesce(case n.kind
          when 'booking_payment' then b.status = 'awaiting_verification' and n.created_at >= coalesce(b.payment_submitted_at, n.created_at)
          when 'membership_payment' then m.status = 'pending'
          when 'booking_cancelled' then b.booking_date = today
          else false end, false) as priority
      from recent n
      left join public.bookings b on n.kind in ('booking_payment', 'booking_confirmed', 'booking_cancelled') and b.id = n.subject_id
      left join public.courts c on c.id = b.court_id
      left join public.membership_applications m on n.kind in ('membership_payment', 'membership_activated') and m.id = n.subject_id
      left join auth.users acc on manager and n.kind = 'account_verified' and acc.id = n.subject_id
    )
    select jsonb_build_object('unread_count', (select count(*) from visible where not is_read),
      'total_count', (select count(*) from visible),
      'rows', coalesce((select jsonb_agg(to_jsonb(page) order by priority desc, id desc) from page), '[]'::jsonb))
  );
end;
$$;

create function public.mark_staff_notifications_read(p_notification_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare
  manager boolean := public.is_staff();
begin
  perform private.pos_require_staff();
  insert into private.staff_notification_reads(user_id, notification_id)
    select auth.uid(), n.id from private.staff_notifications n
    where (p_notification_id is null or n.id = p_notification_id)
      and (manager or n.kind not in ('account_verified', 'membership_activated'))
  on conflict do nothing;
end;
$$;

-- A notification can open the relevant application even when it is outside the first review page.
create function public.list_membership_applications(p_reviewed boolean, p_page integer, p_application uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.pos_require_staff();
  if p_reviewed is null or p_page is null or p_page < 1 then raise exception 'Membership: Choose a valid review page.'; end if;
  return (
    with filtered as (
      select a.id, a.plan_name, a.price_cents, a.payment_reference, a.status, a.submitted_at, a.reviewed_at,
        a.review_note, a.starts_on, a.expires_on, a.gcash_name, a.gcash_number, a.payment_method, s.number as receipt_number,
        case when a.pos_sale_id is not null and public.club_role() = 'cashier'
          then left(u.email, 1) || '•••@' || left(split_part(u.email, '@', 2), 1) || '•••'
          else u.email end as email,
        nullif(left(btrim(u.raw_user_meta_data->>'full_name'), 100), '') as full_name
      from public.membership_applications a left join auth.users u on u.id = a.user_id
      left join public.pos_sales s on s.id = a.pos_sale_id
      where (p_application is null or a.id = p_application)
        and ((not p_reviewed and a.status = 'pending') or (p_reviewed and a.status in ('approved', 'rejected', 'refunded')))
    ), page as (
      select * from filtered order by coalesce(reviewed_at, submitted_at) desc, id desc
      limit 10 offset (p_page::bigint - 1) * 10
    )
    select jsonb_build_object('row_count', (select count(*) from filtered),
      'rows', coalesce((select jsonb_agg(to_jsonb(page) order by coalesce(reviewed_at, submitted_at) desc, id desc) from page), '[]'::jsonb))
  );
end;
$$;

create or replace function public.list_membership_applications(p_reviewed boolean, p_page integer)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select public.list_membership_applications(p_reviewed, p_page, null);
$$;

revoke all on function private.notify_staff_booking(), private.notify_staff_membership(), private.notify_staff_account(),
  public.staff_notification_feed(integer), public.mark_staff_notifications_read(bigint),
  public.list_membership_applications(boolean, integer, uuid) from public, anon, authenticated;
grant execute on function public.staff_notification_feed(integer), public.mark_staff_notifications_read(bigint),
  public.list_membership_applications(boolean, integer, uuid) to authenticated;
notify pgrst, 'reload schema';

commit;
