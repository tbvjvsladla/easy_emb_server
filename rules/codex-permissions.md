# Codex 실행 승인 관리

프로젝트는 `.codex/config.toml`과 `.codex/rules/project.rules`를 사용한다. 모델별 CPU/GPU·입력 길이·출력 차원을 정하는 HITL은 실행 권한 승인과 별개다.

- `config.toml`: `embedding-workspace` 권한 프로필을 기본으로 선택한다. `:workspace`를 상속하고 필요한 패키지/이미지 출처·공식 문서·localhost·Docker 소켓 접근을 설정한다. `.git`·`.agents`·`.codex`·`.aws`의 기본 쓰기 보호는 유지한다.
- `project.rules`: 이 프로젝트의 테스트와 역할별 스킬 CLI 실행 접두어를 영구 저장한다. `approve`는 allow 규칙에 넣지 않으며 실제 사용자 결정을 기록한다. 허용 규칙이 실제 서빙 전략 승인을 대신하지 않는다.
- 공개 `project.rules`는 저장소 루트 기준의 상대 명령을 사용한다. 호스트 절대경로를 포함한 개인별 추가 규칙은 비추적 `.codex/rules/local.rules`에 둔다. Codex UI의 영구 허용은 기본적으로 사용자 전역 `~/.codex/rules/default.rules`에 저장된다. 프로젝트 규칙 파일로 자동 저장되는 것은 아니다.
- 전역에서 이미 허용한 명령도 계속 유효하다. 임시 `/tmp` 설치 스크립트의 허용을 새 프로젝트 규칙으로 계승하지 않는다.

## 승인된 캠페인과 관측 명령

2026-10-23 승인된 하네스 이식 뒤 2026-10-24 사용자 요청에 따라 실제 구현과 고정 진입점을 네 스킬 팩으로 이관했다. 기존 NAS 실행 승인 범위와 반복 실행 규칙을 유지한다.

| 위치 | 범위 |
|---|---|
| `config.toml` | 공식 wheel 리다이렉션에서 관측한 `download-r2.pytorch.org`. 기존 PyTorch/PyPI·이미지·loopback·Docker 소켓 허용 유지 |
| `config.toml` | 고정 Node 도구 설치용 `registry.npmjs.org`, 관측한 공식 GitHub 전송 경로 `github-cloud.githubusercontent.com` |
| `project.rules` | `node .agents/skills/embedding-upstream/src/cli.ts prepare/check`, 스크립트 실행 없는 고정 lock 설치 `npm ci --ignore-scripts --no-audit --no-fund` |
| `project.rules` | `node .agents/skills/embedding-explorer/src/cli.ts campaign`의 init/status/step/run/attach/retry/resolve/reopen/report |
| `project.rules` | `node .agents/validation/campaign_e2e.ts --mode freeze\|discovery\|campaign\|continuity`. continuity는 승인 영수증이 있는 캠페인의 실제 호출자 종료·재호출 검증 |
| `project.rules` | `docker ps`, `docker images`, `docker stats --no-stream`, `node .agents/validation/review.ts` |
| 비추적 `local.rules` | 이 호스트에서 드라이버가 생성하는 Node/도구 절대경로의 동일 범위 |

`approve`, `campaign answer`, 내부 `_work`, 임의 Node/셸, 일반 `codex exec`, Docker 전역 정리는 새 allow에 포함하지 않는다. `attach`도 기존 실제 영수증을 검증하며, 허용 규칙이 사용자 답변을 생성하지 않는다. `not_match`는 해당 규칙의 회귀 예제이며 다른 전역/관리 규칙의 allow를 취소하는 deny가 아니다.

호스트 절대경로와 `process.execPath`은 상대 명령과 다른 접두어다. 다른 개발 환경은 자신의 정확한 경로를 `local.rules`에 기록한다. WSL의 GPU 접근 거부는 다운로드 도메인 추가로 해결되지 않는다. `/dev` 전체나 보호 디렉터리의 쓰기 권한을 넓히지 않는다. R2 전송 중단/해시 불일치 역시 도메인 허용과 별개이므로 무결성 검증을 유지한다.

GPU 관측은 승인한 terraforming-node의 `init`·lite-bench의 `bench`·캠페인 내부의 고정 조회를 사용한다. 직접 `nvidia-smi` 접두어는 프로젝트 allow에 추가하지 않는다. query 뒤에 `--filename`을 붙이면 보호 파일도 덮어쓸 수 있기 때문이다. 직접 진단이 필요하면 이미 승인한 실제 명령 범위를 재사용하며, 새 인자까지 승인된 것으로 해석하지 않는다.

복합 셸의 리다이렉션·변수·glob 때문에 명령 전체가 다른 접두어로 판정될 수 있다. 같은 검증은 고정 진입점으로 실행한다.
Codex 0.163.0의 실제 동일 세션 관측에서 모든 token을 double quote한 명령은 임시 PID namespace에서 실행됐고, 같은 argv의 plain 명령은 기존 allow 규칙으로 host namespace에서 실행됐다.
실행 파일·진입점·고정 옵션은 plain word로 유지하고 공백·특수문자를 가진 값만 POSIX 인용한다. JSON argv 표현 자체를 shell escaping으로 사용하지 않는다.
이는 기존 승인 규칙에 맞는 명령 생성 계약이며 권한 확대나 namespace 게이트 해제는 아니다.

```bash
node .agents/validation/verify.ts
node .agents/validation/verify.ts --suite harness
node .agents/validation/verify.ts --suite wiki
```

실제 실행 명령과 로그·결과는 `output/validation/verify/<UTC시각>/`에 보존된다. 임의 명령 실행 인자는 받지 않는다.

리뷰는 `node .agents/validation/review.ts`로 실행한다. 이 진입점은 추가 인자를 거부한 뒤 저장소 루트에서 고정 Astra max의 `codex review --uncommitted`만 실행하고 원문을 output에 기록한다. 직접 Codex 접두어는 `-c`로 새 MCP 명령 등을 끼워 넣을 수 있어 프로젝트 allow에 넣지 않는다. 이번 보완 과정에서 저장한 해당 전역 허용 한 건도 제거했다. 기존의 다른 사용자 전역 승인은 유지한다.

`bash -lc 'node .agents/validation/review.ts > ...'`는 위 접두어와 일치하지 않을 수 있다. 외부 호출자는 argv 실행의 stdout을 로그로 저장하거나 이미 승인한 정확한 래퍼를 재사용한다. 임의 `bash -lc` 전체를 허용하지 않는다.

`temp/`·`tests/`는 사용자 정책에 따라 중첩 위치까지 비추적이다. 위 테스트 명령은 로컬 테스트 소스가 있는 개발 환경에서 사용한다. 소스가 없는 suite는 `UNAVAILABLE`로 기록하고 성공으로 집계하지 않으며, 다른 실패가 없으면 종료 코드 2를 반환한다. 실제 모델 E2E는 lite-bench의 `bench`·캠페인으로 수행한다.

규칙 확인은 `codex execpolicy check --rules .codex/rules/project.rules -- <명령 토큰>`으로 한다. `allow`는 일치하는 명령의 샌드박스 밖 실행을 승인한다. 도메인 제한은 샌드박스 명령의 프록시 트래픽에만 적용되며, allow 규칙으로 밖에서 실행한 명령이나 Docker 데몬의 통신까지 제한하지 않는다.

새 설정과 규칙은 프로젝트를 신뢰한 **새 세션/재시작**에서 읽힌다. CLI 옵션·앱이 세션에 지정한 권한·조직의 requirements가 우선할 수 있다. 기존 `sandbox_mode`/`sandbox_workspace_write`와 새 권한 프로필은 함께 설정하지 않는다. 현재 실행 중인 세션의 권한을 파일 편집으로 바꿨다고 주장하지 않는다. 필요한 경우 새 세션에서 유효 권한을 확인한다.

근거: [공식 Rules](https://learn.chatgpt.com/docs/agent-configuration/rules), [Permissions](https://learn.chatgpt.com/docs/permissions), [설정 우선순위](https://learn.chatgpt.com/docs/config-file/config-basic). 이 저장소에서 확인한 CLI 버전은 `0.163.0`이다.
