# 관측 게이트

코드: `tools/embedding/hardware.ts`의 `scan → parseManifest → selectPlatform → checkApplicability/assertCurrentCompatibility`.

OS/커널/환경/CPU/메모리/디스크, PCI·벤더 도구, Docker 상태와 원문을 manifest에 담는다. 스캔 성공은 GPU 서빙 성공이 아니다. `absent`, `tool_missing`, `query_failed`, `unknown`을 구별한다.

시간·가용 메모리처럼 흔들리는 값과 장치/드라이버/런타임/총 용량의 실질 변경을 구별한다. 선택한 GPU UUID로 컨테이너를 지정하고 실제 런타임 검증까지 요구한다. 미확인 벤더 런타임을 지원으로 간주하지 않는다.

권한 문제로 Docker/GPU 관측이 실패하면 실제 실행 권한에서 고정 init을 재실행한다. 기존 승인 snapshot은 보존하고 새 관측·실패·다음 조치를 후속 스킬에 전달한다.
