begin;

create or replace function public.paddle_stack_score(
  p_session uuid, p_game uuid, p_revision int, p_action text, p_key uuid default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  session private.paddle_stack_sessions%rowtype;
  game private.paddle_stack_games%rowtype;
  team smallint;
  player_id uuid;
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
      -- The session lock keeps this group behind anyone already waiting.
      -- Retain the players' original queue order even if teams were rearranged.
      for player_id in
        select id from private.paddle_stack_players
        where session_id = p_session and state = 'playing' and id = any(game.players)
        order by queue_number, id
      loop
        update private.paddle_stack_players
          set state = 'waiting', queue_number = nextval('private.paddle_stack_queue_number')
          where id = player_id;
      end loop;
    else
      raise exception 'Paddle Stack: Choose a valid scoring action.';
  end case;
end;
$$;

notify pgrst, 'reload schema';
commit;
