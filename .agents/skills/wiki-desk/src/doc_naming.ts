// docs/ 문서 명명 SSOT — `docs/<type>/<type>_<YYMMDDHH>[_MM_SS]_<주제>.md` (type = plan|devlog|checklist).
// 순수 함수 — 시계·난수·파일시스템을 읽지 않는다. 호출자가 UTC 'YYYY-MM-DDTHH:MM:SS[.fff]Z'(= JS toISOString) 와 이미 점유된 이름 집합을 넘긴다.
// 그 밖의 시각(오프셋·공백 구분·달력 밖)은 이름을 만들지 않고 실패한다 — 날짜 없는 이름은 명명 규칙 위반이자 충돌 판정 붕괴다.
// 충돌 시에만 `_MM_SS` 를 붙이고, 두 형태가 모두 점유되면 NamingCollisionExhausted 로 fail-closed 한다(세 번째 형태를 발명하지 않는다).
// 사용: node doc_naming.ts <함수> '<JSON 인자 배열>' → stdout JSON
//   예) node doc_naming.ts dated_doc_basename '["plan","2026-10-19T17:00:00Z","임베딩_기동",[]]'
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DATED_DOC_TYPES = ["plan", "devlog", "checklist"] as const;
export type DatedDocType = (typeof DATED_DOC_TYPES)[number];

export const PATTERNS = {
  topic: "^[A-Za-z0-9_.가-힣]+$",
  dated_doc: "^(?<type>[a-z]+)_(?<hour>\\d{8})(?:_\\d{2}_\\d{2})?_(?<topic>.+)\\.md$",
  utc: "^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.\\d+)?Z$",
} as const;

const TOPIC_RE = new RegExp(PATTERNS.topic, "u");
const DATED_DOC_RE = new RegExp(PATTERNS.dated_doc, "u");
const UTC_RE = new RegExp(PATTERNS.utc);
const KST_OFFSET_HOURS = 9;

export class NamingCollisionExhausted extends Error {
  constructor(message: string) { super(message); this.name = "NamingCollisionExhausted"; }
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** UTC → (YYMMDDHH, MM, SS) KST. 형태 불일치·달력에 없는 날짜·null 은 throw 한다(대체값을 만들지 않는다). */
export function kstTokens(generatedUtc: unknown): [string, string, string] {
  const bad = (): Error => new Error(`kst_tokens: generatedUtc must be UTC 'YYYY-MM-DDTHH:MM:SS[.fff]Z', got ${JSON.stringify(generatedUtc)}`);
  if (typeof generatedUtc !== "string") throw bad();
  const m = UTC_RE.exec(generatedUtc);
  if (m === null) throw bad();
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(t);
  // Date.UTC 는 넘치는 필드를 굴려 받는다 — 되읽어 같은 필드인지 확인해 달력 밖 날짜를 거부한다
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d ||
    back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== s) throw bad();
  const k = new Date(t + KST_OFFSET_HOURS * 3600_000);
  const yymmddhh = pad2(k.getUTCFullYear() % 100) + pad2(k.getUTCMonth() + 1) + pad2(k.getUTCDate()) + pad2(k.getUTCHours());
  return [yymmddhh, pad2(k.getUTCMinutes()), pad2(k.getUTCSeconds())];
}

export function validateTopic(topic: unknown): asserts topic is string {
  if (typeof topic !== "string" || topic === "" || !TOPIC_RE.test(topic) || topic === "." || topic === "..") {
    throw new Error(`doc_naming: topic must be a non-empty run of [A-Za-z0-9_. 한글] with no path separators/whitespace, got ${JSON.stringify(topic)}`);
  }
}

export function isDatedDocBasename(docType: string, basename: string): boolean {
  if (!(DATED_DOC_TYPES as readonly string[]).includes(docType) || !basename || basename.includes("/")) return false;
  const m = DATED_DOC_RE.exec(basename);
  return m !== null && m.groups!["type"] === docType;
}

/** '<type>_<YYMMDDHH>[_MM_SS]_<topic>.<ext>'. 충돌 키는 (type, hour) 뿐이다(topic 무관). */
export function datedDocBasename(docType: string, generatedUtc: unknown, topic: unknown, existingBasenames: Iterable<string> = [], ext = "md"): string {
  if (!(DATED_DOC_TYPES as readonly string[]).includes(docType)) {
    throw new Error(`dated_doc_basename: doc_type must be one of ${JSON.stringify(DATED_DOC_TYPES)}, got ${JSON.stringify(docType)}`);
  }
  validateTopic(topic);
  const [hour, mm, ss] = kstTokens(generatedUtc);
  const base = `${docType}_${hour}_${topic}.${ext}`;
  const withSuffix = `${docType}_${hour}_${mm}_${ss}_${topic}.${ext}`;
  const taken = new Set(existingBasenames);
  if (![...taken].some((n) => n.startsWith(`${docType}_${hour}_`))) return base;
  if (taken.has(withSuffix)) {
    throw new NamingCollisionExhausted(`dated_doc_basename: both ${JSON.stringify(base)} and ${JSON.stringify(withSuffix)} are already occupied by another publication -- canon permits only unsuffixed or a single _MM_SS suffix`);
  }
  return withSuffix;
}

// ───────────── CLI ─────────────

const FUNCS: Record<string, (...a: never[]) => unknown> = {
  kst_tokens: kstTokens as never,
  validate_topic: ((t: unknown) => { validateTopic(t); return null; }) as never,
  is_dated_doc_basename: isDatedDocBasename as never,
  dated_doc_basename: datedDocBasename as never,
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [fn, rawArgs] = process.argv.slice(2);
  if (fn !== undefined && Object.hasOwn(FUNCS, fn)) {
    const args = JSON.parse(rawArgs ?? "[]") as never[];
    try {
      process.stdout.write(JSON.stringify({ ok: true, value: FUNCS[fn]!(...args) }) + "\n");
    } catch (e) {
      // 오류 종류를 이름으로 넘긴다(삼키지 않는다)
      process.stdout.write(JSON.stringify({ ok: false, error: (e as Error).name, message: (e as Error).message }) + "\n");
      process.exitCode = 3;
    }
  } else {
    process.stderr.write(`사용: node doc_naming.ts <${Object.keys(FUNCS).join("|")}> '<JSON 인자 배열>'\n`);
    process.exitCode = 2;
  }
}
