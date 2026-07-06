# 사회자 브라운의 탐사 라운지 v0.4

이 패키지는 기존 상점 홈페이지에 덮어쓰는 패치가 아니라, 새 GitHub Pages 저장소에 올리는 독립 탐사 홈페이지입니다.

## 핵심 구조

- 기존 상점 홈페이지: 그대로 유지
- 탐사 홈페이지: 새 GitHub 저장소에 별도 업로드
- Supabase DB/Auth: 기존 상점과 같은 프로젝트를 공유
- 프론트엔드 키: `SUPABASE_URL`, `SUPABASE_ANON_KEY`만 사용

절대 GitHub에 올리면 안 되는 값:

- service_role key
- DB password
- JWT secret
- GitHub token
- database connection string

## v0.4 변경점

- 관리자실처럼 보이던 대기실 UI를 제거하고, 탐사자용 라운지 UI로 재구성
- 붉은색/검정색/황금색/갈색 계열의 토크쇼 라운지 디자인 적용
- 상단 로고를 관람차 아이콘으로 변경, 클릭 시 첫 화면으로 이동
- 메뉴 구조 추가: 목록 / 파티 찾기 / 내 탐사방
- 방 만들기, 코드로 참여하기, 저장파일 이어하기를 팝업 모달로 변경
- 오른쪽 사이드 영역에 캐릭터 정보와 내 가방 표시
- 탐사자 정보는 캐릭터명, 밴드 닉네임, 유쾌주화만 표시
- 내 가방은 `inventories` + `items`를 조회해서 최대 6개 표시
- 시나리오 목록 카드 UI 추가
- 시나리오 이미지/섹션 이미지 표시를 지원하도록 구조 추가
- 저장파일 생성 쪽 JS 문법 오류 수정

## 이미지 넣는 법

시나리오 카드 이미지는 `scenarios/scenario-list.json`에 `coverImage`를 추가하면 표시됩니다.

```json
{
  "id": "mulmok-dragon-demo",
  "title": "물목 해안가: 탐사 데모",
  "description": "탐사 엔진 확인용 짧은 데모 시나리오입니다.",
  "status": "published",
  "file": "mulmok-dragon-demo.json",
  "version": "0.1.0",
  "coverImage": "images/mulmok-cover.jpg"
}
```

섹션별 이미지는 시나리오 JSON의 각 섹션에 `image` 값을 넣으면 표시됩니다.

```json
"intro": {
  "title": "물목 해안가 입구",
  "image": "images/mulmok-intro.jpg",
  "commonText": "..."
}
```

이미지를 쓰려면 새 홈페이지 저장소에 `images` 폴더를 만들고 이미지 파일을 올리면 됩니다.

## 설치 순서

1. 이 ZIP을 압축 해제합니다.
2. GitHub에서 새 repository를 만듭니다.
3. 압축 해제한 파일과 폴더를 새 repository 루트에 업로드합니다.
4. `js/config.js`에 기존 상점과 같은 Supabase URL / anon key를 입력합니다.
5. Supabase SQL Editor에서 `migrations/upgrade-v5.8-exploration-rooms.sql`을 실행합니다. 이미 실행했다면 다시 실행하지 않아도 됩니다.
6. GitHub Pages를 `main / root`로 켭니다.
7. 새 Pages 주소에 접속합니다.
8. 기존 상점 아이디/비밀번호로 로그인합니다.

## 아직 미구현

- 파티 찾기 실제 DB 기능
- 엔딩 후 오염도/주화 자동 정산
- 아이템 사용 연동
- 귓속말
- 주사위
- 방 종료/삭제 UI
- 저장파일 위변조 방지
