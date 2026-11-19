begin;

create function public.list_active_memberships(p_page integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'Asia/Manila')::date;
begin
  perform private.pos_require_staff();
  if p_page is null or p_page < 1 then raise exception 'Membership: Choose a valid page.'; end if;

  return (
    with active as (
      select distinct on (a.user_id) a.id, a.user_id, a.plan_name, a.starts_on, a.expires_on, a.pos_sale_id
      from public.membership_applications a
      where a.user_id is not null and a.status = 'approved'
        and a.starts_on <= today and today < a.expires_on
      order by a.user_id, a.starts_on desc, a.reviewed_at desc, a.id desc
    ), page as (
      select a.id, a.plan_name, a.starts_on, a.expires_on,
        nullif(left(btrim(u.raw_user_meta_data->>'full_name'), 100), '') as full_name,
        case when a.pos_sale_id is not null and public.club_role() = 'cashier'
          then left(u.email, 1) || '•••@' || left(split_part(u.email, '@', 2), 1) || '•••'
          else u.email
        end as email
      from active a join auth.users u on u.id = a.user_id
      order by a.expires_on, a.id
      limit 10 offset (p_page::bigint - 1) * 10
    )
    select jsonb_build_object('row_count', (select count(*) from active),
      'rows', coalesce((select jsonb_agg(to_jsonb(page) order by expires_on, id) from page), '[]'::jsonb))
  );
end;
$$;

revoke all on function public.list_active_memberships(integer) from public, anon, authenticated;
grant execute on function public.list_active_memberships(integer) to authenticated;
notify pgrst, 'reload schema';

commit;
