-- upgrade-v0.6-exploration-broadcast-ui.sql
-- 목적: standalone 탐사 홈페이지 v0.6용 공개/비공개 방, 숫자 비밀번호, 현재 탐사방 목록, 익명 파티 찾기를 추가한다.
-- 전제: upgrade-v5.8-exploration-rooms.sql 또는 upgrade-v0.1-exploration-rooms.sql 실행 완료.

create extension if not exists pgcrypto;

alter table public.exploration_rooms
add column if not exists visibility text not null default 'public';

alter table public.exploration_rooms
add column if not exists password_hash text;

alter table public.exploration_rooms
add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'exploration_rooms_visibility_check'
  ) then
    alter table public.exploration_rooms
    add constraint exploration_rooms_visibility_check
    check (visibility in ('public', 'private')) not valid;
    alter table public.exploration_rooms validate constraint exploration_rooms_visibility_check;
  end if;
end $$;

create index if not exists exploration_rooms_status_created_idx on public.exploration_rooms(status, created_at desc);
create index if not exists exploration_rooms_visibility_idx on public.exploration_rooms(visibility, status);

create table if not exists public.exploration_party_posts (
  id uuid primary key default gen_random_uuid(),
  creator_user_id uuid not null references public.profiles(id) on delete cascade,
  scenario_id text,
  title text not null,
  play_time text,
  content text,
  anonymous_name text not null default '익명 탐사자',
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists exploration_party_posts_status_created_idx on public.exploration_party_posts(status, created_at desc);
create index if not exists exploration_party_posts_creator_idx on public.exploration_party_posts(creator_user_id, created_at desc);

alter table public.exploration_party_posts enable row level security;

drop policy if exists "Authenticated users can read party posts" on public.exploration_party_posts;
create policy "Authenticated users can read party posts"
on public.exploration_party_posts
for select
to authenticated
using (true);

grant select on public.exploration_party_posts to authenticated;

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
  select
    r.id,
    r.scenario_id,
    r.title,
    coalesce(r.visibility, 'public') as visibility,
    r.max_players,
    coalesce(count(m.user_id) filter (where m.left_at is null), 0)::integer as current_players,
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
  left join public.exploration_room_members m on m.room_id = r.id
  where r.status <> 'ended'
  group by r.id
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
    case when v_visibility = 'private' then crypt(v_password, gen_salt('bf')) else null end,
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

create or replace function public.join_exploration_room_core(p_room public.exploration_rooms, p_profile public.profiles)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member_count integer;
  v_existing public.exploration_room_members;
begin
  select * into v_existing
  from public.exploration_room_members
  where room_id = p_room.id
    and user_id = auth.uid();

  if v_existing.room_id is not null then
    if v_existing.left_at is not null then
      update public.exploration_room_members
      set left_at = null,
          joined_at = now()
      where room_id = p_room.id
        and user_id = auth.uid();
    end if;

    return jsonb_build_object('ok', true, 'already_member', true, 'room_id', p_room.id, 'invite_code', p_room.invite_code);
  end if;

  select count(*) into v_member_count
  from public.exploration_room_members
  where room_id = p_room.id
    and left_at is null;

  if v_member_count >= p_room.max_players then
    raise exception '탐사방 인원이 가득 찼습니다.';
  end if;

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
    p_room.id,
    auth.uid(),
    'player',
    p_profile.character_key,
    coalesce(nullif(trim(p_profile.display_name), ''), '익명'),
    coalesce(nullif(trim(p_profile.organization_code), ''), 'unaffiliated'),
    coalesce(nullif(trim(p_profile.department_code), ''), 'none'),
    coalesce(nullif(trim(p_profile.affiliation_label), ''), '무소속'),
    coalesce(nullif(trim(p_profile.visitor_type), ''), 'human'),
    coalesce(p_profile.pollution, 0),
    coalesce(p_profile.mask_collapse_rate, 0)
  );

  insert into public.exploration_room_messages (
    room_id,
    sender_id,
    sender_display_name,
    message_type,
    content
  ) values (
    p_room.id,
    auth.uid(),
    '시스템',
    'system',
    coalesce(nullif(trim(p_profile.display_name), ''), '익명') || ' 님이 탐사방에 입장했습니다.'
  );

  return jsonb_build_object('ok', true, 'already_member', false, 'room_id', p_room.id, 'invite_code', p_room.invite_code);
end;
$$;

grant execute on function public.join_exploration_room_core(public.exploration_rooms, public.profiles) to authenticated;

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
    if v_password is null or v_room.password_hash is null or crypt(v_password, v_room.password_hash) <> v_room.password_hash then
      raise exception '비공개방 비밀번호가 올바르지 않습니다.';
    end if;
  end if;

  return public.join_exploration_room_core(v_room, v_profile);
end;
$$;

grant execute on function public.join_exploration_room(text, text) to authenticated;

create or replace function public.join_exploration_room_by_id(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
  v_room public.exploration_rooms;
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다.';
  end if;

  select * into v_profile from public.profiles where id = auth.uid();
  if v_profile.id is null then raise exception '프로필을 찾을 수 없습니다.'; end if;
  if coalesce(v_profile.status, 'active') <> 'active' then raise exception '활성 상태의 계정만 탐사방에 들어갈 수 있습니다.'; end if;

  select * into v_room
  from public.exploration_rooms
  where id = p_room_id
  for update;

  if v_room.id is null then raise exception '탐사방을 찾을 수 없습니다.'; end if;
  if v_room.status = 'ended' then raise exception '이미 종료된 탐사방입니다.'; end if;
  if coalesce(v_room.visibility, 'public') <> 'public' then raise exception '비공개방은 초대코드와 비밀번호로만 입장할 수 있습니다.'; end if;

  return public.join_exploration_room_core(v_room, v_profile);
end;
$$;

grant execute on function public.join_exploration_room_by_id(uuid) to authenticated;

create or replace function public.list_exploration_party_posts()
returns table (
  id uuid,
  scenario_id text,
  title text,
  play_time text,
  content text,
  anonymous_name text,
  status text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select id, scenario_id, title, play_time, content, anonymous_name, status, created_at
  from public.exploration_party_posts
  where status = 'open'
  order by created_at desc
  limit 80;
$$;

grant execute on function public.list_exploration_party_posts() to authenticated;

create or replace function public.create_exploration_party_post(
  p_title text,
  p_scenario_id text default null,
  p_play_time text default null,
  p_content text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
  v_title text;
  v_content text;
  v_post public.exploration_party_posts;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다.'; end if;
  select * into v_profile from public.profiles where id = auth.uid();
  if v_profile.id is null then raise exception '프로필을 찾을 수 없습니다.'; end if;
  if coalesce(v_profile.status, 'active') <> 'active' then raise exception '활성 상태의 계정만 모집글을 작성할 수 있습니다.'; end if;

  v_title := nullif(trim(coalesce(p_title, '')), '');
  v_content := nullif(trim(coalesce(p_content, '')), '');
  if v_title is null then raise exception '모집 제목을 입력하세요.'; end if;
  if length(v_title) > 80 then raise exception '모집 제목은 80자 이하로 입력하세요.'; end if;
  if v_content is not null and length(v_content) > 600 then raise exception '모집 내용은 600자 이하로 입력하세요.'; end if;

  insert into public.exploration_party_posts (
    creator_user_id,
    scenario_id,
    title,
    play_time,
    content,
    anonymous_name
  ) values (
    auth.uid(),
    nullif(trim(coalesce(p_scenario_id, '')), ''),
    v_title,
    nullif(trim(coalesce(p_play_time, '')), ''),
    v_content,
    '익명 탐사자'
  ) returning * into v_post;

  return jsonb_build_object('ok', true, 'post_id', v_post.id);
end;
$$;

grant execute on function public.create_exploration_party_post(text, text, text, text) to authenticated;
