# Campaigns — 세션 간 임베딩 E2E 체크포인트

이 폴더는 추적되는 템플릿과 재개 규약이다. 실제 인스턴스는 비추적
`output/campaigns/<campaign-id>/`에 생성한다. 모델별 원문 증거는 기존
`output/<model>/attempts/<attempt-id>/`가 소유하며 캠페인은 그 경로를 연결한다.

새 세션·compact 뒤·외부 워커 호출은 먼저 다음 명령으로 시작한다.

```bash
python3 tools/embctl.py campaign status --campaign output/campaigns/<id>
python3 tools/embctl.py campaign step --campaign output/campaigns/<id>
```

`status`는 목표·현재 셀/attempt·승인·미결 질문·실행 소유권·다음 작업·여정 끝부분을 JSON으로 반환한다.
`step`은 실제 소유권과 상태를 확인하고 유한 단계 하나를 시작하거나 살아 있는 작업을 관측한다.
대화 기억이나 이전 호출의 마지막 문장을 정본으로 삼지 않는다.

## 생성과 진행

```bash
python3 tools/embctl.py campaign init --spec /path/to/campaign.yaml
python3 tools/embctl.py campaign run --campaign output/campaigns/<id> --timeout 600
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
python3 tools/embctl.py campaign attach --campaign output/campaigns/<id> --cell <cell> --strategy output/<model>/strategies/<receipt>.yaml
```

영수증이 없으면 CPU/GPU → 최대 입력 토큰 → 출력 차원 순서로 `input-required`를 반환한다.
질문 ID·대상 셀·승인 범위·진행/재개점은 반복 호출에도 유지된다. 호출자는 실제 사람의 답변을
다음 형태의 JSON 파일로 전달한다. 그 파일은 사용자 결정을 기록하는 입력이며 템플릿의 예시는 승인이 아니다.

```json
{"request_id":"status의 hitl.id", "cell_id":"대상 셀", "value":"cpu", "approval_reference":"실제 사용자 답변의 출처"}
```

```bash
python3 tools/embctl.py campaign answer --campaign output/campaigns/<id> --answer /path/to/human-answer.json
```

다른 셀·바뀐 모델·이미 답한 질문에 다른 답변은 적용하지 않는다. 외부 호출자가 승인을 만들어내지 않는다.
기존 승인 범위의 빌드·분석·패치·재시도는 자율이고, 세션이 바뀌었다는 이유로 다시 묻지 않는다.
승인 이후 모델/근거가 바뀌면 `field=strategy` 질문으로 중단한다. 실제 재확인한 호환 영수증 경로를
`value`로 전달한다. 이미 실행한 셀의 장치·토큰·차원을 바꾸려면 새 셀을 선언한다.

## 복구와 결과

`next_action=diagnose-and-retry-or-resolve`이면 worker 로그, 실제 attempt와 자원을 읽는다.
복구에는 직전 실패·확인할 가설·변경을 연결한다. 새 빌드 시도는 새 attempt이고, 살아 있는 명령을
중복 실행하지 않는다. TEI 실패 뒤 같은 승인 장치의 ST로 전환할 때도 원문 실패 근거를 남긴다.

```bash
python3 tools/embctl.py campaign retry --campaign output/campaigns/<id> --cell <cell> --reason '<실패>' --hypothesis '<가설>' --change '<변경>'
python3 tools/embctl.py campaign resolve --campaign output/campaigns/<id> --cell <cell> --outcome BLOCKED --reason '<문제>' --evidence /path/to/evidence --resume-condition '<재개 조건>'
python3 tools/embctl.py campaign report --campaign output/campaigns/<id>
python3 tools/embctl.py campaign reopen --campaign output/campaigns/<id> --cell <미해결셀> --reason '<재개 조건 충족 근거>'
```

호출 결과, 셀 판정, 전체 검증/결과/미해결 보고 완료, 재개 가능성은 별개다. PASS는 같은 attempt의
실제 API 기능검사와 유효 경량 측정이 모두 성립할 때만 기록한다. 부분 결과·빌드 성공·과거 PASS로
현재 셀을 완료하지 않는다. 미해결은 이유·증거·재개 조건을 남기고 다음 셀로 진행할 수 있다.
`reopen`은 이전 보고서/미해결 근거를 보존한 채 해당 셀을 다시 연다. 다음 보고서는 새 파일이다.
hint-publisher와 hint 태그 발행은 구현하지 않는다.

## 실제 새 Codex 호출 검증

```bash
python3 tools/campaign_e2e.py --mode discovery --timeout 300
python3 tools/campaign_e2e.py --mode continuity --campaign output/campaigns/<새로운-3셀-캠페인> --timeout 1800
python3 tools/campaign_e2e.py --mode continuity --campaign output/campaigns/<진행중-캠페인> --resume-existing --timeout 1800
```

discovery는 실제 `codex exec`가 이 저장소의 재개 규약을 찾는지 확인한다. continuity는 사전 승인된
A/조건1 → A/조건2 → B/조건1에서 두 번째 셀 도중 첫 Codex/호출자를 종료하고 실제 새 호출로
이어간다. 유한 단계 worker는 유지하며 완료 셀의 불변성·서로 다른 호출 ID·실제 측정 보고서를 검증한다.
호출된 Codex는 같은 승인 전략의 실패 근거를 읽고 campaign retry로 복구할 수 있다. 새 HITL은
즉시 인계하며 checkpoint·선언·승인을 직접 편집하거나 실행 소유권을 우회하지 않는다.
`output/validation/campaign-exec/`에 원문 이벤트·종료 상태·중단 전후 체크포인트와 검증 결과가 남는다.
기존 CLI 모델 선택을 사용하며 인증/용량 오류를 모델 E2E PASS로 바꾸지 않는다.
`--resume-existing`은 첫 셀의 실제 측정 완료와 두 번째 셀의 진행 상태를 검증한 뒤 시작한다.
완료 셀을 다시 수행하지 않고 시작·중단·재개 후에도 같은 증거/상태가 유지되는지 확인한다.
실행 호출은 프로젝트의 기존 `default_permissions`를 따른다. `--sandbox workspace-write`를 덧붙이면
Docker 소켓을 허용한 프로필이 대체되므로 실행 드라이버는 해당 옵션을 넣지 않는다. discovery만
명시적인 읽기 전용 호출이다.

TEI의 실제 장치 관측은 기존 경량 검증 계약의 `device-evidence.json`이 필요하다. 해당 증거가
없거나 API/측정이 실패하면 recovery로 돌아온다. 실제 attempt 로그/장치 할당을 확인해 근거를
남긴 뒤 `retry --phase bench`로 재검증한다. 테스트용 합성 서버는 실제 모델 PASS 근거가 아니다.
