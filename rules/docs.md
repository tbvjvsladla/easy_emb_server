# 문서 발행 규칙

Planner의 계획, Builder의 수행 기록, Validator의 실제 검증을 남긴다.

| 경로 | 내용 |
|---|---|
| `docs/plan/` | 승인 목표·범위·단계·위험·완료 기준 |
| `docs/devlog/` | 결정·시도·폐기·최종 상태·재개 지침 |
| `docs/checklist/` | 실제 실행한 검증·모델별 E2E 결과·리뷰 처분 |
| `docs/report/` | 배포자가 읽는 공개 결과 보고서·적용 조건·한계·후속 과제 |

각 폴더의 `example.md`는 추적되는 골격이다. plan/devlog/checklist의 실제 발행 문서는 비추적이며 발행할 때마다 위키에 입고한다. report는 아래 공개 규약을 따른다.

## 공개 보고서

easy-vllm-simulator의 report 채널을 따른다. `docs/report/<topic-slug>.md`는 주제별 최신 보고서이며 `.gitignore` 예외로 **실제 보고서도 추적**한다. 시점은 본문에, 변경 이력은 Git에 남긴다. 아래의 날짜 기반 작업문서 명명 규칙은 적용하지 않는다.

사용자가 요청하거나 결과 공유가 필요할 때 작성하며, 요약·범위/HW/설정·모델별 결과·검증 방법·실패와 복구·미해결/재개 조건·출처를 담는다. 실측과 합성 테스트를 구분하고 전체 처리 완료를 전 모델 PASS로 표현하지 않는다. 원시 근거는 비추적 `output/`에 보존하며 클론에 포함되지 않음을 밝힌다. 본문 표와 결론은 원시 파일 없이도 읽을 수 있게 한다.

보고서에 계정·호스트명·IP·NAS 실경로·인증정보를 넣지 않는다. HW 사양·모델 이름·측정 수치·저장소 상대 근거 경로는 공개할 수 있다. 발행 전 실제 추적 파일과 내용을 검토한다.

report는 내부 작업 이력용 wiki-desk 색인 범위에 추가하지 않는다. 작성·검증 근거와 보고서 경로는 plan/devlog/checklist에 기록하고 이 작업문서를 입고한다. 원시 결과가 판정의 정본이며 report 자체가 새로운 PASS 판정이나 실행 승인은 아니다.

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
