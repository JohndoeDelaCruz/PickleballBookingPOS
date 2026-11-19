begin;

-- Save both rules in one transaction using the existing permissions and
-- revision checks. A rejected rule rolls back any change to the other.
create function public.save_membership_discounts(
  p_plan text,
  p_court_enabled boolean, p_court_amount_cents integer, p_court_min_hours integer, p_court_revision integer,
  p_open_play_enabled boolean, p_open_play_amount_cents integer, p_open_play_floor_cents integer, p_open_play_revision integer
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  court_revision integer;
  open_play_revision integer;
begin
  court_revision := public.save_membership_booking_discount(
    p_plan, p_court_enabled, p_court_amount_cents, p_court_min_hours, p_court_revision);
  open_play_revision := public.save_membership_open_play_discount(
    p_plan, p_open_play_enabled, p_open_play_amount_cents, p_open_play_floor_cents, p_open_play_revision);
  return jsonb_build_object('courtRevision', court_revision, 'openPlayRevision', open_play_revision);
end;
$$;

revoke all on function public.save_membership_discounts(text, boolean, integer, integer, integer, boolean, integer, integer, integer)
from public, anon, authenticated;
grant execute on function public.save_membership_discounts(text, boolean, integer, integer, integer, boolean, integer, integer, integer)
to authenticated;
notify pgrst, 'reload schema';

commit;
