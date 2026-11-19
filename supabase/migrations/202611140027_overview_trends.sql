begin;

create function public.pos_overview_trends(p_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  history_start timestamptz := (p_date - 6)::timestamp at time zone 'Asia/Manila';
  history_end timestamptz := (p_date + 1)::timestamp at time zone 'Asia/Manila';
begin
  perform private.pos_require_staff();
  if p_date is null or p_date not between date '2000-01-01' and date '2100-12-31' then
    raise exception 'POS: Choose a valid report date.';
  end if;

  return (
    with receipts as (
      select (created_at at time zone 'Asia/Manila')::date as day, amount_cents as amount
      from public.pos_payments where created_at >= history_start and created_at < history_end
      union all
      select (created_at at time zone 'Asia/Manila')::date, -amount_cents
      from public.pos_refunds where created_at >= history_start and created_at < history_end
    ), collected as (
      select day, sum(amount) as total from receipts group by day
    ), retail as (
      select (created_at at time zone 'Asia/Manila')::date as day, sum(total_cents) as total
      from public.pos_sales where kind = 'retail' and created_at >= history_start and created_at < history_end
      group by 1
    ), reservations as (
      select booking_date as day, count(*) as total, sum(round((total_amount - paid_amount) * 100)) as due
      from public.bookings where status = 'confirmed' and booking_date between p_date - 6 and p_date + 30
      group by booking_date
    ), history as (
      select p_date + offset_day as day from generate_series(-6, 0) as offset_day
    ), upcoming as (
      select p_date + offset_day as day from generate_series(0, 30) as offset_day
    )
    select jsonb_build_object(
      'net', jsonb_agg(coalesce(collected.total, 0) order by history.day),
      'reservations', jsonb_agg(coalesce(reservations.total, 0) order by history.day),
      'retail', jsonb_agg(coalesce(retail.total, 0) order by history.day),
      'balances', (select jsonb_agg(coalesce(reservations.due, 0) order by upcoming.day)
        from upcoming left join reservations using (day))
    )
    from history left join collected using (day) left join retail using (day) left join reservations using (day)
  );
end;
$$;

revoke all on function public.pos_overview_trends(date) from public, anon, authenticated;
grant execute on function public.pos_overview_trends(date) to authenticated;
notify pgrst, 'reload schema';
commit;
