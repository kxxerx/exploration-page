# 탐사 홈페이지 standalone v1.0

## 이번 버전

- 익명 파티 모집글 상세 보기 추가
- 익명 댓글/Q&A 기능 추가
- 모집글 작성자/댓글 작성자 권한 처리
- 모집글 기반 방 만들기 후 `모집 완료` 상태 표시
- 모집 완료 후 2일이 지나면 목록 정리 시 자동 삭제
- 페이지 이탈 시 탐사방에서 나가는 best-effort 처리 추가
- `재난 001호: 잔혹동화 - 피리 부는 사나이` 테스트 시나리오 추가
- 기존 물목 해안가 데모 시나리오는 scenario-list에서 제외

## GitHub 업로드

GitHub Pages에는 `deploy-only` ZIP만 올리는 것을 권장합니다.

업로드 대상:

```text
index.html
exploration.html
.nojekyll
css/
js/
scenarios/
```

이미 `js/config.js`에 Supabase URL / anon key를 넣어두었다면 덮어쓰지 마세요.

## Supabase SQL

Supabase SQL Editor에서 아래 파일을 한 번 실행하세요.

```text
migrations/upgrade-v1.0-party-comments-and-cleanup.sql
```

v0.9 SQL까지 적용되어 있어야 합니다.

## 주의

- 댓글은 화면상 익명으로 표시되지만 DB 내부에는 user_id가 저장됩니다.
- 모집 완료 글은 바로 삭제되지 않고 2일 동안 `모집 완료`로 표시됩니다.
- 2일이 지난 모집 완료 글은 파티 목록을 불러올 때 정리됩니다.
- 방에 들어간 상태로 페이지를 벗어나면 탐사방에서 나간 것으로 처리될 수 있습니다.
- 마지막 참가자가 나가면 방이 삭제될 수 있으므로 저장파일을 먼저 내려받으세요.
