# 현재 시도의 PASS

코드: `tools/embedding/bench.ts`의 `validateRoutine → functional → run → validateResult`.

기능검사: 단일/배치 개수·순서·차원·finite 벡터, 오류/입력 상한, contextual 처리, 실제 장치와 입력 정책. 측정: 워밍업 분리, 발행/완료/성공/실패/timeout 회계, 유한 시간과 성공 응답. latency·throughput·RAM/VRAM은 관측 상태와 함께 남긴다.

초기 결과는 미검증이며 모두 통과한 뒤 PASS다. 승인/manifest·모델·runtime/recipe·upstream/의존성·설정·이미지/컨테이너·routine·원문에 결과를 연결한다. 사후 health/runtime/container가 다르면 PASS가 아니다. 정상 stop은 이미 완료한 실측을 바꾸지 않는다.

`validateResult`의 `valid=true`, `fresh=true`가 모두 있어야 새 캠페인 PASS다. `legacy_read_only`와 mock은 새 실측에 포함하지 않는다. 루프백은 프록시 환경 변수와 무관하게 직접 HTTP로 연결하며 리다이렉트를 따르지 않는다. 모델 오류와 클라이언트/경로 오류는 구별해 기록한다.
