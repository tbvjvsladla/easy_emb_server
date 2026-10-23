# 실제 승인·서빙 게이트

코드: `tools/embedding/models.ts`의 `inspectModel/validateUserSource/approve/checkedStrategy`, `attempts.ts`의 `serve`, `campaign.ts`의 `answer/attachStrategy`.

새 승인 JSON:
```json
{"schema":"embedding-user-approval/1","model_path":"/path/to/model","selections":[
  {"key":"device","value":"cpu","source":{"path":"/path/to/actual-session.jsonl","line":1,"sha256":"exact-line-sha256","quote":"실제 답변"}},
  {"key":"context_window","value":512,"source":{"path":"/path/to/actual-session.jsonl","line":2,"sha256":"exact-line-sha256","quote":"실제 답변"}},
  {"key":"dimensions","value":"native","source":{"path":"/path/to/actual-session.jsonl","line":3,"sha256":"exact-line-sha256","quote":"실제 답변"}}
]}
```

예시는 승인이 아니다. 실제 Codex JSONL의 1부터 시작하는 줄번호와 줄바꿈 제외 원문 SHA256을 사용한다. `payload.type=message`, `payload.role=user`, 텍스트 포함 관계를 검사한다. 요약으로 만든 가짜 session 파일을 출처로 만들지 않는다. 한 메시지가 세 축을 모두 명시했다면 동일 원문을 참조할 수 있다.

캠페인 answer JSON은 `request_id`, `cell_id`, `value`, `source`를 받는다. source는 위 descriptor다. 질문 ID는 재호출에도 유지된다. 기존 승인 경로 연결은 campaign attach가 검증한다.

`MODEL_CHANGED/APPROVAL_SCOPE_CHANGED`는 HITL이다. `RECEIPT_TAMPERED/MANIFEST_TAMPERED/APPROVAL_PROVENANCE_INVALID`는 무결성 조사 대상이며 새 승인을 꾸며 덮어쓰지 않는다.

serve는 현재 HW·승인·입력·빌드·소유권을 검사하고 컨테이너 ID·이미지·시작 상태를 기록한다. ready 뒤 기능검사와 경량 측정까지 통과해야 PASS다.
