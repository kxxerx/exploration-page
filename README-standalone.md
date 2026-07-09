# pollution-exploration v1.17.23-persistent-vip-card-flags

## 적용 순서
1. `pollution-exploration-deploy-only-v1.17.23-persistent-vip-card-flags.zip` 압축을 풉니다.
2. 압축을 푼 폴더 안의 내용물을 GitHub 저장소 `main` 브랜치 root에 업로드합니다.
   - ZIP 파일 자체를 올리면 안 됩니다.
3. Supabase SQL Editor에서 아래 SQL 파일 내용을 전체 실행합니다.
   - `migrations/upgrade-v1.17.19-natural-message-and-direct-choice-hotfix.sql`
   - `migrations/upgrade-v1.17.22-shop-code-settlement.sql`
   - `migrations/upgrade-v1.17.23-persistent-vip-card-flags.sql`
4. 이미 v1.17.19 / v1.17.22 SQL을 실행했다면 다시 실행하지 않아도 됩니다. v1.17.23 SQL은 새로 실행해야 합니다.
5. 브라우저에서 `Ctrl + F5`로 강제 새로고침합니다.

## v1.17.23 변경 사항
- VIP 멤버십 카드를 탐사방 임시 인벤토리만이 아니라 DB의 지속 플래그로 저장합니다.
- 저장 기준은 `사용자 ID + 캐릭터 키 + 시나리오 ID + 당시 파티 조합(user_id:character_key 목록)`입니다.
- 같은 사용자들이 같은 캐릭터로 같은 시나리오 방에 다시 모였을 때만 VIP 카드가 개인 소지창에 복원됩니다.
- 같은 캐릭터 조합이어도 사용자가 다르면 복원되지 않습니다.
- 같은 사용자라도 다른 캐릭터로 들어오면 복원되지 않습니다.
- 같은 사용자/캐릭터라도 파티 멤버 조합이 다르면 복원되지 않습니다.
- 5-2-A의 `DLBAD001` 엔딩에 도달하면 현재 활성 참가자 전체에게 VIP 카드 지속 플래그가 저장됩니다.
- 방 로딩 시 `restore_exploration_persistent_flags` RPC를 호출해 조건이 맞는 사람에게만 VIP 카드를 복원합니다.
- 관리자는 VIP 카드 상세창에서 `저주받은 VIP 카드 삭제` 버튼으로 현재 파티 조합의 지속 플래그와 현재 방의 VIP 카드를 제거할 수 있습니다.

## SQL 주의
- v1.17.23 기능은 SQL 실행이 필수입니다.
- SQL을 실행하지 않으면 VIP 카드가 DB에 지속 저장/복원되지 않고, 관리자 삭제 버튼도 동작하지 않습니다.
- 상점 오염도 연계는 기존 v1.17.22 SQL의 `settle_exploration_result`가 담당합니다.

## 이전 유지 사항
- v1.17.22: 탐사 엔딩 `resultCode`를 상점의 `event_codes.code`와 연결합니다.
- v1.17.21: 전용 선택지 노출 문구 제거, 마스코트 골튼의 기념품샵 황금빛 효과, 줄 간격 정리.


## v1.17.24 변경 사항
- 가이드 2페이지 선택지 동의 설명을 최신 즉시 선택지 안내 문구로 교체했습니다.
- 가이드 카드의 개별 소제목을 제거했습니다.
- 새 SQL 실행은 필요 없습니다.


## v1.17.25 로그인 전 탐사 라운지 정리
- 로그인하지 않은 상태에서는 상단 안내 카드(회원만 보실 수 있습니다)를 숨기고, 메뉴 아래에 방 목록 안내가 바로 보이도록 정리했습니다.
- 로그인 전 오른쪽 사이드에는 로그인 창만 표시되도록 수정했습니다. 내 가방, 라운지 데스크, 탐사방 만들기/참여/이어하기 버튼은 로그인 후에만 보입니다.
- 가이드 2페이지 선택지 동의 안내 문구는 v1.17.24 기준 문구를 유지합니다.
