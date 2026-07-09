# v1.17.36 - VIP 진행 제안 메시지 핫픽스

- VIP손님 전용 휴게실 이동은 진행 제안/수락 흐름으로 처리되도록 수정했습니다.
- 모두 수락 시 `모든 참가자가 VIP손님 전용 휴게실로 향하기로 했습니다.`만 보이도록 보정했습니다.
- 돌발상황 거절 시 `VIP손님 전용 휴게실로 안내된다했습니다`류의 이상한 시스템 메시지가 표시되지 않도록 숨김/생성 방지했습니다.
- standalone에는 `migrations/upgrade-v1.17.36-vip-proposal-message-hotfix.sql`이 포함되어 있습니다. deploy-only에는 migrations 폴더를 포함하지 않습니다.

# pollution-exploration v1.17.30-danger-response-messages-right-actions

## 적용 순서
1. `pollution-exploration-deploy-only-v1.17.30-danger-response-messages-right-actions
2. 압축을 푼 폴더 안의 내용물을 GitHub 저장소 `main` 브랜치 root에 업로드합니다.
   - ZIP 파일 자체를 올리면 안 됩니다.
3. Supabase SQL Editor에서 아래 SQL 파일 내용을 전체 실행합니다.
   - `migrations/upgrade-v1.17.30-danger-response-messages-right-actions
   - `migrations/upgrade-v1.17.30-danger-response-messages-right-actions
   - `migrations/upgrade-v1.17.30-danger-response-messages-right-actions
4. 이미 v1.17.30-danger-response-messages-right-actions
5. 브라우저에서 `Ctrl + F5`로 강제 새로고침합니다.

## v1.17.30-danger-response-messages-right-actions
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
- v1.17.30-danger-response-messages-right-actions
- SQL을 실행하지 않으면 VIP 카드가 DB에 지속 저장/복원되지 않고, 관리자 삭제 버튼도 동작하지 않습니다.
- 상점 오염도 연계는 기존 v1.17.30-danger-response-messages-right-actions

## 이전 유지 사항
- v1.17.30-danger-response-messages-right-actions
- v1.17.30-danger-response-messages-right-actions


## v1.17.30-danger-response-messages-right-actions
- 가이드 2페이지 선택지 동의 설명을 최신 즉시 선택지 안내 문구로 교체했습니다.
- 가이드 카드의 개별 소제목을 제거했습니다.
- 새 SQL 실행은 필요 없습니다.


## v1.17.30-danger-response-messages-right-actions
- 로그인하지 않은 상태에서는 상단 안내 카드(회원만 보실 수 있습니다)를 숨기고, 메뉴 아래에 방 목록 안내가 바로 보이도록 정리했습니다.
- 로그인 전 오른쪽 사이드에는 로그인 창만 표시되도록 수정했습니다. 내 가방, 라운지 데스크, 탐사방 만들기/참여/이어하기 버튼은 로그인 후에만 보입니다.
- 가이드 2페이지 선택지 동의 안내 문구는 v1.17.30-danger-response-messages-right-actions


## v1.17.30-danger-response-messages-right-actions
- 시스템 메시지/팝업 표시에서 참가자명 뒤 `님`을 일괄 보정합니다.
- 섹션 5-1에서 구매 후 `물건을 사지 않고 시계탑 광장으로 향한다` 선택 시 빨간 이탤릭 경고 팝업을 15초 표시하고 섹션 6-1로 강제 이동합니다.
- 돌발상황 진행 제안 팝업을 붉은 경고 스타일로 강화하고 수락/거절 버튼을 오른쪽 정렬했습니다.
- 돌발상황 거절 시 VIP실 섹션으로 이동하도록 프론트 처리했습니다.
- 이번 버전에서 새 SQL은 없습니다. 단, v1.17.30-danger-response-messages-right-actions


## v1.17.30-danger-response-messages-right-actions
- 시스템 메시지 표시 단계에서 캐릭터명 뒤 `님`이 누락되는 잔여 문구를 보정했습니다.
- 섹션 5-1 구매 후 퇴장 선택지의 15초 자동 팝업/섹션 6 이동 흐름을 유지했습니다.
- 돌발상황 진행 제안 팝업을 빨간 긴급 경고 스타일로 유지하고, 거절 시 VIP실로 이동하도록 처리했습니다.
- 가이드 2페이지 선택지 동의 문구를 요청 문장으로 조정했습니다.


## v1.17.30-danger-response-messages-right-actions
- 시스템 메시지 표시 직전 보정으로 캐릭터명 뒤 `님` 누락을 한 번 더 막았습니다.
- 가이드 2페이지 선택지 동의 문구에서 효과 설명 괄호를 제거하고, `별도 표시` 글자에만 효과를 유지했습니다.
- 섹션 5-1 구매 후 퇴장 경고 팝업과 돌발상황 경고 모달 스타일/거절 시 VIP실 이동 흐름을 유지했습니다.


## v1.17.30 변경
- 돌발상황 수락/거절 버튼 오른쪽 정렬 보강
- 혼자 도망 시도/수락/거절 시스템 메시지 문구 수정
- deploy-only 배포 ZIP에서는 migrations 폴더 제외


## v1.17.31 입장 메시지 중복 수정
- 방 입장 시스템 메시지는 DB/RPC에서 생성되는 1개만 사용합니다.
- 프론트에서 추가로 `입장했습니다` 로그를 쓰던 부분을 제거했습니다.
- deploy-only ZIP에는 migrations 폴더를 포함하지 않습니다.


## v1.17.33
- 입장 메시지 중복 표시를 프론트에서 한 번 더 제거했습니다.
- 입장 후 별도 토스트 알림을 제거해 채팅 입장 메시지와 겹쳐 보이지 않게 했습니다.
- 물건을 산 뒤 기념품샵을 나가려 하면 모든 참가자에게 경고 팝업을 띄우고 섹션 5-2로 이동하도록 수정했습니다.
- deploy-only에는 migrations 폴더를 포함하지 않았습니다.


## v1.17.35
- 시스템 메시지의 `님님` 중복 경칭 정규화 보강
- 섹션 5-1 구매 후 이탈 선택지는 진행 제안 수락 후 파티 전체 경고 팝업 표시
- 파티 찾기 모집 종료 배지 위치 및 제목 한 줄 표시 보정
- 익명 게시판 목록의 `게시 중` 배지 제거
- v1.17.37: 파티찾기 모집 종료 배지가 카드 전체 폭으로 늘어나는 문제를 수정하고 제목/상태 배지를 한 줄 정렬로 고정
