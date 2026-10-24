# 빌드·복구 게이트

코드: [upstream.ts](../src/upstream.ts)의 `resolveReleases/validateFrozenSources`, [recipes.ts](../src/recipes.ts)의 `nativeAssets/backendBuildInputs`, [build.ts](../src/build.ts)의 `build`. 승인·attempt 준비와 캠페인 복구는 explorer의 `attempts.ts`, `campaign.ts` API를 호출한다.

공식 최신 안정 TEI/ST를 exact commit으로 가져오고 공식 이미지의 버전/commit 표식과 digest를 대조한다. Rust 기반 uv로 해시를 가진 전이 의존성을 고정한다. 최신 조회가 실패하면 과거 버전을 최신으로 간주하지 않는다. 컨테이너 설치는 native 도구로 수행한다.

render가 승인·모델·플랫폼·upstream·runtime/recipe·정책/스킬을 봉인한다. build는 lease와 현재 HW를 검사하고 유한 timeout·명령·로그를 기록한 후 실행한다.

```bash
node .agents/skills/embedding-explorer/src/cli.ts campaign retry --campaign <경로> --cell <id> \
  --reason '<실패 원문 근거>' --hypothesis '<가설>' --change '<실제 조정>' \
  --engine sentence-transformers
```

ST 명시 전환에는 같은 승인·upstream의 실제 TEI 실패 원문 또는 모델 modules의 정적 비호환 근거가 필요하다. 이유 문장만으로 통과하지 않는다. `--dtype`, `--limits <JSON파일>`, `--builder`, `--observation <새 근거파일>`은 허용 범위의 knob다. 장치·토큰·차원은 고정한다.

단일 작업의 새 복구 attempt는 build/render에 `--previous-attempt`, `--reason`, `--hypothesis`, `--change`를 함께 전달한다. 기존 생성물을 수정하지 않는다. 같은 조건을 이유 문장만 바꿔 반복하지 않는다. 한도 도달 또는 새 가설 부재 시 근거와 재개 조건을 resolve에 남긴다.
