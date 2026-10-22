---
name: embedding-upstream
description: "Choose and build TEI or sentence-transformers container recipes for the observed host; diagnose build failures and preserve reusable build evidence."
---

# 임베딩 런타임 업스트림

컨테이너·엔진/라이브러리 버전 선택, 생성 Dockerfile, 빌드 패치(pre/post), 실제 적용 이력과 빌드 실패의 근거를 소유한다.

1. wiki-desk로 같은 HW·엔진·실패 이력을 조회하고 원문을 읽는다. manifest와 승인 전략을 읽는다.
2. 공식 지원정보·릴리스·모델 config를 근거로 TEI 사용 가능성을 판단한다. 선택 장치·입력 길이·출력 차원을 만족해야 한다. 불가하면 같은 선택 장치에서 ST 경로를 구성한다.
3. 공식 이미지 재사용·파생 이미지·소스 빌드/패치 중 필요한 방법을 선택한다. 모델마다 불필요하게 무거운 빌드를 반복하지 않는다. 공통 자산은 식별 가능한 참조로 재사용한다.
4. `python3 tools/embctl.py build --strategy <승인 전략>`를 실행한다. 첫 무거운 작업 전에 조건·명령·시도·로그 위치가 기록돼야 한다. Dockerfile과 결과는 output에 생성한다.
5. 실패 원문·가설·변경점·적용 결과를 남기고 근거 있는 조정으로 재시도한다. 새로 시험할 조정이 없거나 작업에 맞게 정한 한계에 도달하면 미해결과 재개 조건을 남긴다.

서빙 전략 승인 이후 위상별 사람 직접 실행이나 일반 실패별 재승인을 기본으로 요구하지 않는다. 승인 장치·입력 길이·차원 자체의 변경은 HITL이다. 엔진/dtype는 근거로 자동 결정한다.

현재 HW에 맞는 자원/시간·무진전 관측 기준을 정한다. 과거 WSL 수치·GPU·잠금 규칙을 모든 환경에 일괄 적용하지 않는다. 다른 프로젝트 자산·전역 캐시를 정리하지 않는다.

이미지 빌드/import 성공은 서빙 PASS가 아니다. 모델 기동·검증은 explorer와 lite-bench로 연결한다. 빌드·런타임 패치는 필요할 때 실제 생성/적용된 것만 보존한다.
