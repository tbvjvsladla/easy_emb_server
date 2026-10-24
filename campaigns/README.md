# Campaigns — 세션 간 임베딩 E2E 체크포인트

이 폴더는 추적되는 템플릿과 재개 규약이다. 실제 인스턴스는 비추적
`output/campaigns/<campaign-id>/`에 생성한다. 모델별 원문 증거는 기존
`output/<model>/attempts/<attempt-id>/`가 소유하며 캠페인은 그 경로를 연결한다.

새 세션·compact 뒤·외부 워커 호출은 먼저 다음 명령으로 시작한다.

```bash
node .agents/skills/embedding-explorer/src/cli.ts campaign status --campaign output/campaigns/<id>
node .agents/skills/embedding-explorer/src/cli.ts campaign step --campaign output/campaigns/<id>
```

`status`는 목표·현재 셀/attempt·승인·미결 질문·실행 소유권·다음 작업·여정 끝부분을 JSON으로 반환한다.
실패 후에는 `recovery_options`에 같은 승인 장치의 복구 후보와 실제 재시도 옵션·차단 근거를 포함한다.
`step`은 실제 소유권과 상태를 확인하고 유한 단계 하나를 시작하거나 살아 있는 작업을 관측한다.
대화 기억이나 이전 호출의 마지막 문장을 정본으로 삼지 않는다.

## 생성과 진행

```bash
node .agents/skills/embedding-explorer/src/cli.ts campaign init --spec /path/to/campaign.yaml
node .agents/skills/embedding-explorer/src/cli.ts campaign run --campaign output/campaigns/<id> --timeout 600
```

`run`은 유한 호출 예산 안에서 진행하고 예산에 도달하면 현재 상태를 반환한다. 실제 단계 worker는
별도 세션의 유한 프로세스이며, 호출이 끊겨도 lease를 유지한다. 다음 호출은 같은 체크포인트에서
살아 있는 작업을 관측한다. 자체 Codex 세션 기동기나 외부 오케스트레이터를 설치하지 않는다.

`campaign.yaml`은 초기화 시 고정한 선언, `checkpoint.json`은 상태·승인·HITL·여정의 정본이다.
상태 파일을 손으로 편집하지 않는다. 저장과 실행의 잠금은 별개이며 PID에 boot/start identity를
함께 대조한다. 실제 하위 명령도 실행 lease를 물려받으므로 부모 종료가 중복 빌드를 허용하지 않는다.

셀은 **모델 × 승인 전략 × 선언한 비교 조건**이다. 같은 목표의 복구·재시도는 셀 내부 attempt로
누적한다. `comparison`에는 device/context_window/dimensions를 선언할 수 있고 선언값을
바꿀 때는 새 셀을 만든다. `build.builder`와 `build.recipes`로 다른 빌드 셋업을 구분한다.
recipes는 실제 생성 Dockerfile 이름에서 원본 파일 경로로 연결하며 초기화 때 내용/출처를 고정한다.
이름만 붙여 적용하지 않는 비교축은 허용하지 않는다.

## 사람의 결정

기존 승인 영수증을 셀 선언의 `strategy`로 참조하거나, 시작 전 명시적으로 연결한다.

```bash
node .agents/skills/embedding-explorer/src/cli.ts campaign attach --campaign output/campaigns/<id> --cell <cell> --strategy output/<model>/strategies/<receipt>.yaml
```

영수증이 없으면 CPU/GPU → 최대 입력 토큰 → 출력 차원 순서로 `input-required`를 반환한다.
질문 ID·대상 셀·승인 범위·진행/재개점은 반복 호출에도 유지된다. 호출자는 실제 사람의 답변을
다음 형태의 JSON 파일로 전달한다. 그 파일은 사용자 결정을 기록하는 입력이며 템플릿의 예시는 승인이 아니다.

```json
{"request_id":"status의 hitl.id", "cell_id":"대상 셀", "value":"cpu", "source":{"path":"/path/to/actual-session.jsonl","line":1,"sha256":"exact-line-sha256","quote":"실제 사용자 답변"}}
```

```bash
node .agents/skills/embedding-explorer/src/cli.ts campaign answer --campaign output/campaigns/<id> --answer /path/to/human-answer.json
```

출처 형식과 실제 사용자 메시지 검사는 `.agents/skills/embedding-explorer/references/approval.md`를 따른다. 다른 셀·바뀐 모델·이미 답한 질문에 다른 답변은 적용하지 않는다. 외부 호출자가 승인을 만들어내지 않는다.
기존 승인 범위의 빌드·분석·패치·재시도는 자율이고, 세션이 바뀌었다는 이유로 다시 묻지 않는다.
승인 이후 모델/근거가 바뀌면 `field=strategy` 질문으로 중단한다. 실제 재확인한 호환 영수증 경로를
`value`로 전달한다. 이미 실행한 셀의 장치·토큰·차원을 바꾸려면 새 셀을 선언한다.

## 복구와 결과

`next_action=diagnose-and-retry-or-resolve`이면 worker 로그, 실제 attempt와 자원을 읽는다.
복구에는 직전 실패·확인할 가설·변경을 연결한다. 새 빌드 시도는 새 attempt이고, 살아 있는 명령을
중복 실행하지 않는다. TEI 실패 뒤 같은 승인 장치의 ST로 전환할 때도 원문 실패 근거를 남긴다.

사전 판정이나 자산 생성이 실패해 아직 attempt가 없어도 해당 셀의 `recovery`와
`workers/<operation-id>.json`에 원인을 보존한다. 다음 호출은 같은 준비를 자동 반복하지 않는다.
근거 있는 수정은 `retry`로 재개하고, 미해결은 증거와 재개 조건을 남겨 `resolve`한다.

지원되는 같은 장치 ST 복구 후보가 남으면 `resolve`는 `RECOVERY_REVIEW_REQUIRED`와 재시도 옵션을 반환한다.
실제 실패나 같은 고정 빌드 입력의 입증된 장애, 지원 부재, 복구 한도 소진을 판별한 뒤 차단을 기록한다.
`unresolved/`의 새 handoff는 현재 실패 worker·원래 operation·승인·모델·upstream과 복구 검토를 묶는다.
`--evidence`로 제공한 과거 자료는 배경 근거로 별도 보존하며 현재 실패를 대신하지 않는다.

```bash
node .agents/skills/embedding-explorer/src/cli.ts campaign retry --campaign output/campaigns/<id> --cell <cell> --reason '<실패>' --hypothesis '<가설>' --change '<변경>' --observation /path/to/new-evidence
node .agents/skills/embedding-explorer/src/cli.ts campaign resolve --campaign output/campaigns/<id> --cell <cell> --outcome BLOCKED --reason '<문제>' --evidence /path/to/evidence --resume-condition '<재개 조건>'
node .agents/skills/embedding-explorer/src/cli.ts campaign report --campaign output/campaigns/<id>
node .agents/skills/embedding-explorer/src/cli.ts campaign reopen --campaign output/campaigns/<id> --cell <미해결셀> --reason '<재개 조건 충족 근거>'
```

호출 결과, 셀 판정, 전체 검증/결과/미해결 보고 완료, 재개 가능성은 별개다. PASS는 같은 attempt의
실제 API 기능검사와 유효 경량 측정이 모두 성립할 때만 기록한다. 부분 결과·빌드 성공·과거 PASS로
현재 셀을 완료하지 않는다. 미해결은 이유·증거·재개 조건을 남기고 다음 셀로 진행할 수 있다.
`reopen`은 이전 보고서·미해결 근거·실패 attempt를 보존한 채 복구 결정 대기 상태로 다시 연다.
이후 `retry`에 실제 설정 변경 또는 새로운 `--observation` 근거를 전달한 다음 `step/run`으로 진행한다.
기존 attempt 횟수와 경과 시간 한도는 유지하며, 한도에 도달한 셀은 다시 열 수 없다.
재시도에서 생략한 엔진·dtype·timeout·builder는 직전 attempt의 값을 이어받는다. 다음 보고서는 새 파일이다.
프로세스 소유권은 관측한 PID namespace·boot·생성 시각까지 대조한다. 다른 namespace나 관측 불가 상태는
종료로 판정하지 않으며 원래 실행 환경에서 고정 `campaign step/run` 진입점으로 재개한다.
PID 1의 실제 argv[0]가 `codex-linux-sandbox`인 일시 실행 환경에서는 새 detached worker를 시작하지 않는다.
`EPHEMERAL_EXECUTION_NAMESPACE`가 나오면 승인된 실행 파일·진입점·고정 인자를 불필요한 따옴표로 감싸지 않은 단일 명령으로 호출한다.
공백이나 shell 특수문자를 포함하는 값만 안전하게 인용한다. 평가 driver는 이 명령 문자열을 코드로 생성하며 호출자는 그대로 사용한다.
프로젝트 실행 규칙을 바꾼 직후 기존 세션에 반영되지 않았다면 신뢰된 새 Codex 세션에서 같은 진입점을 사용한다.
hint-publisher와 hint 태그 발행은 구현하지 않는다.

## 실제 Luna none 평가

개발·검증을 마친 소스/정책/스킬과 공식 upstream 입력을 고정한 뒤 실제 Codex CLI로 평가한다. 모델과 추론강도는 gpt-6-luna/none으로 고정하며 실제 session_meta/turn_context와 도구 호출을 대조한다.

```bash
node .agents/validation/campaign_e2e.ts --mode freeze --evaluation output/evaluations/<새-id> --upstream-snapshot output/host/upstream-lock.json
node .agents/validation/campaign_e2e.ts --mode discovery --evaluation output/evaluations/<새-id> --timeout 300
node .agents/validation/campaign_e2e.ts --mode campaign --evaluation output/evaluations/<새-id> --campaign output/campaigns/<full36> --group full36 --coverage /path/to/coverage.json --timeout 86400
node .agents/validation/campaign_e2e.ts --mode campaign --evaluation output/evaluations/<새-id> --campaign output/campaigns/<representative6> --group representative6 --coverage /path/to/coverage.json --timeout 86400
node .agents/validation/campaign_e2e.ts --mode continuity --evaluation output/evaluations/<새-id> --campaign output/campaigns/<strict3> --group strict3 --coverage /path/to/coverage.json --timeout 86400
```

discovery는 네 스킬의 SKILL.md·전용 CLI·역할별 실제 구현 경로를 모두 대조한다.

freeze 이후 새 캠페인을 init한다. 선언에는 evaluation_id/group, 각 셀에 condition_id와 같은 고정 upstream 파일의 build.release_snapshot을 넣는다. init은 모델 효과를 실행하지 않는다. 최초 driver 호출 전에 step/run/build/serve/bench를 대신 수행하지 않는다.

coverage는 conditions 배열이며 condition_id/model/model_path/device/context_window/dimensions/prior_outcome/allowed_outcomes를 담는다. 원래 36개 조건 중 34 PASS는 각각 새 PASS를 요구하며 기존 nomic-xlm CPU/GPU 두 조건만 현재 재판정·복구 근거와 재개 조건이 있는 BLOCKED를 허용한다. 대표 6개와 엄격 3개는 각각 별도의 새 실측을 요구한다. 스킬 팩 이관 검증 `difficult6`는 Qwen3-Embedding-4B, Qwen3-VL-Embedding-2B, pplx-embed-context-v1-4b의 원래 CPU/GPU 6조건을 고정하며 전부 새 PASS를 요구한다. 세 종 모두 32768토큰, 차원은 각각 2560/2048/2560이다. 과거 PASS나 다른 조건의 개수로 대신하지 않는다.

strict3는 small CPU → small GPU → base CPU의 순서다. 두 번째 셀의 실제 serve/bench worker가 실행 중일 때 caller와 coordinator를 종료하고, 살아 있는 worker를 유지한 채 새 Luna thread에서 재개한다. 완료된 첫 셀의 불변성과 원래 worker의 단 한 번 수행을 대조한다. 세 가지 장애 시나리오를 뜻하지 않는다.

원문 events/runtime proof, 종료 상태, 중단 전후 checkpoint, 조건별 attempt/result, 최종 판정은 evaluation 디렉터리에 남는다. 실패나 인증/모델 가용성 문제에 다른 모델·mock·직접 스크립트를 대체해 PASS로 만들지 않는다. 최종 실행의 출처/설정 고정이 깨지거나 상위 모델의 해결 개입이 필요하면 해당 평가를 보존하고 개발에서 수정한 뒤 새 evaluation 전체를 실행한다.

실행은 프로젝트 default_permissions를 따른다. Docker 소켓 허용 프로필을 덮어쓰는 sandbox 옵션을 추가하지 않는다. discovery만 읽기 전용 호출이다. 관측된 실행 권한과 실제 HITL 승인은 별개이며, 미응답 HITL은 그대로 반환한다.
