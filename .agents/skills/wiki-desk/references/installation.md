# 설치·초기화

## 전제
- Node.js 24 이상. `.ts`를 빌드 없이 직접 실행한다. 런타임 npm 의존성은 없다. 없으면 차단 사유를 보고하고 자동 설치하지 않는다.
- util-linux `flock(1)`. 없으면 잠금 없이 돌지 않고 거부한다.
- 스킬은 **폴더 전체**(`.agents/skills/wiki-desk/`)가 한 단위다. `SKILL.md`만 복사하는 것은 설치가 아니다.
- 설치 확인: 저장소 루트에서 `node .agents/skills/wiki-desk/src/cli.ts init --contract .agents/skills/wiki-desk/assets/project-contract.json`으로 초기화 계획을 확인한다(`--apply` 없이 쓰기 0). 이미 서고가 있으면 `status`·`check`로 확인한다.
- 이 프로젝트는 `temp/`·`tests/`를 로컬에만 보존한다. 테스트 소스가 있는 개발 환경에서는 `node .agents/validation/verify.ts --suite wiki` 또는 패키지 폴더의 `npm test`로 회귀를 실행한다. 공개본에서 테스트 소스가 없으면 `UNAVAILABLE`과 종료 코드 2를 반환하며 PASS로 표시하지 않는다.

## 서고 초기화
| 명령 | 쓰기 |
|---|---|
| `node .agents/skills/wiki-desk/src/cli.ts init --contract <계약 파일>` | 없음 — 생성 계획 출력 |
| 위 명령 + `--apply` | `<wiki_dir>/contract.json`·`receipt.json`·`.gitignore`(캐시 제외)·`index.md`·`log.md` 생성 |
| `… sync` → `… sync --apply` | 카드 생성 |
| `… check` | 없음 |

- `--contract`는 계약 JSON 파일 경로다(이 프로젝트: `.agents/skills/wiki-desk/assets/project-contract.json`). init은 그 바이트를 `<wiki_dir>/contract.json`으로 복사한다.
- `--root <프로젝트 루트>`를 생략하면 현재 디렉터리가 루트다. 계약의 `source_roots`가 루트 아래에 없으면 sync가 실패한다.
- 기존 서고(`__llm-wiki/`·`__llm_wiki/` 어느 쪽이든)가 있으면 `init`은 거부한다(덮어쓰기 없음).
- 적용 후 `status`·`check` 를 확인한다. 원문은 비추적(`docs/*/*`)이라 git diff 로는 불변을 확인할 수 없다 — 불변의 근거는 카드의 `source_sha256` 와 원문 바이트 해시 일치(`check` 의 stale 0)다.

## 서고 다시 만들기
제거 명령은 없다. 서고는 원문에서 파생되므로, 사람이 고친 카드·`verified` 기록을 먼저 옮겨 둔 뒤 `__llm-wiki/`를 지우고 `init --apply` → `sync --apply`로 다시 만든다.

## 인식 확인
파일 존재나 `status` 성공은 host가 스킬을 인식했다는 뜻이 아니다. 새 세션에서 스킬 목록·실제 로드를 따로 확인한다.
