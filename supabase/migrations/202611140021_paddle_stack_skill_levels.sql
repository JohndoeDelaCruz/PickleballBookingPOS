begin;

alter table private.paddle_stack_players
  add column skill_level text check (skill_level in ('beginner', 'intermediate', 'advanced'));

create function private.paddle_stack_next_players(p_session uuid)
returns uuid[] language sql stable set search_path = '' as $$
  with waiting as (
    select id, queue_number, skill_level, count(*) over (partition by skill_level) as at_level
    from private.paddle_stack_players
    where session_id = p_session and state = 'waiting'
  ), first_player as (
    select skill_level, at_level from waiting order by queue_number, id limit 1
  )
  select coalesce(array_agg(next.id order by next.queue_number, next.id), '{}'::uuid[])
  from (
    select w.id, w.queue_number
    from waiting w cross join first_player first
    where first.skill_level is null or first.at_level < 4 or w.skill_level = first.skill_level
    order by w.queue_number, w.id
    limit 4
  ) next;
$$;

create or replace function public.get_paddle_stack(p_session uuid, p_key uuid default null, p_staff boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  session private.paddle_stack_sessions%rowtype;
  show_staff boolean := p_staff is true and public.is_club_staff();
  today date := (now() at time zone 'Asia/Manila')::date;
  expired boolean;
begin
  select * into session from private.paddle_stack_sessions where id = p_session;
  if not found then return null; end if;
  expired := now() >= private.paddle_stack_time(session.play_date, session.end_hour + 2);
  if not show_staff and session.play_date < today and expired then return null; end if;
  return jsonb_build_object(
    'id', session.id, 'play_date', session.play_date, 'start_hour', session.start_hour,
    'end_hour', session.end_hour, 'capacity', session.capacity,
    'status', case
      when session.closed_at is not null or expired then 'closed'
      when now() >= private.paddle_stack_time(session.play_date, session.end_hour) then 'ending'
      when now() < private.paddle_stack_time(session.play_date, session.start_hour) then 'check_in'
      else 'playing' end,
    'score_court', (select c.court_id from private.paddle_stack_courts c
      where c.session_id = session.id and c.score_key = p_key and not expired and session.closed_at is null),
    'next_players', case when session.closed_at is null and not expired
      then to_jsonb(private.paddle_stack_next_players(p_session)) else '[]'::jsonb end,
    'waiting', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name)
      || case when show_staff and p.skill_level is not null
        then jsonb_build_object('skill_level', p.skill_level) else '{}'::jsonb end
      order by p.queue_number, p.id)
      from private.paddle_stack_players p where p.session_id = session.id and p.state = 'waiting'
        and session.closed_at is null and not expired), '[]'::jsonb),
    'resting', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name)
      || case when show_staff and p.skill_level is not null
        then jsonb_build_object('skill_level', p.skill_level) else '{}'::jsonb end
      order by p.queue_number, p.id)
      from private.paddle_stack_players p where p.session_id = session.id and p.state = 'resting'
        and show_staff and session.closed_at is null and not expired), '[]'::jsonb),
    'checked_in', (select count(*) from private.paddle_stack_players p where p.session_id = session.id and p.state <> 'left'),
    'courts', coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.court_id, 'name', c.name, 'active', coalesce(venue_court.active, false),
      'has_scorekeeper', show_staff and c.score_key is not null,
      'game', (select private.paddle_stack_game_view(g) from private.paddle_stack_games g
        where g.session_id = session.id and g.court_id = c.court_id
          and (g.finished_at is not null or not expired)
        order by g.started_at desc, g.id desc limit 1)
      ) order by c.court_id)
      from private.paddle_stack_courts c left join public.courts venue_court on venue_court.id = c.court_id
      where c.session_id = session.id), '[]'::jsonb),
    'results', coalesce((select jsonb_agg(private.paddle_stack_game_view(g.game) ||
      jsonb_build_object('court_name', g.court_name) order by g.finished_at desc, g.id desc)
      from (select games as game, games.id, games.finished_at, c.name as court_name
        from private.paddle_stack_games games
        join private.paddle_stack_courts c using (session_id, court_id)
        where games.session_id = session.id and games.finished_at is not null and show_staff
        order by games.finished_at desc, games.id desc limit 12) g), '[]'::jsonb)
  );
end;
$$;

-- The new named argument is optional for existing callers.
drop function public.paddle_stack_manage(uuid, text, int, uuid, text, uuid[]);
create function public.paddle_stack_manage(
  p_session uuid, p_action text, p_court int default null, p_player uuid default null,
  p_name text default null, p_expected uuid[] default null, p_skill text default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  session private.paddle_stack_sessions%rowtype;
  next_players uuid[];
  score_key uuid;
  player_name text := btrim(p_name);
  venue jsonb;
  current_time_pht timestamptz := now();
begin
  perform private.pos_require_staff();
  select * into session from private.paddle_stack_sessions where id = p_session for update;
  if not found or session.closed_at is not null or current_time_pht >= private.paddle_stack_time(session.play_date, session.end_hour + 2) then
    raise exception 'Paddle Stack: This session is closed.';
  end if;
  if p_skill is not null and p_skill not in ('beginner', 'intermediate', 'advanced') then
    raise exception 'Paddle Stack: Choose a valid skill level.';
  end if;

  case p_action
    when 'check_in' then
      if current_time_pht >= private.paddle_stack_time(session.play_date, session.end_hour) then
        raise exception 'Paddle Stack: Check-in has ended.';
      end if;
      if p_player is null or player_name is null or char_length(player_name) not between 2 and 40
        or player_name ~ '[[:cntrl:]]' then
        raise exception 'Paddle Stack: Enter a display name of 2 to 40 characters.';
      end if;
      if exists (select 1 from private.paddle_stack_players p where p.id = p_player
        and p.session_id = p_session and p.name = player_name) then return null; end if;
      if session.capacity is not null and session.capacity <= (
        select count(*) from private.paddle_stack_players p where p.session_id = p_session and p.state <> 'left'
      ) then
        raise exception 'Paddle Stack: This session has reached its player limit.';
      end if;
      insert into private.paddle_stack_players(id, session_id, name, skill_level)
        values (p_player, p_session, player_name, p_skill);
    when 'set_skill' then
      update private.paddle_stack_players set skill_level = p_skill
      where id = p_player and session_id = p_session and state in ('waiting', 'resting')
        and current_time_pht < private.paddle_stack_time(session.play_date, session.end_hour);
      if not found then
        raise exception 'Paddle Stack: Only waiting or resting players can change skill level during check-in or open play.';
      end if;
    when 'pause' then
      update private.paddle_stack_players set state = 'resting'
        where id = p_player and session_id = p_session and state = 'waiting';
    when 'rejoin' then
      if current_time_pht >= private.paddle_stack_time(session.play_date, session.end_hour) then
        raise exception 'Paddle Stack: This session has ended.';
      end if;
      update private.paddle_stack_players
        set state = 'waiting', queue_number = nextval('private.paddle_stack_queue_number')
        where id = p_player and session_id = p_session and state = 'resting';
    when 'leave' then
      update private.paddle_stack_players set state = 'left'
        where id = p_player and session_id = p_session and state in ('waiting', 'resting');
    when 'call' then
      if current_time_pht < private.paddle_stack_time(session.play_date, session.start_hour)
         or current_time_pht >= private.paddle_stack_time(session.play_date, session.end_hour) then
        raise exception 'Paddle Stack: Call games during the scheduled open-play hours.';
      end if;
      select to_jsonb(v) into venue from public.venue_settings v where v.id for share;
      perform pg_advisory_xact_lock(hashtextextended('rally-session:' || session.play_date::text, 0));
      if not exists (select 1 from public.resolve_schedule_blocks(venue, session.play_date) b
        where b.kind = 'open_play' and (b.start_hour, b.end_hour) = (session.start_hour, session.end_hour)) then
        raise exception 'Paddle Stack: The open-play schedule has changed.';
      end if;
      if not exists (select 1 from private.paddle_stack_courts c join public.courts v on v.id = c.court_id
        where c.session_id = p_session and c.court_id = p_court and v.active) then
        raise exception 'Paddle Stack: Choose an active court for this session.';
      end if;
      if exists (select 1 from private.paddle_stack_games g join private.paddle_stack_sessions s on s.id = g.session_id
        where g.court_id = p_court and g.finished_at is null and s.closed_at is null
          and now() < private.paddle_stack_time(s.play_date, s.end_hour + 2)) then
        raise exception 'Paddle Stack: Finish the current game on this court first.';
      end if;
      if exists (select 1 from public.bookings b where b.booking_date = session.play_date and b.court_id = p_court
        and b.status in ('awaiting_payment', 'awaiting_verification', 'confirmed', 'blocked')
        and (b.status <> 'awaiting_payment' or b.hold_expires_at > now())
        and b.start_hour < session.end_hour and b.start_hour + b.duration > session.start_hour) then
        raise exception 'Paddle Stack: This court has a conflicting booking or block.';
      end if;
      next_players := private.paddle_stack_next_players(p_session);
      if coalesce(cardinality(next_players), 0) <> 4 then
        raise exception 'Paddle Stack: Four players must be waiting to call a game.';
      end if;
      if next_players is distinct from p_expected then
        raise exception 'Paddle Stack: The queue changed. Check who is up next before calling.';
      end if;
      insert into private.paddle_stack_games(session_id, court_id, players) values (p_session, p_court, next_players);
      update private.paddle_stack_players set state = 'playing' where id = any(next_players);
    when 'assign', 'revoke' then
      update private.paddle_stack_courts
        set score_key = case when p_action = 'assign' then gen_random_uuid() else null end
        where session_id = p_session and court_id = p_court
        returning paddle_stack_courts.score_key into score_key;
      if not found then raise exception 'Paddle Stack: Choose a court for this session.'; end if;
      return score_key;
    when 'close' then
      if exists (select 1 from private.paddle_stack_games where session_id = p_session and finished_at is null) then
        raise exception 'Paddle Stack: Finish the games on court before closing the session.';
      end if;
      update private.paddle_stack_sessions set closed_at = now() where id = p_session;
    else
      raise exception 'Paddle Stack: Choose a valid queue action.';
  end case;
  return null;
end;
$$;

create or replace function private.paddle_stack_pair_game()
returns trigger language plpgsql set search_path = '' as $$
declare
  teams uuid[];
begin
  -- Balance skill first, then prefer splitting recent teammates and results.
  -- Unrated players are neutral for pairing and don't form a same-level group.
  with player_history as (
    select player.id, player.position,
      case p.skill_level when 'beginner' then 1 when 'advanced' then 3 else 2 end as skill,
      case when player.id = any(game.players[1:2]) then game.players[1:2]
           else coalesce(game.players[3:4], '{}'::uuid[]) end as previous_team,
      case when player.id = any(game.players[1:2]) then score.result
           else -score.result end as last_result
    from unnest(new.players) with ordinality as player(id, position)
    join private.paddle_stack_players p on p.id = player.id
    left join lateral (
      select g.players, g.points
      from private.paddle_stack_games g
      where g.session_id = new.session_id and g.finished_at is not null and player.id = any(g.players)
      order by g.finished_at desc, g.started_at desc, g.id desc
      limit 1
    ) game on true
    cross join lateral (
      select sign(count(*) filter (where point = 1) - count(*) filter (where point = 2)) as result
      from unnest(game.points) as point
    ) score
  )
  select array[a.id, b.id, c.id, d.id] into teams
  from (values (2, 3, 4), (3, 2, 4), (4, 2, 3)) as pairing(partner, opponent, other_opponent)
  join player_history a on a.position = 1
  join player_history b on b.position = pairing.partner
  join player_history c on c.position = pairing.opponent
  join player_history d on d.position = pairing.other_opponent
  order by
    abs(a.skill + b.skill - c.skill - d.skill),
    (a.id = any(b.previous_team) or b.id = any(a.previous_team))::int
      + (c.id = any(d.previous_team) or d.id = any(c.previous_team))::int,
    abs(a.last_result + b.last_result - c.last_result - d.last_result),
    random()
  limit 1;

  new.players := teams;
  return new;
end;
$$;

revoke all on function private.paddle_stack_next_players(uuid),
  public.paddle_stack_manage(uuid, text, int, uuid, text, uuid[], text) from public, anon, authenticated;
grant execute on function public.paddle_stack_manage(uuid, text, int, uuid, text, uuid[], text) to authenticated;

notify pgrst, 'reload schema';
commit;
