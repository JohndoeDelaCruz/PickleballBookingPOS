begin;

create table public.pos_expenses (
  id uuid primary key,
  expense_date date not null check (expense_date between date '2000-01-01' and date '2100-12-31'),
  category text not null check (category in ('supplies', 'utilities', 'maintenance', 'payroll', 'inventory', 'other')),
  description text not null check (char_length(btrim(description)) between 2 and 200),
  amount_cents integer not null check (amount_cents between 1 and 100000000),
  payment_method text not null check (payment_method in ('cash', 'gcash', 'bank_transfer', 'card', 'other')),
  shift_id uuid references public.pos_shifts(id),
  actor_id uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references auth.users(id),
  void_reason text,
  check (shift_id is null or payment_method = 'cash'),
  check ((voided_at is null and voided_by is null and void_reason is null)
    or (voided_at is not null and voided_by is not null and void_reason is not null
      and char_length(btrim(void_reason)) between 3 and 200))
);
create index pos_expenses_date on public.pos_expenses(expense_date desc, created_at desc, id);
create index pos_expenses_shift on public.pos_expenses(shift_id) where voided_at is null and shift_id is not null;

alter table public.pos_expenses enable row level security;
revoke all on public.pos_expenses from public, anon, authenticated;
grant select on public.pos_expenses to authenticated;
create policy "Staff read authorized expenses" on public.pos_expenses for select to authenticated
  using ((select public.is_staff()) or (
    (select public.is_club_staff()) and actor_id = (select auth.uid()) and shift_id is not null
  ));

create function public.pos_record_expense(
  p_id uuid, p_date date, p_category text, p_description text,
  p_amount integer, p_method text, p_shift uuid
) returns date language plpgsql security definer set search_path = '' as $$
declare
  existing public.pos_expenses%rowtype;
  expense_description text := btrim(p_description);
  today date;
begin
  perform private.pos_require_staff(p_shift is null);
  if p_id is null or p_amount is null or p_amount not between 1 and 100000000
    or expense_description is null or char_length(expense_description) not between 2 and 200
    or p_category is null or p_category not in ('supplies', 'utilities', 'maintenance', 'payroll', 'inventory', 'other')
    or p_method is null or p_method not in ('cash', 'gcash', 'bank_transfer', 'card', 'other')
    or (p_shift is not null and (p_method <> 'cash' or p_date is not null))
    or (p_shift is null and (p_date is null or p_date not between date '2000-01-01' and date '2100-12-31')) then
    raise exception 'POS: Enter a valid expense date, description, category, amount, and payment method.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('rally-expense:' || p_id::text, 0));
  select * into existing from public.pos_expenses where id = p_id;
  if found then
    if existing.actor_id = auth.uid()
      and (existing.category, existing.description, existing.amount_cents, existing.payment_method)
        = (p_category, expense_description, p_amount, p_method)
      and existing.shift_id is not distinct from p_shift
      and (p_shift is not null or existing.expense_date = p_date) then
      return existing.expense_date;
    end if;
    raise exception 'POS: This request already recorded a different expense. Check the expense log before retrying.';
  end if;

  if p_shift is not null then
    perform 1 from public.pos_shifts where id = p_shift and cashier_id = auth.uid() and closed_at is null for update;
    if not found then raise exception 'POS: Open your cashier shift and refresh before recording a drawer expense.'; end if;
  end if;
  today := (clock_timestamp() at time zone 'Asia/Manila')::date;
  if p_date > today then
    raise exception 'POS: Choose today or an earlier date for a paid expense.';
  end if;

  insert into public.pos_expenses(id, expense_date, category, description, amount_cents, payment_method, shift_id, actor_id)
    values (p_id, coalesce(p_date, today), p_category, expense_description, p_amount, p_method, p_shift, auth.uid());
  insert into public.pos_audit(actor_id, action, entity_id, detail)
    values (auth.uid(), 'expense.record', p_id, jsonb_build_object('amount_cents', p_amount, 'shift_id', p_shift));
  return coalesce(p_date, today);
end;
$$;

create function public.pos_void_expense(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  expense public.pos_expenses%rowtype;
  reason text := btrim(p_reason);
begin
  perform private.pos_require_staff(true);
  if reason is null or char_length(reason) not between 3 and 200 then
    raise exception 'POS: Enter a reason for voiding this expense.';
  end if;
  select * into expense from public.pos_expenses where id = p_id for update;
  if not found then raise exception 'POS: This expense could not be found.'; end if;
  if expense.voided_at is not null then return; end if;
  -- Serialize with close so the saved reconciliation always reflects the drawer at closing.
  if expense.shift_id is not null then
    perform 1 from public.pos_shifts where id = expense.shift_id for update;
  end if;

  update public.pos_expenses set voided_at = now(), voided_by = auth.uid(), void_reason = reason where id = p_id;
  insert into public.pos_audit(actor_id, action, entity_id, detail)
    values (auth.uid(), 'expense.void', p_id, jsonb_build_object('reason', reason));
end;
$$;

create function public.pos_expense_report(p_month date, p_page integer)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  result jsonb;
begin
  if not public.is_club_staff() then
    raise exception 'POS: Authorized staff access is required.';
  end if;
  if p_month is null or p_month not between date '2000-01-01' and date '2100-12-01'
    or extract(day from p_month) <> 1 or p_page is null or p_page < 1 then
    raise exception 'POS: Choose a valid expense report month and page.';
  end if;
  with expenses as (
    select e.*, coalesce(s.closed_at is not null, false) as shift_closed
    from public.pos_expenses e
    left join public.pos_shifts s on s.id = e.shift_id
    where e.expense_date >= p_month and e.expense_date < p_month + interval '1 month'
  ),
  page as (
    select id, expense_date, category, description, amount_cents, payment_method, shift_id, shift_closed,
      created_at, voided_at, void_reason
    from expenses
    order by expense_date desc, created_at desc, id
    limit 25 offset (greatest(p_page, 1)::bigint - 1) * 25
  )
  select jsonb_build_object(
    'total_cents', coalesce(sum(amount_cents) filter (where voided_at is null), 0),
    'drawer_cents', coalesce(sum(amount_cents) filter (where voided_at is null and shift_id is not null), 0),
    'row_count', count(*),
    'rows', coalesce((select jsonb_agg(to_jsonb(page) order by expense_date desc, created_at desc, id) from page), '[]'::jsonb),
    'active_shift', (select id from public.pos_shifts where cashier_id = auth.uid() and closed_at is null)
  ) into result from expenses;
  return result;
end;
$$;

create function private.pos_expected_cash(p_shift uuid, p_opening integer)
returns bigint language sql stable set search_path = '' as $$
  select p_opening
    + coalesce((select sum(amount_cents) from public.pos_payments where shift_id = p_shift and method = 'cash'), 0)
    - coalesce((select sum(amount_cents) from public.pos_refunds where shift_id = p_shift and method = 'cash'), 0)
    - coalesce((select sum(amount_cents) from public.pos_expenses where shift_id = p_shift and voided_at is null), 0);
$$;

create or replace function public.pos_close_shift(p_shift uuid, p_counted integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  shift public.pos_shifts%rowtype;
  expected bigint;
begin
  perform private.pos_require_staff();
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

create or replace function public.pos_shift_summary()
returns setof public.pos_shifts language sql stable security definer set search_path = '' as $$
  select s.id, s.register_id, s.cashier_id, s.opening_cents, s.opened_at, s.closed_at, s.counted_cents,
    case when s.closed_at is null then private.pos_expected_cash(s.id, s.opening_cents) else s.expected_cents end
  from public.pos_shifts s where s.cashier_id = auth.uid() and public.is_club_staff()
  order by s.opened_at desc limit 30;
$$;

revoke all on function private.pos_expected_cash(uuid, integer),
  public.pos_record_expense(uuid, date, text, text, integer, text, uuid),
  public.pos_void_expense(uuid, text), public.pos_expense_report(date, integer)
  from public, anon, authenticated;
grant execute on function public.pos_record_expense(uuid, date, text, text, integer, text, uuid),
  public.pos_void_expense(uuid, text), public.pos_expense_report(date, integer) to authenticated;

notify pgrst, 'reload schema';
commit;
