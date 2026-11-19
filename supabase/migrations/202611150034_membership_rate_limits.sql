begin;

create table private.membership_request_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (action in ('start', 'submit', 'cancel')),
  attempts timestamptz[] not null default '{}',
  primary key (user_id, action),
  check (cardinality(attempts) <= 5)
);
alter table private.membership_request_limits enable row level security;
revoke all on private.membership_request_limits from public, anon, authenticated;

create function public.request_customer_membership(p_action text, p_input jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  attempted_at timestamptz;
  recent timestamptz[];
  retry_seconds integer;
  failure text;
begin
  if actor is null then
    return jsonb_build_object('error', 'Sign in to continue.', 'code', 'AUTH_REQUIRED');
  end if;
  if p_action is null or p_action not in ('start', 'submit', 'cancel') then
    return jsonb_build_object('error', 'Choose a valid membership action.', 'code', 'INVALID_INPUT');
  end if;

  insert into private.membership_request_limits (user_id, action) values (actor, p_action)
    on conflict do nothing;
  -- A row lock shares each action allowance across browser tabs and app servers.
  select attempts into recent from private.membership_request_limits
    where user_id = actor and action = p_action for update;
  attempted_at := clock_timestamp();
  select coalesce(array_agg(attempt order by attempt), '{}'::timestamptz[]) into recent
    from unnest(recent) attempt where attempt > attempted_at - interval '10 minutes';
  if cardinality(recent) >= 5 then
    retry_seconds := greatest(1, ceil(extract(epoch from recent[1] + interval '10 minutes' - attempted_at))::integer);
    return jsonb_build_object(
      'error', 'Too many membership requests. Please try again in ' || ceil(retry_seconds / 60.0)::integer ||
        case when retry_seconds <= 60 then ' minute.' else ' minutes.' end,
      'code', 'RATE_LIMITED', 'retry_after_seconds', retry_seconds
    );
  end if;
  update private.membership_request_limits set attempts = array_append(recent, attempted_at)
    where user_id = actor and action = p_action;

  -- Returning failures from this block preserves the attempt above.
  begin
    if jsonb_typeof(p_input) is distinct from 'object' then
      return jsonb_build_object('error', 'Check the application details and try again.', 'code', 'INVALID_INPUT');
    end if;
    case p_action
      when 'start' then
        perform public.start_membership_application(p_input->>'plan', (p_input->>'revision')::integer);
      when 'submit' then
        perform public.submit_membership_payment((p_input->>'id')::uuid, p_input->>'reference');
      when 'cancel' then
        perform public.cancel_membership_application((p_input->>'id')::uuid);
    end case;
    return jsonb_build_object('success', true);
  exception when others then
    get stacked diagnostics failure = message_text;
    if left(failure, 12) = 'Membership: ' then
      return jsonb_build_object('error', substr(failure, 13), 'code', 'REQUEST_REJECTED');
    end if;
    if sqlstate like '22%' then
      return jsonb_build_object('error', 'Check the application details and try again.', 'code', 'INVALID_INPUT');
    end if;
    return jsonb_build_object('error', 'The membership application couldn’t be updated. Please try again.', 'code', 'REQUEST_REJECTED');
  end;
end;
$$;

-- Keep the original operations callable by the definer function only.
revoke all on function public.start_membership_application(text, integer),
  public.submit_membership_payment(uuid, text), public.cancel_membership_application(uuid),
  public.request_customer_membership(text, jsonb) from public, anon, authenticated;
grant execute on function public.request_customer_membership(text, jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
