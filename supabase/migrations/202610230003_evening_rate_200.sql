-- Apply after 202610230002_time_based_rates.sql.
-- Update the original evening rate; existing booking totals and custom rates stay intact.
begin;

alter table public.venue_settings
  alter column evening_hourly_rate set default 200;

update public.venue_settings
set evening_hourly_rate = 200
where id = true and evening_hourly_rate = 150;

commit;
