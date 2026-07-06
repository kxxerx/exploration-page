# 탐사 홈페이지 standalone v0.6

기존 `마스코트 골든의 기념품샵` 저장소에 덮어쓰는 파일이 아닙니다.  
새 GitHub Pages 저장소에 올리는 독립 탐사 홈페이지입니다.  
단, Supabase 프로젝트와 DB는 기존 상점과 같은 것을 사용합니다.

## v0.6 변경점

- 화면 콘셉트를 방송 송출/브라운관 TV/ON AIR 중심으로 정리했습니다.
- 접속 또는 로그인 직후 전체 화면 ON AIR 브라운관 연출이 나온 뒤 메인 화면이 표시됩니다.
- visible 로고 문구를 제거하고, 관람차 아이콘만 왼쪽에 배치했습니다.
- 기존 임시 명칭을 화면에서 제거했습니다.
- 메뉴는 로고 아래에 배치했습니다.
- 목록 탭은 시나리오 목록이 아니라 현재 탐사방 목록을 표시합니다.
- 공개방은 목록에서 바로 입장할 수 있습니다.
- 비공개방은 목록에 비활성화 상태로 표시되고, 초대코드 + 숫자 비밀번호로만 입장합니다.
- 인원이 가득 찬 방은 목록에서 비활성화됩니다.
- 방 만들기에서 공개/비공개를 선택할 수 있습니다.
- 비공개방 비밀번호는 숫자 1~8자리만 입력할 수 있습니다.
- 파티 찾기 탭에 익명 모집글 작성 버튼과 목록을 추가했습니다.
- 데스크탑에서는 오른쪽 캐릭터 정보/가방/라운지 데스크가 오른쪽에 고정되도록 유지했습니다.

## 업로드 방법

이미 v0.5를 적용한 탐사 홈페이지 저장소가 있다면 아래 파일을 덮어쓰세요.

```text
index.html
exploration.html
css/exploration.css
js/exploration.js
README-standalone.md
```

그리고 새 SQL 파일을 Supabase SQL Editor에서 1회 실행하세요.

```text
migrations/upgrade-v0.6-exploration-broadcast-ui.sql
```

`js/config.js`는 덮어쓰지 않는 편이 안전합니다.  
이미 네 Supabase URL / anon key가 들어있기 때문입니다.

## 새로 추가되는 DB 기능

`upgrade-v0.6-exploration-broadcast-ui.sql`은 기존 탐사방 테이블을 유지하면서 아래를 추가합니다.

```text
exploration_rooms.visibility
exploration_rooms.password_hash
exploration_rooms.updated_at
exploration_party_posts
```

그리고 아래 RPC를 추가/갱신합니다.

```text
list_exploration_rooms()
create_exploration_room(..., p_visibility, p_room_password)
join_exploration_room(p_invite_code, p_room_password)
join_exploration_room_by_id(p_room_id)
list_exploration_party_posts()
create_exploration_party_post(...)
```

## 보안 주의

프론트엔드와 GitHub에는 아래 두 값만 둡니다.

```text
SUPABASE_URL
SUPABASE_ANON_KEY
```

절대 넣으면 안 되는 값입니다.

```text
service_role key
DB password
JWT secret
GitHub token
database connection string
```

## 테스트 순서

1. GitHub에 v0.6 파일 덮어쓰기
2. `upgrade-v0.6-exploration-broadcast-ui.sql` 실행
3. 탐사 홈페이지 접속
4. ON AIR 전체화면 연출 확인
5. 기존 상점 아이디/비밀번호로 로그인
6. 현재 탐사방 목록 확인
7. 공개방 생성 후 목록에서 바로 입장 확인
8. 비공개방 생성 후 목록에서 비활성화되는지 확인
9. 비공개방은 초대코드 + 숫자 비밀번호로 입장되는지 확인
10. 인원 마감 방이 비활성화되는지 확인
11. 파티 찾기에서 익명 모집글 작성 확인

