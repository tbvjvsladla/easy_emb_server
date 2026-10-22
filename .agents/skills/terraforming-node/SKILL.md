---
name: terraforming-node
description: "Scan this node and initialize or refresh manifest.yaml for embedding serving; use on first setup or when host capabilities change."
---

# 노드 초기화

이 스킬은 단일 노드의 HW 관측과 manifest 계약을 소유한다. OS/WSL·CPU 아키텍처·메모리·가속기·컨테이너 런타임·모델 저장소의 사실과 출처를 기록한다.

`python3 tools/embctl.py init --model-root <모델 루트>`로 관측하고 결과 manifest를 읽는다. CPU-only도 유효하다. 장치 없음·도구 없음·관측 실패를 구분하고 미확인 값을 추측으로 채우지 않는다.

manifest의 관측값, 모델별 선택 장치와 어댑터/팩토리 경로, 실제 검증 상태는 다른 정보다. 특정 CPU/GPU 목록이나 현재 실증 환경을 기능 적용 상한으로 고정하지 않는다. 다른 환경에서 발견한 공백은 관측 근거와 후속 과제로 보존한다.

빌드·서빙은 최신 manifest를 입력으로 사용한다. 환경이 바뀌면 다시 관측하고 재사용 조건을 대조한다. 노드 오케스트레이션·블랙박스·다중 노드 제어는 포함하지 않는다.

운영 계약은 프로젝트 `AGENTS.md`와 `rules/workflow.md`를 따른다.
