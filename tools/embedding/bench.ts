/** Verifies the approved running attempt and preserves reproducible measurement evidence. */
import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, realpathSync} from 'node:fs';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {GateError, asRecord, arrayValue, digest, integerValue, load, loadRecord, now, numberValue, omitRecordKeys, save, sha256Bytes, stringValue} from './common.ts';
import type {JsonObject} from './common.ts';
import {capture, compatibility, event, remainingAttemptSeconds, validateAttemptIdentity, withAttemptExecution} from './attempts.ts';
import type {CheckedAttempt} from './attempts.ts';
import {findExecutable, probeCommand} from './hardware.ts';

const SOURCE_PATH = fileURLToPath(import.meta.url);
const MUTABLE_SETTINGS = ['state', 'error', 'previous_compatible_pass'];
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_TIMER_SECONDS = 2_147_483_647 / 1000;

/** Defines the complete finite warmup and measurement request budget. */
export interface LiteRoutine extends JsonObject {
  warmup_requests: number;
  requests: number;
  concurrency: number;
  timeout_seconds: number;
  inputs: string[];
}

/** Preserves one HTTP exchange used to establish functional correctness. */
export interface HttpEvidence extends JsonObject {
  route: string;
  body?: unknown;
  response?: unknown;
  error?: JsonObject;
}

/** Records functional checks and the exact runtime they exercised. */
export interface FunctionalResult extends JsonObject {
  passed: boolean;
  runtime: JsonObject;
  device_evidence: unknown;
  checks: string[];
  boundary_tokens: {accepted: number; rejected: number};
  timeout_seconds: number;
}

/** Supplies transcript persistence and the attempt's remaining finite wall-clock budget. */
export interface FunctionalOptions {
  record?: (exchange: HttpEvidence) => void;
  remainingSeconds?: () => number;
}

/** Records a measured request independently of completion order. */
export interface RequestRecord extends JsonObject {
  index: number;
  success: boolean;
  seconds: number;
  started_at: string;
  finished_at: string;
  start_offset_seconds: number;
  finish_offset_seconds: number;
  body: JsonObject;
  response?: unknown;
  error?: string;
  error_type?: string;
  http_status?: number;
}

/** Summarizes the completed request accounting without a speed threshold. */
export interface Measurement extends JsonObject {
  valid: boolean;
  issued: number;
  completed: number;
  success: number;
  failed: number;
  duration_seconds: number;
  requests_per_second: number;
  vectors_per_second: number;
}

/** Identifies the current run's inputs, recipe, source and running resources. */
export interface EvidenceBinding extends JsonObject {
  receipt_identity: string;
  compatibility_key: string;
  settings_digest: string;
  strategy_digest: string;
  manifest_digest: string;
  files: JsonObject;
  container_identity: JsonObject;
  images_digest: string;
  containers_digest: string;
  routine_digest: string;
  input_digest: string;
  original_routine_path: string;
  original_routine_digest: string;
  tool_source_digest: string;
}

/** Returns the persisted outcome; callers still use validateResult for PASS validity. */
export interface BenchSummary extends JsonObject {
  attempt: string;
  verdict: string;
  stage: string;
  result: string;
  error?: unknown;
}

/** Identifies an explicit reason that a persisted result is not currently valid. */
export interface ValidationReason extends JsonObject {
  code: string;
  message: string;
  evidence: string;
  next_action: string;
}

/** Distinguishes new verified evidence from historical, read-only PASS compatibility. */
export interface ValidationReport extends JsonObject {
  valid: boolean;
  fresh: boolean;
  kind: 'fresh' | 'legacy_read_only' | 'invalid';
  reasons: ValidationReason[];
  result: string;
}

/** Carries an HTTP client/server error without disguising it as invalid input. */
export class HttpResponseError extends Error {
  readonly status: number;
  readonly response: string;

  constructor(status: number, response: string) {
    super(`HTTP ${status}: ${response.slice(0, 2000)}`);
    this.name = 'HttpResponseError';
    this.status = status;
    this.response = response;
  }
}

function errorRecord(error: unknown): JsonObject {
  if (!(error instanceof Error)) throw error;
  return {type: error.name, message: error.message, ...(error instanceof HttpResponseError ? {status: error.status, response: error.response} : {}), ...(error instanceof GateError ? {code: error.code, evidence: error.evidence, next_action: error.nextAction, retryable: error.retryable} : {})};
}

function optionalRecord(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? asRecord(value, 'record') : {};
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = integerValue(value, label);
  if (parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function positiveNumber(value: unknown, label: string): number {
  const parsed = numberValue(value, label);
  if (parsed <= 0) throw new Error(`${label} must be finite and positive`);
  return parsed;
}

function boundedTimeout(timeout: number, remaining?: () => number): number {
  const budget = remaining?.() ?? timeout;
  if (!Number.isFinite(budget) || budget <= 0) throw new GateError('recovery_budget_exhausted', 'The finite wall-clock budget of this attempt lineage is exhausted.', {nextAction: 'inspect preserved progress and recovery evidence'});
  return Math.min(timeout, budget);
}

/** Sends directly with an absolute timeout, ignoring caller proxy variables and redirects. */
export async function request(url: string, route: string, body?: unknown, timeout = 120): Promise<unknown> {
  positiveNumber(timeout, 'HTTP timeout');
  if (timeout > MAX_TIMER_SECONDS) throw new Error('HTTP timeout exceeds the supported Node timer range');
  if (!route.startsWith('/') || route.startsWith('//')) throw new Error('HTTP route must be an absolute path');
  const target = new URL(`${url.replace(/\/+$/, '')}${route}`);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Benchmark URL must use HTTP or HTTPS');
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return await new Promise<unknown>((resolveResponse, rejectResponse) => {
    const outgoing = send(target, {
      method: payload === undefined ? 'GET' : 'POST', agent: false,
      headers: {'Content-Type': 'application/json', ...(payload ? {'Content-Length': payload.length} : {})},
    });
    const timer = setTimeout(() => outgoing.destroy(new Error(`HTTP request timed out after ${timeout} seconds`)), timeout * 1000);
    outgoing.once('error', (error) => {
      clearTimeout(timer);
      rejectResponse(error);
    });
    outgoing.once('response', (incoming) => {
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          incoming.destroy(new Error('HTTP response exceeded the bounded evidence size'));
          return;
        }
        chunks.push(chunk);
      });
      incoming.once('error', (error) => {
        clearTimeout(timer);
        rejectResponse(error);
      });
      incoming.once('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        const status = incoming.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          rejectResponse(new HttpResponseError(status, text));
          return;
        }
        try {
          const response: unknown = JSON.parse(text);
          resolveResponse(response);
        } catch (error: unknown) {
          if (!(error instanceof Error)) throw error;
          rejectResponse(error);
        }
      });
    });
    outgoing.end(payload);
  });
}

/** Validates ordered finite embeddings, optionally including the public response model. */
export function vectors(value: unknown, count: number, dimensions: number, model?: string): number[][] {
  const response = asRecord(value, 'embedding response');
  if (model !== undefined && (response.model !== model || response.object !== 'list')) throw new Error('Response model or object differs from the approved model');
  const data = arrayValue(response.data, 'response.data');
  if (data.length !== count) throw new Error('Response vector count mismatch');
  return data.map((entry, index) => {
    const row = asRecord(entry, 'embedding row');
    if (row.index !== index || (model !== undefined && row.object !== 'embedding')) throw new Error('Response index/order or embedding object mismatch');
    const vector = arrayValue(row.embedding, 'embedding vector');
    if (vector.length !== dimensions) throw new Error('Response dimension mismatch');
    return vector.map((element) => numberValue(element, 'finite embedding value'));
  });
}

/** Validates the declared finite routine and rejects booleans as numeric settings. */
export function validateRoutine(value: unknown): LiteRoutine {
  const routine = asRecord(value, 'lite routine');
  if (routine.evidence_kind !== undefined && !['mock', 'measured'].includes(stringValue(routine.evidence_kind, 'routine evidence_kind'))) throw new Error('Routine evidence_kind must be mock or measured');
  const warmup = integerValue(routine.warmup_requests, 'warmup_requests');
  if (warmup < 0) throw new Error('warmup_requests must be nonnegative');
  const inputs = arrayValue(routine.inputs, 'routine.inputs').map((entry) => stringValue(entry, 'routine input'));
  if (inputs.length < 2 || inputs.some((entry) => !entry.trim()) || new Set(inputs).size !== inputs.length) throw new Error('At least two distinct nonempty text inputs are required for the batch/order check');
  const timeout = positiveNumber(routine.timeout_seconds, 'timeout_seconds');
  if (timeout > MAX_TIMER_SECONDS) throw new Error('timeout_seconds exceeds the supported Node timer range');
  return {
    ...routine, warmup_requests: warmup, requests: positiveInteger(routine.requests, 'requests'),
    concurrency: positiveInteger(routine.concurrency, 'concurrency'), timeout_seconds: timeout, inputs,
  };
}

function inside(path: string, parent: string): boolean {
  const difference = relative(realpathSync(parent), realpathSync(path));
  return difference !== '..' && !difference.startsWith('../') && !isAbsolute(difference);
}

function validateDeviceEvidence(evidence: unknown, strategy: JsonObject, settings: JsonObject, attempt: string): void {
  const record = asRecord(evidence, 'device evidence');
  if (record.attempt_id !== settings.id || record.device !== strategy.device) throw new Error('Device evidence does not belong to the approved current attempt');
  const observations = arrayValue(record.observations, 'device observations');
  if (observations.length === 0) throw new Error('Device evidence has no current runtime observations');
  const captured = arrayValue(load(join(attempt, 'container-backend.json')), 'current backend container');
  if (captured.length !== 1) throw new Error('Current backend device evidence needs one observed container');
  const current = asRecord(captured[0], 'current backend container');
  let matchedContainer = false;
  for (const value of observations) {
    const observation = asRecord(value, 'device observation');
    const source = resolve(attempt, stringValue(observation.file, 'device observation file'));
    if (!inside(source, attempt)) throw new Error('Device observation path leaves this attempt');
    const content = readFileSync(source, 'utf8');
    const excerpt = stringValue(observation.excerpt, 'device observation excerpt');
    if (!excerpt || digest(content) !== observation.digest || !content.includes(excerpt)) throw new Error('Device evidence is stale, missing or not from this attempt');
    if (source.endsWith('/container.json')) {
      const snapshot = asRecord(JSON.parse(content), 'frozen device container');
      const state = asRecord(snapshot.State, 'frozen device container state');
      const labels = asRecord(asRecord(snapshot.Config, 'frozen container config').Labels, 'frozen container labels');
      if (snapshot.Id !== current.Id || snapshot.Image !== current.Image || state.StartedAt !== asRecord(current.State, 'current container state').StartedAt || state.Running !== true || labels['easy-emb.attempt'] !== settings.id || labels['easy-emb.strategy'] !== strategy.id) throw new Error('Device observations belong to a stale or different container process');
      matchedContainer = true;
    }
  }
  if (!matchedContainer) throw new Error('Device evidence does not identify the current backend container');
}

function validateRuntimeInfo(info: JsonObject, strategy: JsonObject, settings: JsonObject): void {
  for (const [key, expected] of Object.entries({model: strategy.model, strategy_id: strategy.id, attempt_id: settings.id, context_window: strategy.context_window, dimensions: strategy.dimensions, input_policy: 'reject_over_limit'})) {
    if (info[key] !== expected) throw new Error(`Runtime ${key} differs from the current approved attempt`);
  }
  const backend = asRecord(info.backend, 'runtime backend');
  if (backend.device !== strategy.device) throw new Error('Actual device differs from approval');
  if (settings.engine !== undefined && backend.engine !== settings.engine) throw new Error('Runtime engine differs from the current recipe');
  if (backend.engine === 'sentence-transformers') {
    if (backend.max_seq_length !== strategy.context_window) throw new Error('Loaded ST input limit differs from approval');
    for (const field of ['model_device', 'probe_device']) {
      const actual = stringValue(backend[field], `backend.${field}`);
      if ((actual.split(':')[0] === 'cpu') !== (strategy.device === 'cpu')) throw new Error('Observed ST allocation differs from approved device');
    }
    const parameters = arrayValue(backend.parameter_devices, 'backend.parameter_devices');
    if (parameters.length === 0 || parameters.some((entry) => (stringValue(entry, 'parameter device').split(':')[0] === 'cpu') !== (strategy.device === 'cpu'))) throw new Error('Model parameter devices differ from approval');
  }
  if (backend.engine === 'tei') {
    const upstream = asRecord(backend.upstream, 'TEI upstream info');
    if (positiveInteger(upstream.max_input_length, 'TEI input capacity') < positiveInteger(strategy.context_window, 'approved context')) throw new Error('Underlying TEI input capacity is below approval');
    if (upstream.auto_truncate === true) throw new Error('Underlying TEI silently truncates input');
  }
}

function tokenLength(value: unknown, context: number): number {
  const response = asRecord(value, 'tokenizer response');
  const lengths = arrayValue(response.lengths, 'tokenizer lengths');
  if (lengths.length !== 1 || response.context_window !== context || response.prompt_included !== true) throw new Error('Tokenizer did not establish the prompt-inclusive approved boundary');
  return positiveInteger(lengths[0], 'token length');
}

/** Exercises model/device identity, ordering, contextual semantics and real token limits. */
export async function functional(url: string, strategy: JsonObject, attempt: string, routine: LiteRoutine, options: FunctionalOptions = {}): Promise<FunctionalResult> {
  const settings = loadRecord(join(attempt, 'settings.yaml'));
  const configuredTimeout = optionalRecord(settings.limits).functional_timeout_seconds;
  const timeout = Math.max(routine.timeout_seconds, configuredTimeout === undefined ? 0 : positiveNumber(configuredTimeout, 'functional timeout'));
  const model = stringValue(strategy.model, 'strategy.model');
  const dimension = positiveInteger(strategy.dimensions, 'strategy.dimensions');
  const context = positiveInteger(strategy.context_window, 'strategy.context_window');
  const call = async (route: string, body?: unknown): Promise<unknown> => {
    try {
      const response = await request(url, route, body, boundedTimeout(timeout, options.remainingSeconds));
      options.record?.({route, ...(body === undefined ? {} : {body}), response});
      return response;
    } catch (error: unknown) {
      options.record?.({route, ...(body === undefined ? {} : {body}), error: errorRecord(error)});
      throw error;
    }
  };
  const rejectClient = async (route: string, body: unknown, exactStatus?: number): Promise<void> => {
    try {
      await call(route, body);
    } catch (error: unknown) {
      if (!(error instanceof HttpResponseError)) throw error;
      if (exactStatus === undefined ? error.status >= 400 && error.status < 500 : error.status === exactStatus) return;
      throw new Error(`Invalid input did not follow the client-error policy: HTTP ${error.status}`, {cause: error});
    }
    throw new Error('Invalid or over-limit input was silently accepted');
  };
  const health = asRecord(await call('/health'), 'health');
  if (health.status !== 'ok') throw new Error('Initial health check did not report ok');
  const info = asRecord(await call('/info'), 'runtime info');
  validateRuntimeInfo(info, strategy, settings);
  const backend = asRecord(info.backend, 'runtime backend');
  const evidencePath = join(attempt, 'device-evidence.json');
  const evidence = existsSync(evidencePath) ? load(evidencePath) : null;
  if (backend.device_observed !== true) validateDeviceEvidence(evidence, strategy, settings, attempt);
  const texts = routine.inputs;
  const batch = vectors(await call('/v1/embeddings', {input: texts, model}), texts.length, dimension, model);
  const singles: number[][] = [];
  for (const text of texts) {
    const rows = vectors(await call('/v1/embeddings', {input: text}), 1, dimension, model);
    const row = rows[0];
    if (!row) throw new Error('Single embedding was not returned');
    singles.push(row);
  }
  for (const [index, vector] of batch.entries()) {
    const distances = singles.map((single) => vector.reduce((sum, value, position) => {
      const other = single[position];
      if (other === undefined) throw new Error('Single embedding dimension mismatch');
      return sum + (value - other) ** 2;
    }, 0));
    const corresponding = distances[index];
    if (corresponding === undefined || distances.some((distance) => !Number.isFinite(distance)) || distances.some((distance, position) => position !== index && corresponding >= distance)) throw new Error('Batch order could not be confirmed against single requests');
  }
  vectors(await call('/v1/embeddings', {input: texts, model, dimensions: dimension}), texts.length, dimension, model);
  for (const value of [true, 0, dimension + 1, String(dimension), null]) await rejectClient('/v1/embeddings', {input: texts[0], dimensions: value});
  await rejectClient('/v1/embeddings', {input: texts[0], model: `${model}-unknown-model`});
  await rejectClient('/v1/embeddings', {input: texts[0], encoding_format: 'base64'});
  const adapter = optionalRecord(backend.adapter);
  const contextual = adapter.contextual === true;
  let contextualLimitRejected = false;
  if (contextual) {
    let expectedIndices: Array<[number, number]> = [[0, 0], [0, 1], [1, 0]];
    let response: unknown;
    try {
      response = await call('/v1/contextualizedembeddings', {input: [[texts[0], texts[1]], [texts[0]]]});
    } catch (error: unknown) {
      if (!(error instanceof HttpResponseError) || error.status !== 400 || !error.response.includes('Input exceeds approved context_window=')) throw error;
      contextualLimitRejected = true;
      expectedIndices = texts.map((text, index) => [index, 0]);
      response = await call('/v1/contextualizedembeddings', {input: texts.map((text) => [text])});
    }
    vectors(response, expectedIndices.length, dimension, model);
    const rows = arrayValue(asRecord(response, 'contextual response').data, 'contextual data');
    for (const [index, value] of rows.entries()) {
      const row = asRecord(value, 'contextual row');
      const expected = expectedIndices[index];
      if (!expected || row.document_index !== expected[0] || row.chunk_index !== expected[1]) throw new Error('Contextual chunk/document mapping mismatch');
    }
    if (adapter.reserved_separator !== undefined) {
      const separator = stringValue(adapter.reserved_separator, 'reserved separator');
      if (separator) {
        await rejectClient('/v1/embeddings', {input: `a${separator}b`}, 400);
        await rejectClient('/v1/contextualizedembeddings', {input: [[`a${separator}b`]]}, 400);
      }
    }
    for (const value of [[], [[]], [['']], [[1]], 'text']) await rejectClient('/v1/contextualizedembeddings', {input: value});
  }
  for (const value of ['', [], [''], [1], 123, null, true]) await rejectClient('/v1/embeddings', {input: value});
  let low = 1;
  let high = context + 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    const length = tokenLength(await call('/tokenize', {input: 'a '.repeat(middle)}), context);
    if (length <= context) low = middle;
    else high = middle;
  }
  const near = tokenLength(await call('/tokenize', {input: 'a '.repeat(low)}), context);
  const over = tokenLength(await call('/tokenize', {input: 'a '.repeat(high)}), context);
  if (!(near <= context && context < over)) throw new Error('Unable to construct a valid tokenizer boundary');
  vectors(await call('/v1/embeddings', {input: 'a '.repeat(low)}), 1, dimension, model);
  await rejectClient('/v1/embeddings', {input: 'a '.repeat(high)}, 400);
  return {
    passed: true, runtime: info, device_evidence: evidence, timeout_seconds: timeout,
    checks: ['model', 'count', 'order_vs_same_runtime_singles', 'dimension', 'request_dimensions', 'finite', 'device', 'input_policy', 'invalid_input', 'real_token_boundary', ...(contextual ? ['contextual_document_chunk_mapping', 'contextual_invalid_input'] : []), ...(contextualLimitRejected ? ['contextual_document_limit_rejection'] : [])],
    boundary_tokens: {accepted: near, rejected: over},
  };
}

async function memorySample(attempt: CheckedAttempt, remaining: () => number): Promise<JsonObject> {
  const sample: JsonObject = {at: now()};
  const containersPath = join(attempt.path, 'containers.json');
  if (existsSync(containersPath)) {
    const containers = loadRecord(containersPath);
    const names = ['api', 'backend'].map((role) => containers[role]).filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (names.length > 0) {
      const observed = await probeCommand(['docker', 'stats', '--no-stream', '--format', '{{json .}}', ...names], boundedTimeout(20, remaining));
      sample.container_memory = {...observed, status: observed.status === 'ok' ? 'observed' : observed.status, raw: observed.stdout};
    } else sample.container_memory = {status: 'unavailable', reason: 'No container identities'};
  } else sample.container_memory = {status: 'unavailable', reason: 'No container identities'};
  if (attempt.strategy.device === 'cpu') {
    sample.gpu_memory = {status: 'not_applicable', reason: 'CPU strategy'};
  } else if (optionalRecord(optionalRecord(attempt.settings.platform).accelerator).vendor === 'nvidia') {
    const executable = findExecutable('nvidia-smi', `${process.env.PATH ?? ''}:/usr/lib/wsl/lib`);
    if (executable) {
      const observed = await probeCommand([executable, '--query-gpu=uuid,memory.used,memory.total', '--format=csv,noheader,nounits'], boundedTimeout(20, remaining));
      sample.gpu_memory = {...observed, status: observed.status === 'ok' ? 'observed' : observed.status, raw: observed.stdout, scope: 'whole-device before/after sample; not per-process peak'};
    } else sample.gpu_memory = {status: 'tool_missing', reason: 'nvidia-smi missing'};
  } else sample.gpu_memory = {status: 'unavailable', reason: 'No sourced collector for this accelerator'};
  return sample;
}

function containerIdentity(attempt: CheckedAttempt, requireRunning: boolean): JsonObject {
  const containers = loadRecord(join(attempt.path, 'containers.json'));
  const images = loadRecord(join(attempt.path, 'images.json'));
  const result: JsonObject = {};
  for (const role of ['api', 'backend']) {
    if (!containers[role]) continue;
    const values = arrayValue(load(join(attempt.path, `container-${role}.json`)), `container ${role}`);
    if (values.length !== 1) throw new Error('Current container inspection did not identify exactly one owned container');
    const info = asRecord(values[0], 'container inspection');
    const config = asRecord(info.Config, 'container Config');
    const labels = asRecord(config.Labels, 'container labels');
    const state = asRecord(info.State, 'container state');
    if (requireRunning && state.Running !== true) throw new Error('The current attempt container is not running at the measurement boundary');
    if (labels['easy-emb.attempt'] !== attempt.settings.id || labels['easy-emb.strategy'] !== attempt.strategy.id) throw new Error('Container is not owned by the approved current attempt');
    const imageRole = role === 'api' && attempt.settings.engine === 'tei' ? 'gateway' : 'backend';
    if (info.Image !== asRecord(images[imageRole], 'built image').id) throw new Error('Running container image differs from current build');
    result[role] = {name: containers[role], id: stringValue(info.Id, 'container ID'), image: stringValue(info.Image, 'container image'), started_at: stringValue(state.StartedAt, 'container StartedAt'), labels};
  }
  if (result.api === undefined || (attempt.settings.engine === 'tei' && result.backend === undefined)) throw new Error('Current attempt container identities are incomplete');
  return result;
}

function currentCompatibility(attempt: string, settings: JsonObject, strategy: JsonObject): string {
  const recipes: JsonObject = {};
  for (const name of readdirSync(attempt).filter((entry) => entry.startsWith('Dockerfile')).toSorted()) recipes[name] = readFileSync(join(attempt, name), 'utf8');
  return compatibility({strategy, manifest: loadRecord(join(attempt, 'manifest.yaml')), adapter: asRecord(settings.platform, 'platform'), versions: asRecord(settings.versions, 'versions'), engine: stringValue(settings.engine, 'engine'), dtype: stringValue(settings.dtype, 'dtype'), runtimeRoot: join(attempt, 'runtime'), recipes, ...(settings.model_config_overrides === undefined ? {} : {modelOverrides: asRecord(settings.model_config_overrides, 'model overrides')})});
}

function createBinding(attempt: CheckedAttempt, routine: LiteRoutine, originalRoutinePath: string, requireRunning = false): EvidenceBinding {
  const files: JsonObject = {};
  const receiptPath = realpathSync(stringValue(attempt.settings.strategy_path, 'strategy_path'));
  files[receiptPath] = sha256Bytes(readFileSync(receiptPath));
  for (const name of readdirSync(attempt.path).filter((entry) => entry.startsWith('Dockerfile') || /^(source|upstream|release).*\.(json|yaml)$/.test(entry)).toSorted()) files[join(attempt.path, name)] = sha256Bytes(readFileSync(join(attempt.path, name)));
  const runtimePath = join(attempt.path, 'runtime');
  for (const name of readdirSync(runtimePath).filter((entry) => entry.endsWith('.py')).toSorted()) files[join(runtimePath, name)] = sha256Bytes(readFileSync(join(runtimePath, name)));
  return {
    receipt_identity: attempt.receiptIdentity, compatibility_key: stringValue(attempt.settings.compatibility_key, 'compatibility_key'),
    settings_digest: digest(omitRecordKeys(attempt.settings, MUTABLE_SETTINGS)), strategy_digest: digest(attempt.strategy), manifest_digest: digest(attempt.manifest), files,
    container_identity: containerIdentity(attempt, requireRunning), images_digest: digest(load(join(attempt.path, 'images.json'))), containers_digest: digest(load(join(attempt.path, 'containers.json'))),
    routine_digest: digest(routine), input_digest: digest({input: routine.inputs, model: attempt.strategy.model}),
    original_routine_path: realpathSync(originalRoutinePath), original_routine_digest: sha256Bytes(readFileSync(originalRoutinePath)), tool_source_digest: sha256Bytes(readFileSync(SOURCE_PATH)),
  };
}

function quantiles(durations: number[]): JsonObject | null {
  if (durations.length === 0) return null;
  const sorted = durations.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upperMiddle = sorted[middle];
  const lowerMiddle = sorted[middle - 1];
  const percentile = sorted[Math.ceil(sorted.length * 0.95) - 1];
  if (upperMiddle === undefined || percentile === undefined || (sorted.length % 2 === 0 && lowerMiddle === undefined)) throw new Error('Latency observations are incomplete');
  return {mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length, p50: sorted.length % 2 === 0 ? (upperMiddle + (lowerMiddle ?? upperMiddle)) / 2 : upperMiddle, p95: percentile};
}

/** Runs a fresh, leased benchmark and invalidates stale PASS before any HTTP effects. */
export async function run(attemptPath: string, url: string, routinePath: string): Promise<BenchSummary> {
  const routine = validateRoutine(load(routinePath));
  return await withAttemptExecution(attemptPath, 'bench', async (attempt: CheckedAttempt) => {
    const availableSeconds = remainingAttemptSeconds(attempt);
    const deadline = performance.now() + availableSeconds * 1000;
    const remaining = (): number => Math.max(0, (deadline - performance.now()) / 1000);
    const runId = `${now().replace(/[:+]/g, '')}_${randomUUID().slice(0, 8)}`;
    const evidencePath = join(attempt.path, 'bench', runId);
    mkdirSync(evidencePath, {recursive: true});
    const frozenRoutinePath = join(evidencePath, 'routine.yaml');
    save(frozenRoutinePath, routine);
    const result: JsonObject = {
      schema: 'embedding-e2e/2', evidence_kind: routine.evidence_kind === 'mock' ? 'mock' : 'measured', started_at: now(), attempt_id: attempt.settings.id, strategy_id: attempt.strategy.id,
      compatibility_key: attempt.settings.compatibility_key, routine: frozenRoutinePath,
      tool: {name: 'node-http', node: process.version, source_digest: sha256Bytes(readFileSync(SOURCE_PATH))},
      execution_budget_seconds: availableSeconds,
      verdict: 'FAIL', stage: 'functional', functional: {passed: false}, measurement: {valid: false}, post_health: {passed: false},
    };
    const records: RequestRecord[] = [];
    const exchanges: HttpEvidence[] = [];
    const warmups: JsonObject[] = [];
    const persistResult = (): void => {
      save(join(evidencePath, 'result.json'), result);
      save(join(attempt.path, 'result.json'), result);
    };
    persistResult();
    event(attempt.path, 'bench_started', {run_id: runId, routine, base_url: url});
    try {
      await capture(attempt.path);
      const binding = createBinding(attempt, routine, routinePath, true);
      result.binding = binding;
      const functionalResult = await functional(url, attempt.strategy, attempt.path, routine, {
        remainingSeconds: remaining,
        record: (exchange) => {
          exchanges.push(exchange);
          save(join(evidencePath, 'functional-requests.json'), exchanges);
        },
      });
      result.functional = functionalResult;
      result.stage = 'warmup';
      persistResult();
      const body = {input: routine.inputs, model: attempt.strategy.model};
      const dimension = positiveInteger(attempt.strategy.dimensions, 'dimensions');
      const model = stringValue(attempt.strategy.model, 'model');
      for (let index = 0; index < routine.warmup_requests; index += 1) {
        let response: unknown;
        try {
          response = await request(url, '/v1/embeddings', body, boundedTimeout(routine.timeout_seconds, remaining));
          vectors(response, routine.inputs.length, dimension, model);
          warmups.push({index, success: true, body, response});
        } catch (error: unknown) {
          warmups.push({index, success: false, body, ...(response === undefined ? {} : {response}), error: errorRecord(error)});
          throw error;
        } finally {
          save(join(evidencePath, 'warmup-requests.json'), warmups);
        }
      }
      result.stage = 'measurement';
      persistResult();
      const memory = [await memorySample(attempt, remaining)];
      const startedAt = now();
      const started = performance.now();
      let issued = 0;
      const worker = async (): Promise<void> => {
        while (issued < routine.requests) {
          if (remaining() <= 0) break;
          const index = issued;
          issued += 1;
          const requestStarted = performance.now();
          const start = now();
          const startOffset = (requestStarted - started) / 1000;
          let record: RequestRecord;
          let response: unknown;
          try {
            response = await request(url, '/v1/embeddings', body, boundedTimeout(routine.timeout_seconds, remaining));
            vectors(response, routine.inputs.length, dimension, model);
            const finished = performance.now();
            record = {index, success: true, seconds: (finished - requestStarted) / 1000, started_at: start, finished_at: now(), start_offset_seconds: startOffset, finish_offset_seconds: (finished - started) / 1000, body, response};
          } catch (error: unknown) {
            if (!(error instanceof Error)) throw error;
            const finished = performance.now();
            record = {index, success: false, seconds: (finished - requestStarted) / 1000, started_at: start, finished_at: now(), start_offset_seconds: startOffset, finish_offset_seconds: (finished - started) / 1000, body, ...(response === undefined ? {} : {response}), error: error.message, error_type: error.name, ...(error instanceof HttpResponseError ? {http_status: error.status} : {})};
          }
          records.push(record);
          save(join(evidencePath, 'requests.json'), records);
        }
      };
      await Promise.all(Array.from({length: Math.min(routine.requests, routine.concurrency)}, () => worker()));
      const duration = (performance.now() - started) / 1000;
      const finishedAt = now();
      try {
        memory.push(await memorySample(attempt, remaining));
      } catch (samplingError: unknown) {
        memory.push({at: now(), status: 'unavailable', error: errorRecord(samplingError), scope: 'after sample could not complete'});
      }
      const successful = records.filter((record) => record.success);
      const durations = successful.map((record) => record.seconds);
      const valid = issued === routine.requests && records.length === issued && successful.length === issued && Number.isFinite(duration) && duration > 0 && durations.every((seconds) => Number.isFinite(seconds) && seconds > 0);
      const measurement: Measurement = {
        valid, issued, completed: records.length, success: successful.length, failed: records.length - successful.length,
        duration_seconds: duration, requests_per_second: successful.length / duration, vectors_per_second: successful.length * routine.inputs.length / duration,
        latency_seconds: quantiles(durations), memory_observations: memory, memory_scope: 'before/after samples; not a peak claim',
        started_at: startedAt, finished_at: finishedAt, concurrency: routine.concurrency, warmup_completed: warmups.length,
      };
      result.measurement = measurement;
      result.stage = 'post_health';
      persistResult();
      const health = asRecord(await request(url, '/health', undefined, boundedTimeout(routine.timeout_seconds, remaining)), 'post health');
      const info = asRecord(await request(url, '/info', undefined, boundedTimeout(routine.timeout_seconds, remaining)), 'post runtime info');
      validateRuntimeInfo(info, attempt.strategy, attempt.settings);
      if (health.status !== 'ok' || digest(info) !== digest(functionalResult.runtime)) throw new Error('Post-measurement health or runtime identity changed');
      await capture(attempt.path);
      boundedTimeout(routine.timeout_seconds, remaining);
      if (digest(createBinding(validateAttemptIdentity(attempt.path), routine, routinePath, true)) !== digest(binding)) throw new Error('Attempt input, recipe, source or container changed during measurement');
      result.post_health = {passed: true, at: now(), health, runtime: info};
      result.verdict = valid ? 'PASS' : 'FAIL';
      result.stage = valid ? 'complete' : 'measurement_failed';
    } catch (error: unknown) {
      result.error = errorRecord(error);
      try {
        await capture(attempt.path);
      } catch (captureError: unknown) {
        result.capture_error = errorRecord(captureError);
      }
    } finally {
      result.finished_at = now();
      save(join(evidencePath, 'requests.json'), records);
      save(join(evidencePath, 'functional-requests.json'), exchanges);
      save(join(evidencePath, 'warmup-requests.json'), warmups);
      result.evidence_digests = {requests: digest(records), functional: digest(exchanges), warmup: digest(warmups)};
      persistResult();
      event(attempt.path, 'bench_finished', {verdict: result.verdict, result: join(evidencePath, 'result.json')});
    }
    return {attempt: attempt.path, verdict: stringValue(result.verdict, 'verdict'), stage: stringValue(result.stage, 'stage'), result: join(evidencePath, 'result.json'), ...(result.error === undefined ? {} : {error: result.error})};
  });
}

function finitePositive(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function closeNumber(actual: unknown, expected: number): boolean {
  return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= Math.max(1e-12, Math.abs(expected) * 1e-10);
}

function validateFunctionalTranscript(value: unknown, functionalResult: JsonObject, strategy: JsonObject, routine: LiteRoutine): void {
  const exchanges = arrayValue(value, 'functional transcript').map((entry) => asRecord(entry, 'functional exchange'));
  const context = positiveInteger(strategy.context_window, 'context');
  const dimension = positiveInteger(strategy.dimensions, 'dimensions');
  const model = stringValue(strategy.model, 'model');
  const matching = (route: string, body: unknown): JsonObject[] => exchanges.filter((exchange) => exchange.route === route && digest(exchange.body ?? null) === digest(body ?? null));
  const responseFor = (route: string, body?: unknown): unknown => {
    const exchange = matching(route, body).find((entry) => entry.response !== undefined);
    if (!exchange) throw new Error(`Functional transcript is missing successful ${route} evidence`);
    return exchange.response;
  };
  const clientErrorFor = (route: string, body: unknown, exactStatus?: number): void => {
    const entries = matching(route, body);
    if (entries.some((entry) => entry.response !== undefined) || !entries.some((entry) => {
      const status = optionalRecord(entry.error).status;
      return typeof status === 'number' && (exactStatus === undefined ? status >= 400 && status < 500 : status === exactStatus);
    })) throw new Error(`Functional transcript does not establish client rejection at ${route}`);
  };
  if (optionalRecord(responseFor('/health')).status !== 'ok' || digest(responseFor('/info')) !== digest(functionalResult.runtime)) throw new Error('Functional transcript health/runtime identity differs from the result');
  const batch = vectors(responseFor('/v1/embeddings', {input: routine.inputs, model}), routine.inputs.length, dimension, model);
  const singles = routine.inputs.map((text) => {
    const vector = vectors(responseFor('/v1/embeddings', {input: text}), 1, dimension, model)[0];
    if (!vector) throw new Error('Functional single-vector evidence is missing');
    return vector;
  });
  for (const [index, vector] of batch.entries()) {
    const distances = singles.map((single) => {
      let distance = 0;
      for (const [position, component] of vector.entries()) {
        const other = single[position];
        if (other === undefined) throw new Error('Functional vector sizes differ');
        distance += (component - other) ** 2;
      }
      return distance;
    });
    const own = distances[index];
    if (own === undefined || distances.some((distance, position) => !Number.isFinite(distance) || (position !== index && own >= distance))) throw new Error('Raw functional vectors do not establish batch order');
  }
  vectors(responseFor('/v1/embeddings', {input: routine.inputs, model, dimensions: dimension}), routine.inputs.length, dimension, model);
  for (const invalidDimension of [true, 0, dimension + 1, String(dimension), null]) clientErrorFor('/v1/embeddings', {input: routine.inputs[0], dimensions: invalidDimension});
  clientErrorFor('/v1/embeddings', {input: routine.inputs[0], model: `${model}-unknown-model`});
  clientErrorFor('/v1/embeddings', {input: routine.inputs[0], encoding_format: 'base64'});
  for (const invalidInput of ['', [], [''], [1], 123, null, true]) clientErrorFor('/v1/embeddings', {input: invalidInput});
  const boundary = asRecord(functionalResult.boundary_tokens, 'boundary');
  const tokenExchanges = exchanges.filter((exchange) => exchange.route === '/tokenize' && exchange.response !== undefined);
  const accepted = tokenExchanges.find((exchange) => tokenLength(exchange.response, context) === boundary.accepted && matching('/v1/embeddings', exchange.body).some((entry) => entry.response !== undefined));
  const rejected = tokenExchanges.find((exchange) => tokenLength(exchange.response, context) === boundary.rejected && matching('/v1/embeddings', exchange.body).some((entry) => optionalRecord(entry.error).status === 400));
  if (!accepted || !rejected) throw new Error('Raw tokenizer evidence does not establish the recorded boundary');
  vectors(responseFor('/v1/embeddings', accepted.body), 1, dimension, model);
  clientErrorFor('/v1/embeddings', rejected.body, 400);
  const adapter = optionalRecord(optionalRecord(optionalRecord(functionalResult.runtime).backend).adapter);
  if (adapter.contextual === true) {
    const contextual = exchanges.filter((exchange) => exchange.route === '/v1/contextualizedembeddings' && exchange.response !== undefined);
    if (contextual.length === 0) throw new Error('Contextual transcript is missing successful document/chunk evidence');
    for (const exchange of contextual) {
      const documents = arrayValue(asRecord(exchange.body, 'contextual request').input, 'contextual documents').map((document) => arrayValue(document, 'chunks'));
      const indices = documents.flatMap((document, documentIndex) => document.map((chunk, chunkIndex) => [documentIndex, chunkIndex]));
      vectors(exchange.response, indices.length, dimension, model);
      const rows = arrayValue(asRecord(exchange.response, 'contextual response').data, 'contextual rows');
      for (const [index, entry] of rows.entries()) {
        const row = asRecord(entry, 'contextual row');
        const expected = indices[index];
        if (!expected || row.document_index !== expected[0] || row.chunk_index !== expected[1]) throw new Error('Raw contextual mapping does not match request documents/chunks');
      }
    }
    const joinedBody = {input: [[routine.inputs[0], routine.inputs[1]], [routine.inputs[0]]]};
    if (matching('/v1/contextualizedembeddings', joinedBody).some((exchange) => exchange.error !== undefined)) {
      const errors = matching('/v1/contextualizedembeddings', joinedBody);
      if (!errors.some((exchange) => optionalRecord(exchange.error).status === 400 && String(optionalRecord(exchange.error).response).includes('Input exceeds approved context_window='))) throw new Error('Contextual document rejection was not an approved context boundary');
      responseFor('/v1/contextualizedembeddings', {input: routine.inputs.map((text) => [text])});
    } else responseFor('/v1/contextualizedembeddings', joinedBody);
    for (const invalidInput of [[], [[]], [['']], [[1]], 'text']) clientErrorFor('/v1/contextualizedembeddings', {input: invalidInput});
    if (typeof adapter.reserved_separator === 'string' && adapter.reserved_separator) {
      clientErrorFor('/v1/embeddings', {input: `a${adapter.reserved_separator}b`}, 400);
      clientErrorFor('/v1/contextualizedembeddings', {input: [[`a${adapter.reserved_separator}b`]]}, 400);
    }
  }
}

/** Reproduces one authoritative verdict from raw evidence, without changing old records. */
export function validateResult(attemptPath: string): ValidationReport {
  const resultPath = join(resolve(attemptPath), 'result.json');
  const reasons: ValidationReason[] = [];
  const invalid = (code: string, message: string, evidence = resultPath): void => {
    reasons.push({code, message, evidence, next_action: 'Inspect preserved evidence and run a fresh approved benchmark when the cause is resolved.'});
  };
  let kind: ValidationReport['kind'] = 'invalid';
  try {
    const path = realpathSync(attemptPath);
    const result = loadRecord(resultPath);
    const settings = loadRecord(join(path, 'settings.yaml'));
    const strategy = loadRecord(join(path, 'strategy.yaml'));
    const measurement = asRecord(result.measurement, 'measurement');
    const functionalResult = asRecord(result.functional, 'functional');
    const routinePath = realpathSync(stringValue(result.routine, 'result.routine'));
    if (!inside(routinePath, join(path, 'bench'))) throw new Error('Frozen routine path is outside this attempt bench directory');
    if (digest(load(join(dirname(routinePath), 'result.json'))) !== digest(result)) invalid('current_result_differs', 'Current result differs from its preserved run result.');
    const routine = validateRoutine(load(routinePath));
    const requests = arrayValue(load(join(dirname(routinePath), 'requests.json')), 'request evidence').map((value) => asRecord(value, 'request record'));
    if (result.schema !== 'embedding-e2e/1' && result.schema !== 'embedding-e2e/2') invalid('unsupported_result_schema', 'Result schema is not a recognized benchmark schema.');
    if (result.verdict !== 'PASS' || result.stage !== 'complete' || functionalResult.passed !== true || measurement.valid !== true || typeof result.finished_at !== 'string' || !Number.isFinite(Date.parse(result.finished_at))) invalid('incomplete_result', 'Functional checks and complete valid measurement are both required.');
    if (result.attempt_id !== settings.id || result.strategy_id !== strategy.id || (settings.strategy_id !== undefined && settings.strategy_id !== strategy.id)) invalid('attempt_identity_mismatch', 'Result belongs to another attempt or strategy.');
    const actualKey = currentCompatibility(path, settings, strategy);
    if (result.compatibility_key !== settings.compatibility_key || result.compatibility_key !== actualKey) invalid('recipe_identity_mismatch', 'Current recipe/runtime inputs differ from the measured compatibility identity.');
    const count = positiveInteger(measurement.issued, 'issued request count');
    const duration = positiveNumber(measurement.duration_seconds, 'measurement duration');
    if (count !== routine.requests || count !== measurement.completed || count !== measurement.success || count !== requests.length || measurement.failed !== 0) invalid('request_accounting_mismatch', 'Declared, issued, completed and successful request counts must agree.');
    const indices = new Set<number>();
    for (const entry of requests) {
      const index = integerValue(entry.index, 'request index');
      if (index < 0 || index >= count || indices.has(index) || entry.success !== true || !finitePositive(entry.seconds)) invalid('invalid_request_record', 'Request records contain missing, duplicate, failed or invalid-duration entries.');
      indices.add(index);
    }
    if (indices.size !== count) invalid('missing_request_records', 'Every issued request needs one successful raw record.');
    if (result.schema === 'embedding-e2e/1') {
      kind = 'legacy_read_only';
    } else {
      kind = 'fresh';
      if (result.evidence_kind !== 'measured') invalid('MOCK_EVIDENCE', 'Synthetic or unclassified evidence cannot complete a real model campaign.');
      const attempt = validateAttemptIdentity(path);
      const binding = asRecord(result.binding, 'evidence binding');
      const current = createBinding(attempt, routine, stringValue(binding.original_routine_path, 'original routine path'));
      if (digest(binding) !== digest(current)) invalid('evidence_binding_changed', 'Receipt, inputs, source, settings, recipe or container identity changed after measurement.');
      const postHealth = asRecord(result.post_health, 'post health');
      if (postHealth.passed !== true || optionalRecord(postHealth.health).status !== 'ok' || digest(postHealth.runtime) !== digest(functionalResult.runtime)) invalid('post_health_failed', 'Post-measurement health and unchanged runtime identity are required.');
      validateRuntimeInfo(asRecord(functionalResult.runtime, 'functional runtime'), strategy, settings);
      const runtimeBackend = asRecord(asRecord(functionalResult.runtime, 'functional runtime').backend, 'backend');
      if (runtimeBackend.device_observed !== true) validateDeviceEvidence(functionalResult.device_evidence, strategy, settings, path);
      const boundary = asRecord(functionalResult.boundary_tokens, 'token boundary');
      if (positiveInteger(boundary.accepted, 'accepted boundary') > positiveInteger(strategy.context_window, 'context') || positiveInteger(boundary.rejected, 'rejected boundary') <= positiveInteger(strategy.context_window, 'context')) invalid('invalid_token_boundary', 'Functional evidence does not prove accepted and rejected real token boundaries.');
      const requiredChecks = ['model', 'count', 'order_vs_same_runtime_singles', 'dimension', 'request_dimensions', 'finite', 'device', 'input_policy', 'invalid_input', 'real_token_boundary'];
      const checks = arrayValue(functionalResult.checks, 'functional checks');
      if (requiredChecks.some((check) => !checks.includes(check))) invalid('functional_checks_missing', 'Current functional check definition was not completed.');
      const rawFunctional = load(join(dirname(routinePath), 'functional-requests.json'));
      validateFunctionalTranscript(rawFunctional, functionalResult, strategy, routine);
      const warmups = arrayValue(load(join(dirname(routinePath), 'warmup-requests.json')), 'warmup records').map((entry) => asRecord(entry, 'warmup record'));
      const evidenceDigests = asRecord(result.evidence_digests, 'evidence digests');
      if (evidenceDigests.requests !== digest(requests) || evidenceDigests.functional !== digest(rawFunctional) || evidenceDigests.warmup !== digest(warmups)) invalid('raw_evidence_changed', 'Raw functional, warmup or measurement evidence changed.');
      if (arrayValue(rawFunctional, 'functional request evidence').length === 0) invalid('functional_evidence_missing', 'Functional HTTP evidence is missing.');
      if (warmups.length !== routine.warmup_requests || measurement.warmup_completed !== routine.warmup_requests || measurement.concurrency !== routine.concurrency) invalid('routine_accounting_mismatch', 'Warmup or concurrency accounting differs from the declared routine.');
      const expectedBody = {input: routine.inputs, model: strategy.model};
      const model = stringValue(strategy.model, 'model');
      const dimension = positiveInteger(strategy.dimensions, 'dimensions');
      for (const [index, warmup] of warmups.entries()) {
        if (warmup.index !== index || warmup.success !== true || digest(warmup.body) !== digest(expectedBody)) invalid('invalid_warmup_record', 'Warmup request does not match its declared input/index.');
        vectors(warmup.response, routine.inputs.length, dimension, model);
      }
      for (const entry of requests) {
        if (digest(entry.body) !== digest(expectedBody)) invalid('request_input_mismatch', 'Measured request inputs differ from the declared routine.');
        vectors(entry.response, routine.inputs.length, dimension, model);
        if (typeof entry.started_at !== 'string' || typeof entry.finished_at !== 'string' || !Number.isFinite(Date.parse(entry.started_at)) || !Number.isFinite(Date.parse(entry.finished_at)) || Date.parse(entry.finished_at) < Date.parse(entry.started_at)) invalid('request_time_invalid', 'Measured request start/end evidence is invalid.');
      }
      const durations = requests.map((entry) => positiveNumber(entry.seconds, 'request seconds'));
      if (digest(measurement.latency_seconds) !== digest(quantiles(durations))) invalid('latency_accounting_mismatch', 'Latency metrics do not reproduce the raw request durations.');
      if (!closeNumber(measurement.requests_per_second, count / duration) || !closeNumber(measurement.vectors_per_second, count * routine.inputs.length / duration)) invalid('throughput_accounting_mismatch', 'Throughput metrics do not reproduce completed requests and vectors.');
      const start = Date.parse(stringValue(measurement.started_at, 'measurement start'));
      const finish = Date.parse(stringValue(measurement.finished_at, 'measurement finish'));
      if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) invalid('measurement_time_invalid', 'Measurement interval is invalid.');
      const edges: Array<{at: number; change: number}> = [];
      for (const entry of requests) {
        const began = numberValue(entry.start_offset_seconds, 'request monotonic start');
        const ended = numberValue(entry.finish_offset_seconds, 'request monotonic finish');
        if (began < 0 || ended <= began || ended > duration || !closeNumber(entry.seconds, ended - began)) invalid('request_interval_invalid', 'Raw monotonic request intervals do not match measured durations.');
        edges.push({at: began, change: 1}, {at: ended, change: -1});
        const requestStart = Date.parse(stringValue(entry.started_at, 'request start'));
        const requestFinish = Date.parse(stringValue(entry.finished_at, 'request finish'));
        if (requestStart < start || requestFinish > finish) invalid('request_outside_measurement', 'A raw request falls outside the measured interval.');
      }
      let active = 0;
      for (const edge of edges.toSorted((left, right) => left.at - right.at || left.change - right.change)) {
        active += edge.change;
        if (active > routine.concurrency || active < 0) invalid('concurrency_accounting_mismatch', 'Raw request intervals exceed the declared concurrency.');
      }
      if (active !== 0) invalid('concurrency_accounting_mismatch', 'Raw request intervals are incomplete.');
      const tool = asRecord(result.tool, 'benchmark tool');
      if (tool.source_digest !== current.tool_source_digest) invalid('check_definition_changed', 'Benchmark check source changed since this run.');
    }
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    invalid('unreadable_or_invalid_evidence', error.message);
  }
  return {valid: reasons.length === 0, fresh: reasons.length === 0 && kind === 'fresh', kind: reasons.length === 0 ? kind : 'invalid', reasons, result: resultPath};
}
