begin;

create policy "Managers read role changes" on public.pos_audit as restrictive
  for select to authenticated using (action <> 'access.role_change' or (select public.is_staff()));

create function public.admin_list_accounts(p_query text, p_page int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  actor_role text := public.club_role();
  query text := lower(btrim(coalesce(p_query, '')));
  page_size constant int := 25;
begin
  if actor_role is null or actor_role not in ('owner', 'manager') then
    raise exception 'Access: Manager or owner authorization is required.';
  end if;
  if length(query) > 254 or p_page is null or p_page < 1 then
    raise exception 'Access: Choose a valid account search and page.';
  end if;

  return (
    with matching as (
      select u.id, u.email, coalesce(s.role, 'player') as role,
        u.email_confirmed_at is not null as email_confirmed
      from auth.users u left join public.staff_members s on s.user_id = u.id
      where u.email <> '' and (query = '' or strpos(lower(u.email), query) > 0)
    ), page as (
      select * from matching order by lower(email), id
      limit page_size offset (p_page::bigint - 1) * page_size
    )
    select jsonb_build_object('row_count', (select count(*) from matching), 'rows',
      coalesce((select jsonb_agg(to_jsonb(page) order by lower(email), id) from page), '[]'::jsonb))
  );
end;
$$;

create function public.admin_set_account_role(p_user_id uuid, p_expected_role text, p_role text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  actor_role text := public.club_role();
  existing_role text;
  confirmed boolean;
begin
  if actor_role is null or actor_role not in ('owner', 'manager') then
    raise exception 'Access: Manager or owner authorization is required.';
  end if;
  if p_user_id is null or p_expected_role is null or p_expected_role not in ('player', 'cashier', 'manager', 'owner')
    or p_role is null or p_role not in ('player', 'cashier', 'manager', 'owner') then
    raise exception 'Access: Choose a valid account and role.';
  end if;
  if p_user_id = actor then
    raise exception 'Access: You can’t change your own role.';
  end if;
  select u.email_confirmed_at is not null into confirmed
  from auth.users u where u.id = p_user_id and u.email <> '' for key share;
  if not found then raise exception 'Access: That account is no longer available.'; end if;
  -- Serialize role edits and recheck the actor after any wait for another edit.
  lock table public.staff_members in share row exclusive mode;
  actor_role := public.club_role();
  if actor_role is null or actor_role not in ('owner', 'manager') then
    raise exception 'Access: Manager or owner authorization is required.';
  end if;
  select s.role into existing_role from public.staff_members s where s.user_id = p_user_id for update;
  existing_role := coalesce(existing_role, 'player');
  if actor_role = 'manager' and (existing_role in ('manager', 'owner') or p_role in ('manager', 'owner')) then
    raise exception 'Access: Only an owner can assign or change Manager and Owner roles.';
  end if;
  if existing_role = p_role then return; end if;
  if existing_role <> p_expected_role then
    raise exception 'Access: This account’s role changed. Refresh the list and review it before trying again.';
  end if;
  if p_role = 'player' then
    if exists (select 1 from public.pos_shifts s where s.cashier_id = p_user_id and s.closed_at is null) then
      raise exception 'Access: Ask this staff member to close their register shift before removing access.';
    end if;
    delete from public.staff_members where user_id = p_user_id;
  else
    if not confirmed then
      raise exception 'Access: This user must confirm their email before receiving staff access.';
    end if;
    insert into public.staff_members(user_id, role) values (p_user_id, p_role)
      on conflict (user_id) do update set role = excluded.role;
  end if;

  insert into public.pos_audit(actor_id, action, entity_id, detail)
  values (actor, 'access.role_change', p_user_id, jsonb_build_object('from', existing_role, 'to', p_role));
end;
$$;

-- A shift must either open before a role removal checks it or wait and check access again.
create or replace function public.pos_open_shift(p_opening integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  shift_id uuid;
begin
  perform 1 from public.staff_members where user_id = auth.uid() for share;
  if not found then raise exception 'POS: Authorized staff access is required.'; end if;
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

revoke all on function public.admin_list_accounts(text,int), public.admin_set_account_role(uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.admin_list_accounts(text,int), public.admin_set_account_role(uuid,text,text)
  to authenticated;

notify pgrst, 'reload schema';
commit;
