# pollution-exploration v1.17.22-shop-code-settlement

## 적용 순서
1. `pollution-exploration-deploy-only-v1.17.22-shop-code-settlement.zip` 압축을 풉니다.
2. 압축을 푼 폴더 안의 내용물을 GitHub 저장소 `main` 브랜치 root에 업로드합니다.
   - ZIP 파일 자체를 올리면 안 됩니다.
3. Supabase SQL Editor에서 아래 SQL 파일 내용을 전체 실행합니다.
   - `migrations/upgrade-v1.17.19-natural-message-and-direct-choice-hotfix.sql`
   - `migrations/upgrade-v1.17.22-shop-code-settlement.sql`
4. 이미 v1.17.19 SQL을 실행했다면 v1.17.19는 다시 실행하지 않아도 됩니다. v1.17.22 SQL은 새로 실행해야 합니다.
5. 브라우저에서 `Ctrl + F5`로 강제 새로고침합니다.

## v1.17.22 변경 사항
- 탐사 엔딩 `resultCode`를 상점의 `event_codes.code`와 연결하는 `settle_exploration_result` RPC를 추가/교체했습니다.
- `DLBAD001` 같은 코드가 상점 DB의 `event_codes`에 등록되어 있고 `is_active = true`이면, 해당 코드의 효과가 엔딩 도달자에게 즉시 반영됩니다.
- 일반/오염자 계정은 `profiles.pollution`에 반영됩니다.
- 괴이 계정(`visitor_type = 'entity'`)은 `profiles.mask_collapse_rate`에 반영됩니다.
- `reward_currency`, `pollution_delta`, `reward_item_id`, `reward_item_quantity`도 상점 코드 기준으로 함께 반영됩니다.
- 같은 방에서 같은 사용자가 같은 결과 코드를 중복 정산하지 않도록 `exploration_result_settlements` 테이블을 추가했습니다.

## 상점 페이지 수정 여부
- 상점 페이지 파일 자체는 수정하지 않아도 됩니다.
- 단, 상점 DB의 `event_codes`에 `DLBAD001` 코드가 실제로 존재해야 하고, `pollution_delta` 값이 들어 있어야 합니다.
- 코드가 없으면 탐사 쪽은 `DLBAD001`을 넘기지만 상점 효과를 읽어올 수 없습니다.

## 이전 v1.17.21 유지 사항
- 선택지의 `[백일몽 전용]`, `[재난관리국 전용]`, `[초자연 재난관리국 전용]` 노출 문구 제거. 실제 소속 제한 조건은 유지됩니다.
- `[마스코트 골튼의 기념품샵]` 문구에 황금빛 효과 추가.
- 섹션 4-1/4-2의 “익숙한 마스코트의 모습”을 “마스코트로 보이는 모습”으로 수정.
- 녹슨 입간판 팝업 문구에 “그 중 가장 깨끗한 한 장을 챙기기로 합니다.” 추가.
- 섹션 5-2-A 본문을 한 줄씩 여백이 생기도록 정리.
