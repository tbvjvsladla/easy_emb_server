---
title: 임베딩 E2E 캠페인 종합 결과
date: 2026-10-23
doc_type: report
status: published
---

# 임베딩 E2E 캠페인 종합 결과

> **SUPERSEDED-IN-PART — 2026-10-24:** 현재 TypeScript 하네스와 실제 Luna `none`의 새 36조건 결과는 [TypeScript 하네스와 Luna none E2E 결과](deterministic-harness-luna-e2e.md)를 따른다. 이 문서의 수치·실패·Python 명령은 2026-10-22~23의 역사 기록으로 보존한다. 현재 실행 진입점과 재개 조건은 새 보고서 및 [README](../../README.md)를 확인한다.

NAS에 준비된 **18종 × CPU/GPU = 36셀의 검증·결과·미해결 보고를 완료했다. 17종 34셀은 PASS, `nomic-xlm-2048`의 2셀은 BLOCKED**다. 각 모델의 기본 입력 상한과 원래 출력 차원을 유지했다. 별도 캠페인에서는 실제 Codex 호출자를 종료한 뒤 새 호출이 체크포인트를 읽어 남은 모델 검증을 완료했다.

이 문서는 2026-10-22~23 KST에 수행한 개발 환경의 결과다. PASS는 현재 시도의 API 기능검사와 유효한 경량 측정이 함께 통과한 상태다. 전체 처리 완료는 모든 모델의 서빙 성공을 뜻하지 않는다. 실행 원문은 로컬에 보존하며 아래 표는 그 원문에서 추출했다.

## 검증 범위와 집계

| 수행 | 대상 | 최종 결과 | 확인한 내용 |
|---|---|---|---|
| 대표 모델 기본값 | E5 small/base, EmbeddingGemma 300M × CPU/GPU, 6셀 | 6 PASS | 실제 빌드·기동·장치·입력 경계·측정·정리 |
| 엄격 세션 연속성 | E5 small CPU → 같은 모델 GPU → E5 base CPU, 3셀 | 모델 3 PASS, 제어 검증 PASS | 호출자/coordinator 종료, finite worker 생존, 별도 실제 Codex 호출의 재개 |
| NAS 전체 기본값 | 전체 18종 × CPU/GPU, 36셀 | 34 PASS / 2 BLOCKED | 18종 목록 대조, 기본 입력 상한·차원, 실패 복구와 최종 보고 |

앞의 6셀과 3셀은 같은 모델의 별도 시도다. 메인 캠페인의 고유 범위를 45셀 또는 27종으로 합산하지 않는다. 초기 discovery, 실패한 포트, 수정 전 연속성 실행도 보존했으며 최종 성공 수에 더하지 않는다.

## 환경과 실행 조건

| 항목 | 실제 관측·조건 |
|---|---|
| 노드 | 단일 WSL Ubuntu 24.04, x86_64 |
| CPU / RAM | 논리 코어 32개 / 67,422,572,544 bytes, 약 62.79 GiB |
| GPU | NVIDIA RTX 5090, 32,607 MiB, compute capability 12.0, driver 617.42 |
| 컨테이너 | Docker Desktop 28.3.0, Buildx |
| 모델·API | 로컬 준비 모델을 읽기 전용으로 사용, `/v1/embeddings`, 셀을 순차 실행 |
| 입력·출력 | 로컬 모델 기본 입력 상한, native 차원. 모델의 prompt/pooling/normalization/quantizer 의미 유지 |
| 엔진 | TEI 우선, 불가 근거가 있으면 동일 승인 장치의 sentence-transformers(ST) 또는 그 컨테이너의 전용 어댑터 |
| 경량 측정 | 각 셀 warmup 2회, 측정 12요청, 동시성 2, 짧은 한국어·영어 입력, 측정 timeout 600초 |
| 입력 경계 | 승인 상한의 전체 입력 수락과 상한+1 거부. 장문 기능검사는 경량 측정과 별개 |
| 자원 예산 | 중간 도입 이후 backend: CPU 24, RAM/메모리+swap 모두 40,453,543,526 bytes. 초기 2셀은 기존 조건 |

메모리 예산은 관측 RAM의 min(total×0.60, available×0.75), CPU는 논리 코어의 75%에서 정했다. 일부 32K 모델의 기동·기능검사 한도는 1800초로 늘렸다. CPU 전체 32K 경계 요청은 모델에 따라 수 분~약 16분이 걸렸다. 승인 대기와 도구 호출 사이의 시간은 모델 지연시간으로 집계하지 않는다.

ST 전환 과정에서 사용한 공통 버전은 sentence-transformers 6.2.0, Transformers 5.20.2, torch 2.14.1, tokenizers 0.23.3, Pillow 13.0.0, torchvision 0.29.1이다. TEI는 1.9 계열이다. **모든 셀이 동일 이미지나 라이브러리로 실행된 것은 아니다.** 각 시도의 동결 Dockerfile·버전·이미지 ID·런타임·승인·device observations가 실제 조건의 정본이다.

## 메인 캠페인: 전체 36셀

캠페인 `nas-all-defaults-261022`, 최종 checkpoint sequence **448**. 처리·보고 완료 `true`, 전 셀 PASS `false`. PASS 34셀은 모두 기능검사와 측정 12/12를 통과했다. RPS는 요청/초, p95는 밀리초다. ST 표기는 일반 ST와 검토한 전용 어댑터를 포함한다.

| 모델 | 장치 | 입력 상한 | 차원 | 엔진 | dtype | 결과 | RPS | p95 ms |
|---|---|---:|---:|---|---|---|---:|---:|
| multilingual-e5-small | cpu | 512 | 384 | tei | float32 | PASS | 40.6432 | 65.74 |
| multilingual-e5-small | gpu | 512 | 384 | tei | float16 | PASS | 66.9921 | 35.83 |
| multilingual-e5-base | cpu | 512 | 768 | tei | float32 | PASS | 36.0406 | 77.59 |
| multilingual-e5-base | gpu | 512 | 768 | tei | float16 | PASS | 73.1474 | 28.82 |
| embeddinggemma-300m | cpu | 2048 | 768 | tei | float32 | PASS | 12.7268 | 174.53 |
| embeddinggemma-300m | gpu | 2048 | 768 | tei | float32 | PASS | 25.0185 | 110.43 |
| multilingual-e5-large | cpu | 512 | 1024 | tei | float32 | PASS | 16.6109 | 155.12 |
| multilingual-e5-large | gpu | 512 | 1024 | tei | float16 | PASS | 47.9581 | 70.66 |
| KoE5 | cpu | 512 | 1024 | tei | float32 | PASS | 7.0870 | 327.38 |
| KoE5 | gpu | 512 | 1024 | tei | float16 | PASS | 37.2839 | 88.11 |
| mdbr-leaf-ir | cpu | 512 | 768 | tei | float32 | PASS | 50.0447 | 45.05 |
| mdbr-leaf-ir | gpu | 512 | 768 | tei | float16 | PASS | 75.9709 | 29.65 |
| KURE-v1 | cpu | 8192 | 1024 | tei | float32 | PASS | 5.9937 | 391.66 |
| KURE-v1 | gpu | 8192 | 1024 | tei | float16 | PASS | 70.7681 | 36.67 |
| nomic-embed-text-v1 | cpu | 8192 | 768 | tei | float32 | PASS | 28.2024 | 85.35 |
| nomic-embed-text-v1 | gpu | 8192 | 768 | tei | float16 | PASS | 71.1824 | 34.43 |
| nomic-embed-text-v1.5 | cpu | 8192 | 768 | tei | float32 | PASS | 27.2381 | 84.42 |
| nomic-embed-text-v1.5 | gpu | 8192 | 768 | tei | float16 | PASS | 78.8788 | 31.23 |
| embeddinggemma-2 | cpu | 8192 | 768 | ST | float32 | PASS | 12.2921 | 179.88 |
| embeddinggemma-2 | gpu | 8192 | 768 | ST | bfloat16 | PASS | 20.7146 | 140.29 |
| Qwen3-Embedding-4B | cpu | 32768 | 2560 | ST | float32 | PASS | 0.7267 | 2918.88 |
| Qwen3-Embedding-4B | gpu | 32768 | 2560 | ST | bfloat16 | PASS | 22.6871 | 107.23 |
| pplx-embed-v1-0.6b | cpu | 32768 | 1024 | ST | float32 | PASS | 5.6676 | 392.86 |
| pplx-embed-v1-0.6b | gpu | 32768 | 1024 | ST | float16 | PASS | 25.7286 | 91.34 |
| pplx-embed-v1-4b | cpu | 32768 | 2560 | ST | float32 | PASS | 0.8159 | 2780.68 |
| pplx-embed-v1-4b | gpu | 32768 | 2560 | ST | float16 | PASS | 21.8055 | 115.15 |
| kanana-nano-2.1b-embedding | cpu | 512 | 1792 | ST | float32 | PASS | 1.7848 | 1180.44 |
| kanana-nano-2.1b-embedding | gpu | 512 | 1792 | ST | bfloat16 | PASS | 34.6844 | 67.90 |
| Qwen3-VL-Embedding-2B | cpu | 32768 | 2048 | ST | float32 | PASS | 1.9018 | 1088.72 |
| Qwen3-VL-Embedding-2B | gpu | 32768 | 2048 | ST | bfloat16 | PASS | 25.6769 | 113.92 |
| pplx-embed-context-v1-0.6b | cpu | 32768 | 1024 | ST | float32 | PASS | 3.5974 | 620.02 |
| pplx-embed-context-v1-0.6b | gpu | 32768 | 1024 | ST | bfloat16 | PASS | 17.7785 | 131.29 |
| pplx-embed-context-v1-4b | cpu | 32768 | 2560 | ST | float32 | PASS | 0.3845 | 6014.72 |
| pplx-embed-context-v1-4b | gpu | 32768 | 2560 | ST | bfloat16 | PASS | 11.1112 | 246.94 |
| nomic-xlm-2048 | cpu | 2048 | 768 | — | — | BLOCKED | — | — |
| nomic-xlm-2048 | gpu | 2048 | 768 | — | — | BLOCKED | — | — |

`nomic-xlm-2048`의 입력 상한·차원은 선언값이다. 두 셀은 실제 prepare에서 차단됐고 서빙·벡터 출력·측정을 수행하지 않았다. 다른 17종은 해당 상한과 차원을 실제로 검증했다. Qwen3-VL 결과는 **텍스트 모달리티만** 포함한다.

짧은 12요청의 RPS/p95는 환경과 입력에 민감한 관측값이다. 모델 간 품질 순위, 전체 입력 길이 처리량, 정확도, 장시간 부하 안정성을 나타내지 않는다. 이 작업은 여러 셀을 오래 수행하고 재개하는 실행 체계의 E2E이며, 각 모델의 장시간 soak 테스트는 수행하지 않았다.

## 대표 6셀의 선행 실측

캠페인 `nas-defaults-261022-p18080`, 최종 보고서 sequence 68. 모두 TEI이며 각 셀에서 독립적으로 기능검사와 측정 12/12를 통과했다. 아래 값은 앞의 메인 캠페인과 다른 시도의 관측값이다.

| 모델 | 장치 | 입력 상한 | 차원 | dtype | RPS | p50 ms | p95 ms |
|---|---|---:|---:|---|---:|---:|---:|
| multilingual-e5-small | cpu | 512 | 384 | float32 | 71.0877 | 29.14 | 32.78 |
| multilingual-e5-small | gpu | 512 | 384 | float16 | 119.1611 | 14.58 | 24.37 |
| multilingual-e5-base | cpu | 512 | 768 | float32 | 35.5623 | 52.16 | 85.55 |
| multilingual-e5-base | gpu | 512 | 768 | float16 | 151.6783 | 11.16 | 19.00 |
| embeddinggemma-300m | cpu | 2048 | 768 | float32 | 12.5842 | 153.58 | 177.22 |
| embeddinggemma-300m | gpu | 2048 | 768 | float32 | 24.7867 | 55.46 | 157.83 |

## 실제 호출 중단과 다음 세션의 재개

최종 엄격 검증은 새 3셀 캠페인 `nas-continuity-proxyfix-261022`에서 수행했다. 최종 모델 보고서는 sequence 29, driver는 `passed=true`, `source_unchanged=true`, `completed_cell_unchanged=true`다. mock 또는 Python 호출을 실제 Codex로 대체 집계하지 않았다.

1. 실제 첫 Codex가 첫 CPU 셀을 완료하고 두 번째 GPU 셀의 serve를 시작했다.
2. 첫 Codex를 SIGKILL했다(exit -9). 해당 coordinator의 명령·PID identity 일치와 실제 종료를 확인했다. finite GPU worker는 살아 있었고 lease를 유지했다.
3. 실제 다른 Codex thread를 새로 호출했다(exit 0). 새 호출이 checkpoint에서 완료 셀을 건너뛰고 GPU bench 및 다음 모델 B의 build/serve/bench/stop을 수행했다.
4. 3셀 모두 현재 시도의 기능검사·유효 12요청 측정 PASS. 셀별 attempt는 1개, 복구나 완료 셀 중복 실행이 없었고, 검증 중 소스도 바꾸지 않았다.

초기 검증에는 두 결함이 있었다. 상대 캠페인 경로의 coordinator 종료를 놓친 실행은 기존 control PASS를 철회했다. 그 다음 실행은 worker가 종료된 caller의 프록시를 물려받아 로컬 API 연결에 실패했다. 정확한 loopback 대상으로만 caller 프록시와 독립된 연결을 사용하고 redirect를 거부하도록 수정한 뒤, 위의 새 캠페인에서 재검증했다. 원격 프록시 정책과 실패 원문은 유지했다.

체크포인트는 목표·셀·승인 참조·현재 attempt·미결 질문·증거·다음 작업을 보존한다. 같은 승인 조건의 복구는 셀 내부 새 attempt에 누적하며, 모델/승인 전략/비교 조건이 바뀌면 별도 셀을 사용한다. 실행 lease와 PID identity를 대조해 살아 있는 작업의 중복 실행을 막는다. 호출자 종료 검증은 호스트 재부팅이나 모든 외부 오케스트레이터의 장애 내성을 검증한 결과와는 구분한다.

## 관측한 실패와 복구

| 관측 | 처분과 최종 결과 |
|---|---|
| Codex `Selected model is at capacity` | 호출 제공자의 용량 오류로 분류. 같은 기본 모델의 후속 실제 discovery 성공. 임베딩 모델 실패로 집계하지 않음 |
| worker sandbox 옵션/실행 권한으로 Docker 소켓 차단 | 권한 프로필 우선순위를 확인하고 중복 옵션 제거, 고정 campaign 명령 승인 재사용. 모델 전략은 유지 |
| 초기 포트 8080 bind 거부 | 원래 BLOCKED/미검증 보고 보존. 같은 승인 영수증으로 18080 후속 캠페인에서 검증 |
| 장치 근거 누락 | 이미지·소유 컨테이너·가속기 할당·실제 로드/Ready 로그의 불변 관측을 연결. 설정값만으로 장치 증명을 만들지 않음 |
| EmbeddingGemma GPU TEI FP16 로드 실패 | 실제 Gemma3 FP32 요구 로그에 따라 같은 GPU·2048·768에서 FP32로 재시도해 PASS |
| Nomic TEI 설정 필드 누락 | 읽기 전용 원본은 유지. attempt 오버레이에 n_positions→max_position_embeddings 별칭, v1.5 학습 위치 2048 유지. 8192 경계 PASS |
| Gemma2 processor/pooling 미지원, Qwen3 TEI 로드·메모리 실패, 전용 모듈 | 사유를 남기고 같은 장치·기본 입력 상한·차원의 ST/전용 경로로 전환해 PASS. TEI가 양자화 모듈을 무시하도록 하지 않음 |
| PyTorch R2 wheel EOF·SHA-256 불일치 | 해시 검증 유지. 같은 공식 wheel의 CloudFront 경로에서 완전한 바이트/동일 기대 해시 확인 후 빌드 |
| Kanana 명시 head_dim을 거부하는 config 검증 | 모델의 실제 head/GQA 구조를 확인하는 제한된 초기화 호환 처리. 전역 검증기를 즉시 복원하고 missing/mismatched/unexpected weights 없이 실제 로드·512 경계 PASS |
| PPLX contextual config 클래스 identity 충돌 | 검토·해시 확인한 모델 클래스의 config_class로 로드. 기존 타입 검사 유지, CPU/GPU 실제 E2E PASS |
| PPLX context GPU FP16 비유한 출력 | 값을 대체하지 않고 같은 승인 조건의 BF16 경로에서 재검증, 두 크기 모두 PASS |
| 뒤늦은 Docker 조회 실패가 기존 capture를 훼손할 위험 | 실패 프로브를 별도 기록하고 기존 로그·inspection·장치 관측 보존. 기존 PASS의 원문 근거를 대조 |

Qwen3-VL은 공식 텍스트 processor/last-token 경로, Kanana는 non-causal mask와 공식 빈 instruction mean, PPLX context는 공식 late chunking 의미를 검토해 적용했다. PPLX 사용자 코드는 파일 해시뿐 아니라 AutoMap·토크나이저·모듈 진입점도 제한하고 오프라인 로드했다. 패딩 토큰 예산에 따른 마이크로배치 후 순서를 복구한다.

PPLX context에서 일반 `/v1/embeddings`의 각 문자열은 독립 1청크 문서다. 여러 청크의 문맥 처리는 `/v1/contextualizedembeddings`에서 문서별 배열을 사용한다. 기능검사에서 문서/청크 개수와 순서 매핑, 문서 전체 토큰 한도, 예약 구분자 거부를 확인했다. context 4B의 출력은 잘못된 일반 pooling 설정 1024를 따르지 않고 실제 native 2560으로 확인했다.

## 미해결과 재개 조건

`nomic-xlm-2048`은 로컬 설명의 AutoModelForMaskedLM, config의 NomicBertForPreTraining, modules.json 부재를 확인했다. 문장 임베딩의 pooling 파이프라인 근거가 부족해 CPU/GPU prepare를 BLOCKED로 종결했다. 이 결과는 모델이 영구적으로 임베딩 불가능하다는 판정이 아니다.

재개에는 검토·검증한 문장 임베딩 파이프라인과 갱신된 실제 전략 영수증이 필요하다. 실험 pooling은 명시 승인을 받은 새 셀로 분리한다. 단순 평균 풀링을 임의로 추가해 모델 기본값 PASS를 만들지 않는다. 기존 완료 PASS 셀은 재실행할 필요가 없으며 checkpoint를 직접 편집하지 않는다.

다음은 당시 Python 하네스의 역사적 명령이다.

```bash
python3 tools/embctl.py campaign status --campaign output/campaigns/nas-all-defaults-261022
```

현재 캠페인의 상태 조회는 아래 스킬 진입점을 사용한다. 스킬 팩 이관과 새 선별 검증은 [후속 보고서](skill-pack-luna-e2e.md)에 기록한다.

```bash
node .agents/skills/embedding-explorer/src/cli.ts campaign status --campaign output/campaigns/<id>
```

최종 정리 관측(2026-10-23 08:12:54 KST)에서 프로젝트 라벨의 실행·종료 컨테이너는 모두 0개였다. NAS 모델, 이미지·빌드 캐시, 실제 생성물·실패·측정 원문은 보존했다. 작업 인계에는 활성 worker와 미응답 HITL이 없고 두 BLOCKED의 후속 조건만 남았다.

## 소스 검증과 근거

메인 캠페인 완료 시 Python 회귀 76개 PASS, 초기 wiki-desk 회귀 240개 PASS를 확인했다. 이 합성·도구 테스트는 모델 PASS 수에 포함하지 않는다. 메인 캠페인의 Codex 로컬 리뷰는 7회였으며 초기 두 회의 발견 5건을 처분했고 후속 리뷰에서 추가 회귀를 점검했다. 외부 독립 리뷰어 검증으로 표현하지 않는다.

E2E 결과 감사 시점 소스는 `cfaa9ce5b0fd03302c5d605d5c19bc1a47256ef5`다. 이후 보고서·권한 설정 편집은 모델 E2E 재실행을 뜻하지 않는다. 원시 근거는 **비추적 로컬 산출물이므로 클론에는 포함되지 않는다.** 아래 저장소 상대 경로와 SHA-256으로 원문 스냅샷을 식별한다. 승인·환경·실효 설정·시도별 생성물·raw requests 연결은 각 캠페인 보고서와 checkpoint에서 찾는다.

| 근거 | 저장소 상대 경로 | SHA-256 |
|---|---|---|
| 메인 최종 보고서 | `output/campaigns/nas-all-defaults-261022/reports/448.json` | `377b70c875bf60772a792ec5ce32a24eb981eabc5ca47468024c56cf8bc85fa0` |
| 메인 표 원문 | `output/e2e/nas-all-defaults-261022/results.json` | `5cb786e0e34e7c03eb270d46f78cda1885206e1425a9d41002d89388984a3859` |
| 36셀 원문 대조 | `output/e2e/nas-all-defaults-261022/audit.json` | `bb06624f1b40d02e03906e4da1b55595e1481268a13a63043ca5837b3c3410f4` |
| 대표6셀 집계 | `output/e2e/nas-defaults-261022/model-summary.json` | `1084959984315743ad5a6d47d689e0c265649d3d60b7fff3b2da49f90ea55e30` |
| 엄격3셀 제어 검증 | `output/validation/campaign-exec/20261022T092752.463525Z/result.json` | `19759bcea2fb4ac8f4c50adf7b29dd2318c33ffb6d69f18af7fa10b1f89513e3` |
| 엄격 재개 최종 대조 | `output/e2e/nas-defaults-261022/final-verification.json` | `1e77b99c5755657e669462e6df071a4bd8978cdc7aa3e44329bd9d707b838088` |
| Nomic 실제 preflight | `output/e2e/nas-all-defaults-261022/nomic-xlm-preflight.json` | `b457b975b4b1f067263f3e4d94a3dbcf0454c96ca9e29a8e5ff7afd014cff2b1` |
| 최종 자원 정리 | `output/e2e/nas-all-defaults-261022/cleanup.json` | `ea2abe5243f756a66eb0d7671122da513b441a100ab64216785a3d25834aff69` |
| 리뷰 원문과 처분 | `output/e2e/nas-all-defaults-261022/review-index.json` | `087175bee446890a933a66c03f593915bd78688a264d56fb7929ff6861d195e6` |

서빙 절차는 [README](../../README.md), 셀 구분·증거·재개 계약은 [캠페인 규약](../../campaigns/README.md)을 참고한다.
