begin;

create or replace function public.admin_list_accounts(p_query text, p_page int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  actor_role text := public.club_role();
  query text := lower(btrim(regexp_replace(coalesce(p_query, ''), '[[:space:]]+', ' ', 'g')));
  page_size constant int := 10;
begin
  if actor_role is null or actor_role not in ('owner', 'manager') then
    raise exception 'Access: Manager or owner authorization is required.';
  end if;
  if length(query) > 254 or p_page is null or p_page < 1 then
    raise exception 'Access: Choose a valid account search and page.';
  end if;

  return (
    with accounts as (
      select u.id, u.email, coalesce(s.role, 'player') as role,
        u.email_confirmed_at is not null as email_confirmed,
        case when jsonb_typeof(u.raw_user_meta_data -> 'full_name') = 'string' then
          nullif(left(btrim(regexp_replace(u.raw_user_meta_data ->> 'full_name', '[[:space:]]+', ' ', 'g')), 100), '')
        end as full_name
      from auth.users u left join public.staff_members s on s.user_id = u.id
      where u.email <> ''
    ), matching as (
      select * from accounts
      where query = '' or strpos(lower(email), query) > 0 or strpos(lower(full_name), query) > 0
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
