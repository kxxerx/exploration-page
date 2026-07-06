# 탐사 홈페이지 standalone v0.8

이 ZIP은 기존 기념품샵 저장소에 덮어쓰는 파일이 아니라, 별도 GitHub Pages 저장소에 올리는 탐사 홈페이지 파일입니다. 기존 상점 홈페이지는 그대로 두고, 같은 Supabase 프로젝트만 공유합니다.

## v0.8 수정 사항

* 목록 탭의 불필요한 제목/설명 제거
* 목록 탭은 시나리오 목록이 아니라 현재 열린 탐사방 목록만 표시
* 새로고침 버튼을 원형 화살표 아이콘 버튼으로 변경
* 파티 찾기 탭의 제목/설명 제거
* 익명 모집 글쓰기 버튼 위치와 스타일 정리
* `function gen\_salt(unknown) does not exist` 오류 제거

  * v0.8 SQL은 `gen\_salt/crypt`를 쓰지 않고 `md5(password || ':' || invite\_code)` 방식으로 방 비밀번호를 저장/검증합니다.
* 방 안에서 방장이 방 제목, 최대 인원, 공개/비공개, 비밀번호를 수정할 수 있음
* 라운지로 나가기 시 확인창 표시
* 마지막 참가자가 나가면 방이 DB에서 삭제되어 목록에서 사라짐
* 참가자가 남아 있으면 방은 유지됨
* ON AIR 연출을 TV 노이즈가 먼저 나오고, 이후 빨간 네온 ON AIR가 뜨는 구조로 수정
* 갈색 계열 제거, 검정/붉은색/금색 중심으로 재정리
* 로고의 금색 원형 테두리 제거, 관람차 아이콘만 남김
* Pretendard 계열 웹폰트 적용

## 적용 방법

기존 탐사 홈페이지 저장소에 아래 파일을 덮어씁니다.

```text
index.html
exploration.html
css/exploration.css
js/exploration.js
README-standalone.md
```

그리고 Supabase SQL Editor에서 아래 SQL을 한 번 실행합니다.

```text
migrations/upgrade-v0.8-exploration-lobby-fixes.sql
```

## 주의

`js/config.js`는 덮어쓰지 마세요. 이미 기존 상점과 같은 Supabase URL / anon key가 들어있다면 그대로 둬야 합니다.

프론트엔드나 GitHub에 넣으면 안 되는 값:

```text
service\_role key
DB password
JWT secret
GitHub token
database connection string
```

## 테스트 순서

1. 파일 덮어쓰기
2. Supabase에서 `upgrade-v0.8-exploration-lobby-fixes.sql` 실행
3. 탐사 홈페이지 접속
4. TV 노이즈 → ON AIR 연출 확인
5. 로그인
6. 목록 탭에서 설명문 없이 방 목록만 뜨는지 확인
7. 공개방 만들기
8. 목록에서 공개방 입장 확인
9. 비공개방 만들기
10. 목록에서 비공개방이 비활성화되는지 확인
11. 코드 + 숫자 비밀번호로 비공개방 입장 확인
12. 방 안에서 방 설정 수정 확인
13. 라운지로 나가기 확인창 확인
14. 마지막 참가자가 나간 방이 목록에서 사라지는지 확인
15. 파티 찾기에서 익명 모집글 작성 확인



## v0.8 변경

* 나가기 안내 문구를 “방이 삭제됩니다” 기준으로 수정했습니다.
* ON AIR 전에 브라운관 채널 조정/노이즈 연출이 먼저 보이도록 강화했습니다.
* 갈색 기운을 제거하고 검정, 붉은색, 금색 중심의 현대적인 방송 UI로 다시 정리했습니다.
* 관람차 로고는 테두리 없이 아이콘만 남기는 방향을 유지했습니다.





deploy retry

