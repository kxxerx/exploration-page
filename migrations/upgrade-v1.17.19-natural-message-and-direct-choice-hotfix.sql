-- v1.17.19
-- 필수 적용 SQL
-- 목적:
-- 1) advance_exploration_room RPC가 더 이상 "님이 선택했습니다:" 문구를 저장하지 않도록 수정
-- 2) 선택지 로그를 가능한 한 자연문으로 저장

create or replace function public.exploration_natural_choice_action(p_choice_label text)
returns text
language plpgsql
immutable
as $$
declare
  v_label text := coalesce(nullif(trim(p_choice_label), ''), '다음 진행');
  v_text text;
  v_compact text;
  v_item text;
begin
  v_text := regexp_replace(v_label, '^\s*\[[^\]]+\s*전용\]\s*', '');
  v_text := regexp_replace(v_text, '^\s*\[[^\]]+\]\s*', '');
  v_text := regexp_replace(v_text, '[\.。\s]+$', '');
  v_text := replace(v_text, '마스코트 골든', '마스코트 골튼');
  v_text := replace(v_text, '골든 리조트', '골튼 리조트');
  v_compact := regexp_replace(v_text, '\s+', '', 'g');

  if v_compact = '테스트진행코드입력' then
    return '테스트 진행 코드를 입력했습니다.';
  elsif v_compact in ('녹슨입간판걷어차기', '녹슨입간판을걷어찬다') then
    return '녹슨 입간판을 걷어찼습니다.';
  elsif v_compact in ('쓰레기수거함을뒤진다', '쓰레기통을뒤진다') then
    return '쓰레기 수거함을 뒤졌습니다.';
  elsif v_compact = '쓰레기통을걷어찬다' then
    return '쓰레기통을 걷어찼습니다.';
  end if;

  if v_text ~ '^\[?(.+?)\]?을\(를\)\s*획득한다$' then
    v_item := regexp_replace(v_text, '^\[?(.+?)\]?을\(를\)\s*획득한다$', '\1');
    if v_item = '낡고 이상한 동전' then
      return '낡고 이상한 동전을 주웠습니다.';
    end if;
    return v_item || '을(를) 얻었습니다.';
  end if;

  if v_text ~ '을\s*산다$' then
    return regexp_replace(v_text, '을\s*산다$', '을 샀습니다.');
  elsif v_text ~ '를\s*산다$' then
    return regexp_replace(v_text, '를\s*산다$', '를 샀습니다.');
  elsif v_text ~ '으로\s*향한다$' then
    return regexp_replace(v_text, '으로\s*향한다$', '으로 향했습니다.');
  elsif v_text ~ '로\s*향한다$' then
    return regexp_replace(v_text, '로\s*향한다$', '로 향했습니다.');
  elsif v_text ~ '으로\s*들어간다$' then
    return regexp_replace(v_text, '으로\s*들어간다$', '으로 들어갔습니다.');
  elsif v_text ~ '로\s*들어간다$' then
    return regexp_replace(v_text, '로\s*들어간다$', '로 들어갔습니다.');
  elsif v_text ~ '으로\s*진입한다$' then
    return regexp_replace(v_text, '으로\s*진입한다$', '으로 진입했습니다.');
  elsif v_text ~ '로\s*진입한다$' then
    return regexp_replace(v_text, '로\s*진입한다$', '로 진입했습니다.');
  elsif v_text ~ '사용한다$' then
    return regexp_replace(v_text, '사용한다$', '사용했습니다.');
  elsif v_text ~ '도망간다$' then
    return regexp_replace(v_text, '도망간다$', '도망쳤습니다.');
  elsif v_text ~ '시도한다$' then
    return regexp_replace(v_text, '시도한다$', '시도했습니다.');
  elsif v_text ~ '살핀다$' then
    return regexp_replace(v_text, '살핀다$', '살폈습니다.');
  elsif v_text ~ '뒤진다$' then
    return regexp_replace(v_text, '뒤진다$', '뒤졌습니다.');
  elsif v_text ~ '걷어찬다$' then
    return regexp_replace(v_text, '걷어찬다$', '걷어찼습니다.');
  elsif v_text ~ '획득한다$' then
    return regexp_replace(v_text, '획득한다$', '얻었습니다.');
  elsif v_text ~ '한다$' then
    return regexp_replace(v_text, '한다$', '했습니다.');
  end if;

  return v_text || case when v_text ~ '[.!?]$' then '' else '했습니다.' end;
end;
$$;

create or replace function public.advance_exploration_room(
  p_room_id uuid,
  p_next_section_key text,
  p_choice_label text default null,
  p_state_patch jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.exploration_room_members;
  v_room public.exploration_rooms;
  v_actor text;
  v_label text;
  v_action text;
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다.';
  end if;

  select * into v_member
  from public.exploration_room_members
  where room_id = p_room_id
    and user_id = auth.uid()
    and left_at is null;

  if v_member.room_id is null then
    raise exception '탐사방 참가자만 진행할 수 있습니다.';
  end if;

  select * into v_room
  from public.exploration_rooms
  where id = p_room_id
  for update;

  if v_room.id is null then
    raise exception '탐사방을 찾을 수 없습니다.';
  end if;

  if v_room.status = 'ended' then
    raise exception '이미 종료된 탐사방입니다.';
  end if;

  if nullif(trim(p_next_section_key), '') is null then
    raise exception '다음 섹션이 비어 있습니다.';
  end if;

  update public.exploration_rooms
  set status = case when status = 'waiting' then 'playing' else status end,
      started_at = case when started_at is null then now() else started_at end
  where id = p_room_id;

  update public.exploration_room_state
  set current_section_key = trim(p_next_section_key),
      state_json = coalesce(state_json, '{}'::jsonb) || coalesce(p_state_patch, '{}'::jsonb),
      updated_by = auth.uid(),
      updated_at = now()
  where room_id = p_room_id;

  v_actor := coalesce(nullif(trim(v_member.display_name_snapshot), ''), '탐사자');
  v_actor := regexp_replace(v_actor, '\s*님$', '');
  v_label := coalesce(nullif(trim(p_choice_label), ''), trim(p_next_section_key));
  v_action := public.exploration_natural_choice_action(v_label);

  insert into public.exploration_room_messages (
    room_id,
    sender_id,
    sender_display_name,
    message_type,
    content
  ) values (
    p_room_id,
    auth.uid(),
    '시스템',
    'system',
    v_actor || '님이 ' || v_action
  );

  return jsonb_build_object('ok', true, 'room_id', p_room_id, 'current_section_key', trim(p_next_section_key));
end;
$$;

grant execute on function public.exploration_natural_choice_action(text) to authenticated;
grant execute on function public.advance_exploration_room(uuid, text, text, jsonb) to authenticated;
