-- Apply once after migration 014. No existing courts or bookings are deleted.
begin;

-- Never reuse a removed court ID: a stale manager tab must not edit a new court.
create sequence private.court_id_seq as integer minvalue 1;
select pg_catalog.setval('private.court_id_seq',
  greatest(coalesce(max(id),0),1), coalesce(max(id),0)>0) from public.courts;
revoke all on sequence private.court_id_seq from public,anon,authenticated;

do $$
declare definition text;
begin
  definition:=pg_get_functiondef('public.save_court(integer,text,boolean,integer)'::regprocedure);
  if position('select coalesce(max(id),0)+1 into next_id from public.courts;' in definition)=0 then
    raise exception 'Expected court ID allocation was not found. Apply migration 014 before 015.';
  end if;
  definition:=replace(definition,
    'select coalesce(max(id),0)+1 into next_id from public.courts;',
    'select nextval(''private.court_id_seq'') into next_id;');
  execute definition;
end;
$$;

create function public.delete_court(p_id integer,p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.courts%rowtype;
begin
  if not public.is_staff() then
    raise exception 'Booking: Manager access is required to delete courts.';
  end if;
  -- Match booking creation and court updates so availability cannot change mid-booking.
  perform 1 from public.venue_settings where id=true for update;
  select * into c from public.courts where id=p_id for update;
  if not found or p_revision is null or c.revision<>p_revision then
    raise exception 'Booking: Another manager changed or removed this court. Reload before deleting.';
  end if;
  if exists(select 1 from public.bookings where court_id=p_id) then
    raise exception 'Booking: This court has booking or block history. Deactivate it instead of deleting it.';
  end if;
  if c.active then
    if (select count(*) from public.courts where active)=1 and
      (select booking_enabled from public.venue_settings where id=true) then
      raise exception 'Booking: Pause online reservations before deleting the last active court.';
    end if;
    if exists(select 1 from public.bookings b where b.booking_type='open_play'
      and b.status in ('awaiting_payment','awaiting_verification','confirmed')
      and (b.status<>'awaiting_payment' or b.hold_expires_at>now())
      and (b.booking_date+(b.start_hour+b.duration)*interval '1 hour') at time zone 'Asia/Manila'>now()) then
      raise exception 'Booking: Upcoming shared open-play reservations use the active courts. Resolve them before deleting this court.';
    end if;
  end if;
  delete from public.courts where id=p_id;
  return to_jsonb(c);
exception when foreign_key_violation then
  raise exception 'Booking: This court has linked records. Deactivate it instead of deleting it.';
end;
$$;
revoke all on function public.delete_court(integer,integer) from public,anon,authenticated;
grant execute on function public.delete_court(integer,integer) to authenticated;

notify pgrst,'reload schema';
commit;
