# 문서 발행 규칙

Planner의 계획, Builder의 수행 기록, Validator의 실제 검증을 남긴다.

| 경로 | 내용 |
|---|---|
| `docs/plan/` | 승인 목표·범위·단계·위험·완료 기준 |
| `docs/devlog/` | 결정·시도·폐기·최종 상태·재개 지침 |
| `docs/checklist/` | 실제 실행한 검증·모델별 E2E 결과·리뷰 처분 |

각 폴더의 `example.md`는 추적되는 골격이다. 실제 발행 문서는 기존 정책대로 비추적이며, 발행할 때마다 위키에 입고한다. 다른 문서 종류는 필요와 사용처가 있을 때만 추가한다.

## 이름과 근거

- `docs/<type>/<type>_<YYMMDDHH>[_MM_SS]_<주제>.md`. 시간은 KST 절대시각이다. 같은 type·시각이 점유됐을 때만 `_MM_SS`를 붙인다.
- 명명 정본: `.agents/skills/wiki-desk/src/doc_naming.ts`의 `datedDocBasename`.
- frontmatter에는 title·date·doc_type·status, 후속 devlog/checklist에는 plan 경로를 기록한다.
- 모델·HW·이미지/라이브러리 버전·날짜를 판정 맥락으로 남기고 측정/추정/테스트 값을 구분한다.
- 가변 소스의 줄번호를 근거로 인용할 때 커밋 SHA를 병기한다.
- 새 문서가 과거 판정을 뒤집을 때 선행 헤더에 `SUPERSEDED` 또는 `SUPERSEDED-IN-PART`와 후속 경로를 남긴다. 단순 보완은 인용한다.

## 발행과 재개

문서 작성 전·새 모델/복구 시작 전에 관련 근거를 조회한다. 검색 결과는 후보이므로 `read`로 원문을 확인한다.

```bash
node .agents/skills/wiki-desk/src/cli.ts query --terms "모델 아키텍처 실패"
node .agents/skills/wiki-desk/src/cli.ts sync --apply
node .agents/skills/wiki-desk/src/cli.ts check
```

`__llm-wiki/`는 원문을 복제하지 않는 로컬 포인터 서고다. Seed·출력 근거는 발행 문서에서 연결하며 원문과 산출물이 정본이다.

미완결 devlog에는 실제 디스크/컨테이너 상태, 대기 결정, 재개 명령과 예상 장애를 기록한다. 후속 과제는 `- [ ] 후속: <문제>`로 열고 문제·환경·실패 증거·기시도/결과·재현/재개 조건·산출물을 연결한다. 해소 문서에서 `- [x]`와 해소 경로로 닫는다.

모델별 PASS는 API 기능검사와 유효 경량 측정의 결합이다. 정확도 벤치·기준 벡터 비교·임의 속도 문턱을 기본 필수로 두지 않는다. 전체 검증·결과·미해결 보고 완료와 개별 모델 PASS는 별도 상태로 기록한다.
