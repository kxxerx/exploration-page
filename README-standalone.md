# 심야 괴담 탐사회 standalone v0.5

이 버전은 기존 `pollution-exploration-standalone-v0.4`의 UI 문제를 고친 standalone 탐사 홈페이지용 패치입니다.

## v0.5에서 고친 것

- 글꼴을 과한 serif 계열에서 시스템 고딕 계열로 변경했습니다.
- 상단 구조를 `로고 → 메뉴 → 탐사창` 순서로 정리했습니다.
- 로고는 관람차 아이콘 형태이며, 클릭하면 첫 화면으로 돌아갑니다.
- 로그인 상태에서 로그인창이 계속 보이지 않도록 상태 전환 로직을 정리했습니다.
- `ON AIR`는 접속/로그인 직후 잠깐 뜨고 사라지는 토스트형 연출로 바꿨습니다.
- 과한 히어로 문구와 `사회자 브라운의 탐사 라운지` 문구를 제거했습니다.
- 탐사방 입장 시 화면 아래쪽이 아니라 메인 탐사창으로 바로 전환되도록 했습니다.
- 탐사방에서 `라운지로 나가기`를 누르면 다시 목록 화면으로 돌아갑니다.
- 오른쪽에는 캐릭터명, 밴드 닉네임, 유쾌주화, 가방, 방 만들기/참여 버튼만 남겼습니다.
- 시나리오 이미지는 `scenario-list.json`의 `coverImage`, 시나리오 JSON 섹션의 `image` 값으로 띄울 수 있습니다.

## 적용 방법

기존 새 탐사 홈페이지 저장소에 아래 파일을 덮어쓰세요.

```text
index.html
exploration.html
css/exploration.css
js/exploration.js
README-standalone.md
```

`js/config.js`는 덮어쓰지 마세요. 이미 넣어둔 기존 Supabase URL / anon key가 날아갈 수 있습니다.

## DB / SQL

이번 v0.5는 UI와 프론트 상태 처리 수정입니다.  
v0.3에서 `migrations/upgrade-v5.8-exploration-rooms.sql`을 이미 실행했다면 SQL을 다시 실행할 필요 없습니다.

## 여전히 같은 원칙

- 기존 상점 홈페이지와 파일은 분리합니다.
- 같은 Supabase 프로젝트만 공유합니다.
- 프론트엔드에는 `SUPABASE_URL`, `SUPABASE_ANON_KEY`만 둡니다.
- `service_role key`, DB password, JWT secret은 절대 넣지 않습니다.
