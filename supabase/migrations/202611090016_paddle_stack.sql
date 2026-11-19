begin;

create table private.paddle_stack_sessions (
  id uuid primary key default gen_random_uuid(),
  play_date date not null,
  start_hour int not null check (start_hour between 0 and 23),
  end_hour int not null check (end_hour between 1 and 24 and end_hour > start_hour),
  capacity int check (capacity > 0),
  closed_at timestamptz,
  unique (play_date, start_hour, end_hour)
);

create table private.paddle_stack_courts (
  session_id uuid references private.paddle_stack_sessions(id) on delete cascade,
  court_id smallint not null,
  name text not null,
  score_key uuid unique,
  primary key (session_id, court_id)
);

create sequence private.paddle_stack_queue_number;
create table private.paddle_stack_players (
  id uuid primary key,
  session_id uuid not null references private.paddle_stack_sessions(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 40),
  state text not null default 'waiting' check (state in ('waiting', 'playing', 'resting', 'left')),
  queue_number bigint not null default nextval('private.paddle_stack_queue_number')
);
create index paddle_stack_player_queue on private.paddle_stack_players(session_id, state, queue_number);

create table private.paddle_stack_games (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  court_id smallint not null,
  players uuid[] not null check (cardinality(players) = 4),
  points smallint[] not null default '{}',
  revision int not null default 0,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  foreign key (session_id, court_id) references private.paddle_stack_courts(session_id, court_id) on delete cascade
);
create unique index paddle_stack_one_game_per_court
  on private.paddle_stack_games(session_id, court_id) where finished_at is null;
create index paddle_stack_live_court
  on private.paddle_stack_games(court_id) where finished_at is null;
create index paddle_stack_game_history
  on private.paddle_stack_games(session_id, court_id, started_at desc);

alter table private.paddle_stack_sessions enable row level security;
alter table private.paddle_stack_courts enable row level security;
alter table private.paddle_stack_players enable row level security;
alter table private.paddle_stack_games enable row level security;
revoke all on private.paddle_stack_sessions, private.paddle_stack_courts,
  private.paddle_stack_players, private.paddle_stack_games from public, anon, authenticated;
revoke all on sequence private.paddle_stack_queue_number from public, anon, authenticated;

create function private.paddle_stack_time(p_date date, p_hour int)
returns timestamptz language sql immutable set search_path = '' as $$
  select (p_date + make_interval(hours => p_hour)) at time zone 'Asia/Manila';
$$;

create function public.paddle_stack_sessions()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'Asia/Manila')::date;
  result jsonb;
begin
  perform private.pos_require_staff();
  select coalesce(jsonb_agg(to_jsonb(s) order by s.play_date, s.start_hour, s.end_hour), '[]'::jsonb)
  into result
  from (
    select today as play_date, b.start_hour, b.end_hour, p.id, p.closed_at
    from public.venue_settings v
    cross join lateral public.resolve_schedule_blocks(to_jsonb(v), today) b
    left join private.paddle_stack_sessions p
      on (p.play_date, p.start_hour, p.end_hour) = (today, b.start_hour, b.end_hour)
    where v.id and b.kind = 'open_play'
      and (p.id is not null or private.paddle_stack_time(today, b.end_hour) > now())
    union
    select p.play_date, p.start_hour, p.end_hour, p.id, p.closed_at
    from private.paddle_stack_sessions p
    where p.play_date = today
       or (p.play_date = today - 1 and p.closed_at is null
           and now() < private.paddle_stack_time(p.play_date, p.end_hour + 2))
  ) s;
  return result;
end;
$$;

create function public.paddle_stack_open(p_start int, p_end int)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'Asia/Manila')::date;
  venue jsonb;
  player_limit int;
  session_id uuid;
begin
  perform private.pos_require_staff();
  select to_jsonb(v) into venue from public.venue_settings v where v.id for share;
  perform pg_advisory_xact_lock(hashtextextended('rally-session:' || today::text, 0));
  select p.id into session_id from private.paddle_stack_sessions p
    where (p.play_date, p.start_hour, p.end_hour) = (today, p_start, p_end);
  if found then return session_id; end if;

  select b.capacity into player_limit from public.resolve_schedule_blocks(venue, today) b
    where b.kind = 'open_play' and b.start_hour = p_start and b.end_hour = p_end;
  if not found or now() >= private.paddle_stack_time(today, p_end) then
    raise exception 'Paddle Stack: Choose an upcoming or current open-play session.';
  end if;
  if not exists (select 1 from public.courts where active) then
    raise exception 'Paddle Stack: There are no active courts.';
  end if;

  insert into private.paddle_stack_sessions(play_date, start_hour, end_hour, capacity)
    values (today, p_start, p_end, player_limit) returning id into session_id;
  insert into private.paddle_stack_courts(session_id, court_id, name)
    select session_id, id, name from public.courts where active;
  return session_id;
end;
$$;

create function private.paddle_stack_game_view(p_game private.paddle_stack_games)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_game.id, 'revision', p_game.revision, 'finished_at', p_game.finished_at,
    'team_a', count(*) filter (where point = 1), 'team_b', count(*) filter (where point = 2),
    'can_undo', cardinality(p_game.points) > 0,
    'players', (select jsonb_agg(p.name order by member.position)
      from unnest(p_game.players) with ordinality as member(id, position)
      join private.paddle_stack_players p on p.id = member.id)
  )
  from unnest(p_game.points) as point;
$$;

create function public.get_paddle_stack(p_session uuid, p_key uuid default null, p_staff boolean default false)
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
    'waiting', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.queue_number)
      from private.paddle_stack_players p where p.session_id = session.id and p.state = 'waiting'
        and session.closed_at is null and not expired), '[]'::jsonb),
    'resting', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.queue_number)
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

create function public.paddle_stack_manage(
  p_session uuid, p_action text, p_court int default null, p_player uuid default null,
  p_name text default null, p_expected uuid[] default null
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
      insert into private.paddle_stack_players(id, session_id, name) values (p_player, p_session, player_name);
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
      select array_agg(p.id order by p.queue_number) into next_players
        from (select id, queue_number from private.paddle_stack_players
          where session_id = p_session and state = 'waiting' order by queue_number limit 4) p;
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

create function public.paddle_stack_score(
  p_session uuid, p_game uuid, p_revision int, p_action text, p_key uuid default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  session private.paddle_stack_sessions%rowtype;
  game private.paddle_stack_games%rowtype;
  team smallint;
begin
  -- Check the capability before locking, then recheck after locking in case
  -- staff revoked or rotated the link while this request was waiting.
  select * into game from private.paddle_stack_games where id = p_game and session_id = p_session;
  if not found or not (public.is_club_staff() or exists (select 1 from private.paddle_stack_courts c
    where c.session_id = p_session and c.court_id = game.court_id and c.score_key = p_key)) then
    raise exception 'Paddle Stack: A valid scorekeeper link is required.';
  end if;
  select * into session from private.paddle_stack_sessions where id = p_session for update;
  if session.closed_at is not null or now() >= private.paddle_stack_time(session.play_date, session.end_hour + 2) then
    raise exception 'Paddle Stack: This session is closed.';
  end if;
  if not public.is_club_staff() and not exists (select 1 from private.paddle_stack_courts c
    where c.session_id = p_session and c.court_id = game.court_id and c.score_key = p_key) then
    raise exception 'Paddle Stack: This scorekeeper link has expired.';
  end if;
  select * into game from private.paddle_stack_games where id = p_game and session_id = p_session;
  if game.finished_at is not null or game.revision is distinct from p_revision then
    raise exception 'Paddle Stack: The game changed. Check the latest score before trying again.';
  end if;
  case p_action
    when 'point_a', 'point_b' then
      team := case when p_action = 'point_a' then 1 else 2 end;
      if cardinality(array_positions(game.points, team)) >= 99 then
        raise exception 'Paddle Stack: The maximum score is 99.';
      end if;
      update private.paddle_stack_games set points = array_append(points, team), revision = revision + 1 where id = p_game;
    when 'undo' then
      if cardinality(game.points) = 0 then raise exception 'Paddle Stack: There is no point to undo.'; end if;
      update private.paddle_stack_games set points = points[1:cardinality(points)-1], revision = revision + 1 where id = p_game;
    when 'finish' then
      update private.paddle_stack_games set finished_at = now(), revision = revision + 1 where id = p_game;
      update private.paddle_stack_players set state = 'resting' where id = any(game.players);
    else
      raise exception 'Paddle Stack: Choose a valid scoring action.';
  end case;
end;
$$;

revoke all on function private.paddle_stack_time(date,int),
  private.paddle_stack_game_view(private.paddle_stack_games) from public, anon, authenticated;
revoke all on function public.paddle_stack_sessions(), public.paddle_stack_open(int,int),
  public.paddle_stack_manage(uuid,text,int,uuid,text,uuid[]), public.get_paddle_stack(uuid,uuid,boolean),
  public.paddle_stack_score(uuid,uuid,int,text,uuid) from public, anon, authenticated;
grant execute on function public.paddle_stack_sessions(), public.paddle_stack_open(int,int),
  public.paddle_stack_manage(uuid,text,int,uuid,text,uuid[]) to authenticated;
grant execute on function public.get_paddle_stack(uuid,uuid,boolean),
  public.paddle_stack_score(uuid,uuid,int,text,uuid) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
