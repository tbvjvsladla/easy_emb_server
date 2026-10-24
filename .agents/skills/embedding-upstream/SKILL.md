---
name: embedding-upstream
description: "Choose and build TEI or sentence-transformers container recipes for the observed host; diagnose build failures and preserve reusable build evidence."
---

# 임베딩 런타임 업스트림

공식 소스·컨테이너 recipe·빌드·실패 근거를 소유한다. [공통 게이트 계약](../../../rules/harness.md)을 따른다.


실행 진입점은 [src/cli.ts](src/cli.ts)의 `prepare`, `check`, `build`다. 공식 소스·의존성 고정은 [src/upstream.ts](src/upstream.ts), native Dockerfile·설치 입력 생성은 [src/recipes.ts](src/recipes.ts), 이미지 빌드·검증은 [src/build.ts](src/build.ts)가 소유한다. `build --strategy`는 explorer의 승인·attempt 준비 API를 거친다.

1. wiki-desk에서 같은 HW/엔진/실패의 원문을 조회하고 manifest와 승인 전략을 읽는다.
2. 개발 준비에서 `node .agents/skills/embedding-upstream/src/cli.ts prepare --manifest manifest.yaml`로 공식 최신 안정 TEI/ST와 소스 commit·이미지 digest·의존성 해시를 `output/host/upstream-lock.json`에 고정한다. `check --lock <파일>`로 검사한다. 최종 평가 중에는 prepare를 다시 실행하지 않는다.
3. 단일 작업은 `node .agents/skills/embedding-upstream/src/cli.ts build --strategy <영수증> --release-lock <lock>`을 실행한다. 캠페인 소유 작업은 explorer의 `node .agents/skills/embedding-explorer/src/cli.ts campaign status → step/run`으로 진행한다.
4. 실패 원문·가설·실제 변경 또는 새 관측을 기록하고 [복구 게이트](references/gates.md)에 따라 유한 재시도한다.
5. 빌드한 attempt를 explorer에 전달한다. 빌드/import 성공은 서빙 PASS가 아니다.

선택 장치에서 TEI를 우선하며 불가/실패 근거가 있으면 같은 장치의 ST로 전환한다. 컨테이너 내부 TEI Rust, ST/PyTorch·API Python은 유지한다. 생성물과 실제 적용 패치는 비추적 output에 보존한다. 다른 프로젝트 자산·전역 Docker 캐시는 정리하지 않는다.
