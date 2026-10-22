# Codex 실행 승인 관리

프로젝트는 `.codex/config.toml`과 `.codex/rules/project.rules`를 사용한다. 모델별 CPU/GPU·입력 길이·출력 차원을 정하는 HITL은 실행 권한 승인과 별개다.

- `config.toml`: `embedding-workspace` 권한 프로필을 기본으로 선택한다. `:workspace`를 상속하고 필요한 패키지/이미지 출처·공식 문서·localhost·Docker 소켓 접근을 설정한다. `.git`·`.agents`·`.codex`·`.aws`의 기본 쓰기 보호는 유지한다.
- `project.rules`: 이 프로젝트의 테스트와 `embctl` 실행 접두어를 영구 저장한다. `approve`는 allow 규칙에 넣지 않으며 실제 사용자 결정을 기록한다. 허용 규칙이 실제 서빙 전략 승인을 대신하지 않는다.
- 공개 `project.rules`는 저장소 루트 기준의 상대 명령을 사용한다. 호스트 절대경로를 포함한 개인별 추가 규칙은 비추적 `.codex/rules/local.rules`에 둔다. Codex UI의 영구 허용은 기본적으로 사용자 전역 `~/.codex/rules/default.rules`에 저장된다. 프로젝트 규칙 파일로 자동 저장되는 것은 아니다.
- 전역에서 이미 허용한 명령도 계속 유효하다. 임시 `/tmp` 설치 스크립트의 허용을 새 프로젝트 규칙으로 계승하지 않는다.

복합 셸의 리다이렉션·변수·glob 때문에 명령 전체가 다른 접두어로 판정될 수 있다. 같은 검증은 고정 진입점으로 실행한다.

```bash
python3 tools/verify.py
python3 tools/verify.py --suite python
python3 tools/verify.py --suite wiki
```

실제 실행 명령과 로그·결과는 `output/validation/verify/<UTC시각>/`에 보존된다. 임의 명령 실행 인자는 받지 않는다.

`temp/`·`tests/`는 사용자 정책에 따라 중첩 위치까지 비추적이다. 위 테스트 명령은 로컬 테스트 소스가 있는 개발 환경에서 사용한다. 소스가 없는 suite는 `UNAVAILABLE`로 기록하고 성공으로 집계하지 않으며, 다른 실패가 없으면 종료 코드 2를 반환한다. 실제 모델 E2E는 `embctl bench`·캠페인으로 수행한다.

규칙 확인은 `codex execpolicy check --rules .codex/rules/project.rules -- <명령 토큰>`으로 한다. `allow`는 일치하는 명령의 샌드박스 밖 실행을 승인한다. 도메인 제한은 샌드박스 명령의 프록시 트래픽에만 적용되며, allow 규칙으로 밖에서 실행한 명령이나 Docker 데몬의 통신까지 제한하지 않는다.

새 설정과 규칙은 프로젝트를 신뢰한 **새 세션/재시작**에서 읽힌다. CLI 옵션·앱이 세션에 지정한 권한·조직의 requirements가 우선할 수 있다. 기존 `sandbox_mode`/`sandbox_workspace_write`와 새 권한 프로필은 함께 설정하지 않는다. 현재 실행 중인 세션의 권한을 파일 편집으로 바꿨다고 주장하지 않는다. 필요한 경우 새 세션에서 유효 권한을 확인한다.

근거: [공식 Rules](https://learn.chatgpt.com/docs/agent-configuration/rules), [Permissions](https://learn.chatgpt.com/docs/permissions), [설정 우선순위](https://learn.chatgpt.com/docs/config-file/config-basic). 이 저장소에서 확인한 CLI 버전은 `0.163.0`이다.
