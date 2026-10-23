---
name: terraforming-node
description: "Scan this node and initialize or refresh manifest.yaml for embedding serving; use on first setup or when host capabilities change."
---

# 노드 초기화

단일 노드의 HW 관측과 manifest를 소유한다. [공통 게이트 계약](../../../rules/harness.md)을 따른다. 초기화 또는 환경 변경 때 사용한다.

1. `node tools/embctl.ts init --out manifest.yaml`을 실행한다. 모델 저장소 디스크를 관측하려면 `--model-root <경로>`를 추가한다.
2. manifest 원문에서 관측값·출처·상태를 확인한다. CPU-only는 유효하다. 장치 없음·도구 없음·관측 실패·미확인을 구별한다.
3. 모델 조사와 HITL을 explorer에 연결한다. 빌드/서빙은 승인 당시 환경과 현재 HW 적용성 게이트를 다시 통과한다.

샌드박스 GPU/Docker 접근 실패를 장치 없음으로 바꾸지 않는다. HW 목록을 지원 상한으로 고정하지 않으며, 새 경로가 없으면 `adapter_required` 근거를 남긴다. 기존 승인 manifest snapshot은 보존한다. 다중 노드는 범위 밖이다.

코드·실패 처리: [references/gates.md](references/gates.md).
