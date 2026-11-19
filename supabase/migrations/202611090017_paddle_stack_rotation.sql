begin;

create function public.paddle_stack_shuffle(p_session uuid, p_expected uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  session private.paddle_stack_sessions%rowtype;
  waiting_players uuid[];
  queue_numbers bigint[];
  shuffled_players uuid[];
begin
  perform private.pos_require_staff();
  select * into session from private.paddle_stack_sessions where id = p_session for update;
  if not found or session.closed_at is not null
     or clock_timestamp() >= private.paddle_stack_time(session.play_date, session.end_hour) then
    raise exception 'Paddle Stack: The waiting queue is closed.';
  end if;

  select coalesce(array_agg(p.id order by p.queue_number), '{}'::uuid[]), array_agg(p.queue_number order by p.queue_number)
    into waiting_players, queue_numbers
    from private.paddle_stack_players p where p.session_id = p_session and p.state = 'waiting';
  if waiting_players is distinct from p_expected then
    raise exception 'Paddle Stack: The queue changed. Review the current queue and try again.';
  end if;
  if cardinality(waiting_players) < 2 then
    raise exception 'Paddle Stack: At least two players must be waiting to shuffle the queue.';
  end if;

  -- Always change the order so replaying the same request cannot reshuffle the queue.
  loop
    select array_agg(player_id order by random()) into shuffled_players
      from unnest(waiting_players) as player_id;
    exit when shuffled_players <> waiting_players;
  end loop;

  update private.paddle_stack_players p set queue_number = shuffled.queue_number
    from unnest(shuffled_players, queue_numbers) as shuffled(id, queue_number)
    where p.id = shuffled.id and p.session_id = p_session and p.state = 'waiting';
end;
$$;

create function private.paddle_stack_pair_game()
returns trigger language plpgsql set search_path = '' as $$
declare
  teams uuid[];
begin
  -- The court call already locked the session and selected the next four.
  with player_history as (
    select player.id, player.position,
      case when player.id = any(game.players[1:2]) then game.players[1:2]
           else coalesce(game.players[3:4], '{}'::uuid[]) end as previous_team,
      case when player.id = any(game.players[1:2]) then score.result
           else -score.result end as last_result
    from unnest(new.players) with ordinality as player(id, position)
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
    (a.id = any(b.previous_team) or b.id = any(a.previous_team))::int
      + (c.id = any(d.previous_team) or d.id = any(c.previous_team))::int,
    abs(a.last_result + b.last_result - c.last_result - d.last_result),
    random()
  limit 1;

  new.players := teams;
  return new;
end;
$$;

create trigger paddle_stack_pair_game before insert on private.paddle_stack_games
  for each row execute function private.paddle_stack_pair_game();

revoke all on function private.paddle_stack_pair_game(), public.paddle_stack_shuffle(uuid,uuid[])
  from public, anon, authenticated;
grant execute on function public.paddle_stack_shuffle(uuid,uuid[]) to authenticated;

notify pgrst, 'reload schema';
commit;
