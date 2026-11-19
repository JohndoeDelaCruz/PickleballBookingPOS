begin;

create function private.walk_in_account_name(p_metadata jsonb) returns text
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_metadata->'full_name') = 'string' then
    nullif(left(btrim(regexp_replace(p_metadata->>'full_name', '[[:space:]]+', ' ', 'g')), 100), '')
  end;
$$;

create function public.pos_find_walk_in_customers(p_query text, p_date date, p_active_only boolean default true)
returns table (id uuid, full_name text, email text, active_membership boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  search text := lower(btrim(p_query));
  today date := (now() at time zone 'Asia/Manila')::date;
begin
  perform private.pos_require_staff();
  if search is null or length(search) not between 2 and 254 then
    raise exception 'Booking: Enter at least two characters of a name or the full email address.';
  end if;
  if p_date is null or p_date not between today and today + 30 or p_active_only is null then
    raise exception 'Booking: Choose a valid date and customer filter.';
  end if;

  return query
    select u.id, profile.full_name,
      case when lower(u.email) = search then u.email::text
        else left(u.email, 1) || '•••@' || left(split_part(u.email, '@', 2), 1) || '•••'
      end,
      coalesce(member.active, false)
    from auth.users u
    cross join lateral (
      select private.walk_in_account_name(u.raw_user_meta_data) as full_name
    ) profile
    left join lateral (
      select true as active from public.membership_applications a
      where a.user_id = u.id and a.status = 'approved'
        and a.starts_on <= today and a.starts_on <= p_date and p_date < a.expires_on
      limit 1
    ) member on true
    where u.email_confirmed_at is not null and nullif(btrim(u.email), '') is not null
      and (lower(u.email) = search or strpos(lower(profile.full_name), search) > 0)
      and (not p_active_only or member.active)
    order by (lower(u.email) = search) desc, member.active desc nulls last, u.email, u.id
    limit 10;
end;
$$;

-- Reuse the reservation checks while allowing the account checkout to leave
-- a missing phone blank. Existing reservation entry points still require it.
do $$
declare
  schedule_definition text := pg_get_functiondef(
    'public.reserve_scheduled_booking_internal(text,date,text,text,integer,integer,integer,integer,boolean,boolean,boolean,text,text,text)'::regprocedure);
  equipment_definition text := pg_get_functiondef(
    'public.reserve_equipment_booking(text,date,text,text,integer,integer,integer,integer,boolean,boolean,boolean,text,text,text,integer)'::regprocedure);
  phone_check text := $fragment$(p_phone is null or p_phone !~ '^(\+63|0)9[0-9]{9}$')$fragment$;
  schedule_call text := 'public.reserve_scheduled_booking_internal(';
  equipment_call text := 'public.reserve_equipment_booking(';
begin
  if strpos(schedule_definition, phone_check) = 0 or strpos(schedule_definition, schedule_call) = 0
    or strpos(equipment_definition, equipment_call) = 0 or strpos(equipment_definition, schedule_call) = 0 then
    raise exception 'Expected reservation contact checks were not found.';
  end if;

  schedule_definition := replace(schedule_definition, schedule_call,
    'private.reserve_scheduled_booking(p_allow_missing_phone boolean, ');
  schedule_definition := replace(schedule_definition, phone_check,
    $fragment$((p_phone is null and not (p_allow_missing_phone and p_walk_in)) or p_phone !~ '^(\+63|0)9[0-9]{9}$')$fragment$);
  execute schedule_definition;

  equipment_definition := replace(equipment_definition, equipment_call,
    'private.reserve_equipment_booking(p_allow_missing_phone boolean, ');
  equipment_definition := replace(equipment_definition, schedule_call,
    'private.reserve_scheduled_booking(p_allow_missing_phone, ');
  execute equipment_definition;
end;
$$;

create or replace function public.reserve_scheduled_booking_internal(
  p_kind text, p_date date, p_name text, p_phone text,
  p_court integer default null, p_start integer default null, p_duration integer default 1, p_people integer default 1,
  p_rental boolean default false, p_walk_in boolean default false, p_blocked boolean default false,
  p_method text default 'cash', p_notes text default '', p_payment_option text default 'full'
) returns uuid language sql security definer set search_path = '' as $$
  select private.reserve_scheduled_booking(false, p_kind, p_date, p_name, p_phone, p_court, p_start,
    p_duration, p_people, p_rental, p_walk_in, p_blocked, p_method, p_notes, p_payment_option);
$$;

create or replace function public.reserve_equipment_booking(
  p_kind text, p_date date, p_name text, p_phone text,
  p_court integer default null, p_start integer default null, p_duration integer default 1, p_people integer default 1,
  p_rental boolean default false, p_walk_in boolean default false, p_blocked boolean default false,
  p_method text default 'cash', p_notes text default '', p_payment_option text default 'full', p_quantity integer default null
) returns uuid language sql security definer set search_path = '' as $$
  select private.reserve_equipment_booking(false, p_kind, p_date, p_name, p_phone, p_court, p_start,
    p_duration, p_people, p_rental, p_walk_in, p_blocked, p_method, p_notes, p_payment_option, p_quantity);
$$;

-- Resolve profile details after the idempotency check so a profile edit
-- cannot prevent a retry from returning its previously recorded booking.
do $$
declare
  definition text := pg_get_functiondef(
    'private.book_member_walk_in(uuid,uuid,date,text,text,integer,integer,integer,text,integer,integer,text,text,text,boolean,bigint,bigint,text)'::regprocedure);
  reserve_call text := 'booking_id := public.reserve_equipment_booking(p_kind, p_date, p_name, p_phone, p_court, p_start,';
begin
  if strpos(definition, reserve_call) = 0 or strpos(definition, 'request_fields jsonb;') = 0 then
    raise exception 'Expected linked member reservation was not found.';
  end if;

  definition := replace(definition, 'request_fields jsonb;',
    'request_fields jsonb; use_account_contact boolean := p_name is null and p_phone is null;');
  definition := replace(definition, reserve_call, $fragment$
  if use_account_contact then
    select case when length(profile.full_name) >= 2 then profile.full_name else
      case when length(profile.email_name) >= 2 then profile.email_name else 'Account holder' end end,
      case when u.phone_confirmed_at is not null then
        case when u.phone ~ '^(\+63|0)9[0-9]{9}$' then u.phone
          when u.phone ~ '^639[0-9]{9}$' then '+' || u.phone end
      end
    into p_name, p_phone
    from auth.users u
    cross join lateral (
      select private.walk_in_account_name(u.raw_user_meta_data) as full_name,
        left(split_part(btrim(u.email), '@', 1), 100) as email_name
    ) profile
    where u.id = p_customer;
  end if;
  booking_id := private.reserve_equipment_booking(use_account_contact, p_kind, p_date, p_name, p_phone, p_court, p_start,$fragment$);
  execute definition;
end;
$$;

create function public.pos_book_account_walk_in(
  p_key uuid, p_customer uuid, p_kind text, p_date date, p_court integer, p_start integer, p_duration integer,
  p_people integer, p_quantity integer, p_payment_option text, p_method text, p_reference text,
  p_verified boolean, p_collected_cents bigint, p_expected_total_cents bigint, p_notes text
) returns uuid language sql security definer set search_path = '' as $$
  select private.book_member_walk_in(p_key, p_customer, p_date, null, null, p_court, p_start, p_duration, p_kind,
    p_people, p_quantity, p_payment_option, p_method, p_reference, p_verified, p_collected_cents, p_expected_total_cents, p_notes);
$$;

revoke all on function private.walk_in_account_name(jsonb),
  private.reserve_scheduled_booking(boolean,text,date,text,text,integer,integer,integer,integer,boolean,boolean,boolean,text,text,text),
  private.reserve_equipment_booking(boolean,text,date,text,text,integer,integer,integer,integer,boolean,boolean,boolean,text,text,text,integer),
  public.pos_find_walk_in_customers(text,date,boolean),
  public.pos_book_account_walk_in(uuid,uuid,text,date,integer,integer,integer,integer,integer,text,text,text,boolean,bigint,bigint,text)
from public, anon, authenticated;
grant execute on function public.pos_find_walk_in_customers(text,date,boolean),
  public.pos_book_account_walk_in(uuid,uuid,text,date,integer,integer,integer,integer,integer,text,text,text,boolean,bigint,bigint,text)
to authenticated;
notify pgrst, 'reload schema';

commit;
