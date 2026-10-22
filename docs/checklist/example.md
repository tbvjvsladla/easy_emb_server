---
title: "<제목>"
date: <YYYY-MM-DD>
doc_type: checklist
plan: docs/plan/plan_<YYMMDDHH>_<주제>.md
status: 진행 중 | PASS | FAIL
---

# checklist_<YYMMDDHH>_<주제>

> 추적되는 골격이다. 실제 checklist 는 `checklist_<YYMMDDHH>[_MM_SS]_<주제>.md` 로 이 폴더에 두며 비추적이다. 규칙 정본: `rules/docs.md`.

- 유효맥락: <커밋 SHA> · <GPU/HW> · <이미지 태그> · <YYYY-MM-DD>

## 1. 단계 체크

- [ ] 사전 판정(TEI / ST + 근거)
- [ ] 기동
- [ ] `/health` 200
- [ ] `/v1/embeddings` 응답
- [ ] API 개수·순서·차원·finite와 장치·입력 정책 확인
- [ ] 선언형 경량 측정·요청 회계·RAM/적용 가능한 VRAM 관측

## 2. 모델별 E2E 결과

| 모델 | 아키텍처 | 엔진 경로(TEI/ST) | health | /v1/embeddings | 기능검사 | 유효 경량 측정·메모리 관측 | 판정 | 실패 사유/증거 |
|---|---|---|---|---|---|---|---|---|

## 3. 리뷰 기록

| 리뷰어 | 대상 커밋 | 발견 | 처분 |
|---|---|---|---|
