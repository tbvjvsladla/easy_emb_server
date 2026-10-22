---
name: embedding-explorer
description: "Inspect an embedding model, collect device/context/dimension HITL choices, generate its serving assets, and run TEI-first or sentence-transformers fallback."
---

# 임베딩 모델 서빙

모델 프로필·서빙 HITL·실효 설정·기동·런타임 조정과 모델별 .yaml/.sh/.env 및 필요한 런타임 패치를 소유한다.

- 먼저 wiki-desk로 같은 모델·아키텍처·실패의 근거를 조회한다. `python3 tools/embctl.py inspect --model <경로>`로 config·ST modules·권장 prompt/pooling/normalization·지원 길이/차원을 조사한다.
- **CPU/GPU를 먼저**, 최대 입력 토큰과 출력 차원을 각각 HITL로 확정한다. 원래 차원과 지원/권장 축소를 보여 주고 선택한다. 확인되지 않은 값은 표시한다. 모델별 값을 임의로 채워 승인됐다고 기록하지 않는다.
- `python3 tools/embctl.py approve --model <경로> --device <장치> --context-window <토큰> --dimensions <차원 또는 native> --approval-reference <실제 승인 근거>`로 결정과 근거를 기록한다.
- 모델 권장 설정을 우선하며 없으면 엔진 기본값이라고 표시한다. 엔진/dtype는 자동 결정한다. TEI 가능→TEI, 불가→ST는 같은 선택 장치와 설정에서 적용한다.
- `python3 tools/embctl.py serve --strategy <승인 전략>`로 생성된 빌드·서빙 자산을 사용한다. TEI 라우터가 모델을 거부할 때도 ST 대체 HTTP 경로가 실제로 기동해야 한다.
- 기본 API는 /v1/embeddings다. 용처·포트·컨테이너 유지 등은 원본 관련 정책과 사용자의 실제 요청에 맞춘다. 기본 API 경로를 반복해서 묻지 않는다.
- 기동 후 실제 엔진·장치·입력/차원 적용을 확인하고 경량검증에 넘긴다. 과거 PASS·정적 모델 분류·빌드 성공을 현재 서빙 PASS로 삼지 않는다.

다른 모델로 넘어가기 전 이 프로젝트가 실행한 컨테이너의 상태와 필요한 로그를 보존한다. 모델·전략·시도·산출물·문서를 연결하고 미해결 문제는 새 세션이 조회해 재개하도록 남긴다.
