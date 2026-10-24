# easy-emb-server 스킬 팩

> **에이전트는 근거를 해석하고 다음 작업을 제안합니다. 각 스킬의 코드는 승인·상태·증거를 검사하고 실행과 판정을 책임집니다.**

이 디렉터리는 단일 노드의 임베딩 모델을 빌드·서빙·검증하는 역할별 스킬을 모읍니다. 각 스킬 팩은 **판단 지침인 `SKILL.md`와 실제 구현인 `src/`를 함께 소유**합니다. 에이전트가 작업에 맞는 스킬을 선택하고 호출하며, 해당 역할의 절차·게이트·완료 기준은 그 스킬 안에서 유지합니다.

프로젝트 설치와 모델 실행은 [메인 README](../../README.md)를, 스킬의 책임을 이해하거나 확장할 때는 이 문서를 읽습니다. 상세 실행 규약의 정본은 [AGENTS.md](../../AGENTS.md)와 [결정론적 실행 계약](../../rules/harness.md)입니다.

## 판단과 실행의 책임

여기서 **확률론적 로직**은 `SKILL.md`와 참조 문서를 읽은 에이전트가 수행하는 조사·해석·전략 제안·실패 가설 수립입니다. **결정론적 로직**은 그 제안을 입력으로 받아 정해진 조건에 따라 진행·차단·상태 전이·결과 판정을 수행하는 코드입니다.

| 주체 | 책임 | 남기는 근거 |
|---|---|---|
| 사람 | **CPU/GPU → 최대 입력 토큰 → 출력 차원**을 확정하고 전략 변경을 승인 | 실제 사용자 선택과 출처를 연결한 승인 영수증 |
| 에이전트 | 모델·HW·실패 원문을 해석하고 스킬 선택, 설정 추천, 복구 가설을 제안 | 조사 출처, 실패 원인 후보, 다음 시도의 변경 이유 |
| 스킬의 TypeScript 코드 | 승인 범위·고정 입력·자산 소유권·실행 한도를 검사하고 작업과 상태 전이를 수행 | manifest, 입력 스냅샷, 시도별 생성물, 로그, 측정과 판정 |

결정론적이라는 말은 **분기와 판정 기준을 코드로 고정한다**는 뜻입니다. 하드웨어·네트워크·모델 실행의 결과는 실제로 관측하며, 실행 시간이나 벡터 수치의 재현성은 별도 검증 대상입니다. 에이전트의 모델이나 추론 강도가 달라도 같은 진입점에서는 같은 필수 검사를 거치도록 구성했습니다.

```mermaid
flowchart LR
  H[사람의 전략 승인] --> A[에이전트의 작업·복구 제안]
  A --> C[역할 스킬의 CLI]
  C --> G[사전 게이트 · 실행 · 사후 검증]
  G --> R[진행·차단·판정과 원시 증거]
  R --> A
  A -->|전략 변경 필요| H
```

## 네 작업 스킬의 책임

**terraforming-node는 초기화 또는 환경 변경 때 사용합니다.** 나머지 세 스킬은 모델별 빌드·서빙·검증 과정에서 협력합니다. 실행 단계의 이름과 코드 소유자가 연결돼 있어, 실패가 나면 해당 역할의 지침과 구현에서 원인을 찾을 수 있습니다.

| 스킬 | 에이전트가 판단하는 부분 | 코드가 수행·판별하는 부분 | 다음 역할에 넘기는 근거 |
|---|---|---|---|
| [terraforming-node](terraforming-node/SKILL.md) | 관측 실패·미확인의 의미를 해석하고 추가 확인이 필요한 환경을 설명 | [hardware.ts](terraforming-node/src/hardware.ts): HW 관측, manifest 검증, 플랫폼 선택과 현재 환경 적용성 대조 | 관측값·출처·상태가 담긴 `manifest.yaml` |
| [embedding-upstream](embedding-upstream/SKILL.md) | HW와 모델에 맞는 빌드 경로를 검토하고 빌드 실패의 원인·수정 가설을 제안 | [upstream.ts](embedding-upstream/src/upstream.ts)·[recipes.ts](embedding-upstream/src/recipes.ts)·[build.ts](embedding-upstream/src/build.ts): 공식 소스·의존성 고정, recipe 생성, 실제 이미지 빌드와 검증 | upstream lock, Dockerfile·설치 입력, 이미지 ID와 빌드 로그 |
| [embedding-explorer](embedding-explorer/SKILL.md) | 모델 의미와 지원 설정을 조사하고 HITL 선택지를 추천하며 런타임 복구 전략을 수립 | [models.ts](embedding-explorer/src/models.ts)·[attempts.ts](embedding-explorer/src/attempts.ts)·[serving.ts](embedding-explorer/src/serving.ts)·[recovery.ts](embedding-explorer/src/recovery.ts): 승인 검증, 입력 봉인, 기동·소유 자산 정리, 유한 복구 판별 | 승인 전략, 현재 attempt, 실효 설정·기동 증거·복구 이력 |
| [embedding-lite-bench](embedding-lite-bench/SKILL.md) | 선언된 검증 목적과 실패 원문을 해석하고 결과·미해결 조건을 설명 | [bench.ts](embedding-lite-bench/src/bench.ts): API 기능검사, 유한 요청 실행, 워밍업 분리와 요청 회계, 사후 상태 및 현재 PASS 검증 | 기능검사·경량 측정 원문과 결과 판정 |

[wiki-desk](wiki-desk/SKILL.md)는 이 네 역할이 사용할 이전 문서와 근거 구간을 찾고 발행 문서를 색인합니다. 검색·입고는 코드로 수행하고, 검색된 원문이 현재 작업에 적용되는지는 에이전트가 판단합니다.

## 하나의 스킬 팩 안에 두는 것

upstream을 예로 들면 지침·상세 계약·실행 코드가 같은 폴더에 있습니다.

```text
embedding-upstream/
├── SKILL.md                   # 언제 쓰며 어떤 순서로 진행하는가
├── references/gates.md        # 상세 입력·실패·복구 계약
└── src/
    ├── cli.ts                 # prepare / check / build 진입점
    ├── upstream.ts            # 공식 소스와 의존성 고정
    ├── recipes.ts             # 컨테이너 빌드 입력 생성
    ├── build.ts               # 실제 빌드와 이미지 검증
    └── dependency-provenance.ts
```

다른 팩도 같은 방식으로 지침과 자기 역할의 실제 구현을 묶습니다. 역할별 진입점은 [terraforming CLI](terraforming-node/src/cli.ts), [upstream CLI](embedding-upstream/src/cli.ts), [explorer CLI](embedding-explorer/src/cli.ts), [lite-bench CLI](embedding-lite-bench/src/cli.ts)입니다. 한 역할을 변경할 때는 해당 팩의 지침·입력 계약·구현·검증을 함께 검토합니다.

공유하는 부분은 다음과 같습니다.

| 위치 | 책임 |
|---|---|
| [`.agents/harness/`](../harness/) | 파일 입출력·직렬화·해시, 프로세스 정체성·실행 lease, 공통 CLI 처리. 역할 구현을 import하지 않는 기반 |
| [`.agents/validation/`](../validation/) | 개발 검사·리뷰와 소스를 고정한 별도 E2E 평가 |
| [`runtime/`](../../runtime/)·[`config/`](../../config/) | 컨테이너에 넣는 API·모델 어댑터 원천과 공통 설정 |

스킬 팩은 이 저장소의 공통 기반·runtime·config를 함께 사용하는 협력 모듈입니다. 배포와 사용은 저장소 전체를 기준으로 하며, 개별 스킬 폴더만 복사하는 독립 배포는 검증하지 않았습니다.

결정론적 TypeScript 코드는 산출물을 만드는 절차와 검증을 담당합니다. 컨테이너 내부에서는 TEI의 Rust, ST/PyTorch·API의 Python 등 각 구성요소의 기본 언어를 유지합니다.

## 스킬 사이의 작업 흐름

1. **terraforming-node**가 노드를 관측합니다. **explorer**는 그 manifest와 모델 메타데이터를 읽고 사람의 장치·토큰·차원 선택을 승인 영수증으로 연결합니다.
2. **upstream**이 공식 최신 안정 릴리스를 조회해 빌드 입력을 고정하고 이미지를 빌드합니다. `build --strategy`는 explorer의 승인·attempt 준비 API를 거칩니다. 고정된 평가를 재현할 때는 보존된 lock을 사용합니다.
3. **explorer**가 같은 attempt의 이미지를 기동하고 실제 엔진·장치·입력 정책을 확인합니다. TEI가 가능하면 우선하며, 불가 또는 실패 근거가 있으면 같은 승인 장치의 ST 경로를 검토합니다.
4. **lite-bench**가 현재 서빙의 기능검사와 유효한 경량 측정을 수행합니다. explorer는 소유 자산의 정리와 다음 시도의 상태를 관리합니다.

장시간 작업의 상태는 explorer의 [campaign.ts](embedding-explorer/src/campaign.ts)가 소유합니다. 캠페인은 `prepare → build → serve → bench → stop` 위상을 이어가면서 upstream의 빌드와 lite-bench의 검증 함수를 호출합니다. 이때 `prepare` 위상은 **현재 시도 생성**이고 upstream CLI의 `prepare`는 **공식 소스·의존성 준비**입니다.

캠페인 소유 작업의 재개는 `campaign status → step/run`으로 진행합니다. [캠페인 규약](../../campaigns/README.md)에 따라 체크포인트와 실제 실행 소유권을 확인한 뒤 다음 위상으로 넘어갑니다.

## 조절할 값과 통과해야 할 게이트

에이전트가 제안하는 조절값(knob)은 [허용된 입력 계약](../../rules/harness.md#조절할-수-있는-값)을 거쳐 실행에 반영됩니다.

| 변경하려는 것 | 결정·적용 경로 |
|---|---|
| 장치·최대 입력 토큰·출력 차원 | 사람의 결정과 그 범위를 확인한 승인 영수증 |
| 엔진·dtype·timeout·builder 등 실행 조건 | 에이전트의 근거 있는 제안 → 코드의 지원 여부·복구 한도 검사 → 새 attempt 또는 허용된 위상 재시도 |
| recipe·runtime·스킬 구현 | 개발에서 변경·검증하고 새 입력으로 고정. 평가 중 수정이 필요하면 실패 근거를 보존한 뒤 새 평가 수행 |
| PASS | 같은 현재 attempt의 **기능검사 통과 AND 유효 실측 완료**를 코드가 판별 |

예를 들어 TEI 기동이 메모리 부족으로 실패하면 에이전트는 원문을 읽고 ST 복구 가설을 제안할 수 있습니다. 코드는 원승인·실패 근거·지원 경로·남은 한도를 대조하고, 허용된 새 시도에서 다시 빌드·기동·측정하게 합니다. 입력 상한을 줄여야 한다면 사람의 선택으로 돌아갑니다. 빌드 성공이나 과거 PASS는 현재 시도의 측정을 대신할 수 없습니다.

이 게이트는 정해진 진입점을 사용하는 작업의 판정 기준입니다. 동일 사용자 권한의 임의 파일·Docker 명령 전체를 격리하는 보안 경계는 아니며, 그 경로로 수행한 작업은 현재 하네스의 PASS 근거로 인정하지 않습니다.

## 검증으로 확인한 범위

스킬 팩 이관 후 실제 **Luna / reasoning effort `none`**으로 Qwen3-Embedding-4B, Qwen3-VL-Embedding-2B, pplx-embed-context-v1-4b의 CPU/GPU **6조건을 새로 빌드·서빙·검증해 모두 PASS**했습니다(2026-10-24). 실행 중 코드와 승인 조건을 유지했고, 실패와 복구 원문도 보존했습니다. 설정·수치·검증 범위는 [스킬 팩 E2E 보고서](../../docs/report/skill-pack-luna-e2e.md)에 있습니다.

이 결과는 해당 소스·호스트·모델 조건의 실증입니다. 에이전트 모델에 무관하게 사용할 수 있는 실행 계약을 지향하되, 다른 모델·HW·라이브러리 조합의 성공은 그 실행에서 다시 확인합니다.

## 참고한 설계 관점

[mattpocock/skills의 README](https://github.com/mattpocock/skills/blob/5beb35b040e3de97e54fa9e386d7e42d15c295c2/README.md)에서 작은 스킬을 목적에 맞게 조합하는 구성과 역할별 안내 방식을 참고했습니다. [codebase-design](https://github.com/mattpocock/skills/blob/5beb35b040e3de97e54fa9e386d7e42d15c295c2/skills/engineering/codebase-design/SKILL.md)의 관점은 간결한 호출면 뒤에 해당 역할의 실제 구현을 모으는 배치에, [writing-for-agents](https://github.com/mattpocock/skills/blob/5beb35b040e3de97e54fa9e386d7e42d15c295c2/skills/productivity/writing-for-agents/SKILL.md)의 관점은 개요에서 상세 계약으로 연결하는 문서 구성에 적용했습니다.

위 저장소의 사용자 호출·모델 호출 구분은 **누가 스킬을 호출하는가**의 축입니다. 이 프로젝트가 설명하는 **에이전트의 판단과 코드의 실행·판정 책임**은 별도의 설계 축이며, 위의 역할 배치와 게이트는 easy-emb-server의 구현을 설명합니다.
