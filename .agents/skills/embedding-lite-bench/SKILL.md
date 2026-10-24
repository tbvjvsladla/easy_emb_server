---
name: embedding-lite-bench
description: "Verify a running /v1/embeddings service and execute its declared lightweight embedding load routine; report evidence without accuracy benchmarks."
---

# 경량 임베딩 검증

유한 측정 루틴·기능검사·요청 회계·판정을 소유한다. [공통 게이트 계약](../../../rules/harness.md)을 따른다.


실행 진입점은 [src/cli.ts](src/cli.ts)의 `bench`, `report`다. 기능검사·경량 측정·현재 PASS 검증의 실제 구현은 [src/bench.ts](src/bench.ts)에 있다.

1. 실행 중인 attempt와 승인 전략, 선언한 routine을 읽는다. 입력·워밍업·요청 수·동시성·timeout은 코드의 유한 범위 안이어야 한다.
2. `node .agents/skills/embedding-lite-bench/src/cli.ts bench --attempt <경로> --routine <파일>`로 실행한다. 캠페인 소유 attempt는 explorer의 `node .agents/skills/embedding-explorer/src/cli.ts campaign status → step/run`을 사용한다. 별도 서버 주소는 `--base-url`로 지정한다.
3. [판정 게이트](references/gates.md)에 따라 기능검사·실측·사후 상태·실패 근거를 읽는다. **PASS는 같은 현재 attempt의 기능검사 통과 AND 유효 실측 완료**다.
4. 전체 대상의 결과·미해결·재개 조건을 보고한다. 전체 수행 완료와 전 모델 PASS를 구별한다.

기준 벡터/MTEB/정확도·임의 throughput 문턱은 추가하지 않는다. GuideLLM embeddings 검토 후 채택한 유한 HTTP runner와 선택 이유는 routine에 기록한다. mock/estimated/과거 결과는 새 실측 PASS와 구별한다. 속도를 높이기 위해 승인 장치·토큰·차원을 바꾸지 않는다.
