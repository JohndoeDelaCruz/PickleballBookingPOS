-- Editable private-court capacity and rental inclusions.
-- Keep the ball count promised on existing rental bookings unchanged.
begin;

alter table public.venue_settings
  add column private_court_capacity int not null default 8
    check (private_court_capacity between 1 and 100),
  add column equipment_ball_count int not null default 1
    check (equipment_ball_count between 1 and 20);

alter table public.bookings
  add column equipment_ball_count int not null default 0;
update public.bookings set equipment_ball_count = 2 where equipment_rental;
alter table public.bookings
  add constraint booking_equipment_balls_valid check (
    (equipment_rental and equipment_ball_count between 1 and 20)
    or (not equipment_rental and equipment_ball_count = 0)
  );

create function public.snapshot_equipment_inclusions() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not new.equipment_rental then
    new.equipment_ball_count := 0;
  elsif tg_op = 'INSERT' or not old.equipment_rental then
    select v.equipment_ball_count into new.equipment_ball_count
      from public.venue_settings v where v.id = true for share;
  end if;
  return new;
end;
$$;
revoke all on function public.snapshot_equipment_inclusions() from public,anon,authenticated;
create trigger snapshot_equipment_inclusions
  before insert or update of equipment_rental on public.bookings
  for each row execute function public.snapshot_equipment_inclusions();

notify pgrst, 'reload schema';
commit;
