-- upgrade-v0.7-exploration-lobby-fixes.sql
-- 목적: v0.7 탐사 홈페이지용 수정
-- 1) gen_salt/crypt 의존 제거: 숫자 방 비밀번호는 md5(password || ':' || invite_code)로 저장/검증
-- 2) 목록에는 실제 활성 참가자가 있는 방만 표시
-- 3) 방장이 방 안에서 설정을 수정할 수 있게 함
-- 4) 나가기 시 마지막 참가자라면 방을 삭제하여 목록에서 사라지게 함
-- 전제: upgrade-v0.1-exploration-rooms.sql 및 upgrade-v0.6-exploration-broadcast-ui.sql 실행 완료

alter table public.exploration_rooms
add column if not exists visibility text not null default 'public';

alter table public.exploration_rooms
add column if not exists password_hash text;

alter table public.exploration_rooms
add column if not exists updated_at timestamptz not null default now();

create or replace function public.list_exploration_rooms()
returns table (
  id uuid,
  scenario_id text,
  title text,
  visibility text,
  max_players integer,
  current_players integer,
  status text,
  created_at timestamptz,
  is_member boolean,
  is_host boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with active_counts as (
    select room_id, count(*)::integer as current_players
    from public.exploration_room_members
    where left_at is null
    group by room_id
  )
  select
    r.id,
    r.scenario_id,
    r.title,
    coalesce(r.visibility, 'public') as visibility,
    r.max_players,
    coalesce(ac.current_players, 0)::integer as current_players,
    r.status,
    r.created_at,
    exists (
      select 1 from public.exploration_room_members my
      where my.room_id = r.id
        and my.user_id = auth.uid()
        and my.left_at is null
    ) as is_member,
    r.host_user_id = auth.uid() as is_host
  from public.exploration_rooms r
  join active_counts ac on ac.room_id = r.id
  where r.status <> 'ended'
    and ac.current_players > 0
  order by r.created_at desc;
$$;

grant execute on function public.list_exploration_rooms() to authenticated;

create or replace function public.create_exploration_room(
  p_scenario_id text,
  p_title text,
  p_max_players integer default 2,
  p_start_section_key text default 'intro',
  p_state_json jsonb default '{}'::jsonb,
  p_visibility text default 'public',
  p_room_password text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
  v_room public.exploration_rooms;
  v_invite_code text;
  v_try integer := 0;
  v_visibility text;
  v_password text;
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다.';
  end if;

  select * into v_profile
  from public.profiles
  where id = auth.uid();

  if v_profile.id is null then
    raise exception '프로필을 찾을 수 없습니다.';
  end if;

  if coalesce(v_profile.status, 'active') <> 'active' then
    raise exception '활성 상태의 계정만 탐사방을 만들 수 있습니다.';
  end if;

  if p_max_players is null or p_max_players < 1 or p_max_players > 4 then
    raise exception '최대 인원은 1~4명 사이여야 합니다.';
  end if;

  v_visibility := case when p_visibility = 'private' then 'private' else 'public' end;
  v_password := nullif(trim(coalesce(p_room_password, '')), '');

  if v_visibility = 'private' then
    if v_password is null or v_password !~ '^[0-9]{1,8}$' then
      raise exception '비공개방 비밀번호는 숫자 1~8자리로 입력하세요.';
    end if;
  end if;

  loop
    v_try := v_try + 1;
    v_invite_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists (select 1 from public.exploration_rooms where invite_code = v_invite_code);
    if v_try > 20 then
      raise exception '초대코드 생성에 실패했습니다.';
    end if;
  end loop;

  insert into public.exploration_rooms (
    scenario_id,
    title,
    host_user_id,
    invite_code,
    max_players,
    status,
    visibility,
    password_hash,
    updated_at
  ) values (
    coalesce(nullif(trim(p_scenario_id), ''), 'unknown'),
    coalesce(nullif(trim(p_title), ''), '이름 없는 탐사방'),
    auth.uid(),
    v_invite_code,
    p_max_players,
    'waiting',
    v_visibility,
    case when v_visibility = 'private' then md5(v_password || ':' || v_invite_code) else null end,
    now()
  ) returning * into v_room;

  insert into public.exploration_room_members (
    room_id,
    user_id,
    role,
    character_key_snapshot,
    display_name_snapshot,
    organization_code_snapshot,
    department_code_snapshot,
    affiliation_label_snapshot,
    visitor_type_snapshot,
    pollution_snapshot,
    mask_collapse_rate_snapshot
  ) values (
    v_room.id,
    auth.uid(),
    'host',
    v_profile.character_key,
    coalesce(nullif(trim(v_profile.display_name), ''), '익명'),
    coalesce(nullif(trim(v_profile.organization_code), ''), 'unaffiliated'),
    coalesce(nullif(trim(v_profile.department_code), ''), 'none'),
    coalesce(nullif(trim(v_profile.affiliation_label), ''), '무소속'),
    coalesce(nullif(trim(v_profile.visitor_type), ''), 'human'),
    coalesce(v_profile.pollution, 0),
    coalesce(v_profile.mask_collapse_rate, 0)
  );

  insert into public.exploration_room_state (
    room_id,
    current_section_key,
    state_json,
    updated_by
  ) values (
    v_room.id,
    coalesce(nullif(trim(p_start_section_key), ''), 'intro'),
    coalesce(p_state_json, '{}'::jsonb),
    auth.uid()
  );

  insert into public.exploration_room_messages (
    room_id,
    sender_id,
    sender_display_name,
    message_type,
    content
  ) values (
    v_room.id,
    auth.uid(),
    '시스템',
    'system',
    '탐사방이 생성되었습니다.'
  );

  return jsonb_build_object(
    'ok', true,
    'room_id', v_room.id,
    'invite_code', v_room.invite_code,
    'status', v_room.status,
    'visibility', v_room.visibility
  );
end;
$$;

grant execute on function public.create_exploration_room(text, text, integer, text, jsonb, text, text) to authenticated;

create or replace function public.join_exploration_room(
  p_invite_code text,
  p_room_password text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
  v_room public.exploration_rooms;
  v_password text;
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다.';
  end if;

  select * into v_profile from public.profiles where id = auth.uid();
  if v_profile.id is null then raise exception '프로필을 찾을 수 없습니다.'; end if;
  if coalesce(v_profile.status, 'active') <> 'active' then raise exception '활성 상태의 계정만 탐사방에 들어갈 수 있습니다.'; end if;

  select * into v_room
  from public.exploration_rooms
  where invite_code = upper(trim(p_invite_code))
  for update;

  if v_room.id is null then raise exception '초대코드가 올바르지 않습니다.'; end if;
  if v_room.status = 'ended' then raise exception '이미 종료된 탐사방입니다.'; end if;

  if coalesce(v_room.visibility, 'public') = 'private' then
    v_password := nullif(trim(coalesce(p_room_password, '')), '');
    if v_password is null or v_password !~ '^[0-9]{1,8}$' or v_room.password_hash is null or md5(v_password || ':' || v_room.invite_code) <> v_room.password_hash then
      raise exception '비공개방 비밀번호가 올바르지 않습니다.';
    end if;
  end if;

  return public.join_exploration_room_core(v_room, v_profile);
end;
$$;

grant execute on function public.join_exploration_room(text, text) to authenticated;

create or replace function public.update_exploration_room_settings(
  p_room_id uuid,
  p_title text,
  p_max_players integer,
  p_visibility text default 'public',
  p_room_password text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.exploration_rooms;
  v_active_count integer;
  v_visibility text;
  v_password text;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다.'; end if;

  select * into v_room
  from public.exploration_rooms
  where id = p_room_id
  for update;

  if v_room.id is null then raise exception '탐사방을 찾을 수 없습니다.'; end if;
  if v_room.host_user_id <> auth.uid() then raise exception '방장만 방 설정을 수정할 수 있습니다.'; end if;
  if v_room.status = 'ended' then raise exception '종료된 방은 수정할 수 없습니다.'; end if;

  select count(*) into v_active_count
  from public.exploration_room_members
  where room_id = p_room_id and left_at is null;

  if p_max_players is null or p_max_players < 1 or p_max_players > 4 then
    raise exception '최대 인원은 1~4명 사이여야 합니다.';
  end if;
  if p_max_players < v_active_count then
    raise exception '현재 참가자 수보다 최대 인원을 낮출 수 없습니다.';
  end if;

  v_visibility := case when p_visibility = 'private' then 'private' else 'public' end;
  v_password := nullif(trim(coalesce(p_room_password, '')), '');

  if v_visibility = 'private' then
    if v_password is not null and v_password !~ '^[0-9]{1,8}$' then
      raise exception '비공개방 비밀번호는 숫자 1~8자리로 입력하세요.';
    end if;
    if v_room.password_hash is null and v_password is null then
      raise exception '공개방을 비공개로 바꾸려면 숫자 비밀번호를 입력하세요.';
    end if;
  end if;

  update public.exploration_rooms
  set title = coalesce(nullif(trim(p_title), ''), title),
      max_players = p_max_players,
      visibility = v_visibility,
      password_hash = case
        when v_visibility = 'public' then null
        when v_password is not null then md5(v_password || ':' || invite_code)
        else password_hash
      end,
      updated_at = now()
  where id = p_room_id
  returning * into v_room;

  insert into public.exploration_room_messages (
    room_id, sender_id, sender_display_name, message_type, content
  ) values (
    p_room_id, auth.uid(), '시스템', 'system', '방 설정이 변경되었습니다.'
  );

  return jsonb_build_object('ok', true, 'room_id', v_room.id, 'visibility', v_room.visibility, 'max_players', v_room.max_players);
end;
$$;

grant execute on function public.update_exploration_room_settings(uuid, text, integer, text, text) to authenticated;

create or replace function public.leave_exploration_room(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.exploration_room_members;
  v_remaining integer;
  v_name text;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다.'; end if;

  select * into v_member
  from public.exploration_room_members
  where room_id = p_room_id
    and user_id = auth.uid()
  for update;

  if v_member.room_id is null then raise exception '참가 중인 탐사방이 아닙니다.'; end if;

  v_name := coalesce(nullif(trim(v_member.display_name_snapshot), ''), '익명');

  update public.exploration_room_members
  set left_at = now()
  where room_id = p_room_id
    and user_id = auth.uid();

  select count(*) into v_remaining
  from public.exploration_room_members
  where room_id = p_room_id
    and left_at is null;

  if v_remaining <= 0 then
    delete from public.exploration_rooms where id = p_room_id;
    return jsonb_build_object('ok', true, 'room_deleted', true);
  end if;

  insert into public.exploration_room_messages (
    room_id, sender_id, sender_display_name, message_type, content
  ) values (
    p_room_id, auth.uid(), '시스템', 'system', v_name || ' 님이 라운지로 나갔습니다.'
  );

  return jsonb_build_object('ok', true, 'room_deleted', false, 'remaining', v_remaining);
end;
$$;

grant execute on function public.leave_exploration_room(uuid) to authenticated;
