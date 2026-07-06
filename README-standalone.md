# 탐사 홈페이지 standalone v0.3

이 패키지는 기존 `마스코트 골든의 기념품샵` 저장소에 덮어씌우는 패치가 아닙니다.
새 GitHub Pages 저장소에 그대로 올리는 별도 탐사 홈페이지입니다.

기존 상점과 공유하는 것은 파일이 아니라 Supabase 프로젝트/DB입니다.

```text
상점 홈페이지 GitHub 저장소 1개
탐사 홈페이지 GitHub 저장소 1개
Supabase 프로젝트는 동일하게 공유
```

## 1. 포함 파일

```text
index.html
exploration.html
css/exploration.css
js/config.js
js/config.example.js
js/supabaseClient.js
js/common.js
js/exploration.js
scenarios/scenario-list.json
scenarios/mulmok-dragon-demo.json
migrations/upgrade-v5.8-exploration-rooms.sql
README-standalone.md
```

`exploration.html`은 기존 설명과의 호환용 이동 파일입니다. 실제 메인 페이지는 `index.html`입니다.

## 2. 절대 상점 저장소에 덮어쓰지 말 것

이 패키지는 새 저장소용입니다.

기존 상점 저장소에 이 파일들을 그대로 덮어쓰면 `index.html`, `css`, `js` 구조가 섞일 수 있습니다.
상점 페이지는 기존 저장소에 그대로 두고, 탐사 페이지는 새 저장소를 만들어 올리세요.

예시:

```text
기존 상점:
https://계정.github.io/pollution-shop/

새 탐사:
https://계정.github.io/pollution-exploration/
```

## 3. Supabase 설정

새 탐사 저장소의 `js/config.js`를 열고 기존 상점의 `js/config.js`와 같은 값을 넣으세요.

```js
export const SUPABASE_URL = "기존 상점과 같은 값";
export const SUPABASE_ANON_KEY = "기존 상점과 같은 값";
```

프론트엔드에 넣어도 되는 것은 이 두 개뿐입니다.

절대 넣으면 안 되는 것:

```text
service_role key
DB password
JWT secret
GitHub token
database connection string
```

## 4. Supabase SQL 적용

Supabase SQL Editor에서 아래 파일을 실행하세요.

```text
migrations/upgrade-v5.8-exploration-rooms.sql
```

전제:

```text
기존 상점 DB가 이미 v5.8 패치까지 적용되어 있어야 합니다.
profiles.character_key
profiles.organization_code
profiles.department_code
profiles.affiliation_label
관련 character_presets 패치가 이미 존재해야 합니다.
```

이 SQL은 탐사방용 테이블과 RPC를 추가합니다.

```text
exploration_rooms
exploration_room_members
exploration_room_state
exploration_room_messages
```

## 5. GitHub Pages 새 홈페이지 만들기

1. GitHub에서 새 repository를 만듭니다.
2. 예: `pollution-exploration`
3. 이 ZIP 안의 파일을 새 repository 루트에 업로드합니다.
4. `js/config.js` 값을 기존 상점과 같은 Supabase URL/anon key로 수정합니다.
5. Settings > Pages에서 GitHub Pages를 켭니다.
6. 배포 URL로 접속합니다.

## 6. 로그인 방식

기존 상점과 동일합니다.

사용자가 입력한 아이디는 내부적으로 아래 이메일로 바뀝니다.

```js
`${site_id}@pollution.invalid`
```

그 이메일과 비밀번호로 Supabase Auth email/password 로그인을 수행합니다.

로그인 후 현재 사용자 정보는 `profiles.id = session.user.id` 기준으로 읽습니다.

## 7. 탐사 페이지 기능

현재 포함된 기능:

```text
- 기존 기념품샵 아이디/비밀번호 로그인
- profiles 정보 조회
- 캐릭터명/소속/팀/상태/오염도/동기화/주화 표시
- 초대코드 방 만들기
- 초대코드 방 입장
- 방 참가자 표시
- 방 채팅
- 한 사람이 선택지를 누르면 같은 방 참가자 화면도 같은 섹션으로 이동
- 소속/팀/방문객 상태/캐릭터 키 조건부 본문 표시
- 조건부 선택지 표시
- 저장파일 다운로드
- 저장파일 업로드로 이어하기 방 생성
- 채팅 로그 txt 다운로드
- 방장 채팅 초기화
```

아직 포함하지 않은 기능:

```text
- 엔딩 후 주화/오염도 자동 정산
- 아이템 사용 연동
- 익명 구인
- 귓속말
- 주사위
- 저장파일 위변조 방지
- 방 종료/삭제 UI
```

## 8. 시나리오 추가 방법

시나리오는 홈페이지 코드에 박지 않고 JSON으로 관리합니다.

```text
scenarios/scenario-list.json
scenarios/mulmok-dragon-demo.json
```

새 시나리오를 추가하려면:

1. `scenarios/새시나리오.json` 파일을 만듭니다.
2. `scenario-list.json`에 항목을 추가합니다.
3. `index.html`과 `js/exploration.js`는 수정하지 않는 것을 원칙으로 합니다.

홈페이지는 엔진이고, 시나리오는 데이터입니다.
이 구조를 깨면 새 시나리오 추가 때마다 사이트가 찢어집니다.

## 9. 테스트 순서

```text
1. SQL 실행
2. 새 GitHub 저장소에 파일 업로드
3. js/config.js 값 수정
4. GitHub Pages 켜기
5. index.html 접속
6. 기존 상점 아이디/비밀번호로 로그인
7. 프로필 정보가 보이는지 확인
8. 방 만들기
9. 초대코드 복사
10. 다른 계정/다른 브라우저로 입장
11. 한쪽에서 선택지 클릭
12. 다른 쪽 화면도 이동하는지 확인
13. 채팅 전송 확인
14. 저장파일/채팅 다운로드 확인
```

## 10. 주의

이 사이트는 같은 Supabase DB를 사용합니다.
즉 탐사 홈페이지에서 만든 탐사방/채팅 테이블은 기존 상점 DB 안에 추가됩니다.
하지만 상점 GitHub 파일을 수정하지는 않습니다.

파일은 분리, DB는 공유입니다.
