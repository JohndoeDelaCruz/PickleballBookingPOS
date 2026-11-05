-- Twelve rotating open-play participants per court, across two shared courts.
alter table public.venue_settings alter column open_play_capacity set default 24;
update public.venue_settings set open_play_capacity = 24 where id = true;
