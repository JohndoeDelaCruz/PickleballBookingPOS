begin;

create function public.current_paddle_stack_matches()
returns table (session_id uuid, court_name text, game jsonb)
language sql stable security definer set search_path = '' as $$
  select s.id, c.name,
    private.paddle_stack_game_view(g) - array['revision', 'finished_at', 'can_undo']
  from private.paddle_stack_games g
  join private.paddle_stack_sessions s on s.id = g.session_id
  join private.paddle_stack_courts c on (c.session_id, c.court_id) = (g.session_id, g.court_id)
  where auth.uid() is not null
    and g.finished_at is null
    and s.closed_at is null
    and s.play_date between (now() at time zone 'Asia/Manila')::date - 1
      and (now() at time zone 'Asia/Manila')::date
    and now() >= private.paddle_stack_time(s.play_date, s.start_hour)
    and now() < private.paddle_stack_time(s.play_date, s.end_hour + 2)
  order by c.court_id, g.started_at, g.id;
$$;

revoke all on function public.current_paddle_stack_matches() from public, anon, authenticated;
grant execute on function public.current_paddle_stack_matches() to authenticated;

notify pgrst, 'reload schema';
commit;
