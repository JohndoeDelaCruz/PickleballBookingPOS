begin;

create or replace function public.admin_list_accounts(p_query text, p_page int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  actor_role text := public.club_role();
  query text := lower(btrim(coalesce(p_query, '')));
  page_size constant int := 10;
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
    select jsonb_build_object('row_count', (select count(*) from matching), 'page_size', page_size,
      'rows', coalesce((select jsonb_agg(to_jsonb(page) order by lower(email), id) from page), '[]'::jsonb))
  );
end;
$$;

notify pgrst, 'reload schema';
commit;
