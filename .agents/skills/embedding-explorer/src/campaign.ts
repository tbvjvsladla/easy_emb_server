/** Durable ordered campaigns; phase workers own effects and inherited leases. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {GateError, ROOT, absolutePath, arrayValue, asRecord, cloneJson, digest, integerValue,
  load, loadRecord, now, numberValue, omitRecordKeys, optionalString, save, sha256Bytes, stringValue} from '../../../harness/common.ts';
import type {JsonObject} from '../../../harness/common.ts';
import * as models from './models.ts';
import * as attempts from './attempts.ts';
import {build as buildImage} from '../../embedding-upstream/src/build.ts';
import {serve, stop} from './serving.ts';
import * as bench from '../../embedding-lite-bench/src/bench.ts';
import {assessRecovery} from './recovery.ts';
import type {RecoveryInputs} from './recovery.ts';
import {parseManifest} from '../../terraforming-node/src/hardware.ts';
import {LeaseBusyError, alive, assertPersistentExecutionEnvironment, executionLeasePaths, identity, inheritedLeaseBindings, observeProcess,
  runCommand, spawnDetached, withExecutionLease, withFileLease, withInheritedLeases} from '../../../harness/processes.ts';

/** Finite campaign phases; prepare also runs under recorded worker ownership. */
export type Phase = 'prepare' | 'build' | 'serve' | 'bench' | 'stop' | 'done';

/** Persists one condition's attempts, outcome, unanswered question and recovery. */
export interface CellState extends JsonObject {
  id: string;
  strategy: string | null;
  selection: JsonObject;
  phase: Phase;
  outcome: string;
  attempts: JsonObject[];
  attempt: string | null;
  request: string | null;
  recovery: JsonObject | null;
  evidence: string[];
  unresolved: JsonObject | null;
}

/** Stores the single authoritative campaign checkpoint. */
export interface CampaignState extends JsonObject {
  schema: string;
  id: string;
  sequence: number;
  declaration: JsonObject;
  declaration_digest: string;
  model_output: string;
  cells: {[cellId: string]: CellState};
  active: JsonObject | null;
  invocations: JsonObject[];
  requests: {[requestId: string]: JsonObject};
  journey: JsonObject[];
  report: string | null;
}

/** Describes a bounded recovery decision within the already approved strategy. */
export interface RetryOptions {
  reason: string;
  hypothesis: string;
  change: string;
  engine?: string;
  phase?: string;
  dtype?: string;
  limits?: JsonObject;
  builder?: string;
  observationPaths?: string[];
}

/** Records a non-PASS outcome with enough evidence to resume later. */
export interface ResolveOptions {
  outcome: string;
  reason: string;
  evidence: string;
  resumeCondition: string;
}

/** Constrains fresh unresolved evidence to the actual evaluation and its verified callers. */
export interface UnresolvedEvidenceOptions {
  notBefore?: string;
  evaluationId?: string;
  upstreamDigest?: string;
  controlThreads?: ReadonlySet<string>;
}

/** Keeps historical handoffs readable without treating them as fresh evaluation evidence. */
export interface UnresolvedEvidenceValidation {
  valid: boolean;
  fresh: boolean;
  kind: 'fresh' | 'legacy_read_only' | 'invalid';
  reasons: string[];
  evidence: string | null;
  worker: string | null;
}

const SCHEMA = 'embedding-campaign-checkpoint/1';
const CHOICES = ['device', 'context_window', 'dimensions'];
const TERMINAL = new Set(['PASS', 'FAIL', 'BLOCKED', 'UNVERIFIED']);
const NEXT_PHASE = new Map<Phase, Phase>([['prepare', 'build'], ['build', 'serve'], ['serve', 'bench'], ['bench', 'stop'], ['stop', 'done']]);
const RECOVERY_LIMITS = ['build_timeout_seconds', 'startup_timeout_seconds', 'functional_timeout_seconds'];

function phaseValue(value: unknown): Phase {
  switch (value) {
    case 'prepare': case 'build': case 'serve': case 'bench': case 'stop': case 'done': return value;
    default: throw new GateError('CAMPAIGN_PHASE', `Unknown phase: ${String(value)}`);
  }
}

function nullableString(value: unknown, label: string): asserts value is string | null {
  if (value !== null) stringValue(value, label);
}

function recordArray(value: unknown, label: string): JsonObject[] {
  return arrayValue(value, label).map((entry) => asRecord(entry, label));
}

function assertCell(value: JsonObject): asserts value is CellState {
  safeId(value.id);
  nullableString(value.strategy, 'strategy');
  asRecord(value.selection, 'selection');
  phaseValue(value.phase);
  stringValue(value.outcome, 'outcome');
  recordArray(value.attempts, 'attempts');
  nullableString(value.attempt, 'attempt');
  nullableString(value.request, 'request');
  if (value.recovery !== null) asRecord(value.recovery, 'recovery');
  for (const item of arrayValue(value.evidence, 'evidence')) stringValue(item, 'evidence path');
  if (value.unresolved !== null) asRecord(value.unresolved, 'unresolved');
}

function assertState(value: JsonObject): asserts value is CampaignState {
  if (value.schema !== SCHEMA) throw new GateError('CAMPAIGN_SCHEMA', 'Unsupported campaign checkpoint schema.');
  safeId(value.id);
  if (integerValue(value.sequence, 'sequence') < 0) throw new GateError('CAMPAIGN_SCHEMA', 'Negative checkpoint sequence.');
  const declaration = asRecord(value.declaration, 'declaration');
  recordArray(declaration.cells, 'declared cells');
  stringValue(value.declaration_digest, 'declaration digest');
  stringValue(value.model_output, 'model output');
  const cells = asRecord(value.cells, 'cells');
  for (const [key, item] of Object.entries(cells)) {
    const cell = asRecord(item, 'cell');
    assertCell(cell);
    if (key !== cell.id) throw new GateError('CAMPAIGN_SCHEMA', 'Cell key differs from cell identity.');
  }
  const declaredIds = recordArray(declaration.cells, 'declared cells').map((entry) => safeId(entry.id));
  if (new Set(declaredIds).size !== declaredIds.length || declaredIds.length !== Object.keys(cells).length ||
      declaredIds.some((id) => !Object.hasOwn(cells, id))) throw new GateError('CAMPAIGN_SCHEMA', 'Checkpoint cell set differs from its declaration.');
  if (value.active !== null) asRecord(value.active, 'active operation');
  recordArray(value.invocations, 'invocations');
  for (const item of Object.values(asRecord(value.requests, 'requests'))) asRecord(item, 'request');
  recordArray(value.journey, 'journey');
  nullableString(value.report, 'report');
}

/** Rejects path traversal and unsupported campaign/cell identifiers. */
export function safeId(value: unknown): string {
  const id = stringValue(value, 'campaign or cell ID');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/u.test(id) || id === '.' || id === '..') {
    throw new GateError('CAMPAIGN_ID', 'Campaign and cell IDs must be safe nonempty path components.');
  }
  return id;
}

function readState(base: string): CampaignState {
  const state = loadRecord(path.join(base, 'checkpoint.json'));
  assertState(state);
  const declaration = load(path.join(base, 'campaign.yaml'));
  if (digest(declaration) !== state.declaration_digest || digest(state.declaration) !== state.declaration_digest) {
    throw new GateError('CAMPAIGN_DECLARATION_DRIFT', 'Campaign declaration/checkpoint mismatch; preserve and investigate drift.');
  }
  return state;
}

async function transaction<T>(base: string, action: (base: string, state: CampaignState) => Promise<T>): Promise<T> {
  const canonical = absolutePath(base);
  if (!fs.existsSync(path.join(canonical, 'checkpoint.json'))) throw new GateError('CAMPAIGN_MISSING', `No campaign checkpoint: ${canonical}`);
  return await withFileLease(path.join(canonical, '.state.lock'), async () => await action(canonical, readState(canonical)), {waitMs: 30_000});
}

function commit(base: string, state: CampaignState, event: string, data: JsonObject = {}): void {
  state.sequence += 1;
  state.updated_at = now();
  state.journey.push({sequence: state.sequence, at: state.updated_at, event, ...data});
  save(path.join(base, 'checkpoint.json'), state);
}

function definition(state: CampaignState, cellId: string): JsonObject {
  const found = recordArray(state.declaration.cells, 'cells').find((entry) => entry.id === cellId);
  if (!found) throw new GateError('CAMPAIGN_CELL', `Cell is not declared: ${cellId}`);
  return found;
}

function cellState(state: CampaignState, cellId: string): CellState {
  const cell = state.cells[cellId];
  if (!Object.hasOwn(state.cells, cellId) || !cell) throw new GateError('CAMPAIGN_CELL', `Cell is not declared: ${cellId}`);
  return cell;
}

function orderedCells(state: CampaignState): CellState[] {
  return recordArray(state.declaration.cells, 'cells').map((spec) => cellState(state, stringValue(spec.id)));
}

/** Selects the first unfinished declared condition, preserving numeric-ID order. */
export function current(state: CampaignState): string | null {
  return orderedCells(state).find((cell) => cell.phase !== 'done')?.id ?? null;
}

function checkStrategy(spec: JsonObject, receipt: string): models.Strategy {
  const {strategy} = models.checkedStrategy(receipt);
  if (absolutePath(strategy.model_path) !== absolutePath(stringValue(spec.model_path))) {
    throw new GateError('APPROVAL_MODEL_MISMATCH', 'Strategy belongs to another model.');
  }
  for (const [key, raw] of Object.entries(asRecord(spec.comparison ?? {}, 'comparison'))) {
    if (!CHOICES.includes(key)) throw new GateError('CAMPAIGN_COMPARISON', `Unsupported comparison axis ${key}.`);
    const expected = key === 'dimensions' && raw === 'native' ? strategy.native_dimensions : raw;
    if (strategy[key] !== expected) throw new GateError('APPROVAL_COMPARISON_MISMATCH', `Strategy violates comparison axis ${key}.`);
  }
  return strategy;
}

function resultCompatibility(cell: CellState): string {
  if (!cell.attempt) return 'unmeasured';
  const settings = path.join(cell.attempt, 'settings.yaml');
  if (!fs.existsSync(settings)) return 'unverified';
  return loadRecord(settings).schema === 'embedding-attempt/2' ? 'current' : 'legacy_read_only';
}

function summary(base: string, state: CampaignState): JsonObject {
  const cellId = current(state);
  const cell = cellId ? cellState(state, cellId) : null;
  const request = cell?.request ? state.requests[cell.request] ?? null : null;
  let taskState = 'working';
  let nextAction = state.active ? 'observe' : 'step';
  if (request?.state === 'pending') { taskState = 'input-required'; nextAction = 'answer'; }
  else if (!cell) { taskState = state.report ? 'completed' : 'working'; nextAction = state.report ? 'none' : 'report'; }
  else if (cell.recovery) nextAction = 'diagnose-and-retry-or-resolve';
  const ownerObservation = state.active ? observeProcess(state.active.process) : null;
  let recoveryOptions: JsonObject | null = null;
  if (cell?.recovery && cell.strategy && !state.active) {
    try { recoveryOptions = assessRecovery(recoveryInputs(base, state, cell, now())); }
    catch (error: unknown) { recoveryOptions = {assessment_error: errorRecord(error)}; }
  }
  return {schema: 'embedding-campaign-status/1', campaign: base, campaign_id: state.id,
    goal: state.declaration.goal, sequence: state.sequence, task_state: taskState,
    campaign_complete: Boolean(state.report), resumable: Boolean(cell) || orderedCells(state).some((entry) => entry.unresolved !== null),
    next_action: nextAction, current_cell: cellId,
    active: state.active ? {...state.active, owner_alive: ownerObservation?.state === 'unavailable' ? null : ownerObservation?.state === 'alive', owner_observation: ownerObservation} : null,
    hitl: request, recovery_options: recoveryOptions, cells: orderedCells(state).map((entry) => ({id: entry.id, phase: entry.phase, outcome: entry.outcome,
      strategy: entry.strategy, attempt: entry.attempt, recovery: entry.recovery, unresolved: entry.unresolved,
      condition_id: definition(state, entry.id).condition_id ?? entry.id, result_compatibility: resultCompatibility(entry)})),
    journey_tail: state.journey.slice(-4), report: state.report,
    evaluation_id: state.declaration.evaluation_id ?? null, group: state.declaration.group ?? null,
    resume_command: [process.execPath, path.join(ROOT, '.agents/skills/embedding-explorer/src/cli.ts'), 'campaign', 'step', '--campaign', base]};
}

/** Reads canonical checkpoint state without launching or replaying effects. */
export async function status(base: string): Promise<JsonObject> {
  return await transaction(base, async (canonical, state) => summary(canonical, state));
}

/** Creates an exclusive new declaration; existing campaigns are only resumed. */
export async function initialize(specPath: string, outputRoot = path.join(ROOT, 'output')): Promise<JsonObject> {
  const spec = asRecord(cloneJson(load(specPath)), 'campaign specification');
  if (spec.schema !== 'embedding-campaign/1' || !stringValue(spec.goal, 'goal').trim()) {
    throw new GateError('CAMPAIGN_SPEC', 'An embedding-campaign/1 declaration and explicit goal are required.');
  }
  const specs = recordArray(spec.cells, 'declared cells');
  if (!specs.length) throw new GateError('CAMPAIGN_SPEC', 'Declare a nonempty ordered cell list.');
  const campaignId = safeId(spec.id);
  const output = absolutePath(outputRoot);
  const base = path.join(output, 'campaigns', campaignId);
  const manifestSource = absolutePath(optionalString(spec.manifest) ?? path.join(ROOT, 'manifest.yaml'));
  const manifest = parseManifest(loadRecord(manifestSource));
  spec.manifest = manifestSource;
  spec.manifest_digest = digest(manifest);
  const runtime = asRecord(spec.runtime ?? {}, 'runtime');
  runtime.bind ??= '127.0.0.1';
  runtime.port ??= 8080;
  const port = integerValue(runtime.port, 'port');
  if (port < 1 || port > 65535) throw new GateError('CAMPAIGN_SPEC', 'API port must be 1..65535.');
  const routine = typeof runtime.routine === 'object' && runtime.routine !== null ? runtime.routine :
    load(optionalString(runtime.routine) ?? path.join(ROOT, 'config/lite.yaml'));
  bench.validateRoutine(routine);
  runtime.routine = routine;
  spec.runtime = runtime;
  const recovery = asRecord(spec.recovery ?? {}, 'recovery policy');
  recovery.max_attempts_per_cell ??= 8;
  recovery.max_elapsed_seconds_per_cell ??= 14_400;
  if (integerValue(recovery.max_attempts_per_cell) < 1 || numberValue(recovery.max_elapsed_seconds_per_cell) <= 0) {
    throw new GateError('RECOVERY_BUDGET', 'Recovery budgets must be finite and positive.');
  }
  spec.recovery = recovery;
  const cells: {[cellId: string]: CellState} = {};
  for (const cell of specs) {
    if (Object.keys(cell).some((key) => !['id', 'model_path', 'comparison', 'build', 'strategy', 'condition_id'].includes(key))) {
      throw new GateError('CAMPAIGN_SPEC', 'Unknown cell input; declare supported comparisons/build settings explicitly.');
    }
    const cellId = safeId(cell.id);
    if (Object.hasOwn(cells, cellId)) throw new GateError('CAMPAIGN_SPEC', 'Duplicate cell ID.');
    cell.model_path = absolutePath(stringValue(cell.model_path));
    if (!fs.existsSync(path.join(stringValue(cell.model_path), 'config.json'))) throw new GateError('MODEL_METADATA', 'Model config.json is missing.');
    const comparison = asRecord(cell.comparison ?? {}, 'comparison');
    if (Object.keys(comparison).some((key) => !CHOICES.includes(key))) throw new GateError('CAMPAIGN_COMPARISON', 'Comparison supports device/context_window/dimensions.');
    cell.comparison = comparison;
    const build = asRecord(cell.build ?? {}, 'build');
    if (Object.keys(build).some((key) => !['builder', 'recipes', 'release_snapshot', 'dtype', 'limits'].includes(key))) {
      throw new GateError('CAMPAIGN_BUILD', 'Unknown build setting.');
    }
    const recipes: JsonObject = {};
    for (const [filename, source] of Object.entries(asRecord(build.recipes ?? {}, 'recipes'))) {
      if (!['Dockerfile', 'Dockerfile.gateway'].includes(filename)) throw new GateError('CAMPAIGN_RECIPE', 'Recipes must name generated Dockerfiles.');
      const sourcePath = absolutePath(stringValue(source, 'recipe source'));
      const content = fs.readFileSync(sourcePath, 'utf8');
      recipes[filename] = {source: sourcePath, content, digest: digest(content)};
    }
    build.recipes = recipes;
    cell.build = build;
    const receipt = cell.strategy ? absolutePath(stringValue(cell.strategy)) : null;
    if (receipt) checkStrategy(cell, receipt);
    cell.strategy = receipt;
    cells[cellId] = {id: cellId, strategy: receipt, selection: {}, phase: 'prepare', outcome: 'pending',
      attempts: [], attempt: null, request: null, recovery: null, evidence: [], unresolved: null};
  }
  fs.mkdirSync(path.dirname(base), {recursive: true});
  fs.mkdirSync(base);
  save(path.join(base, 'campaign.yaml'), spec);
  save(path.join(base, 'routine.yaml'), routine);
  save(path.join(base, 'host-manifest.yaml'), manifest);
  const state: CampaignState = {schema: SCHEMA, id: campaignId, created_at: now(), updated_at: now(), sequence: 0,
    declaration: spec, declaration_digest: digest(spec), model_output: output, cells, active: null,
    invocations: [], requests: {}, journey: [], report: null};
  commit(base, state, 'campaign_created', {source: absolutePath(specPath)});
  return await status(base);
}

function ensureQuestion(state: CampaignState, cellId: string, strategyError?: Error): void {
  const cell = cellState(state, cellId);
  if (cell.request) return;
  const spec = definition(state, cellId);
  const field = strategyError ? 'strategy' : CHOICES.find((choice) => !Object.hasOwn(cell.selection, choice));
  if (!field) throw new GateError('APPROVAL_INTERRUPTED', 'Selections have no receipt; inspect interrupted approval.');
  const profile = models.inspectModel(stringValue(spec.model_path));
  const scope: JsonObject = {declaration: state.declaration_digest, cell: cellId, field,
    prior: cloneJson(cell.selection), model_fingerprint: profile.fingerprint};
  if (strategyError) scope.previous_strategy = cell.strategy;
  const key = `${cellId}-${field === 'strategy' ? 'strategy-' : ''}${digest(scope).slice(0, 16)}`;
  const supported: JsonObject = {device: ['cpu', 'gpu'], context_window: profile.recommended_context_window,
    dimensions: {native: profile.native_dimensions, reduction: profile.reduction},
    strategy: {context_window: profile.recommended_context_window, native_dimensions: profile.native_dimensions, reduction: profile.reduction}};
  const questions: JsonObject = {device: 'CPU 또는 GPU를 선택하세요.', context_window: '최대 입력 토큰을 선택하세요.',
    dimensions: '원래 차원 또는 모델이 지원하는 축소 차원을 선택하세요.',
    strategy: '승인 범위가 변경됐습니다. 실제 사용자 결정이 기록된 호환 승인 영수증 경로를 전달하세요.'};
  state.requests[key] = {id: key, cell_id: cellId, field, scope, state: 'pending', question: questions[field],
    supported: supported[field], suggested: asRecord(spec.comparison)[field] ?? null, reason: strategyError?.message ?? null,
    created_at: now(), resume_point: {cell_id: cellId, phase: cell.phase}};
  cell.request = key;
}

/** Applies exactly the pending human answer; exact replay is idempotent. */
export async function answer(base: string, answerPath: string): Promise<JsonObject> {
  const payload = loadRecord(answerPath);
  return await transaction(base, async (canonical, state) => {
    const request = state.requests[stringValue(payload.request_id)];
    if (!request || payload.cell_id !== request.cell_id) throw new GateError('APPROVAL_QUESTION', 'Answer does not match question and cell.');
    if (request.state === 'answered') {
      if (isDeepStrictEqual(request.answer, payload)) return summary(canonical, state);
      throw new GateError('APPROVAL_REPLAY', 'An answered question cannot be replaced.');
    }
    const cellId = stringValue(request.cell_id);
    const cell = cellState(state, cellId);
    const spec = definition(state, cellId);
    const profile = models.inspectModel(stringValue(spec.model_path));
    if (!isDeepStrictEqual(profile.fingerprint, asRecord(request.scope).model_fingerprint) || cell.request !== request.id) {
      throw new GateError('APPROVAL_SCOPE_CHANGED', 'Approval scope changed; stale answer rejected.');
    }
    const field = stringValue(request.field);
    const value = payload.value;
    if (field === 'strategy') {
      return await withExecutionLease({campaign: canonical}, async () => {
        if (state.active) throw new GateError('EXECUTION_BUSY', 'Observe active operation before reconnecting approval.');
        const replacement = absolutePath(stringValue(value, 'replacement receipt'));
        const strategy = checkStrategy(spec, replacement);
        if (cell.attempts.length && cell.strategy && fs.existsSync(cell.strategy)) {
          const previous = loadRecord(cell.strategy);
          if (CHOICES.some((key) => previous[key] !== strategy[key])) throw new GateError('CAMPAIGN_COMPARISON', 'Changed choices require a new cell.');
        }
        cell.recovery = null;
        cell.phase = cell.attempt && fs.existsSync(path.join(cell.attempt, 'containers.json')) ? 'stop' : 'prepare';
        const receiptChange = {previous: cell.strategy, replacement, previous_attempt: cell.attempt,
          request_id: request.id, answered_at: now()};
        delete cell.next_recovery;
        if (cell.phase === 'stop') {
          cell.pending_strategy = receiptChange;
          cell.next_after_stop = 'prepare';
        } else {
          cell.strategy = replacement;
          cell.attempt = null;
          cell.receipt_history = [...arrayValue(cell.receipt_history ?? []), receiptChange];
        }
        request.state = 'answered'; request.answer = payload; request.answered_at = now(); cell.request = null;
        commit(canonical, state, 'compatible_approval_reconnected', {cell_id: cellId, request_id: request.id});
        return summary(canonical, state);
      });
    }
    const source = models.validateUserSource(payload.source);
    if (field === 'device' && value !== 'cpu' && value !== 'gpu') throw new GateError('APPROVAL_DEVICE', 'Choose cpu or gpu.');
    if (field === 'context_window' && (integerValue(value) <= 0 || integerValue(value) > numberValue(profile.recommended_context_window))) {
      throw new GateError('APPROVAL_CONTEXT', 'Input limit lacks model support.');
    }
    const comparison = asRecord(spec.comparison);
    if (Object.hasOwn(comparison, field)) {
      const expected = field === 'dimensions' && comparison[field] === 'native' ? profile.native_dimensions : comparison[field];
      const actual = field === 'dimensions' && value === 'native' ? profile.native_dimensions : value;
      if (actual !== expected) throw new GateError('CAMPAIGN_COMPARISON', 'Answer changes a declared comparison; declare another cell.');
    }
    cell.selection[field] = {value, source};
    if (CHOICES.every((key) => Object.hasOwn(cell.selection, key))) {
      const authorization = path.join(canonical, 'approvals', `${cellId}-${digest(cell.selection).slice(0, 16)}.json`);
      const manifestPath = state.declaration.manifest_digest === undefined ? path.join(ROOT, 'manifest.yaml') : path.join(canonical, 'host-manifest.yaml');
      const manifest = loadRecord(manifestPath);
      if (state.declaration.manifest_digest !== undefined && digest(manifest) !== state.declaration.manifest_digest) throw new GateError('MANIFEST_TAMPERED', 'Campaign host snapshot changed before approval.');
      const authorizationRecord: JsonObject = {schema: 'embedding-user-approval/1', model_path: spec.model_path,
        selections: CHOICES.map((key) => ({key, ...asRecord(cell.selection[key])}))};
      if (manifest.evidence_kind === 'mock') authorizationRecord.evidence_kind = 'mock';
      save(authorization, authorizationRecord);
      const receipt = models.approve({model: stringValue(spec.model_path), manifest: manifestPath,
        device: stringValue(asRecord(cell.selection.device).value), contextWindow: integerValue(asRecord(cell.selection.context_window).value),
        dimensions: String(asRecord(cell.selection.dimensions).value), approvalReference: authorization, output: state.model_output});
      const receiptPath = stringValue(receipt.strategy);
      checkStrategy(spec, receiptPath);
      cell.strategy = receiptPath;
    }
    request.state = 'answered'; request.answer = payload; request.answered_at = now(); cell.request = null;
    commit(canonical, state, 'human_answer_recorded', {cell_id: cellId, request_id: request.id, field});
    return summary(canonical, state);
  });
}

/** Connects an existing checked receipt without inventing another approval. */
export async function attachStrategy(base: string, cellId: string, receipt: string): Promise<JsonObject> {
  return await transaction(base, async (canonical, state) => {
    const cell = cellState(state, cellId);
    if (cell.attempts.length || state.active) throw new GateError('APPROVAL_REPLACE', 'Cannot replace approval after work started.');
    checkStrategy(definition(state, cellId), receipt);
    cell.strategy = absolutePath(receipt);
    if (cell.request) {
      const request = state.requests[cell.request];
      if (request) Object.assign(request, {state: 'answered', answer: {existing_receipt: cell.strategy}, answered_at: now()});
      cell.request = null;
    }
    commit(canonical, state, 'approved_strategy_attached', {cell_id: cellId, strategy: cell.strategy});
    return summary(canonical, state);
  });
}

async function inspectResource(kind: string, name: string): Promise<{probe: JsonObject; info: JsonObject | null}> {
  const result = await runCommand(['docker', kind, 'inspect', name], {timeoutSeconds: 20});
  if (result.code !== 0 || result.timedOut || result.spawnError) {
    const absent = !result.timedOut && !result.spawnError && /no such (?:object|container|image|network)/iu.test(result.stderr);
    return {probe: {present: absent ? false : null, probe_status: absent ? 'absent' : 'query_failed', error: result.stderr}, info: null};
  }
  try {
    const info = asRecord(arrayValue(JSON.parse(result.stdout))[0]);
    return {probe: {present: true, probe_status: 'observed'}, info};
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    return {probe: {present: null, probe_status: 'query_failed', error: error.message}, info: null};
  }
}

/** Reconciles actual owned processes/containers/images; query errors are not absence. */
export async function observedResources(attempt: string): Promise<JsonObject> {
  const cfg = loadRecord(path.join(attempt, 'settings.yaml'));
  const images: JsonObject[] = [];
  const containers: JsonObject[] = [];
  const activePath = path.join(attempt, 'active.json');
  const command = fs.existsSync(activePath) ? loadRecord(activePath) : null;
  const imagePath = path.join(attempt, 'images.json');
  if (fs.existsSync(imagePath)) {
    for (const raw of Object.values(loadRecord(imagePath))) {
      const image = asRecord(raw);
      const id = stringValue(image.id);
      const {probe, info} = await inspectResource('image', id);
      images.push({id, ...probe, identity_matches: info ? info.Id === id : null});
    }
  }
  const containerPath = path.join(attempt, 'containers.json');
  const recorded = fs.existsSync(containerPath) ? loadRecord(containerPath) : {};
  for (const role of ['api', 'backend']) {
    const name = optionalString(recorded[role]);
    if (!name) continue;
    const {probe, info} = await inspectResource('container', name);
    if (!info) { containers.push({role, name, ...probe}); continue; }
    const labels = asRecord(asRecord(info.Config).Labels ?? {});
    containers.push({role, name, ...probe, owned: labels['easy-emb.attempt'] === cfg.id && labels['easy-emb.strategy'] === cfg.strategy_id,
      running: asRecord(info.State).Running, image: info.Image});
  }
  const commandObservation = command ? observeProcess(command.process) : null;
  return {attempt, settings_state: cfg.state, process: command ? {...command,
    alive: commandObservation?.state === 'unavailable' ? null : commandObservation?.state === 'alive', observation: commandObservation} : null, containers, images};
}

function verifyResources(observed: JsonObject): void {
  const containers = recordArray(observed.containers, 'containers');
  const resources = [...containers, ...recordArray(observed.images, 'images')];
  if (resources.some((item) => item.probe_status === 'query_failed')) throw new GateError('RESOURCE_QUERY_FAILED', 'Resource observation failed; absence/completion is unverified.');
  if (containers.some((item) => item.present === true && item.owned !== true)) throw new GateError('RESOURCE_OWNER', 'Foreign container identity; refusing operation.');
  if (resources.some((item) => item.identity_matches === false)) throw new GateError('RESOURCE_IDENTITY', 'Image identity differs from attempt.');
  if (observed.process && asRecord(observed.process).alive === null) throw new GateError('PROCESS_OBSERVATION_UNAVAILABLE', 'Recorded command liveness cannot be established from this process namespace.', {nextAction: 'resume from the original execution environment', retryable: true});
  if (observed.process && asRecord(observed.process).alive === true) throw new GateError('EXECUTION_BUSY', 'Recorded actual command is still alive.');
}

function errorRecord(error: unknown): JsonObject {
  if (!(error instanceof Error)) throw error;
  return {type: error.name, message: error.message, code: error instanceof GateError ? error.code : null,
    ...(error instanceof GateError ? {evidence: error.evidence, next_action: error.nextAction, retryable: error.retryable} : {})};
}

function operationInputs(base: string, state: CampaignState, cell: CellState): JsonObject {
  const checked = models.checkedStrategyForCleanup(stringValue(cell.strategy));
  const build = asRecord(definition(state, cell.id).build);
  const upstreamPath = absolutePath(optionalString(build.release_snapshot) ?? path.join(ROOT, 'output/host/upstream-lock.json'));
  let upstream: JsonObject;
  let evidenceKind = checked.strategy.evidence_kind === 'mock' || checked.manifest.evidence_kind === 'mock' ? 'mock' : 'measured';
  try {
    const raw = fs.readFileSync(upstreamPath);
    const snapshot = loadRecord(upstreamPath);
    upstream = {path: upstreamPath, digest: digest(snapshot), sha256: sha256Bytes(raw)};
    if (snapshot.evidence_kind === 'mock') evidenceKind = 'mock';
  } catch (error: unknown) {
    upstream = {path: upstreamPath, error: errorRecord(error)};
    if (evidenceKind !== 'mock') evidenceKind = 'unverified';
  }
  return {schema: 'embedding-campaign-operation-inputs/1', campaign_path: base, campaign_id: state.id,
    declaration_digest: state.declaration_digest, evaluation_id: state.declaration.evaluation_id ?? null,
    group: state.declaration.group ?? null, cell_id: cell.id, attempt: cell.attempt,
    strategy_path: absolutePath(stringValue(cell.strategy)), strategy_id: checked.strategy.id, receipt_identity: checked.receiptIdentity,
    model_fingerprint_digest: digest(checked.strategy.model_fingerprint), upstream, evidence_kind: evidenceKind};
}

function unstartedInvocation(state: CampaignState, active: JsonObject): JsonObject | null {
  if (active.process !== null) return null;
  const invocations = state.invocations.filter((entry) => entry.id === active.invocation_id);
  const invocation = invocations[0];
  const related = state.journey.filter((entry) => entry.operation_id === active.operation_id || entry.invocation_id === active.invocation_id);
  const intents = related.filter((entry) => entry.event === 'phase_intent');
  const intent = intents[0];
  const cell = cellState(state, stringValue(active.cell_id));
  if (invocations.length !== 1 || !invocation || invocation.worker !== null || invocation.cell_id !== active.cell_id || invocation.phase !== active.phase ||
      cell.phase !== active.phase || invocation.attempt !== cell.attempt || intents.length !== 1 || !intent ||
      digest(omitRecordKeys(intent, ['sequence', 'at', 'event'])) !== digest(active) ||
      related.some((entry) => entry.event === 'phase_started')) return null;
  return invocation;
}

function preserveInterruption(filename: string, operation: JsonObject, observed: JsonObject | null, unstarted: boolean): JsonObject {
  const error = {code: 'worker_interrupted', message: unstarted ? 'Coordinator ended after recording intent but before confirming a worker' : 'Worker ended before checkpoint completion'};
  if (fs.existsSync(filename)) {
    const previous = loadRecord(filename);
    const finished = Date.parse(stringValue(previous.finished_at, 'interruption completion time'));
    if (digest(previous.operation) !== digest(operation) || digest(previous.error) !== digest(error) || previous.interrupted !== true ||
        (previous.interrupted_before_worker === true) !== unstarted || previous.result !== null ||
        !Number.isFinite(finished) || finished < Date.parse(stringValue(operation.started_at))) {
      throw new GateError('recovery_failure_evidence_changed', 'Preserved interruption evidence does not match this original operation.', {evidence: [filename]});
    }
    // A prior reconciler may have bound these exact bytes and then ended before
    // the checkpoint commit. Its original timestamp and observations stay fixed.
    return previous;
  }
  const record = {operation, finished_at: now(), observed, result: null, error, interrupted: true,
    ...(unstarted ? {interrupted_before_worker: true} : {})};
  save(filename, record);
  return record;
}

/** Starts one finite phase or observes its live owner without duplicate effects. */
export async function step(base: string): Promise<JsonObject> {
  return await transaction(base, async (canonical, state) => {
    try {
      return await withExecutionLease({campaign: canonical}, async () => {
        if (state.active) {
          const unstarted = unstartedInvocation(state, state.active);
          const observation = observeProcess(unstarted ? unstarted.caller : state.active.process);
          if (observation.state === 'alive') return {...summary(canonical, state), next_action: 'observe', execution_lease: 'owner-alive-checkpoint-retained'};
          if (observation.state === 'unavailable') throw new GateError('PROCESS_OBSERVATION_UNAVAILABLE', observation.reason,
            {evidence: [path.join(canonical, 'checkpoint.json')], nextAction: 'resume from the original execution environment', retryable: true});
          const old = state.active;
          const cell = cellState(state, stringValue(old.cell_id));
          const currentObserved = cell.attempt ? await observedResources(cell.attempt) : null;
          const evidence = path.join(canonical, 'workers', `${stringValue(old.operation_id)}.interrupted.json`);
          const record = preserveInterruption(evidence, old, currentObserved, Boolean(unstarted));
          const error = asRecord(record.error);
          const observed = record.observed;
          if (cell.attempt) await attempts.recordCampaignFailure(cell.attempt, evidence, {interrupted: true, interruptedBeforeWorker: Boolean(unstarted)});
          cell.evidence.push(evidence);
          cell.recovery = {phase: old.phase, reason: error.message, error, evidence, operation: old, observed,
            next: 'Inspect evidence, retry with changed conditions, or resolve with a follow-up.'};
          const invocation = state.invocations.find((entry) => entry.id === old.invocation_id);
          if (invocation) Object.assign(invocation, {finished_at: now(), phase_result: 'interrupted'});
          state.active = null;
          commit(canonical, state, 'interrupted_worker_reconciled', {cell_id: cell.id, observed, evidence});
        }
        const cellId = current(state);
        if (!cellId) return summary(canonical, state);
        const cell = cellState(state, cellId);
        if (!cell.strategy) {
          ensureQuestion(state, cellId);
          if (!state.journey.some((event) => event.request_id === cell.request)) commit(canonical, state, 'human_input_required', {cell_id: cellId, request_id: cell.request});
          return summary(canonical, state);
        }
        if (cell.phase !== 'stop') {
          try { checkStrategy(definition(state, cellId), cell.strategy); }
          catch (error: unknown) {
            if (!(error instanceof Error)) throw error;
            if (error instanceof GateError && ['APPROVAL_SCOPE_CHANGED', 'MODEL_CHANGED'].includes(error.code)) {
              ensureQuestion(state, cellId, error);
              if (!state.journey.some((event) => event.request_id === cell.request)) commit(canonical, state, 'changed_approval_scope', {cell_id: cellId, request_id: cell.request});
              return summary(canonical, state);
            }
            cell.recovery = {phase: cell.phase, error: errorRecord(error), reason: 'Approval integrity verification failed'};
            commit(canonical, state, 'approval_integrity_failed', {cell_id: cellId, error: errorRecord(error)});
            return summary(canonical, state);
          }
        }
        if (cell.recovery) return summary(canonical, state);
        assertPersistentExecutionEnvironment();
        const operationId = randomUUID();
        const invocationId = randomUUID();
        const log = path.join(canonical, 'workers', `${operationId}.log`);
        state.active = {operation_id: operationId, invocation_id: invocationId, cell_id: cellId,
          phase: cell.phase, started_at: now(), process: null, log, inputs: operationInputs(canonical, state, cell)};
        state.invocations.push({id: invocationId, caller: identity(), worker: null,
          codex_thread_id: process.env.CODEX_THREAD_ID ?? null, cell_id: cellId, attempt: cell.attempt, phase: cell.phase, started_at: now()});
        commit(canonical, state, 'phase_intent', state.active);
        try {
          const worker = spawnDetached([process.execPath, path.join(ROOT, '.agents/skills/embedding-explorer/src/cli.ts'), 'campaign', '_work', '--campaign', canonical,
            '--operation-id', operationId, '--lease-bindings', JSON.stringify(inheritedLeaseBindings())], {logPath: log});
          await new Promise<void>((ready, reject) => { worker.once('spawn', () => { ready(); }); worker.once('error', reject); });
          if (!worker.pid) throw new GateError('WORKER_SPAWN', 'Worker has no process identity.');
          state.active.process = identity(worker.pid);
          const invocation = state.invocations.at(-1);
          if (invocation) invocation.worker = state.active.process;
          commit(canonical, state, 'phase_started', state.active);
        } catch (error: unknown) {
          // A failed phase_started write may leave an in-memory PID that was
          // never durably assigned. Recover only the actual persisted intent.
          Object.assign(state, readState(canonical));
          if (!state.active || state.active.operation_id !== operationId) throw new GateError('WORKER_OWNER', 'Worker startup failed after its durable operation ownership changed.');
          commit(canonical, state, 'worker_spawn_failed', {cell_id: cellId, operation_id: operationId, invocation_id: invocationId, error: errorRecord(error)});
          return {...summary(canonical, state), next_action: 'observe', yield_reason: 'worker_spawn_failed'};
        }
        return summary(canonical, state);
      });
    } catch (error: unknown) {
      if (error instanceof LeaseBusyError) return {...summary(canonical, state), next_action: 'observe', execution_lease: 'held'};
      throw error;
    }
  });
}

/** Uses the benchmark module's sole evidence validator for current-attempt PASS. */
export async function validResult(cell: CellState): Promise<boolean> {
  if (!cell.attempt) return false;
  const validation = bench.validateResult(cell.attempt);
  return validation.valid && validation.fresh && validation.kind === 'fresh';
}

function renderOptions(base: string, state: CampaignState, cell: CellState): attempts.RenderOptions {
  const build = asRecord(definition(state, cell.id).build);
  const recovery = cell.next_recovery ? asRecord(cell.next_recovery) : null;
  const previous = recovery?.previous_attempt
    ? attempts.validateAttemptIdentityForCleanup(stringValue(recovery.previous_attempt)).settings : null;
  const options: attempts.RenderOptions = {campaignOwner: {campaign_path: base, cell_id: cell.id}, recipes: asRecord(build.recipes ?? {})};
  const engine = optionalString(recovery?.engine ?? previous?.engine);
  const reason = optionalString(recovery?.reason);
  const dtype = optionalString(recovery?.dtype ?? previous?.dtype ?? build.dtype);
  const builder = optionalString(recovery?.builder ?? previous?.builder ?? build.builder);
  const snapshot = optionalString(build.release_snapshot);
  if (engine) options.engine = engine;
  if (reason) options.reason = reason;
  if (dtype) options.dtype = dtype;
  if (builder) options.builder = builder;
  if (snapshot) options.releaseSnapshotPath = snapshot;
  const limits: JsonObject = {...asRecord(build.limits ?? {})};
  if (previous) {
    const inherited = asRecord(previous.limits, 'previous attempt limits');
    for (const key of RECOVERY_LIMITS) limits[key] = integerValue(inherited[key], key);
  }
  Object.assign(limits, asRecord(recovery?.limits ?? {}));
  if (Object.keys(limits).length) options.limits = limits;
  if (recovery?.previous_attempt) {
    options.recovery = {previousAttempt: stringValue(recovery.previous_attempt), reason: stringValue(recovery.reason),
      hypothesis: stringValue(recovery.hypothesis), change: stringValue(recovery.change)};
    if (recovery.observation_paths) options.recovery.observationPaths = arrayValue(recovery.observation_paths).map((item) => stringValue(item));
  }
  return options;
}

/** Performs one phase only after authenticating inherited leases and checkpoint PID. */
export async function work(base: string, operationId: string, bindings: unknown): Promise<JsonObject> {
  const canonical = absolutePath(base);
  return await withInheritedLeases(bindings, executionLeasePaths({campaign: canonical}), async () => {
    const snapshot = await transaction(canonical, async (directory, state) => {
      const active = state.active;
      if (!active || active.operation_id !== operationId || !alive(active.process) || asRecord(active.process).pid !== process.pid) {
        throw new GateError('WORKER_OWNER', 'Worker does not own this campaign operation.');
      }
      const cell = cellState(state, stringValue(active.cell_id));
      return {state, active, cell, runtime: asRecord(state.declaration.runtime), spec: definition(state, cell.id), base: directory};
    });
    const {active, cell, runtime, spec} = snapshot;
    const phase = phaseValue(active.phase);
    let error: JsonObject | null = null;
    let result: unknown = null;
    let observed: JsonObject | null = null;
    let prepared: string | null = null;
    try {
      if (phase !== 'stop') checkStrategy(spec, stringValue(cell.strategy));
      if (!isDeepStrictEqual(load(path.join(canonical, 'routine.yaml')), runtime.routine)) throw new GateError('ROUTINE_DRIFT', 'Declared routine snapshot changed.');
      if (phase === 'prepare') {
        prepared = await attempts.render(stringValue(cell.strategy), snapshot.state.model_output, renderOptions(canonical, snapshot.state, cell));
        result = {attempt: prepared, state: 'prepared'};
      } else {
        const attempt = stringValue(cell.attempt, 'current attempt');
        observed = await observedResources(attempt);
        verifyResources(observed);
        if (phase === 'build') {
          result = await buildImage(attempt);
        } else if (phase === 'serve') {
          result = await serve(attempt, {port: integerValue(runtime.port), bind: stringValue(runtime.bind)});
        } else if (phase === 'bench') {
          result = await bench.run(attempt, stringValue(loadRecord(path.join(attempt, 'containers.json')).base_url), path.join(canonical, 'routine.yaml'));
          if (!(await validResult(cell))) throw new GateError('VERIFICATION_FAILED', 'Cell verification lacks current valid functional and measurement evidence.');
        } else if (phase === 'stop') {
          result = fs.existsSync(path.join(attempt, 'containers.json')) ? await stop(attempt) : {stopped: true, reason: 'No containers created'};
        } else throw new GateError('CAMPAIGN_PHASE', `Cannot work phase ${phase}.`);
      }
    } catch (caught: unknown) { error = errorRecord(caught); }
    return await transaction(canonical, async (directory, state) => {
      if (!state.active || state.active.operation_id !== operationId || asRecord(state.active.process).pid !== process.pid) {
        throw new GateError('WORKER_OWNER', 'Operation ownership changed; checkpoint not overwritten.');
      }
      const actual = cellState(state, cell.id);
      const evidence = path.join(directory, 'workers', `${operationId}.json`);
      save(evidence, {operation: active, finished_at: now(), observed, result, error});
      actual.evidence.push(evidence);
      if (error) {
        if (actual.attempt) await attempts.recordCampaignFailure(actual.attempt, evidence);
        actual.recovery = {phase, error, evidence, failed_at: now()};
      } else if (phase === 'prepare' && prepared) {
        actual.attempt = prepared;
        actual.attempts.push({path: prepared, attempt_id: loadRecord(path.join(prepared, 'settings.yaml')).id,
          created_at: now(), reason: actual.next_recovery ?? null});
        actual.phase = 'build'; actual.outcome = 'running';
        delete actual.next_recovery;
      } else {
        if (phase === 'bench') { actual.outcome = 'PASS'; actual.evidence.push(path.join(stringValue(actual.attempt), 'result.json')); }
        if (phase === 'stop' && actual.next_after_stop) {
          actual.phase = phaseValue(actual.next_after_stop);
          if (actual.pending_strategy) {
            const receiptChange = asRecord(actual.pending_strategy);
            actual.strategy = stringValue(receiptChange.replacement);
            actual.receipt_history = [...arrayValue(actual.receipt_history ?? []), {...receiptChange, cleanup_finished_at: now()}];
            delete actual.pending_strategy;
            actual.attempt = null;
          }
          if (actual.phase === 'prepare') actual.attempt = null;
          delete actual.next_after_stop;
        } else {
          const next = NEXT_PHASE.get(phase);
          if (!next) throw new GateError('CAMPAIGN_PHASE', 'No next finite phase.');
          actual.phase = next;
        }
      }
      state.active = null;
      const invocation = state.invocations.find((entry) => entry.id === active.invocation_id);
      if (invocation) Object.assign(invocation, {finished_at: now(), phase_result: error ? 'failed' : 'done'});
      commit(directory, state, 'phase_finished', {cell_id: actual.id, phase, operation_id: operationId, error, result});
      return summary(directory, state);
    });
  });
}

function recoveryPredecessor(cell: CellState): string | null {
  return cell.attempt ?? optionalString(asRecord(cell.next_recovery ?? {}).previous_attempt) ?? null;
}

function recoveryInputs(base: string, state: CampaignState, cell: CellState, asOf: string): RecoveryInputs {
  const policy = asRecord(state.declaration.recovery ?? {max_attempts_per_cell: 8, max_elapsed_seconds_per_cell: 14_400});
  const build = asRecord(definition(state, cell.id).build ?? {});
  const boundary = evidenceTime(asOf, 'recovery assessment time');
  const knownAttempts = (entry: CellState): string[] => entry.attempts
    .filter((attempt) => evidenceTime(attempt.created_at, 'attempt creation') <= boundary)
    .map((attempt) => absolutePath(stringValue(attempt.path)));
  const decisions = recordArray(cell.recovery_history ?? [], 'recovery decisions')
    .filter((decision) => evidenceTime(decision.at, 'recovery decision') <= boundary);
  return {campaignPath: base, cellId: cell.id, evaluationId: optionalString(state.declaration.evaluation_id) ?? null,
    declarationDigest: state.declaration_digest, strategyPath: stringValue(cell.strategy),
    releaseSnapshotPath: absolutePath(optionalString(build.release_snapshot) ?? path.join(ROOT, 'output/host/upstream-lock.json')),
    currentAttempt: recoveryPredecessor(cell), cellAttempts: knownAttempts(cell),
    relatedAttempts: orderedCells(state).flatMap((entry) => knownAttempts(entry)), recipes: asRecord(build.recipes ?? {}),
    budget: {maxAttempts: integerValue(policy.max_attempts_per_cell), maxElapsedSeconds: numberValue(policy.max_elapsed_seconds_per_cell),
      startedAt: optionalString(cell.attempts[0]?.created_at) ?? null, recoveryDecisions: decisions.length}, asOf};
}

function checkRecoveryBudget(state: CampaignState, cell: CellState): void {
  const policy = asRecord(state.declaration.recovery ?? {max_attempts_per_cell: 8, max_elapsed_seconds_per_cell: 14_400});
  const history = recordArray(cell.recovery_history ?? [], 'recovery history');
  const firstStart = optionalString(cell.attempts[0]?.created_at);
  if (cell.attempts.length >= integerValue(policy.max_attempts_per_cell) || history.length >= integerValue(policy.max_attempts_per_cell) ||
      (firstStart && (!Number.isFinite(Date.parse(firstStart)) || (Date.now() - Date.parse(firstStart)) / 1000 >= numberValue(policy.max_elapsed_seconds_per_cell)))) {
    throw new GateError('RECOVERY_BUDGET', 'Finite cell recovery budget reached; preserve unresolved evidence.', {nextAction: 'resolve'});
  }
}

function recoverySignature(previousAttempt: string | null, options: RetryOptions): string {
  const observations = (options.observationPaths ?? []).map((filename) => {
    const content = fs.readFileSync(filename);
    if (!content.length) throw new GateError('RECOVERY_EVIDENCE', 'Recovery observation must not be empty.');
    return {path: absolutePath(filename), digest: digest(content.toString('utf8'))};
  });
  return digest({attempt: previousAttempt, phase: options.phase ?? 'prepare', engine: options.engine ?? null,
    dtype: options.dtype ?? null, limits: options.limits ?? null, builder: options.builder ?? null, observations});
}

/** Records bounded recovery and schedules owned cleanup/preparation or a phase retry. */
export async function retry(base: string, cellId: string, options: RetryOptions): Promise<JsonObject> {
  for (const value of [options.reason, options.hypothesis, options.change]) {
    if (!value.trim()) throw new GateError('RECOVERY_REASON', 'Recovery requires prior failure, hypothesis and actual changed condition.');
  }
  return await transaction(base, async (canonical, state) => await withExecutionLease({campaign: canonical}, async () => {
    const cell = cellState(state, cellId);
    if (cellId !== current(state) || !cell.recovery || state.active) throw new GateError('RECOVERY_STATE', 'Only the inactive current failed operation can be retried.');
    checkRecoveryBudget(state, cell);
    if (cell.pending_strategy && options.phase !== 'stop') throw new GateError('RECOVERY_PHASE', 'Owned cleanup must finish before the pending receipt can replace its original authority; retry the stop phase.');
    const history = recordArray(cell.recovery_history ?? [], 'recovery history');
    const previousAttempt = recoveryPredecessor(cell);
    const observed = previousAttempt ? await observedResources(previousAttempt) : {process: null, containers: [], images: []};
    verifyResources(observed);
    const signature = recoverySignature(previousAttempt, options);
    if (history.some((entry) => entry.signature === signature)) throw new GateError('RECOVERY_UNCHANGED', 'This failed condition was already retried without a new observation.');
    if (!options.engine && !options.dtype && !options.limits && !options.builder && !(options.observationPaths?.length)) {
      throw new GateError('RECOVERY_UNCHANGED', 'A description alone is not a changed condition; supply a typed adjustment or new observation evidence.');
    }
    const decision: JsonObject = {at: now(), previous: cell.recovery, previous_attempt: previousAttempt,
      reason: options.reason, hypothesis: options.hypothesis, change: options.change, signature,
      engine: options.engine ?? null, dtype: options.dtype ?? null, limits: options.limits ?? null,
      builder: options.builder ?? null, observation_paths: options.observationPaths ?? []};
    history.push(decision); cell.recovery_history = history;
    if (options.phase) {
      if (!cell.attempt || !['serve', 'bench', 'stop'].includes(options.phase)) throw new GateError('RECOVERY_PHASE', 'Runtime retry requires an attempt and serve, bench or stop phase.');
      if (options.engine || options.dtype || options.limits || options.builder) throw new GateError('RECOVERY_PHASE', 'Changed runtime settings require a new immutable attempt; omit phase.');
      cell.phase = phaseValue(options.phase);
      if (cell.phase !== 'stop') cell.outcome = 'running';
    } else {
      cell.next_recovery = decision;
      if (cell.attempt && fs.existsSync(path.join(cell.attempt, 'containers.json'))) { cell.phase = 'stop'; cell.next_after_stop = 'prepare'; }
      else { cell.phase = 'prepare'; cell.attempt = null; }
      cell.outcome = 'running';
    }
    cell.recovery = null;
    commit(canonical, state, 'recovery_decided', {cell_id: cellId, decision, observed});
    return summary(canonical, state);
  }));
}

function evidenceFile(filename: string): JsonObject {
  const canonical = absolutePath(filename);
  const info = fs.statSync(canonical);
  if (!info.isFile() || info.size === 0) throw new GateError('UNRESOLVED_EVIDENCE', 'Unresolved evidence must be a nonempty regular file.', {evidence: [canonical]});
  return {path: canonical, sha256: sha256Bytes(fs.readFileSync(canonical)), size: info.size};
}

function checkedEvidenceFile(value: unknown): {path: string; modified: number; value: JsonObject} {
  const reference = asRecord(value, 'evidence reference');
  const filename = stringValue(reference.path, 'evidence path');
  const actual = evidenceFile(filename);
  if (filename !== actual.path || reference.sha256 !== actual.sha256 || reference.size !== actual.size) {
    throw new GateError('UNRESOLVED_EVIDENCE_CHANGED', 'Preserved unresolved evidence bytes or identity changed.', {evidence: [filename]});
  }
  return {path: filename, modified: fs.statSync(filename).mtimeMs, value: loadRecord(filename)};
}

function preserveContextEvidence(source: string, destination: string): JsonObject {
  const original = evidenceFile(source);
  const bytes = fs.readFileSync(stringValue(original.path));
  if (sha256Bytes(bytes) !== original.sha256 || bytes.length !== original.size) throw new GateError('UNRESOLVED_EVIDENCE_CHANGED', 'Context changed while its original bytes were being captured.');
  fs.mkdirSync(path.dirname(destination), {recursive: true});
  fs.writeFileSync(destination, bytes, {flag: 'wx'});
  return {path: destination, sha256: original.sha256, size: original.size,
    origin_path: original.path, origin_sha256: original.sha256, origin_size: original.size};
}

function evidenceTime(value: unknown, label: string): number {
  const parsed = Date.parse(stringValue(value, label));
  if (!Number.isFinite(parsed)) throw new GateError('UNRESOLVED_EVIDENCE_TIME', `${label} is not a finite timestamp.`);
  return parsed;
}

function failedWorker(base: string, state: CampaignState, cell: CellState, filename: string): {file: JsonObject; record: JsonObject; invocation: JsonObject} {
  const file = evidenceFile(filename);
  const record = loadRecord(stringValue(file.path));
  const operation = asRecord(record.operation, 'failed worker operation');
  const operationId = safeId(operation.operation_id);
  const interrupted = record.interrupted === true;
  const expected = path.join(base, 'workers', `${operationId}${interrupted ? '.interrupted' : ''}.json`);
  if (file.path !== expected || !cell.evidence.includes(expected) || operation.cell_id !== cell.id) {
    throw new GateError('UNRESOLVED_WORKER_OWNER', 'Current failed worker evidence must belong to this exact campaign cell.', {evidence: [filename]});
  }
  const invocations = state.invocations.filter((entry) => entry.id === operation.invocation_id);
  const invocation = invocations[0];
  const recovery = asRecord(cell.recovery ?? cell.unresolved?.recovery ?? {}, 'preserved failure');
  const expectedAttempt = operation.inputs === undefined ? recoveryPredecessor(cell) : asRecord(operation.inputs).attempt;
  if (invocations.length !== 1 || !invocation || invocation.cell_id !== cell.id || invocation.phase !== operation.phase ||
      invocation.attempt !== expectedAttempt || invocation.phase_result !== (interrupted ? 'interrupted' : 'failed') ||
      recovery.evidence !== filename || recovery.phase !== operation.phase || digest(recovery.error) !== digest(record.error) ||
      !stringValue(asRecord(record.error).message).trim()) {
    throw new GateError('UNRESOLVED_WORKER_FAILURE', 'The handoff must retain the actual current failed operation and its invocation.');
  }
  const intents = state.journey.filter((entry) => entry.event === 'phase_intent' && entry.operation_id === operationId);
  const intent = intents[0];
  const starts = state.journey.filter((entry) => entry.event === 'phase_started' && entry.operation_id === operationId);
  const start = starts[0];
  if (intents.length !== 1 || !intent || digest(omitRecordKeys(intent, ['sequence', 'at', 'event'])) !== digest({...operation, process: null})) {
    throw new GateError('UNRESOLVED_WORKER_INTENT', 'The worker does not match the original durable operation intent.');
  }
  if (record.interrupted_before_worker === true) {
    if (!interrupted || starts.length !== 0 || operation.process !== null || invocation.worker !== null) throw new GateError('UNRESOLVED_WORKER_START', 'Unstarted worker evidence has inconsistent execution ownership.');
  } else if (starts.length !== 1 || !start || digest(omitRecordKeys(start, ['sequence', 'at', 'event'])) !== digest(operation) || digest(invocation.worker) !== digest(operation.process)) {
    throw new GateError('UNRESOLVED_WORKER_START', 'Worker evidence lacks its matching durable process identity.');
  }
  const completions = state.journey.filter((entry) => interrupted
    ? entry.event === 'interrupted_worker_reconciled' && entry.cell_id === cell.id && entry.evidence === expected
    : entry.event === 'phase_finished' && entry.cell_id === cell.id && entry.operation_id === operationId);
  const completion = completions[0];
  if (completions.length !== 1 || !completion || (!interrupted && digest(completion.error) !== digest(record.error))) {
    throw new GateError('UNRESOLVED_WORKER_COMPLETION', 'Worker failure is not the completed operation retained in the campaign journal.');
  }
  const started = evidenceTime(operation.started_at, 'worker start');
  const finished = evidenceTime(record.finished_at, 'worker finish');
  if (started < evidenceTime(state.created_at, 'campaign creation') || finished < started ||
      evidenceTime(invocation.finished_at, 'invocation finish') < finished || evidenceTime(completion.at, 'journal completion') < finished) {
    throw new GateError('UNRESOLVED_EVIDENCE_TIME', 'Worker failure predates its campaign or has inconsistent completion times.');
  }
  return {file, record, invocation};
}

/** Verifies immutable handoff, worker, receipt and fresh-evaluation bindings without changing historical files. */
export function validateUnresolvedEvidence(base: string, cellId: string, options: UnresolvedEvidenceOptions = {}): UnresolvedEvidenceValidation {
  const reasons: string[] = [];
  let filename: string | null = null;
  let workerPath: string | null = null;
  try {
    const canonical = absolutePath(base);
    const state = readState(canonical);
    const cell = cellState(state, cellId);
    const unresolved = asRecord(cell.unresolved, 'unresolved handoff');
    filename = stringValue(unresolved.evidence, 'unresolved evidence');
    if (!stringValue(unresolved.reason).trim() || !stringValue(unresolved.resume_condition).trim()) throw new GateError('UNRESOLVED_HANDOFF', 'Unresolved outcome needs a current cause and actionable resume condition.');
    if (unresolved.evidence_schema !== 'embedding-campaign-unresolved/1') {
      evidenceFile(filename);
      return {valid: true, fresh: false, kind: 'legacy_read_only', reasons: ['LEGACY_UNRESOLVED_EVIDENCE: Historical handoffs do not establish fresh evaluation evidence.'], evidence: filename, worker: null};
    }
    const actual = evidenceFile(filename);
    if (actual.sha256 !== unresolved.evidence_sha256 || path.dirname(filename) !== path.join(canonical, 'unresolved')) throw new GateError('UNRESOLVED_EVIDENCE_CHANGED', 'The canonical handoff bytes or location changed.');
    const handoff = loadRecord(filename);
    const scope = asRecord(handoff.campaign, 'handoff campaign');
    if (handoff.schema !== unresolved.evidence_schema || scope.path !== canonical || scope.id !== state.id || scope.declaration_digest !== state.declaration_digest ||
        scope.evaluation_id !== (state.declaration.evaluation_id ?? null) || scope.group !== (state.declaration.group ?? null) || handoff.cell_id !== cell.id ||
        handoff.outcome !== cell.outcome || handoff.reason !== unresolved.reason || handoff.resume_condition !== unresolved.resume_condition ||
        handoff.created_at !== unresolved.resolved_at || digest(handoff.recovery) !== digest(unresolved.recovery) ||
        handoff.previous_attempt !== unresolved.previous_attempt || handoff.strategy_path !== cell.strategy) {
      throw new GateError('UNRESOLVED_HANDOFF_BINDING', 'Handoff differs from its declaration, approval, current cell or recorded resolution.');
    }
    if (!handoff.worker_evidence) throw new GateError('UNRESOLVED_CURRENT_WORKER', 'A new wrapper around background material is not current failed-worker evidence.');
    const worker = checkedEvidenceFile(handoff.worker_evidence);
    workerPath = worker.path;
    const proof = failedWorker(canonical, state, cell, worker.path);
    const operation = asRecord(proof.record.operation);
    if (operation.inputs === undefined) return {valid: true, fresh: false, kind: 'legacy_read_only',
      reasons: ['LEGACY_WORKER_EVIDENCE: Historical workers lack current operation input bindings.'], evidence: filename, worker: workerPath};
    const inputs = asRecord(operation.inputs, 'operation input binding');
    const checked = models.checkedStrategy(stringValue(cell.strategy));
    const upstream = asRecord(inputs.upstream);
    const upstreamPath = absolutePath(stringValue(asRecord(definition(state, cell.id).build).release_snapshot ?? path.join(ROOT, 'output/host/upstream-lock.json')));
    if (inputs.schema !== 'embedding-campaign-operation-inputs/1' || inputs.campaign_path !== canonical || inputs.campaign_id !== state.id ||
        inputs.declaration_digest !== state.declaration_digest || inputs.evaluation_id !== scope.evaluation_id || inputs.group !== scope.group || inputs.cell_id !== cell.id ||
        inputs.strategy_path !== cell.strategy || inputs.strategy_id !== checked.strategy.id || inputs.receipt_identity !== checked.receiptIdentity ||
        inputs.model_fingerprint_digest !== digest(checked.strategy.model_fingerprint) || upstream.path !== upstreamPath ||
        upstream.digest !== digest(loadRecord(upstreamPath)) || upstream.sha256 !== sha256Bytes(fs.readFileSync(upstreamPath))) {
      throw new GateError('UNRESOLVED_INPUT_BINDING', 'Fresh blocking evidence differs from its actual receipt, model or frozen upstream inputs.');
    }
    const contextEvidence = asRecord(handoff.context_evidence, 'background evidence');
    const contextActual = evidenceFile(stringValue(contextEvidence.path));
    const contextPath = `${filename.slice(0, -'.json'.length)}.context`;
    if (!filename.endsWith('.json') || contextActual.path !== contextPath || contextActual.sha256 !== contextEvidence.sha256 || contextActual.size !== contextEvidence.size ||
        contextEvidence.origin_sha256 !== contextActual.sha256 || contextEvidence.origin_size !== contextActual.size ||
        !path.isAbsolute(stringValue(contextEvidence.origin_path)) || digest(unresolved.context_evidence) !== digest(contextEvidence)) {
      throw new GateError('UNRESOLVED_EVIDENCE_CHANGED', 'Sealed background evidence changed; later changes to its original live path do not alter this snapshot.');
    }
    const created = evidenceTime(handoff.created_at, 'handoff creation');
    const assessmentInputs = recoveryInputs(canonical, state, cell, stringValue(handoff.created_at));
    if (digest(handoff.recovery_inputs) !== digest(assessmentInputs)) throw new GateError('UNRESOLVED_RECOVERY_BINDING', 'Recovery review differs from the attempts and budget known at resolution.');
    const assessment = assessRecovery(assessmentInputs);
    if (digest(handoff.recovery_assessment) !== digest(assessment) || !assessment.resolution.allowed) {
      throw new GateError('UNRESOLVED_RECOVERY_REVIEW', 'Resolution does not retain a valid generation-time recovery review.');
    }
    const started = evidenceTime(operation.started_at, 'worker start');
    const finished = evidenceTime(proof.record.finished_at, 'worker finish');
    const boundary = options.notBefore === undefined ? evidenceTime(state.created_at, 'campaign creation') : evidenceTime(options.notBefore, 'evaluation freeze');
    if (created < finished || created > Date.now() || started < boundary || finished < boundary || created < boundary ||
        fs.statSync(filename).mtimeMs < boundary || worker.modified < boundary) reasons.push('UNRESOLVED_STALE_EVIDENCE: A fresh handoff requires a worker executed after the evaluation boundary.');
    if (options.evaluationId !== undefined && scope.evaluation_id !== options.evaluationId) reasons.push('UNRESOLVED_EVALUATION: Handoff belongs to another evaluation.');
    if (options.upstreamDigest !== undefined && upstream.digest !== options.upstreamDigest) reasons.push('UNRESOLVED_UPSTREAM: Worker used another frozen upstream snapshot.');
    if (options.controlThreads !== undefined && !options.controlThreads.has(stringValue(proof.invocation.codex_thread_id))) reasons.push('UNRESOLVED_CONTROL: Failed worker was not initiated by a verified actual control thread.');
    if (inputs.evidence_kind !== 'measured' || checked.strategy.evidence_kind === 'mock' || checked.manifest.evidence_kind === 'mock' || loadRecord(upstreamPath).evidence_kind === 'mock') reasons.push('MOCK_OR_UNVERIFIED_EVIDENCE: Only current observed inputs can support real blocked-condition acceptance.');
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    reasons.push(`${error instanceof GateError ? error.code : error.name}: ${error.message}`);
  }
  const valid = reasons.length === 0;
  return {valid, fresh: valid, kind: valid ? 'fresh' : 'invalid', reasons, evidence: filename, worker: workerPath};
}

/** Stores an evidenced unresolved outcome; PASS can only come from measurement. */
export async function resolve(base: string, cellId: string, options: ResolveOptions): Promise<JsonObject> {
  if (!TERMINAL.has(options.outcome) || options.outcome === 'PASS' || !options.reason.trim() || !options.resumeCondition.trim() || !fs.existsSync(options.evidence)) {
    throw new GateError('UNRESOLVED_EVIDENCE', 'Non-PASS outcome requires reason, existing evidence and resume condition.');
  }
  return await transaction(base, async (canonical, state) => await withExecutionLease({campaign: canonical}, async () => {
    if (cellId !== current(state) || state.active) throw new GateError('RECOVERY_STATE', 'Resolve only the inactive current cell.');
    const cell = cellState(state, cellId);
    const created = now();
    const assessmentInputs = recoveryInputs(canonical, state, cell, created);
    const assessment = assessRecovery(assessmentInputs);
    if (!assessment.resolution.allowed) {
      const candidates = assessment.candidates.filter((candidate) => assessment.resolution.untried_candidate_ids.includes(candidate.id));
      throw new GateError('RECOVERY_REVIEW_REQUIRED', 'Available same-device recovery must be considered before resolving this cell.', {
        nextAction: JSON.stringify({command: [process.execPath, path.join(ROOT, '.agents/skills/embedding-explorer/src/cli.ts'), 'campaign', 'retry', '--campaign', canonical, '--cell', cellId],
          candidates: candidates.map((candidate) => ({id: candidate.id, retry_options: candidate.retry_options}))}), retryable: true});
    }
    const currentFailure = optionalString(cell.recovery?.evidence);
    let workerEvidence: JsonObject | null = null;
    let workerInputs: unknown;
    if (currentFailure && path.dirname(absolutePath(currentFailure)) === path.join(canonical, 'workers')) {
      const proof = failedWorker(canonical, state, cell, currentFailure);
      workerEvidence = proof.file;
      workerInputs = asRecord(proof.record.operation).inputs;
    }
    if (options.outcome === 'BLOCKED' && typeof state.declaration.evaluation_id === 'string' && (!workerEvidence || workerInputs === undefined)) {
      throw new GateError('UNRESOLVED_CURRENT_WORKER', 'Evaluation BLOCKED requires the current actual failed worker with immutable operation inputs before resolution.', {
        nextAction: JSON.stringify({command: [process.execPath, path.join(ROOT, '.agents/skills/embedding-explorer/src/cli.ts'), 'campaign', 'run', '--campaign', canonical],
          reason: 'Preserve the current finite worker failure before resolving this evaluation condition.'}), retryable: true});
    }
    const stem = path.join(canonical, 'unresolved', `${cell.id}-${randomUUID()}`);
    const evidence = `${stem}.json`;
    const contextEvidence = preserveContextEvidence(options.evidence, `${stem}.context`);
    save(evidence, {schema: 'embedding-campaign-unresolved/1', created_at: created,
      campaign: {path: canonical, id: state.id, declaration_digest: state.declaration_digest, evaluation_id: state.declaration.evaluation_id ?? null, group: state.declaration.group ?? null},
      cell_id: cell.id, outcome: options.outcome, strategy_path: cell.strategy, reason: options.reason, resume_condition: options.resumeCondition,
      previous_attempt: recoveryPredecessor(cell), recovery: cell.recovery, worker_evidence: workerEvidence, context_evidence: contextEvidence,
      recovery_inputs: assessmentInputs, recovery_assessment: assessment});
    cell.unresolved = {reason: options.reason, evidence, evidence_schema: 'embedding-campaign-unresolved/1', evidence_sha256: sha256Bytes(fs.readFileSync(evidence)),
      context_evidence: contextEvidence, resume_condition: options.resumeCondition,
      previous_attempt: recoveryPredecessor(cell), recovery: cell.recovery, phase: cell.phase, resolved_at: created};
    cell.outcome = options.outcome; cell.recovery = null;
    cell.phase = cell.attempt && fs.existsSync(path.join(cell.attempt, 'containers.json')) ? 'stop' : 'done';
    if (cell.phase === 'stop') cell.next_after_stop = 'done';
    commit(canonical, state, 'cell_unresolved', {cell_id: cellId, outcome: options.outcome, follow_up: cell.unresolved});
    return summary(canonical, state);
  }));
}

/** Reports all terminal conditions only after validating their current evidence. */
export async function report(base: string): Promise<JsonObject> {
  return await transaction(base, async (canonical, state) => await withExecutionLease({campaign: canonical}, async () => {
    if (current(state) || state.active) throw new GateError('CAMPAIGN_INCOMPLETE', 'Campaign work remains; partial progress is not completion.');
    for (const cell of orderedCells(state)) {
      if (!TERMINAL.has(cell.outcome) || (cell.outcome === 'PASS' && !(await validResult(cell)))) throw new GateError('VERIFICATION_FAILED', 'Cell outcome lacks current measured evidence.');
      if (cell.outcome !== 'PASS' && !cell.unresolved) throw new GateError('UNRESOLVED_EVIDENCE', 'Non-PASS cell needs an unresolved handoff.');
    }
    if (!state.report) {
      const target = path.join(canonical, 'reports', `${state.sequence + 1}.json`);
      save(target, {schema: 'embedding-campaign-report/1', campaign_id: state.id, generated_at: now(),
        evaluation_id: state.declaration.evaluation_id ?? null, group: state.declaration.group ?? null,
        validation_and_report_complete: true, all_cells_passed: orderedCells(state).every((cell) => cell.outcome === 'PASS'),
        cells: state.cells, invocations: state.invocations, declaration: path.join(canonical, 'campaign.yaml')});
      state.report = target;
      commit(canonical, state, 'campaign_reported', {report: target});
    }
    return summary(canonical, state);
  }));
}

/** Reopens an unresolved cell for a linked recovery decision within its original budget. */
export async function reopen(base: string, cellId: string, reason: string): Promise<JsonObject> {
  if (!reason.trim()) throw new GateError('RECOVERY_REASON', 'Reopening requires changed-condition evidence.');
  return await transaction(base, async (canonical, state) => await withExecutionLease({campaign: canonical}, async () => {
    const cell = cellState(state, cellId);
    if (state.active || cell.phase !== 'done' || !cell.unresolved || cell.outcome === 'PASS') throw new GateError('RECOVERY_STATE', 'Reopen only an inactive terminal unresolved cell.');
    checkRecoveryBudget(state, cell);
    if (state.report) { state.report_history = [...arrayValue(state.report_history ?? []), state.report]; state.report = null; }
    cell.follow_up_history = [...arrayValue(cell.follow_up_history ?? []), {previous: cell.unresolved, reopened_at: now(), reason}];
    const recovery = {phase: 'prepare', reason, previous_attempt: recoveryPredecessor(cell), previous: cell.unresolved,
      next: 'Supply an evidence-based linked retry; reopening does not reset attempt or elapsed-time budgets.'};
    Object.assign(cell, {phase: 'prepare', outcome: 'pending', recovery, unresolved: null});
    commit(canonical, state, 'unresolved_cell_reopened', {cell_id: cellId, reason});
    return summary(canonical, state);
  }));
}

/** Runs a bounded coordinator invocation; phase workers survive caller exit. */
export async function run(base: string, timeoutSeconds = 600, pollSeconds = 1): Promise<JsonObject> {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || !Number.isFinite(pollSeconds) || pollSeconds <= 0 || pollSeconds > 30) {
    throw new GateError('CAMPAIGN_TIMEOUT', 'Finite positive timeout and poll interval <=30 seconds required.');
  }
  const deadline = performance.now() + timeoutSeconds * 1000;
  while (performance.now() < deadline) {
    const result = await step(base);
    if (result.yield_reason === 'worker_spawn_failed') return result;
    if (result.task_state === 'completed' || result.task_state === 'input-required' || stringValue(result.next_action).startsWith('diagnose')) return result;
    if (result.next_action === 'report') return await report(base);
    await delay(Math.min(pollSeconds * 1000, Math.max(1, deadline - performance.now())));
  }
  return {...await status(base), yield_reason: 'invocation_budget'};
}
