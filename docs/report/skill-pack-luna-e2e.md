---
title: 역할별 스킬 팩과 Luna none 선별 E2E
date: 2026-10-24
doc_type: report
status: published
---

# 역할별 스킬 팩과 Luna none 선별 E2E

**네 작업 스킬 안으로 실제 TypeScript 구현과 전용 CLI를 옮기고 기존 `tools/`를 제거했다. 사전 선정한 3종 모델의 CPU/GPU 6조건을 실제 `gpt-6-luna`, reasoning effort `none`으로 새로 빌드·서빙·검증했고 모두 PASS했다.** 독립 원시 감사에서 발견 사항은 없었다. 개발 회귀 146건과 wiki 회귀 240건도 통과했다.

평가 ID는 `skillpack-luna-261024-r1`, 소스 커밋은 `a366482d34fffdcbb69972aeafa50ef6fa981d9a`다. 실행 입력은 2026-10-24 11:48:49 KST에 고정했으며, 소스 digest는 `92975a1029c73a187a90483968a2c029711e59fc686f5ca892e683879d40042e`다. 앞선 [TypeScript 하네스 r4 보고서](deterministic-harness-luna-e2e.md)의 실측은 당시 결과로 보존한다. 이번 평가는 역할별 코드 배치를 바꾼 소스에서 새 시도를 요구한다. [동결 입력](../../output/evaluations/skillpack-luna-261024-r1/evaluation.json) · [개발 인계](../../output/evaluations/skillpack-luna-261024-r1/development-handoff.json)

각 스킬은 판단 지침과 실제 구현을 함께 소유한다. CLI는 정해진 역할 명령을 받고, 캠페인은 explorer가 상태를 관리하면서 빌드와 측정을 담당 스킬에 연결한다.

| 스킬 팩 | 실제 진입점과 명령 | 실제 구현의 소유권 |
|---|---|---|
| [terraforming-node](../../.agents/skills/terraforming-node/SKILL.md) | [src/cli.ts](../../.agents/skills/terraforming-node/src/cli.ts): `init` | [hardware.ts](../../.agents/skills/terraforming-node/src/hardware.ts): HW 관측, manifest 검증, 플랫폼 선택, 승인 당시와 현재 환경의 적용성 비교 |
| [embedding-upstream](../../.agents/skills/embedding-upstream/SKILL.md) | [src/cli.ts](../../.agents/skills/embedding-upstream/src/cli.ts): `prepare`, `check`, `build` | [upstream.ts](../../.agents/skills/embedding-upstream/src/upstream.ts): 공식 소스·이미지·의존성 고정; [recipes.ts](../../.agents/skills/embedding-upstream/src/recipes.ts): Dockerfile과 설치 입력; [build.ts](../../.agents/skills/embedding-upstream/src/build.ts): 실제 이미지 빌드와 정체성 검증. `dependency-provenance.ts`는 보존한 공식 배포 근거를 검증한다. |
| [embedding-explorer](../../.agents/skills/embedding-explorer/SKILL.md) | [src/cli.ts](../../.agents/skills/embedding-explorer/src/cli.ts): `inventory`, `inspect`, `approve`, `render`, `serve`, `capture`, `stop`, `campaign` | [models.ts](../../.agents/skills/embedding-explorer/src/models.ts)와 `model-fingerprint.ts`: 모델·원승인; [attempts.ts](../../.agents/skills/embedding-explorer/src/attempts.ts): 입력 봉인·시도·실패 이력·예산; [serving.ts](../../.agents/skills/embedding-explorer/src/serving.ts)와 `resources.ts`: 실제 기동·관측·소유 자산 정리; [recovery.ts](../../.agents/skills/embedding-explorer/src/recovery.ts), [campaign.ts](../../.agents/skills/embedding-explorer/src/campaign.ts): 복구 판별과 캠페인 상태 |
| [embedding-lite-bench](../../.agents/skills/embedding-lite-bench/SKILL.md) | [src/cli.ts](../../.agents/skills/embedding-lite-bench/src/cli.ts): `bench`, `report` | [bench.ts](../../.agents/skills/embedding-lite-bench/src/bench.ts): API 기능검사, 유한 HTTP 측정, 요청 회계, 사후 상태, 현재 시도의 PASS 판정 |

공통 `.agents/harness/`에는 직렬화·해시·원자적 파일 저장·오류를 다루는 [common.ts](../../.agents/harness/common.ts), 프로세스 정체성·실행 lease·유한 명령 실행을 다루는 [processes.ts](../../.agents/harness/processes.ts), 인자·출력·종료 코드를 다루는 [cli.ts](../../.agents/harness/cli.ts)를 둔다. 공통 기반은 스킬 구현을 import하지 않는다. `.agents/validation/`의 `verify.ts`, `review.ts`, `campaign_e2e.ts`는 개발 검사와 별도 평가 도구다. 스킬 간 import 순환과 공통 기반의 역방향 의존은 개발 회귀에서 검사했다.

호스트 제어 언어는 TypeScript이며, 컨테이너 내부 TEI의 Rust와 sentence-transformers/PyTorch 및 API 어댑터의 Python은 유지한다. 이번 이관에서 `runtime/__init__.py`, `runtime/adapters.py`, `runtime/policy.py`, `runtime/server.py`는 바꾸지 않았다. 스킬 팩은 이 저장소의 공통 기반·runtime·config를 사용하는 협력 모듈이다. 각 스킬 폴더만 복사하는 독립 배포 형태는 검증 범위에 포함하지 않는다. [역할 분리 검토](../../output/validation/skillpack-migration-261024/role-split-review.json) · [통합 경로 검토](../../output/validation/skillpack-migration-261024/root-integration-review.json)

새 실행은 위 스킬 CLI를 사용하며 `tools/` 호환용 wrapper는 없다. 과거 `output/`의 생성 스크립트·명령·실패·해시는 당시 증거로 보존한다. 오래된 `run.sh` 대신 새 진입점을 사용하고, 과거 자산의 정리도 explorer의 `capture/stop --attempt`에서 원래 자산 ID와 소유권을 확인한다.

이관 뒤에도 다음 판정은 코드가 수행한다. 에이전트는 목표와 복구 가설을 제안하고, 실제 효과 함수가 승인·입력·소유권·예산을 검사한다. [결정론적 실행 계약](../../rules/harness.md)

| 판정 경계 | 유지한 검사 |
|---|---|
| HW | 장치 없음·도구 없음·조회 실패·미확인을 구별한다. 시간이나 가용 메모리 변동과 선택 장치·드라이버·런타임의 실질 변경을 구별한다. |
| 승인 | 실제 사용자 출처와 CPU/GPU → 최대 입력 토큰 → 출력 차원을 대조한다. 기존 실제 영수증은 고정한 원문 해시와 범위를 확인한다. |
| 입력 | 모델·manifest·upstream·의존성·recipe·runtime·호스트 소스를 시도에 연결한다. 빌드한 이미지의 recipe와 불변 ID를 기동 때 다시 확인한다. |
| 실행 | host·campaign·attempt lease와 현재 worker 소유권을 확인한다. 하위 명령은 lease를 상속하고 유한 timeout을 갖는다. PID namespace가 달라 생사 확인이 불가능한 상태를 종료로 단정하지 않는다. |
| 복구 | 같은 승인 안의 실제 실패·변경·남은 예산으로 판단한다. renderer가 허용하는 같은 장치 ST 경로가 남으면 이유 문장만으로 차단 처분하지 않는다. 실패 이력과 생성 당시 시점의 불변 근거를 사용한다. |
| 현재 PASS | 같은 시도의 기능검사 통과와 유효 실측 완료를 모두 요구한다. 요청 원문·회계·사후 health·runtime·이미지/컨테이너 정체성을 대조한다. 과거 PASS·mock·빌드 성공은 새 PASS에 포함하지 않는다. |

선정 근거는 Qwen3-Embedding-4B의 4B·32K 메모리 요구와 복구, Qwen3-VL-Embedding-2B의 전용 텍스트 로딩 경로와 기동 호환성, pplx-embed-context-v1-4b의 contextual 문서·청크 매핑과 긴 입력 경계다. VL 모델은 텍스트 임베딩을 평가한다.

아래 원승인 조건을 유지하며, 성공 기준은 여섯 조건 각각의 새 기능검사 통과와 유효 측정 PASS다. 기존 승인 출처와 비교 조건은 새 평가의 coverage·campaign 입력에서 대조한다. [6조건 coverage](../../output/evaluations/skillpack-luna-261024-r1/inputs/coverage-difficult6.json) · [캠페인 선언](../../output/evaluations/skillpack-luna-261024-r1/inputs/campaign-difficult6.json)

| 모델 | 장치 | 승인 입력 상한 | 승인 차원 | 원승인 영수증 |
|---|---|---:|---:|---|
| Qwen3-Embedding-4B | CPU | 32768 | 2560 | [b7951ce6938f1325](../../output/Qwen3-Embedding-4B/strategies/b7951ce6938f1325.yaml) |
| Qwen3-Embedding-4B | GPU | 32768 | 2560 | [11466ca3baa4b009](../../output/Qwen3-Embedding-4B/strategies/11466ca3baa4b009.yaml) |
| Qwen3-VL-Embedding-2B | CPU | 32768 | 2048 | [2115aac3a0376d10](../../output/Qwen3-VL-Embedding-2B/strategies/2115aac3a0376d10.yaml) |
| Qwen3-VL-Embedding-2B | GPU | 32768 | 2048 | [3be15d69febc9e01](../../output/Qwen3-VL-Embedding-2B/strategies/3be15d69febc9e01.yaml) |
| pplx-embed-context-v1-4b | CPU | 32768 | 2560 | [dd0819ff0a029f54](../../output/pplx-embed-context-v1-4b/strategies/dd0819ff0a029f54.yaml) |
| pplx-embed-context-v1-4b | GPU | 32768 | 2560 | [510f50faf8b13f36](../../output/pplx-embed-context-v1-4b/strategies/510f50faf8b13f36.yaml) |

| 환경·측정 항목 | 고정 또는 선언한 조건 |
|---|---|
| 관측 manifest | 단일 WSL Ubuntu 24.04, x86_64, AMD Ryzen 9 9950X, 논리 코어 32개, RAM 67,422,572,544 bytes |
| 선택 GPU | NVIDIA GeForce RTX 5090, 32,607 MiB, compute capability 12.0, driver 617.42 |
| 호스트 실행 | Node.js 24.15.0으로 개발 검증; 프로젝트 요구 버전은 Node.js 24.12.0 이상 |
| upstream | 보존한 TEI 1.9.4와 sentence-transformers 6.2.0, exact commit·이미지 digest·설치 URL/hash를 가진 동일 snapshot 재사용 |
| 소스 동결 | 네 핵심 스킬·공통 기반·validation·runtime·config·정책 등 선언된 실행 입력 55파일 |
| 복구 예산 | 셀별 최대 8시도·14400초; 앞선 실패와 남은 예산을 상속 |
| 경량 루틴 | warmup 2회, 본 측정 12요청, 동시성 2, 요청 timeout 600초, 선언한 짧은 한국어·영어 입력 |
| 기능 범위 | 벡터 개수·순서·차원·finite 값·실제 장치·입력 정책·오류 응답·실제 tokenizer 경계; 해당 모델의 contextual 문서·청크 계약 |

HW 표는 [보존 manifest](../../output/host/manifest.current.json)의 관측값이며, upstream은 [고정 원문](../../output/evaluations/skillpack-luna-261024-r1/inputs/upstream-lock.json)을 사용했다. 빌드 캐시는 재사용했으며 새 시도·빌드 명령·컨테이너·현재 측정 결과를 확인했다. driver는 선언된 55파일을 동결했고, 독립 감사는 wiki 구현을 포함한 추적 실행 코드 43파일과 로컬 실행 규칙도 기준 커밋·사전 해시에 대조했다. 실행 소스와 정책의 변경은 없었다.

개발 회귀는 로컬 HTTP fixture와 실제 자식 프로세스·중단·재개 검사를 포함한다. 아래 개발 검증과 discovery 결과는 임베딩 모델의 빌드·서빙·실측 결과와 구분한다. 검증 후 `model-fingerprint.ts`의 끝 빈 줄 한 개를 제거한 사실은 개발 인계에 기록했고 실행 본문 변경은 없었다.

| 검증 | 현재 확인한 결과 | 근거 |
|---|---|---|
| TypeScript 타입·Oxlint | PASS | [통합 결과](../../output/validation/verify/2026-10-24T012041-846Z/result.json) |
| 하네스 로컬 회귀 | 146 PASS, 실패·skip 0 | [harness.log](../../output/validation/verify/2026-10-24T012041-846Z/harness.log) |
| wiki-desk 회귀 | 240 PASS, 실패·skip 0 | [wiki.log](../../output/validation/verify/2026-10-24T012041-846Z/wiki.log) |
| 역할 분리·통합 경로의 독립 읽기 검토 | 두 검토에서 발견 0; 각 기록의 범위·제외 항목 적용 | [역할 분리](../../output/validation/skillpack-migration-261024/role-split-review.json) · [통합 경로](../../output/validation/skillpack-migration-261024/root-integration-review.json) |
| 실제 Luna none discovery | PASS; 실제 세션의 model/effort·관측 도구 호출 독립성·소스 불변 검사 통과 | [discovery 원문 결과](../../output/evaluations/skillpack-luna-261024-r1/discovery-1792811221273-81553bfa/result.json) |
| difficult6 실제 E2E | 새 PASS 6, 과거 결과 재사용 0, 미해결 0 | [driver 결과](../../output/evaluations/skillpack-luna-261024-r1/groups/difficult6/1792811373412-64942985/result.json) |
| 독립 원시 감사 | 종합 23개·부분 168개 대조 통과, 발견 0 | [최종 감사](../../output/validation/skillpack-evidence-261024/final-audit.json) |

discovery는 실제 Codex `gpt-6-luna`, reasoning effort `none`의 세션 기록을 확인했다. 응답에는 네 스킬의 `SKILL.md`, 각 `src/cli.ts`, 실제 구현 파일이 포함됐으며 driver가 파일의 존재와 소유 경로까지 검증했다.

첫 difficult6 제어 호출은 모델 명령 발행 전 `workspace routing discovery failed`로 종료됐다. WebSocket 재연결·HTTPS 전환·`turn.failed` 원문을 보존했고, 운영 기록에 외부 연결 차단과 attempt 생성 전 중단을 남겼다. 이후 동일한 고정 소스·승인·캠페인으로 실행 권한이 있는 환경에서 재호출했다. 이 제어 계층 실패는 모델 결과와 별도로 기록한다. [초기 호출 원문](../../output/evaluations/skillpack-luna-261024-r1/groups/difficult6/1792811280438-cb451039/call/events.jsonl) · [작업 기록](../../docs/devlog/devlog_26102409_스킬팩_이관과_Luna_선별_E2E.md)

**최종 결과는 6/6 새 PASS다.** 실제 제어 호출은 2026-10-24 12:09:33–12:56:10 KST에 실행됐고 정상 종료했다. 정본 세션의 실제 모델은 `gpt-6-luna`, effort는 `none`이며, 다른 에이전트 모델로 대체하거나 실행 중 상위 모델의 해결 지시를 받은 기록은 없다. 47개 worker 호출을 같은 세션·승인·입력·현재 시도에 연결했고 선언된 실행 소스의 불변성을 확인했다. [캠페인 최종 결과](../../output/campaigns/skillpack-luna-261024-r1-difficult6/reports/148.json) · [원시 감사](../../output/validation/skillpack-evidence-261024/final-audit.json)

각 행의 PASS 링크는 현재 시도의 결과와 원시 근거 해시를 가리킨다. ST는 sentence-transformers다. 모든 행은 원래 승인한 32768토큰과 차원을 유지했으며, 본 측정 전 워밍업 2회는 수치에서 제외했다.

| 모델 | 장치 | 최종 엔진 / dtype | 현재 E2E 판정 | 본 측정 성공 / 발행 | RPS | p95 ms |
|---|---|---|---|---|---|---|
| Qwen3-Embedding-4B | CPU | ST / float32 | [PASS](../../output/Qwen3-Embedding-4B/attempts/2026-10-24T031340.767Z_986fc3ee/result.json) | 12 / 12 | 0.691 | 3108.792 |
| Qwen3-Embedding-4B | GPU | ST / bfloat16 | [PASS](../../output/Qwen3-Embedding-4B/attempts/2026-10-24T032657.007Z_c6322cfd/result.json) | 12 / 12 | 17.031 | 137.565 |
| Qwen3-VL-Embedding-2B | CPU | ST / float32 | [PASS](../../output/Qwen3-VL-Embedding-2B/attempts/2026-10-24T032916.122Z_372a5e05/result.json) | 12 / 12 | 2.021 | 968.685 |
| Qwen3-VL-Embedding-2B | GPU | ST / bfloat16 | [PASS](../../output/Qwen3-VL-Embedding-2B/attempts/2026-10-24T033429.570Z_b4999f06/result.json) | 12 / 12 | 23.735 | 73.560 |
| pplx-embed-context-v1-4b | CPU | ST / float32 | [PASS](../../output/pplx-embed-context-v1-4b/attempts/2026-10-24T033546.953Z_b1dd9086/result.json) | 12 / 12 | 0.362 | 5821.385 |
| pplx-embed-context-v1-4b | GPU | ST / bfloat16 | [PASS](../../output/pplx-embed-context-v1-4b/attempts/2026-10-24T035246.692Z_80a26a04/result.json) | 12 / 12 | 13.820 | 148.216 |

원시 기능 요청·응답은 합계 250건, 본 측정은 72/72 성공, 별도 워밍업은 12건이다. 각 조건에서 실제 tokenizer 기준 32768토큰을 처리하고 32769토큰을 HTTP 400으로 거부했다. contextual 검사는 두 문서의 `[2, 1]` 청크 매핑·순서·차원·finite 값과 flat/one-chunk 문서의 일관성을 대조했다. 출력 벡터 합계 216개·517120성분을 검산했다.

생성된 시도는 10개이며, 이 중 TEI 실패 4개를 보존했다. Qwen3 CPU는 warmup 중 컨테이너 OOM 종료(`OOMKilled=true`, 종료 코드 137), GPU는 CUDA 메모리 부족(종료 코드 1)이었다. Qwen3-VL 양쪽은 pooling 설정 부재로 종료했다. Luna가 네 조건 모두 원래 장치·입력 상한·차원을 유지하며 ST로 복구했고, pplx 양쪽은 각 한 번의 ST 시도로 통과했다. 실패 근거와 복구 처분은 최종 감사의 recovery 항목에 연결했다.

Qwen3 CPU 복구 중 `memory_bytes` 제안은 `unsupported_recovery_knob` 게이트가 새 시도 생성 전에 차단했다. Luna의 보조 명령에는 임시 제안 JSON 작성과 원시 기록 키 조회에 사용한 Python 명령이 각각 1회 있었다. 이는 스킬·하네스 구현 변경이 아니며, 호스트의 결정론적 실행 로직은 TypeScript로 유지됐다.

10개 시도의 정확한 소유 컨테이너 ID 14개와 네트워크 4개가 정리됐고, 종료 후 label 조회에서 실행 중인 소유 컨테이너는 0개였다. 실행·복구의 미해결 조건은 없다. 이미지와 빌드 캐시, 실패·성공 원문은 보존했다. 이후 같은 boot와 PID namespace에서 제어 호출·caller·worker·마지막 명령의 65개 기록 정체성을 다시 관측해 원래 프로세스가 모두 부재함을 확인했다. [컨테이너 관측](../../output/validation/skillpack-evidence-261024/post-evaluation-containers.json) · [프로세스 정체성 관측](../../output/validation/skillpack-evidence-261024/post-evaluation-process-identities-extended.json) · [추가 종료 감사](../../output/validation/skillpack-evidence-261024/final-audit-addendum.json)

검증 범위는 관측한 단일 호스트, 고정한 upstream과 세 모델의 CPU/GPU 조건이다. 복구 판별은 실제 지원 경로·실패 근거·예산을 사용하며, 이 결과를 모든 에이전트 모델·HW·아키텍처의 중립성이나 성공 보장으로 일반화하지 않는다. RPS/p95는 짧은 입력 두 개를 담은 12요청의 flat embedding 관측값이다. 32K 처리량이나 contextual 다중 문서 처리량을 뜻하지 않으며 장문 경계는 별도로 검사했다. contextual 장문 경계는 한 청크 문서 조건이다. 메모리는 전후 표본이며 peak 사용량이 아니다. 모델 fingerprint는 메타데이터 해시와 가중치 크기·수정시각을 대조하며 가중치 전체 바이트 해시는 아니다. 검색 정확도·모델 품질 순위·장기 soak·이미지/비디오·전체 adversarial·멀티노드는 검증 범위 밖이다.

파일 해시와 실행 게이트는 입력·결과의 일치를 검사하며, 같은 사용자 권한의 임의 파일·Docker 작업 전체를 격리하는 보안 경계는 아니다. Luna 독립성 판정은 보존된 세션·도구 호출에서 관측한 범위에 적용한다.

원시 근거 `output/`, 로컬 승인 출처·작업문서·회귀 테스트는 일반 clone에 포함되지 않는다. 위 상대 링크는 근거를 보존한 작업 공간에서의 감사 경로다. 이 고정 평가의 freeze에는 기존 로컬 승인·기준 결과가 필요하다. 새 사용자 모델의 일반 스킬 실행 흐름은 이 역사적 평가 자료를 요구하지 않는다. 보고서는 원시 결과를 전달하며 새로운 실행 승인이나 별도 PASS 판정을 만들지 않는다.
