/** Durable documents and exact compatibility with the original Python receipts. */
import {createHash, randomUUID} from 'node:crypto';
import {closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname, extname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseDocument} from 'yaml';

/** Project root, independent of the caller's working directory. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Untrusted document fields must be narrowed before use. Disk keys retain schema-1 spelling. */
export interface JsonObject { [field: string]: unknown; }

/** Machine-readable gate failure, including the action that can resolve it. */
export class GateError extends Error {
  readonly code: string;
  readonly evidence: string[];
  readonly nextAction: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, options: {evidence?: string[]; nextAction?: string; retryable?: boolean} = {}) {
    super(message);
    this.name = 'GateError';
    this.code = code;
    this.evidence = options.evidence ?? [];
    this.nextAction = options.nextAction ?? 'inspect_evidence';
    this.retryable = options.retryable ?? false;
  }
}

interface NumericToken { token: string; value: number; }
const numericTokens = new WeakMap<object, Map<string, NumericToken>>();

/** UTC timestamp for evidence, never a substitute for process identity. */
export function now(): string { return new Date().toISOString(); }

/** Narrows a plain record without accepting null or arrays. */
export function asRecord(value: unknown, label = 'document'): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GateError('INVALID_INPUT', `${label} must be an object.`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    throw new GateError('INVALID_INPUT', `${label} must be a plain object.`);
  }
  // The object/prototype checks establish a plain keyed record, not its field types.
  return value as JsonObject;
}

/** Requires a string, including empty strings when the caller permits them. */
export function stringValue(value: unknown, label = 'value'): string {
  if (typeof value !== 'string') throw new GateError('INVALID_INPUT', `${label} must be a string.`);
  return value;
}

/** Requires a finite number; a caller supplies domain-specific range checks. */
export function numberValue(value: unknown, label = 'value'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new GateError('INVALID_INPUT', `${label} must be finite.`);
  return value;
}

/** Requires a safely representable integer, excluding booleans and rounded large values. */
export function integerValue(value: unknown, label = 'value'): number {
  const result = numberValue(value, label);
  if (!Number.isSafeInteger(result)) throw new GateError('INVALID_INPUT', `${label} must be a safe integer.`);
  return result;
}

/** Requires an actual boolean, without coercion of strings or numbers. */
export function booleanValue(value: unknown, label = 'value'): boolean {
  if (typeof value !== 'boolean') throw new GateError('INVALID_INPUT', `${label} must be boolean.`);
  return value;
}

/** Narrows an array whose elements still require validation. */
export function arrayValue(value: unknown, label = 'value'): unknown[] {
  if (!Array.isArray(value)) throw new GateError('INVALID_INPUT', `${label} must be an array.`);
  return value;
}

/** Accepts only an omitted/null string or an actual string. */
export function optionalString(value: unknown, label = 'value'): string | undefined {
  return value === undefined || value === null ? undefined : stringValue(value, label);
}

function revive(this: unknown, key: string, value: unknown, context?: {source?: string}): unknown {
  if (typeof value === 'number' && context?.source && typeof this === 'object' && this !== null) {
    const fields = numericTokens.get(this) ?? new Map<string, NumericToken>();
    fields.set(key, {token: context.source, value});
    numericTokens.set(this, fields);
  }
  return value;
}

/** Parses JSON while retaining numeric lexemes needed to verify Python schema-1 hashes. */
export function parseJson(text: string): unknown {
  return JSON.parse(text, revive);
}

/** Reads JSON or YAML without invoking a Python host parser. */
export function load(path: string): unknown {
  const text = readFileSync(path, 'utf8');
  // Existing .yaml artifacts are JSON. Malformed JSON must not be silently reinterpreted.
  if (/^\s*[[{]/u.test(text)) return parseJson(text);
  const document = parseDocument(text, {intAsBigInt: true, uniqueKeys: true});
  if (document.errors.length > 0) throw new GateError('INVALID_DOCUMENT', `${path}: ${document.errors.map(error => error.message).join(', ')}`);
  const value: unknown = document.toJS({maxAliasCount: 50});
  return normalizeYaml(value);
}

function normalizeYaml(value: unknown): unknown {
  if (typeof value === 'bigint') return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value;
  if (Array.isArray(value)) return value.map(item => normalizeYaml(item));
  if (typeof value === 'object' && value !== null) {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(asRecord(value))) Object.defineProperty(result, key, {value: normalizeYaml(item), enumerable: true, writable: true, configurable: true});
    return result;
  }
  return value;
}

/** Reads and narrows the document root. */
export function loadRecord(path: string): JsonObject { return asRecord(load(path), path); }

function tokenFor(parent: object | undefined, key: string, value: unknown): string | undefined {
  const entry = parent ? numericTokens.get(parent)?.get(key) : undefined;
  return entry && Object.is(entry.value, value) ? entry.token : undefined;
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const delta = (a[i]?.codePointAt(0) ?? 0) - (b[i]?.codePointAt(0) ?? 0);
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}

function canonical(value: unknown, parent?: object, key = '', seen = new Set<object>()): string {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new GateError('INVALID_NUMBER', 'Nonfinite numbers cannot enter an evidence digest.');
  const token = tokenFor(parent, key, value);
  if (token !== undefined) return token;
  if (value === null) return 'null';
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new GateError('INVALID_NUMBER', 'Nonfinite numbers cannot enter an evidence digest.');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value !== 'object') throw new GateError('INVALID_DOCUMENT', 'Undefined/function/symbol values cannot enter evidence.');
  if (seen.has(value)) throw new GateError('INVALID_DOCUMENT', 'Cyclic evidence is unsupported.');
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((item, index) => canonical(item, value, String(index), seen)).join(', ')}]`;
  } else {
    const object = asRecord(value);
    result = `{${Object.keys(object).toSorted(compareCodePoints).map(field => `${JSON.stringify(field)}: ${canonical(object[field], object, field, seen)}`).join(', ')}}`;
  }
  seen.delete(value);
  return result;
}

/** Hashes bytes directly, unlike digest() which hashes a canonical JSON value. */
export function sha256Bytes(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }

/** Preserves Python json.dumps(sort_keys=True, ensure_ascii=False) schema-1 preimages. */
export function legacyDigest(value: unknown): string { return sha256Bytes(canonical(value)); }

/** The schema-1 digest contract used throughout persisted campaign/approval records. */
export function digest(value: unknown): string { return legacyDigest(value); }

/** Clones a document while retaining the numeric provenance used by legacyDigest/save. */
export function cloneJson(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const result: unknown[] | JsonObject = Array.isArray(value) ? value.map(item => cloneJson(item)) : {};
  if (!Array.isArray(value) && !Array.isArray(result)) {
    for (const [key, item] of Object.entries(asRecord(value))) Object.defineProperty(result, key, {value: cloneJson(item), enumerable: true, writable: true, configurable: true});
  }
  const tokens = numericTokens.get(value);
  if (tokens) numericTokens.set(result, new Map(tokens));
  return result;
}

/** Removes keys without losing float/integer lexemes in an approved document. */
export function omitRecordKeys(value: JsonObject, keys: readonly string[]): JsonObject {
  const result = asRecord(cloneJson(value));
  for (const key of keys) { delete result[key]; numericTokens.get(result)?.delete(key); }
  return result;
}

function rawNumber(token: string): unknown {
  // Node 24 implements this standardized JSON feature before the compiler's lib declarations.
  if (!('rawJSON' in JSON) || typeof JSON.rawJSON !== 'function') throw new GateError('NODE_VERSION', 'Node 24 raw JSON support is required.');
  return JSON.rawJSON(token);
}

function serializable(value: unknown, parent?: object, key = '', seen = new Set<object>()): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new GateError('INVALID_NUMBER', 'Nonfinite evidence is not permitted.');
  const token = tokenFor(parent, key, value);
  if (token !== undefined) return rawNumber(token);
  if (typeof value === 'bigint') return rawNumber(String(value));
  if (typeof value === 'number' && !Number.isFinite(value)) throw new GateError('INVALID_NUMBER', 'Nonfinite evidence is not permitted.');
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (typeof value !== 'object') throw new GateError('INVALID_DOCUMENT', 'Evidence must not contain undefined/function/symbol fields.');
  if (seen.has(value)) throw new GateError('INVALID_DOCUMENT', 'Cyclic evidence is unsupported.');
  seen.add(value);
  let result: unknown[] | JsonObject;
  if (Array.isArray(value)) {
    result = value.map((item, index) => serializable(item, value, String(index), seen));
  } else {
    result = {};
    for (const [field, item] of Object.entries(asRecord(value))) Object.defineProperty(result, field, {value: serializable(item, value, field, seen), enumerable: true});
  }
  seen.delete(value);
  return result;
}

/** Writes a fsync/rename/fsync document; never leaves a partial checkpoint as current. */
export function save(path: string, value: unknown): void {
  const content = `${JSON.stringify(serializable(value), null, 2)}\n`;
  mkdirSync(dirname(path), {recursive: true});
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); } catch (error) { unlinkSync(temporary); throw error; }
  const directoryFd = openSync(dirname(path), 'r');
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}

/** Appends one durable event to an evidence journal under the caller's state/effect lease. */
export function appendEvent(path: string, record: JsonObject): void {
  mkdirSync(dirname(path), {recursive: true});
  const fd = openSync(path, 'a', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(serializable(record))}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}

/** Model identity hashes metadata content and observes weight sizes/mtimes, not all weight bytes. */
export interface ModelFingerprint { method: string; digest: string; }

/** Matches Python Path ordering and exact nanosecond timestamps without rounding through Number. */
export function fingerprintModel(model: string): ModelFingerprint {
  const root = realpathSync(model);
  const records: JsonObject[] = [];
  function visit(directory: string): void {
    for (const name of readdirSync(directory).toSorted(compareCodePoints)) {
      const path = join(directory, name);
      const entry = lstatSync(path);
      if (entry.isDirectory()) { visit(path); continue; }
      const extension = extname(name);
      if (!['.json', '.py', '.safetensors', '.bin'].includes(extension)) continue;
      const stats = statSync(path, {bigint: true});
      if (!stats.isFile()) continue;
      const row: JsonObject = {path: path.slice(root.length + 1), size: stats.size, mtime_ns: stats.mtimeNs};
      if (extension === '.json' || extension === '.py') row.sha256 = sha256Bytes(readFileSync(path));
      const after = statSync(path, {bigint: true});
      if (stats.mtimeNs !== after.mtimeNs || stats.size !== after.size) throw new GateError('MODEL_CHANGED_DURING_SCAN', `Model changed while reading ${path}.`);
      records.push(row);
    }
  }
  visit(root);
  return {method: 'metadata-sha256+weight-size-mtime', digest: digest(records)};
}

/** Canonicalizes existing paths while permitting a not-yet-created final artifact. */
export function absolutePath(path: string): string { return existsSync(path) ? realpathSync(path) : resolve(path); }
