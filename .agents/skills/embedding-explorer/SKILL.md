---
name: embedding-explorer
description: "Inspect an embedding model, collect device/context/dimension HITL choices, generate its serving assets, and run TEI-first or sentence-transformers fallback."
---

# 임베딩 모델 서빙

모델 프로필·HITL·실효 설정·기동과 런타임 조정을 소유한다. [공통 게이트 계약](../../../rules/harness.md)을 따른다.


실행 진입점은 [src/cli.ts](src/cli.ts)의 `inventory`, `inspect`, `approve`, `render`, `serve`, `capture`, `stop`, `campaign`이다. 모델·HITL은 [src/models.ts](src/models.ts), attempt 봉인·복구 한도는 [src/attempts.ts](src/attempts.ts), 기동·소유 정리는 [src/serving.ts](src/serving.ts), 복구 판별은 [src/recovery.ts](src/recovery.ts)에 있다. [src/campaign.ts](src/campaign.ts)가 서빙 목표의 상태를 소유하며 upstream의 build와 lite-bench의 run을 호출한다.

1. wiki-desk에서 같은 모델/아키텍처/실패의 원문을 조회한다. `node .agents/skills/embedding-explorer/src/cli.ts inspect --model <경로>`로 config·ST modules·길이·차원·prompt/pooling/normalization을 조사한다.
2. **CPU/GPU → 최대 입력 토큰 → 출력 차원** 순서로 실제 선택을 받는다. 지원값·추천·원래 차원을 제시한다. 동일 조건을 포함한 기존 실제 승인 영수증은 재사용한다.
3. 새 승인은 [출처 형식](references/approval.md)을 만든 뒤 `node .agents/skills/embedding-explorer/src/cli.ts approve --model <경로> --device <장치> --context-window <토큰> --dimensions <값 또는 native> --approval-reference <JSON파일>`로 기록한다.
4. upstream에서 빌드한 attempt로 `node .agents/skills/embedding-explorer/src/cli.ts serve --attempt <경로> --port <포트>`를 실행한다. 캠페인 소유 작업은 explorer의 `node .agents/skills/embedding-explorer/src/cli.ts campaign status → step/run`으로 진행한다.
5. 실제 엔진·장치·입력 정책을 확인하고 lite-bench로 넘긴다. 기본 API는 `/v1/embeddings`, 엔진/dtype는 자동 판단하며 승인된 세 축을 유지한다.

임의 문자열·도구 출력·에이전트의 결정을 사용자 승인으로 만들지 않는다. TEI 불가/실패는 근거를 남기고 동일 장치에서 ST로 복구한다. runtime/recipe 변경은 새 attempt로 연결한다. 과거 PASS·정적 분류·빌드 성공은 현재 서빙 PASS가 아니다.

다음 모델로 넘어가기 전에 소유 컨테이너의 로그·결과를 보존하고 적절히 stop한다. 장시간 실행·재개는 `campaigns/README.md`를 따른다.
