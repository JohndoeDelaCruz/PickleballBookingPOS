begin;

create or replace function public.pos_register_day(p_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  manager boolean := public.is_staff();
begin
  perform private.pos_require_staff();
  if p_date is null or p_date not between date '2000-01-01' and date '2100-12-31' then
    raise exception 'POS: Choose a valid duty date.';
  end if;

  return (
    with cashier_accounts as (
      select u.id, u.email,
        case when jsonb_typeof(u.raw_user_meta_data -> 'full_name') = 'string' then
          nullif(left(btrim(regexp_replace(u.raw_user_meta_data ->> 'full_name', '[[:space:]]+', ' ', 'g')), 100), '')
        end as name,
        coalesce(s.role = 'cashier' and u.email <> '' and u.email_confirmed_at is not null, false) as eligible
      from auth.users u left join public.staff_members s on s.user_id = u.id
      where s.role = 'cashier' or u.id = (select cashier_id from private.cashier_assignments where duty_date = p_date)
    )
    select jsonb_build_object(
      'assignment', (select jsonb_build_object('id', u.id, 'name', u.name,
         'label', case when manager then u.email else split_part(u.email, '@', 1) end, 'eligible', u.eligible)
        from private.cashier_assignments a join cashier_accounts u on u.id = a.cashier_id where a.duty_date = p_date),
      'cashiers', case when manager then (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'label', u.email, 'name', u.name)
        order by lower(coalesce(u.name, u.email)), u.id), '[]'::jsonb)
        from cashier_accounts u where u.eligible) else '[]'::jsonb end,
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
    )
  );
end;
$$;

notify pgrst, 'reload schema';
commit;
