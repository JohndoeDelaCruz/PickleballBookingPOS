begin;

alter table public.pos_sales
  drop constraint pos_sales_kind_check,
  drop constraint pos_sales_check1,
  add constraint pos_sales_kind_check check (kind in ('booking', 'retail', 'membership')),
  add constraint pos_sales_booking_link check ((kind = 'booking') = (booking_id is not null));

alter table public.membership_applications
  add column pos_sale_id uuid unique references public.pos_sales(id),
  add column payment_method text not null default 'gcash' check (payment_method in ('cash', 'gcash')),
  drop constraint membership_applications_status_check,
  drop constraint membership_applications_check,
  drop constraint membership_applications_check2,
  drop constraint membership_applications_check3,
  add constraint membership_applications_status_check
    check (status in ('awaiting_payment', 'pending', 'approved', 'rejected', 'refunded')),
  add constraint membership_payment_reference_check
    check ((status = 'awaiting_payment' or payment_method = 'cash') = (payment_reference is null)),
  add constraint membership_review_check
    check ((status in ('approved', 'rejected', 'refunded')) = (reviewed_at is not null)),
  add constraint membership_term_check
    check ((status in ('approved', 'refunded')) = (starts_on is not null and expires_on is not null)),
  add constraint membership_sale_link check (
    (payment_method <> 'cash' or pos_sale_id is not null)
    and (pos_sale_id is null or status in ('approved', 'refunded'))
    and (status <> 'refunded' or pos_sale_id is not null)
  );

create function public.pos_find_membership_customers(p_query text)
returns table (id uuid, full_name text, email text, availability text)
language plpgsql stable security definer set search_path = '' as $$
declare
  search text := lower(btrim(p_query));
begin
  perform private.pos_require_staff();
  if search is null or length(search) not between 2 and 254 then
    raise exception 'Membership: Enter at least two characters of a name or the full email address.';
  end if;
  return query
    select u.id, nullif(left(btrim(u.raw_user_meta_data->>'full_name'), 100), ''),
      case when lower(u.email) = search then u.email::text
        else left(u.email, 1) || '•••@' || left(split_part(u.email, '@', 2), 1) || '•••'
      end,
      case
        when exists (select 1 from public.membership_applications a where a.user_id = u.id and a.status = 'pending') then 'pending'
        when exists (select 1 from public.membership_applications a where a.user_id = u.id and a.status = 'approved'
          and a.expires_on > (now() at time zone 'Asia/Manila')::date) then 'active'
        else 'available'
      end
    from auth.users u
    where u.email_confirmed_at is not null and nullif(btrim(u.email), '') is not null
      and (lower(u.email) = search
        or strpos(lower(left(btrim(u.raw_user_meta_data->>'full_name'), 100)), search) > 0)
    order by (lower(u.email) = search) desc, u.email, u.id
    limit 10;
end;
$$;

create function public.pos_sell_membership(
  p_key uuid, p_customer uuid, p_plan text, p_revision integer, p_method text,
  p_received integer, p_reference text, p_verified boolean
) returns table (
  receipt_number text, plan_name text, price_cents integer, starts_on date, expires_on date, status text
) language plpgsql security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'Asia/Manila')::date;
  reference text := nullif(btrim(p_reference), '');
  sale_request jsonb;
  sale public.pos_sales%rowtype;
  application public.membership_applications%rowtype;
  plan public.membership_settings%rowtype;
  venue public.venue_settings%rowtype;
  customer_name text;
  label text;
  fee integer;
  expiry date;
  shift_id uuid;
begin
  perform pg_advisory_xact_lock_shared(hashtextextended('rally-cashier-date:' || today::text, 0));
  perform 1 from public.staff_members where user_id = auth.uid() for share;
  if not found then raise exception 'POS: Authorized staff access is required.'; end if;
  perform private.pos_require_staff();
  if p_key is null or p_customer is null or p_plan is null or p_plan not in ('annual', 'six-month')
    or p_revision is null or p_revision < 0 then
    raise exception 'Membership: Choose a customer and membership plan.';
  end if;
  if p_method is null or p_method not in ('cash', 'gcash') or p_received is null
    or p_received not between 1 and 100000000 then
    raise exception 'Membership: Enter a valid payment amount.';
  end if;
  if (p_method = 'gcash' and (p_verified is distinct from true or reference is null or length(reference) > 40))
    or (p_method = 'cash' and reference is not null) then
    raise exception 'Membership: Verify the GCash payment and enter its reference.';
  end if;

  sale_request := jsonb_build_object('customer', p_customer, 'plan', p_plan, 'revision', p_revision,
    'method', p_method, 'received', p_received, 'reference', reference);
  perform pg_advisory_xact_lock(hashtextextended('rally-checkout:' || p_key::text, 0));
  select * into sale from public.pos_sales where id = p_key;
  if found then
    if sale.kind <> 'membership' or sale.cashier_id is distinct from auth.uid()
      or sale.request is distinct from sale_request then
      raise exception 'POS: This checkout key was already used. Check Transactions before starting another sale.';
    end if;
  else
    -- Serialize with customer applications and lock any draft or payment under review.
    perform pg_advisory_xact_lock(hashtextextended('rally-membership:' || p_customer::text, 0));
    select coalesce(nullif(left(btrim(u.raw_user_meta_data->>'full_name'), 100), ''), 'Membership customer')
      into customer_name from auth.users u
      where u.id = p_customer and u.email_confirmed_at is not null and nullif(btrim(u.email), '') is not null for share;
    if not found then raise exception 'Membership: Select a customer with a confirmed email address.'; end if;

    select * into application from public.membership_applications a
      where a.user_id = p_customer and a.status in ('awaiting_payment', 'pending') for update;
    if application.status = 'pending' then
      raise exception 'Membership: Review this customer’s online GCash payment before taking another payment.';
    end if;
    if exists (select 1 from public.membership_applications a
      where a.user_id = p_customer and a.status = 'approved' and a.expires_on > today) then
      raise exception 'Membership: This customer already has an active membership.';
    end if;

    select * into plan from public.membership_settings where id = (p_plan = 'annual') for share;
    if not found or plan.details is null then
      raise exception 'Membership: This plan is not available for sale yet.';
    end if;
    if plan.revision <> p_revision then
      raise exception 'Membership: The plan changed. Refresh the page and check the current price before taking payment.';
    end if;
    fee := (plan.details->>'price_cents')::integer;
    label := plan.details->>'plan_name';
    expiry := (today + make_interval(months => case when p_plan = 'annual' then 12 else 6 end))::date;
    if coalesce(fee, 0) <= 0 then raise exception 'Membership: The selected plan has no sale price.'; end if;
    if p_method = 'cash' then
      if p_received < fee then raise exception 'Membership: Cash received must cover the full membership fee.'; end if;
      shift_id := private.pos_open_shift_lock();
    else
      if p_received <> fee then raise exception 'Membership: Verify a GCash payment for the full membership fee.'; end if;
      select * into venue from public.venue_settings where id for share;
      if nullif(btrim(venue.gcash_name), '') is null
        or (nullif(btrim(venue.gcash_number), '') is null and nullif(btrim(venue.gcash_qr_url), '') is null) then
        raise exception 'Membership: The venue’s GCash payment details are unavailable.';
      end if;
    end if;

    insert into public.pos_sales (id, kind, customer_name, total_cents, cashier_id, request)
      values (p_key, 'membership', customer_name, fee, auth.uid(), sale_request);
    insert into public.pos_sale_items (sale_id, name, quantity, price_cents, cost_cents)
      values (p_key, label, 1, fee, 0);
    -- Record the payment first so the shared reference guard does not see its own approval.
    perform private.pos_add_payment(p_key, fee, p_method, reference, shift_id);

    insert into public.membership_applications (id, user_id, plan_id, plan_name, price_cents, status,
        gcash_name, gcash_number, gcash_qr_url, payment_reference, payment_method, pos_sale_id,
        submitted_at, reviewed_at, reviewed_by, starts_on, expires_on)
      values (coalesce(application.id, gen_random_uuid()), p_customer, p_plan, label, fee, 'approved',
        coalesce(venue.gcash_name, ''), coalesce(venue.gcash_number, ''), coalesce(venue.gcash_qr_url, ''),
        reference, p_method, p_key, now(), now(), auth.uid(), today, expiry)
      on conflict on constraint membership_applications_pkey do update set
        plan_id = excluded.plan_id, plan_name = excluded.plan_name, price_cents = excluded.price_cents,
        status = excluded.status, gcash_name = excluded.gcash_name, gcash_number = excluded.gcash_number,
        gcash_qr_url = excluded.gcash_qr_url, payment_reference = excluded.payment_reference,
        payment_method = excluded.payment_method, pos_sale_id = excluded.pos_sale_id, submitted_at = excluded.submitted_at,
        reviewed_at = excluded.reviewed_at, reviewed_by = excluded.reviewed_by,
        starts_on = excluded.starts_on, expires_on = excluded.expires_on;

    insert into public.pos_audit (actor_id, action, entity_id, detail)
      values (auth.uid(), 'membership.sale', p_key, jsonb_build_object('plan', p_plan, 'total_cents', fee, 'method', p_method));
  end if;

  return query select s.number, a.plan_name, a.price_cents, a.starts_on, a.expires_on, a.status
    from public.membership_applications a join public.pos_sales s on s.id = a.pos_sale_id
    where s.id = p_key;
end;
$$;

create function private.pos_refund_membership() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.membership_applications set status = 'refunded' where pos_sale_id = new.id and status = 'approved';
  return new;
end;
$$;

create trigger refund_membership after update of status on public.pos_sales for each row
when (old.status = 'completed' and new.status = 'refunded' and new.kind = 'membership')
execute function private.pos_refund_membership();

create or replace function public.list_membership_applications(p_reviewed boolean, p_page integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.pos_require_staff();
  if p_reviewed is null or p_page is null or p_page < 1 then raise exception 'Membership: Choose a valid review page.'; end if;
  return (
    with filtered as (
      select a.id, a.plan_name, a.price_cents, a.payment_reference, a.status, a.submitted_at, a.reviewed_at,
        a.review_note, a.starts_on, a.expires_on, a.gcash_name, a.gcash_number, a.payment_method, s.number as receipt_number,
        case when a.pos_sale_id is not null and public.club_role() = 'cashier'
          then left(u.email, 1) || '•••@' || left(split_part(u.email, '@', 2), 1) || '•••'
          else u.email
        end as email,
        nullif(left(btrim(u.raw_user_meta_data->>'full_name'), 100), '') as full_name
      from public.membership_applications a left join auth.users u on u.id = a.user_id
      left join public.pos_sales s on s.id = a.pos_sale_id
      where (not p_reviewed and a.status = 'pending') or (p_reviewed and a.status in ('approved', 'rejected', 'refunded'))
    ), page as (
      select * from filtered
      order by coalesce(reviewed_at, submitted_at) desc, id desc
      limit 10 offset (p_page::bigint - 1) * 10
    )
    select jsonb_build_object('row_count', (select count(*) from filtered),
      'rows', coalesce((select jsonb_agg(to_jsonb(page) order by coalesce(reviewed_at, submitted_at) desc, id desc) from page), '[]'::jsonb))
  );
end;
$$;

revoke all on function private.pos_refund_membership(), public.pos_find_membership_customers(text),
  public.pos_sell_membership(uuid, uuid, text, integer, text, integer, text, boolean) from public, anon, authenticated;
grant execute on function public.pos_find_membership_customers(text),
  public.pos_sell_membership(uuid, uuid, text, integer, text, integer, text, boolean) to authenticated;

notify pgrst, 'reload schema';
commit;
