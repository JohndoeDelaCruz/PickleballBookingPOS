begin;

-- Operational access always uses the current Philippine day.
create or replace function public.is_club_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff_members s
    where s.user_id = auth.uid() and (
      s.role in ('manager', 'owner') or (
        s.role = 'cashier' and not exists (
          select 1 from private.cashier_assignments a
          where a.duty_date = (now() at time zone 'Asia/Manila')::date
            and a.cashier_id <> s.user_id
        )
      )
    )
  );
$$;

create or replace function public.pos_open_shift(p_opening integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  shift_id uuid;
  duty_date date := (now() at time zone 'Asia/Manila')::date;
begin
  -- Serialize opening a shift with the assignment change for the same date.
  perform pg_advisory_xact_lock_shared(hashtextextended('rally-cashier-date:' || duty_date::text, 0));
  perform 1 from public.staff_members where user_id = auth.uid() for share;
  if not found then raise exception 'POS: Authorized staff access is required.'; end if;
  if not public.is_club_staff() then
    raise exception 'POS: Another cashier is assigned to the register today.';
  end if;
  if p_opening is null or p_opening not between 0 and 100000000 then
    raise exception 'POS: Enter a valid opening cash amount.';
  end if;
  insert into public.pos_shifts(register_id, cashier_id, opening_cents)
  values ('00000000-0000-4000-a000-000000000001', auth.uid(), p_opening) returning id into shift_id;
  insert into public.pos_audit(actor_id, action, entity_id, detail)
  values (auth.uid(), 'shift.open', shift_id, jsonb_build_object('opening_cents', p_opening));
  return shift_id;
exception when unique_violation then
  raise exception 'POS: This register or cashier already has an open shift.';
end;
$$;

-- During a handover, an off-duty cashier can reconcile their own open drawer.
create function public.pos_own_open_shift()
returns setof public.pos_shifts language sql stable security definer set search_path = '' as $$
  select s.id, s.register_id, s.cashier_id, s.opening_cents, s.opened_at, s.closed_at, s.counted_cents,
    private.pos_expected_cash(s.id, s.opening_cents)
  from public.pos_shifts s
  where s.cashier_id = auth.uid() and s.closed_at is null and public.club_role() = 'cashier';
$$;

create or replace function public.pos_close_shift(p_shift uuid, p_counted integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  shift public.pos_shifts%rowtype;
  expected bigint;
begin
  perform 1 from public.staff_members where user_id = auth.uid() for share;
  if not found then raise exception 'POS: Authorized staff access is required.'; end if;
  select * into shift from public.pos_shifts where id = p_shift for update;
  if shift.id is null or shift.cashier_id <> auth.uid() or shift.closed_at is not null then
    raise exception 'POS: Only your active shift can be closed.';
  end if;
  if p_counted is null or p_counted not between 0 and 100000000 then
    raise exception 'POS: Enter the cash counted in the drawer.';
  end if;
  expected := private.pos_expected_cash(shift.id, shift.opening_cents);
  update public.pos_shifts set expected_cents = expected, counted_cents = p_counted, closed_at = now() where id = shift.id;
  insert into public.pos_audit(actor_id, action, entity_id, detail)
  values (auth.uid(), 'shift.close', shift.id, jsonb_build_object('expected', expected, 'counted', p_counted, 'variance', p_counted - expected));
end;
$$;

revoke all on function public.pos_own_open_shift() from public, anon, authenticated;
grant execute on function public.pos_own_open_shift() to authenticated;
notify pgrst, 'reload schema';
commit;
