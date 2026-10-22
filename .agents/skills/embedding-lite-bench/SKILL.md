---
name: embedding-lite-bench
description: "Verify a running /v1/embeddings service and execute its declared lightweight embedding load routine; report evidence without accuracy benchmarks."
---

# 경량 임베딩 검증

이 스킬은 반복 가능한 루틴 YAML과 기능검사·경량 측정·실패 분류·판정을 소유한다.

`python3 tools/embctl.py bench --strategy <승인 전략> --base-url <서버> --routine config/lite.yaml`로 실행한다. 적용 루틴·도구 버전·현재 시도·로그·결과는 output에 남긴다.

- 기능검사: 단일/배치 입력과 벡터 수·대응·승인 차원·finite 값, 실제 장치 및 입력 정책의 근거를 확인한다. 빈/오타입·입력 상한은 문서화한 처리 정책에 맞는지 확인한다.
- 측정: 실행 전에 확정한 입력·워밍업·요청수·동시성·timeout·반복의 유한 루틴을 완료한다. 요청 발행/완료/성공/실패/timeout 회계와 실제 성공 응답·측정 구간을 확인한다.
- 요청 수·latency·throughput·적용 가능한 RAM/VRAM을 관측값으로 기록한다. 관측 불가 항목은 이유를 밝힌다. 모델 실패와 측정 클라이언트/경로 실패를 구분한다.
- **PASS = 같은 현재 시도의 기능검사 통과 AND 유효 측정 완료**. 속도 목표가 없으면 임의 성능 문턱을 만들지 않는다. 측정을 쉽게 만들려고 승인 장치·입력 길이·차원을 바꾸지 않는다.

GuideLLM embeddings는 우선 검토 후보이며 실제 호환성과 도입비용을 보고 사용한다. 작은 HTTP runner가 충분하면 사용한다. 도구 선택·버전과 근거를 기록한다. 정확도/MTEB·기준 벡터 비교·생성 전용 지표·전체 adversarial/full sweep은 기본 범위가 아니다.

대표 CPU/GPU 경로와 NAS 대상의 선택 모드 결과를 집계한다. 모든 대상 검증·결과·미해결 보고로 이번 수행을 완료하고 성공만 PASS로 표시한다. 후속 과제는 문서·위키·실제 산출물에서 새 세션이 문제·기시도·재현/재개 조건을 찾을 수 있어야 한다.
