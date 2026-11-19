begin;

create table private.cashier_assignments (
  duty_date date primary key,
  cashier_id uuid not null references auth.users(id) on delete cascade,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table private.cashier_assignments enable row level security;
revoke all on private.cashier_assignments from public, anon, authenticated;

create policy "Managers read cashier assignment changes" on public.pos_audit as restrictive
  for select to authenticated using (action <> 'shift.assignment' or (select public.is_staff()));

create function public.pos_register_day(p_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  manager boolean := public.is_staff();
begin
  perform private.pos_require_staff();
  if p_date is null or p_date not between date '2000-01-01' and date '2100-12-31' then
    raise exception 'POS: Choose a valid duty date.';
  end if;

  return jsonb_build_object(
    'assignment', (select jsonb_build_object('id', u.id,
       'label', case when manager then u.email else split_part(u.email, '@', 1) end,
       'eligible', coalesce(s.role = 'cashier' and u.email <> '' and u.email_confirmed_at is not null, false))
      from private.cashier_assignments a join auth.users u on u.id = a.cashier_id
      left join public.staff_members s on s.user_id = u.id where a.duty_date = p_date),
    'cashiers', case when manager then (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'label', u.email)
      order by lower(u.email), u.id), '[]'::jsonb)
      from public.staff_members s join auth.users u on u.id = s.user_id
      where s.role = 'cashier' and u.email <> '' and u.email_confirmed_at is not null) else '[]'::jsonb end,
    'operators', (select coalesce(jsonb_agg(operator order by first_opened), '[]'::jsonb)
      from (select case when manager then u.email else split_part(u.email, '@', 1) end as operator,
          min(s.opened_at) as first_opened
        from public.pos_shifts s join auth.users u on u.id = s.cashier_id
        where s.opened_at >= (p_date::timestamp at time zone 'Asia/Manila')
          and s.opened_at < ((p_date + 1)::timestamp at time zone 'Asia/Manila')
        group by u.id) as operators),
    'active', (select jsonb_build_object('label', case when manager then u.email else split_part(u.email, '@', 1) end,
       'opened_at', s.opened_at, 'own_shift', case when s.cashier_id = auth.uid() then
         to_jsonb(s) || jsonb_build_object('expected_cents', private.pos_expected_cash(s.id, s.opening_cents)) end)
      from public.pos_shifts s join auth.users u on u.id = s.cashier_id where s.closed_at is null limit 1)
  );
end;
$$;

create function public.pos_assign_cashier(p_date date, p_expected uuid, p_cashier uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
begin
  perform private.pos_require_staff(true);
  if p_date is null or p_date not between date '2000-01-01' and date '2100-12-31' then
    raise exception 'POS: Choose a valid duty date.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('rally-cashier-date:' || p_date::text, 0));
  perform 1 from public.staff_members where user_id = auth.uid() and role in ('manager', 'owner') for share;
  if not found then raise exception 'POS: Manager authorization is required.'; end if;
  select cashier_id into previous from private.cashier_assignments where duty_date = p_date;
  if previous is not distinct from p_cashier then return; end if;
  if previous is distinct from p_expected then
    raise exception 'POS: This day’s assignment changed. Refresh to see the latest assignment.';
  end if;
  if p_cashier is null then
    delete from private.cashier_assignments where duty_date = p_date;
  else
    perform 1 from public.staff_members s join auth.users u on u.id = s.user_id
    where s.user_id = p_cashier and s.role = 'cashier' and u.email <> '' and u.email_confirmed_at is not null
    for share of s;
    if not found then raise exception 'POS: Choose a confirmed account with the Cashier role.'; end if;
    insert into private.cashier_assignments(duty_date, cashier_id, updated_by) values (p_date, p_cashier, auth.uid())
    on conflict (duty_date) do update set cashier_id = excluded.cashier_id, updated_by = excluded.updated_by, updated_at = now();
  end if;
  insert into public.pos_audit(actor_id, action, entity_id, detail)
  values (auth.uid(), 'shift.assignment', p_cashier, jsonb_build_object('date', p_date, 'from', previous, 'to', p_cashier));
end;
$$;

revoke all on function public.pos_register_day(date), public.pos_assign_cashier(date, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.pos_register_day(date), public.pos_assign_cashier(date, uuid, uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
