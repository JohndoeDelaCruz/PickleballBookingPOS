-- Apply once after migration 013. Existing court IDs and bookings are preserved.
begin;
alter table public.courts drop constraint courts_id_check;
alter table public.courts add constraint courts_id_check check (id > 0);
alter table public.courts add column active boolean not null default true;
alter table public.courts add column revision integer not null default 0 check (revision >= 0);
alter table public.courts add constraint court_name_length check (length(trim(name)) between 1 and 60);
create unique index courts_unique_name on public.courts (lower(trim(name)));
revoke insert,update,delete on public.courts from anon,authenticated;

create function public.save_court(p_id integer,p_name text,p_active boolean,p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.courts%rowtype; next_id integer;
begin
  if not public.is_staff() then raise exception 'Booking: Manager access is required to edit courts.'; end if;
  if p_name is null or length(trim(p_name)) not between 1 and 60 or p_active is null then
    raise exception 'Booking: Enter a court name of up to 60 characters and an active status.'; end if;
  -- The same venue lock is acquired by booking creation and schedule changes.
  -- This serializes court deactivation with new reservations.
  perform 1 from public.venue_settings where id=true for update;
  if p_id is null then
    if p_revision is not null then raise exception 'Booking: Reload the courts before adding a new one.'; end if;
    if (select count(*) from public.courts)>=100 then raise exception 'Booking: This venue supports up to 100 court records.'; end if;
    select coalesce(max(id),0)+1 into next_id from public.courts;
    if next_id>32767 then raise exception 'Booking: No more court identifiers are available.'; end if;
    insert into public.courts(id,name,active) values(next_id,trim(p_name),p_active) returning * into c;
  else
    select * into c from public.courts where id=p_id for update;
    if not found or p_revision is null or c.revision<>p_revision then
      raise exception 'Booking: Another manager changed this court. Reload before saving.'; end if;
    if c.active and not p_active then
      if (select count(*) from public.courts where active)=1 and
        (select booking_enabled from public.venue_settings where id=true) then
        raise exception 'Booking: Pause online reservations before deactivating the last court.'; end if;
      if exists(select 1 from public.bookings b where (b.court_id=p_id or b.booking_type='open_play')
        and b.status in ('awaiting_payment','awaiting_verification','confirmed','blocked')
        and (b.status<>'awaiting_payment' or b.hold_expires_at>now())
        and (b.booking_date+(b.start_hour+b.duration)*interval '1 hour') at time zone 'Asia/Manila'>now()) then
        raise exception 'Booking: This court has upcoming reservations, blocks, or shared open-play sessions. Resolve them before deactivating it.'; end if;
    end if;
    update public.courts set name=trim(p_name),active=p_active,revision=revision+1 where id=p_id returning * into c;
  end if;
  return to_jsonb(c);
exception when unique_violation then
  raise exception 'Booking: A court with that name already exists.';
end;
$$;
revoke all on function public.save_court(integer,text,boolean,integer) from public,anon,authenticated;
grant execute on function public.save_court(integer,text,boolean,integer) to authenticated;

create function private.require_active_court() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.status not in ('awaiting_payment','awaiting_verification','confirmed','blocked') then return new; end if;
  if tg_op='UPDATE' then
    if old.status in ('awaiting_payment','awaiting_verification','confirmed','blocked')
      and (old.status<>'awaiting_payment' or old.hold_expires_at>now())
      and row(new.booking_type,new.court_id,new.booking_date,new.start_hour,new.duration,new.participant_count)
      is not distinct from row(old.booking_type,old.court_id,old.booking_date,old.start_hour,old.duration,old.participant_count)
      then return new; end if;
  end if;
  perform 1 from public.venue_settings where id=true for share;
  if new.booking_type='court' then
    perform 1 from public.courts where id=new.court_id and active for share;
    if not found then raise exception 'Booking: This court is inactive or no longer available. Choose an active court.'; end if;
  elsif not exists(select 1 from public.courts where active) then
    raise exception 'Booking: No active courts are available for open play.';
  end if;
  return new;
end;
$$;
create trigger aa_require_active_court before insert or update on public.bookings
for each row execute function private.require_active_court();

create function private.require_courts_for_reservations() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.booking_enabled and not exists(select 1 from public.courts where active) then
    raise exception 'Booking: Activate a court before opening online reservations.'; end if;
  return new;
end;
$$;
create trigger require_courts_for_reservations before update on public.venue_settings
for each row execute function private.require_courts_for_reservations();
revoke all on function private.require_active_court(),private.require_courts_for_reservations() from public,anon,authenticated;

-- Preserve every existing signature and payment/scheduling rule while widening
-- the three legacy court checks. The shared trigger protects every write path.
do $$
declare f regprocedure; definition text;
begin
  foreach f in array array[
    'public.create_booking(integer,date,integer,integer,text,text)'::regprocedure,
    'public.staff_create_booking(integer,date,integer,integer,text,text,boolean)'::regprocedure,
    'public.reserve_scheduled_booking_internal(text,date,text,text,integer,integer,integer,integer,boolean,boolean,boolean,text,text,text)'::regprocedure
  ] loop
    definition:=pg_get_functiondef(f);
    if position('p_court not in (1,2)' in definition)=0 then
      raise exception 'Expected legacy court validation was not found in %',f; end if;
    definition:=replace(definition,'p_court not in (1,2)',
      'not exists (select 1 from public.courts c where c.id=p_court and c.active)');
    execute definition;
  end loop;
end;
$$;

-- Dynamic per-court figures complement the unchanged aggregate report RPC.
-- Inactive courts remain in reports and existing collection semantics stay intact.
create function public.get_court_finance_month(p_month date)
returns table(report_date date,court_id smallint,sales numeric,hours bigint)
language plpgsql security definer set search_path='' as $$
begin
  if not public.is_staff() then raise exception 'Booking: Staff access is required.'; end if;
  if p_month is null or p_month not between date '2000-01-01' and date '2100-12-01' or extract(day from p_month)<>1 then
    raise exception 'Booking: Choose a valid report month.'; end if;
  perform public.expire_unpaid_holds();
  return query
    select d::date,c.id,
      coalesce(sum(b.paid_amount-case when b.total_amount>0 then round(b.equipment_amount*b.paid_amount/b.total_amount,2) else 0 end),0),
      coalesce(sum(b.duration),0)::bigint
    from generate_series(p_month::timestamp,p_month+interval '1 month'-interval '1 day',interval '1 day') d
    cross join public.courts c
    left join public.bookings b on b.booking_date=d::date and b.court_id=c.id and b.booking_type='court' and b.status='confirmed'
    group by d,c.id order by d,c.id;
end;
$$;
revoke all on function public.get_court_finance_month(date) from public,anon,authenticated;
grant execute on function public.get_court_finance_month(date) to authenticated;

-- New counter slips use the configured court name; saved slips keep their snapshot.
do $$
declare definition text;
begin
  definition:=pg_get_functiondef('private.pos_sync_booking(uuid)'::regprocedure);
  definition:=replace(definition,'''Court ''||b.court_id::text',
    'coalesce((select c.name from public.courts c where c.id=b.court_id),''Court ''||b.court_id::text)');
  execute definition;
end;
$$;
notify pgrst,'reload schema';
commit;
