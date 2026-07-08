# pollution-exploration standalone v1.17.8-no-scene-images

- SQL 실행 필요 없음.
- v1.17.7 기준에서 장면/섹션 이미지를 전부 제거한 패치입니다.
- `assets/scenes/` 폴더와 `dreamland-*.webp` 파일을 제거했습니다.
- `scenarios/disaster-001-pied-piper.json`에서 `coverImage`, 각 섹션의 `image`, `imagePrompt` 참조를 제거했습니다.
- GitHub에는 deploy-only ZIP의 압축을 푼 내용물만 main/root에 업로드하세요. ZIP 파일 자체를 올리면 안 됩니다. 인간이 압축 파일을 홈페이지라고 믿는 비극은 여기서 끝냅시다.
- standalone ZIP은 백업/전체 확인용이고, 실제 배포는 deploy-only ZIP을 쓰면 됩니다.
