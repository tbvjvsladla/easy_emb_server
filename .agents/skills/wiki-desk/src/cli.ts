// wiki-desk CLI. 사용: node .agents/skills/wiki-desk/src/cli.ts <명령> [옵션]  — 출력은 JSON(stdout)
// flock 아래에서 돈다: 쓰기 = 배타, 읽기 = 공유(concurrency.ts · references/concurrency.md).
import path from "node:path";
import { parseArgs } from "node:util";
import { initWiki, syncWiki, queryWiki, readRef, treeOf, checkWiki, statusWiki, enterWiki } from "./commands.ts";
import { findContract } from "./contract.ts";
import { reexecUnderLock } from "./concurrency.ts";

const USAGE = `명령: init --contract <파일> [--apply] | sync [--apply] [--accept-removed P]... [--relocate OLD=NEW]...
      | query --terms <질의>... [--limit N] | read <경로:시작-끝> | tree <경로> | check | status
공통: --root <프로젝트 루트>(생략 시 현재 디렉터리)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string" },
    contract: { type: "string" },
    apply: { type: "boolean", default: false },
    terms: { type: "string", multiple: true },
    limit: { type: "string" },
    "accept-removed": { type: "string", multiple: true },
    relocate: { type: "string", multiple: true },
  },
});

const [cmd, arg] = positionals;
const root = path.resolve(values.root ?? process.cwd());
const now = new Date().toISOString();
const need = (v: string | undefined, name: string): string => {
  if (v === undefined || v === "") throw new Error(`${name} 필요\n${USAGE}`);
  return v;
};
const pair = (s: string): [string, string] => {
  const i = s.indexOf("=");
  if (i <= 0 || i === s.length - 1) throw new Error(`--relocate 형식은 OLD=NEW: ${s}`);
  return [s.slice(0, i), s.slice(i + 1)];
};
const limit = values.limit === undefined ? undefined : Number(values.limit);
if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error(`--limit는 양의 정수: ${values.limit}`);
const name = need(cmd, "<명령>");

const run: Record<string, () => unknown> = {
  init: () => initWiki(root, need(values.contract, "--contract"), { apply: values.apply, now }),
  sync: () => syncWiki(root, {
    apply: values.apply, now,
    acceptRemoved: values["accept-removed"] ?? [],
    relocate: (values.relocate ?? []).map(pair),
  }),
  query: () => queryWiki(root, values.terms ?? [], limit),
  read: () => readRef(root, need(arg, "<경로:시작-끝>")),
  tree: () => treeOf(root, need(arg, "<경로>")),
  check: () => checkWiki(root),
  status: () => statusWiki(root),
};
// 상속 속성(toString·constructor 등)이 명령으로 잡히지 않게 자기 키만 허용
if (!Object.hasOwn(run, name)) throw new Error(`알 수 없는 명령: ${name}\n${USAGE}`);

// ── 잠금(init 은 위키가 아직 없으므로 제외 · init 은 기존 위키가 있으면 거부한다) ──
if (name !== "init") {
  const { wikiDir } = findContract(root);
  reexecUnderLock(path.join(root, wikiDir), name === "sync" && values.apply ? "x" : "s");
}
const recovered = name === "init" ? null : enterWiki(root);
const result = run[name]!();
// 저널 복구는 침묵하지 않는다 — 결과 옆에 싣는다(배열 결과는 감싸지 않고 stderr 로 고지)
if (recovered !== null) {
  if (typeof result === "object" && result !== null && !Array.isArray(result)) (result as Record<string, unknown>)["journal_recovered"] = recovered;
  else process.stderr.write(`wiki-desk: 저널 복구 ${JSON.stringify(recovered)}\n`);
}
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
// check는 문제가 있으면 exit 1 (기계 판정용)
if (name === "check" && !(result as { ok: boolean }).ok) process.exitCode = 1;
