/** Owns approved attempt rendering, immutable evidence and bounded recovery contracts. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {GateError, ROOT, absolutePath, appendEvent, arrayValue, asRecord, cloneJson, digest, integerValue, loadRecord, now, omitRecordKeys, save, sha256Bytes, stringValue} from '../../../harness/common.ts';
import type {JsonObject} from '../../../harness/common.ts';
import {assertCurrentCompatibility, selectPlatform} from '../../terraforming-node/src/hardware.ts';
import {checkedStrategy, checkedStrategyForCleanup} from './models.ts';
import {alive, hasExecutionLease, identity, observeProcess, runCommand, withExecutionLease} from '../../../harness/processes.ts';
import {validateFrozenSources} from '../../embedding-upstream/src/upstream.ts';
import {nativeAssets, readNativeTextFiles} from '../../embedding-upstream/src/recipes.ts';
import {assertNoOtherContainers} from './resources.ts';

const ENGINES = new Set(['tei', 'sentence-transformers']);

const DTYPES = new Set(['float32', 'float16', 'bfloat16']);

const MAX_RECOVERY_ATTEMPTS = 8;

const MAX_RECOVERY_SECONDS = 14_400;

const FAILURE_ARTIFACTS = ['events.jsonl', 'build-backend.log', 'start-api.log', 'start-backend.log', 'container-api.log', 'container-backend.log'];

/** Declares campaign provenance; a matching live worker lease is required as proof. */
export interface CampaignOwner {
  campaign_path: string;
  cell_id: string;
}

/** Connects a new bounded attempt to a previous failure and a falsifiable adjustment. */
export interface RecoveryOptions {
  previousAttempt: string;
  reason: string;
  hypothesis: string;
  change: string;
  observationPaths?: string[];
}

/** Distinguishes a completed worker error, an ended worker, and an untouched pre-spawn intent. */
export interface CampaignFailureOptions { interrupted?: boolean; interruptedBeforeWorker?: boolean; }

/** Selects approved mutable knobs while frozen source inputs remain immutable. */
export interface RenderOptions {
  engine?: string;
  reason?: string;
  campaignOwner?: CampaignOwner;
  releaseSnapshotPath?: string;
  recipes?: JsonObject;
  dtype?: string;
  limits?: JsonObject;
  builder?: string;
  recovery?: RecoveryOptions;
}

/** Names the exact inputs to the legacy-compatible recipe identity. */
export interface CompatibilityInputs {
  strategy: JsonObject;
  manifest: JsonObject;
  adapter: JsonObject;
  versions: JsonObject;
  engine: string;
  dtype: string;
  runtimeRoot?: string;
  recipes?: JsonObject;
  modelOverrides?: JsonObject;
}

/** Contains validated records for one effect or a read-only evidence check. */
export interface CheckedAttempt {
  path: string;
  settings: JsonObject;
  strategy: JsonObject;
  manifest: JsonObject;
  receiptIdentity: string;
  cleanupDrift?: JsonObject[];
}

/** Describes an existing runtime route without claiming that it has served this model. */
export interface RuntimeSupport extends JsonObject {
  status: 'renderable_unverified' | 'adapter_required';
  kind: 'native_adapter' | 'sentence_transformers' | 'unsupported';
  adapter_id: string | null;
  reason: string;
  source_files: JsonObject;
}

function gate(code: string, message: string, evidence: string[] = [], nextAction = 'inspect evidence and create a justified recovery attempt'): never {
  throw new GateError(code, message, {evidence, nextAction, retryable: false});
}

function recordClone(value: unknown): JsonObject {
  return asRecord(cloneJson(value));
}

function strings(value: unknown, label: string): string[] {
  return arrayValue(value, label).map((item) => stringValue(item, label));
}

/** Validates a positive integer used by sealed attempt phase limits. */
export function positiveAttemptInteger(value: unknown, label: string): number {
  const integer = integerValue(value, label);
  if (integer <= 0) gate('invalid_attempt_limit', `${label} must be positive.`);
  return integer;
}

function recipesAt(attemptPath: string): JsonObject {
  return readNativeTextFiles(attemptPath, (name) => name.startsWith('Dockerfile'));
}

function hasTeiFailure(attemptPath: string, upstreamId: string): boolean {
  let directory = absolutePath(attemptPath);
  for (let index = 0; index < MAX_RECOVERY_ATTEMPTS; index += 1) {
    const cfg = loadRecord(path.join(directory, 'settings.yaml'));
    if (cfg.upstream_id !== upstreamId) return false;
    if (cfg.engine === 'tei' && fs.existsSync(path.join(directory, 'failure.json'))) {
      return ['build-backend.log', 'start-backend.log', 'container-backend.log'].some((name) => {
        const filename = path.join(directory, name);
        return fs.existsSync(filename) && fs.statSync(filename).size > 0;
      });
    }
    const recovery = asRecord(cfg.recovery ?? {});
    if (typeof recovery.previous_attempt !== 'string') return false;
    directory = absolutePath(recovery.previous_attempt);
  }
  return false;
}

/** Records durable attempt events using the historical event shape. */
export function event(attemptPath: string, kind: string, data: JsonObject = {}): void {
  appendEvent(path.join(attemptPath, 'events.jsonl'), {at: now(), event: kind, ...data});
}

/** Marks a previous result unverified before a fresh build or container process begins. */
export function invalidateValidation(attemptPath: string, reason: string): void {
  const resultPath = path.join(attemptPath, 'result.json');
  if (!fs.existsSync(resultPath)) return;
  const previous = loadRecord(resultPath);
  event(attemptPath, 'validation_invalidated', {reason, previous});
  save(resultPath, {verdict: 'UNVERIFIED', reason, previous_evidence: previous.routine ?? null, invalidated_at: now()});
}

/** Reproduces the existing Python compatibility digest, including legacy numeric tokens. */
export function compatibility(inputs: CompatibilityInputs): string {
  const host = asRecord(inputs.manifest.host, 'manifest host');
  const runtime = readNativeTextFiles(inputs.runtimeRoot ?? path.join(ROOT, 'runtime'), (name) => name.endsWith('.py'));
  const runtimeSource: JsonObject = {};
  for (const [name, content] of Object.entries(runtime)) runtimeSource[name] = digest(content);
  const data: JsonObject = {
    model: inputs.strategy.model_fingerprint, device: inputs.strategy.device,
    context: inputs.strategy.context_window, dimensions: inputs.strategy.dimensions,
    profile: omitRecordKeys(asRecord(inputs.strategy.profile, 'model profile'), ['inspected_at']),
    engine: inputs.engine, dtype: inputs.dtype, architecture: host.architecture, os: host.os,
    accelerator: inputs.adapter.accelerator ?? null, adapter: inputs.adapter, versions: inputs.versions,
    runtime_source: runtimeSource, recipes: inputs.recipes ?? null,
  };
  if (inputs.modelOverrides && Object.keys(inputs.modelOverrides).length > 0) data.model_config_overrides = inputs.modelOverrides;
  return digest(data);
}

function currentCompatibility(attemptPath: string, cfg: JsonObject): string {
  const overrides = cfg.model_config_overrides === undefined ? undefined : asRecord(cfg.model_config_overrides, 'model overrides');
  return compatibility({strategy: loadRecord(path.join(attemptPath, 'strategy.yaml')), manifest: loadRecord(path.join(attemptPath, 'manifest.yaml')),
    adapter: asRecord(cfg.platform, 'platform'), versions: asRecord(cfg.versions, 'versions'), engine: stringValue(cfg.engine, 'engine'),
    dtype: stringValue(cfg.dtype, 'dtype'), runtimeRoot: path.join(attemptPath, 'runtime'), recipes: recipesAt(attemptPath), modelOverrides: overrides});
}

function condition(cfg: JsonObject): JsonObject {
  return {engine: cfg.engine, dtype: cfg.dtype, platform: cfg.platform, versions: cfg.versions,
    compatibility_key: cfg.compatibility_key, limits: cfg.limits, builder: cfg.builder ?? null,
    model_config_overrides: cfg.model_config_overrides ?? null, upstream_id: cfg.upstream_id ?? null,
    harness_source_digest: cfg.harness_source === undefined ? null : asRecord(cfg.harness_source).digest};
}

function inputIdentity(cfg: JsonObject): string {
  return digest({schema: cfg.schema, attempt_id: cfg.id, created_at: cfg.created_at, evidence_kind: cfg.evidence_kind,
    strategy_id: cfg.strategy_id, strategy_path: cfg.strategy_path, receipt_identity: cfg.receipt_identity, condition: condition(cfg),
    engine_reason: cfg.engine_reason, dtype_reason: cfg.dtype_reason, model_config_override_reason: cfg.model_config_override_reason ?? null,
    campaign_owner: cfg.campaign_owner ?? null, recovery: cfg.recovery ?? null,
    source_snapshot_path: cfg.source_snapshot_path, source_snapshot_digest: cfg.source_snapshot_digest,
    recipe_snapshots: cfg.recipe_snapshots ?? {}, recovery_policy: cfg.recovery_policy,
    dependency_locks: cfg.dependency_locks, harness_source: cfg.harness_source});
}

/** Returns the finite remaining lineage budget, preserving cleanup after exhaustion. */
export function remainingAttemptSeconds(attempt: CheckedAttempt): number {
  const recovery = asRecord(attempt.settings.recovery ?? {});
  const started = stringValue(recovery.started_at ?? attempt.settings.created_at, 'attempt start time');
  const elapsed = (Date.now() - Date.parse(started)) / 1000;
  if (!Number.isFinite(elapsed) || elapsed < -60) gate('attempt_clock_invalid', 'Attempt creation/recovery time is invalid.', [attempt.path]);
  return Math.max(0, MAX_RECOVERY_SECONDS - Math.max(0, elapsed));
}

function harnessSource(): JsonObject {
  const files: JsonObject = {};
  const add = (filename: string): void => {
    if (fs.existsSync(filename)) files[path.relative(ROOT, filename)] = sha256Bytes(fs.readFileSync(filename));
  };
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile() && /\.(?:ts|json|toml|yaml|md|rules|sh)$/.test(entry.name)) add(filename);
    }
  };
  for (const directory of ['.agents/harness', '.agents/validation', 'config', 'rules']) visit(path.join(ROOT, directory));
  for (const skill of ['terraforming-node', 'embedding-upstream', 'embedding-explorer', 'embedding-lite-bench']) visit(path.join(ROOT, '.agents/skills', skill));
  for (const filename of ['AGENTS.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'oxlintrc.jsonc', '.codex/config.toml', '.codex/rules/project.rules', 'campaigns/README.md']) add(path.join(ROOT, filename));
  return {schema: 'embedding-harness-source/1', node_version: process.version, files, digest: digest(files)};
}

/** Finds historical compatible PASS candidates without treating them as a new validation. */
export function findCompatiblePass(output: string, key: string): string | null {
  if (!fs.existsSync(output)) return null;
  let found: {path: string; modified: bigint} | undefined;
  for (const model of fs.readdirSync(output, {withFileTypes: true})) {
    if (!model.isDirectory()) continue;
    const parent = path.join(output, model.name, 'attempts');
    if (!fs.existsSync(parent)) continue;
    for (const attempt of fs.readdirSync(parent, {withFileTypes: true})) {
      if (!attempt.isDirectory()) continue;
      const candidate = path.join(parent, attempt.name, 'result.json');
      if (!fs.existsSync(candidate)) continue;
      try {
        const result = loadRecord(candidate);
        const modified = fs.statSync(candidate, {bigint: true}).mtimeNs;
        if (result.verdict === 'PASS' && result.compatibility_key === key && (!found || modified > found.modified)) {
          found = {path: fs.realpathSync(path.dirname(candidate)), modified};
        }
      } catch (error: unknown) {
        if (!(error instanceof Error)) throw error;
        // An unreadable historical result is not reusable evidence.
      }
    }
  }
  return found?.path ?? null;
}

/** Checks compatibility without silently accepting edits to a previously sealed attempt. */
export function refreshCompatibility(attemptPath: string, cfg: JsonObject): void {
  const actual = currentCompatibility(attemptPath, cfg);
  if (cfg.input_identity !== undefined && cfg.compatibility_key !== actual) {
    gate('attempt_recipe_changed', 'A sealed recipe changed; declare the change in a new recovery attempt.', [attemptPath]);
  }
  cfg.compatibility_key = actual;
  cfg.previous_compatible_pass = findCompatiblePass(path.resolve(attemptPath, '../../..'), actual);
  save(path.join(attemptPath, 'settings.yaml'), cfg);
}

function campaignGate(cfg: JsonObject, attemptPath: string | undefined, effect: string, strategyPath: string): void {
  if (cfg.campaign_owner === undefined) return;
  const owner = asRecord(cfg.campaign_owner, 'campaign owner');
  const campaignPath = absolutePath(stringValue(owner.campaign_path, 'campaign path'));
  const cellId = stringValue(owner.cell_id, 'campaign cell');
  const nextAction = `campaign status --campaign ${campaignPath}`;
  if (!hasExecutionLease(path.join(campaignPath, '.execution.lock'))) {
    gate('campaign_owned_attempt', 'This attempt must execute through its campaign worker.', [campaignPath], nextAction);
  }
  const state = loadRecord(path.join(campaignPath, 'checkpoint.json'));
  const active = asRecord(state.active, 'active campaign operation');
  const worker = asRecord(active.process, 'campaign worker identity');
  const current = identity();
  if (!alive(worker) || worker.pid !== current.pid || worker.boot_id !== current.boot_id || worker.start_ticks !== current.start_ticks || active.cell_id !== cellId || typeof active.operation_id !== 'string') {
    gate('campaign_owner_changed', 'Campaign checkpoint does not identify this live worker.', [campaignPath], nextAction);
  }
  const allowed = effect === 'capture' ? ['serve', 'bench', 'stop'] : [effect];
  if (!allowed.includes(stringValue(active.phase, 'active phase'))) gate('campaign_phase_mismatch', 'Campaign operation does not own this effect.', [campaignPath], nextAction);
  const cell = asRecord(asRecord(state.cells, 'campaign cells')[cellId], 'campaign cell');
  if (absolutePath(stringValue(cell.strategy, 'campaign receipt')) !== absolutePath(strategyPath)) gate('campaign_strategy_mismatch', 'Campaign cell refers to another approval receipt.', [campaignPath], nextAction);
  if (attemptPath !== undefined && absolutePath(stringValue(cell.attempt, 'campaign attempt')) !== attemptPath) gate('campaign_attempt_mismatch', 'Campaign cell refers to another attempt.', [campaignPath], nextAction);
  if (effect === 'prepare' && cell.attempt !== null && cell.attempt !== undefined) gate('campaign_attempt_exists', 'Preparation cannot overwrite a recorded attempt.', [campaignPath], nextAction);
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) throw error;
  return error.message;
}

function readAttemptIdentity(attemptPath: string, cleanup: boolean): CheckedAttempt {
  const directory = fs.realpathSync(attemptPath);
  const settings = loadRecord(path.join(directory, 'settings.yaml'));
  if (!['embedding-attempt/1', 'embedding-attempt/2'].includes(stringValue(settings.schema, 'attempt schema'))) gate('attempt_schema', 'Unsupported attempt schema.');
  const strategyPath = stringValue(settings.strategy_path, 'strategy path');
  const checked = cleanup ? checkedStrategyForCleanup(strategyPath) : checkedStrategy(strategyPath);
  const strategy = loadRecord(path.join(directory, 'strategy.yaml'));
  const manifest = loadRecord(path.join(directory, 'manifest.yaml'));
  if (digest(strategy) !== digest(checked.strategy) || digest(manifest) !== digest(checked.manifest) || settings.strategy_id !== strategy.id) {
    gate('attempt_approval_mismatch', 'Attempt snapshots no longer match the actual approval receipt.', [strategyPath, directory]);
  }
  const drift: JsonObject[] = [];
  const noteDrift = (code: string, message: string): void => {
    if (!cleanup) gate(code, message, [directory]);
    drift.push({code, message});
  };
  try {
    if (currentCompatibility(directory, settings) !== settings.compatibility_key) noteDrift('attempt_recipe_changed', 'Recipe or runtime identity changed since this attempt was sealed.');
  } catch (error: unknown) {
    if (!cleanup) throw error;
    drift.push({code: 'cleanup_recipe_observation', message: errorMessage(error)});
  }
  if (settings.schema === 'embedding-attempt/2') {
    if (settings.receipt_identity !== checked.receiptIdentity || settings.input_identity !== inputIdentity(settings)) gate('attempt_inputs_changed', 'Frozen attempt inputs or receipt provenance changed.', [directory]);
    const snapshotPath = stringValue(settings.source_snapshot_path, 'frozen upstream path');
    const snapshot = loadRecord(snapshotPath);
    if (snapshot.id !== settings.upstream_id || digest(snapshot) !== settings.source_snapshot_digest || digest(loadRecord(path.join(directory, 'upstream-lock.json'))) !== settings.source_snapshot_digest) gate('attempt_upstream_changed', 'Attempt upstream snapshot does not match its prepared input.', [directory, snapshotPath]);
    try { validateFrozenSources(snapshot); }
    catch (error: unknown) {
      if (!cleanup) throw error;
      drift.push({code: 'cleanup_upstream_observation', message: errorMessage(error)});
    }
    const source = asRecord(settings.harness_source, 'harness source identity');
    if (source.digest !== digest(source.files)) gate('attempt_harness_record_changed', 'The preserved harness source identity was altered.', [directory]);
    if (digest(source) !== digest(harnessSource())) noteDrift('attempt_harness_changed', 'Host source, toolchain, policy or one of the four skills changed after this attempt was prepared.');
    for (const item of Object.values(asRecord(settings.dependency_locks, 'attempt dependency locks'))) {
      const lock = asRecord(item, 'attempt dependency lock');
      const filename = stringValue(lock.file);
      if (path.basename(filename) !== filename) gate('attempt_dependencies_changed', 'Dependency lock escaped the sealed attempt directory.', [directory]);
      if (!fs.existsSync(path.join(directory, filename)) || sha256Bytes(fs.readFileSync(path.join(directory, filename))) !== lock.sha256) noteDrift('attempt_dependencies_changed', 'Attempt transitive dependency lock was changed.');
    }
  }
  return {path: directory, settings, strategy, manifest, receiptIdentity: checked.receiptIdentity, cleanupDrift: drift};
}

/** Validates stored identity for historical evidence without adopting execution ownership. */
export function validateAttemptIdentity(attemptPath: string): CheckedAttempt {
  return readAttemptIdentity(attemptPath, false);
}

/** Reads original approved inputs for cleanup or recovery inheritance while reporting current source drift. */
export function validateAttemptIdentityForCleanup(attemptPath: string): CheckedAttempt {
  return readAttemptIdentity(attemptPath, true);
}

/** Rejects direct campaign effects and unprepared legacy attempts at the execution boundary. */
export function checkedAttempt(attemptPath: string, options: {effect?: string} = {}): CheckedAttempt {
  const effect = options.effect ?? 'validate';
  const checked = readAttemptIdentity(attemptPath, effect === 'stop' || effect === 'capture');
  if (checked.settings.schema !== 'embedding-attempt/2' && !['stop', 'capture'].includes(effect)) gate('legacy_attempt_readonly', 'Historical attempts require a new preparation for live execution; exact owned resources may still be captured or stopped.', [checked.path], 'render with the existing strategy receipt');
  campaignGate(checked.settings, checked.path, effect, stringValue(checked.settings.strategy_path));
  return checked;
}

/** Owns node/attempt execution and verifies current hardware before expensive work. */
export async function withAttemptExecution<T>(attemptPath: string, effect: string, action: (attempt: CheckedAttempt) => Promise<T>): Promise<T> {
  const checked = checkedAttempt(attemptPath, {effect});
  return withExecutionLease({attempt: checked.path}, async () => {
    const current = checkedAttempt(checked.path, {effect});
    if (current.cleanupDrift && current.cleanupDrift.length > 0) event(current.path, 'cleanup_source_drift_observed', {drift: current.cleanupDrift, invariant: 'Cleanup authority remains the immutable original receipt, attempt identity, resource IDs and labels.'});
    if (['build', 'serve', 'bench'].includes(effect)) {
      if (current.manifest.evidence_kind === 'mock' || current.settings.evidence_kind === 'mock' || current.strategy.evidence_kind === 'mock') gate('mock_effect_forbidden', 'Mock evidence cannot authorize live model execution.', [current.path]);
      if (remainingAttemptSeconds(current) <= 0) gate('recovery_budget_exhausted', 'The finite wall-clock budget of this attempt lineage is exhausted.', [current.path]);
      await assertCurrentCompatibility(current.strategy, current.manifest, current.settings.platform);
      await assertNoOtherContainers(current);
    }
    return await action(current);
  });
}

/** Chooses a dtype from device, model implementation and retained runtime evidence. */
export function chooseDtype(strategy: JsonObject, engine: string): string {
  if (strategy.device === 'cpu') return 'float32';
  const profile = asRecord(strategy.profile, 'model profile');
  if (engine === 'tei' && profile.model_type === 'gemma3_text') return 'float32';
  if (engine === 'sentence-transformers' && profile.model_type === 'bidirectional_pplx_qwen3') {
    const config = loadRecord(path.join(stringValue(strategy.model_path), 'config.json'));
    if (asRecord(config.auto_map ?? {}).AutoModel === 'modeling.PPLXQwen3ContextualModel') return 'bfloat16';
  }
  if (profile.checkpoint_dtype === 'bfloat16') return engine === 'sentence-transformers' ? 'bfloat16' : 'float32';
  return 'float16';
}

/** Applies the renderer's adapter gate and identifies the implementation already on disk. */
export function runtimeSupport(strategy: JsonObject, runtimeRoot = path.join(ROOT, 'runtime')): RuntimeSupport {
  const profile = asRecord(strategy.profile, 'model profile');
  const modules = arrayValue(profile.modules ?? [], 'ST modules');
  const adapters = fs.readFileSync(path.join(runtimeRoot, 'adapters.py'), 'utf8');
  const server = fs.readFileSync(path.join(runtimeRoot, 'server.py'), 'utf8');
  const sourceFiles = {'runtime/adapters.py': sha256Bytes(adapters), 'runtime/server.py': sha256Bytes(server)};
  const native = new Map([['qwen3_vl', 'QwenVLTextAdapter'], ['kanana2vec', 'KananaTextAdapter']]);
  const adapter = native.get(String(profile.model_type));
  if (adapter && adapters.includes(`class ${adapter}(`) && adapters.includes(`return ${adapter}(config)`) && server.includes('native_adapter(config)')) {
    return {status: 'renderable_unverified', kind: 'native_adapter', adapter_id: adapter,
      reason: 'The native runtime dispatch and adapter implementation are present; fresh serving validation is still required.', source_files: sourceFiles};
  }
  if (profile.requires_model_adapter && modules.length === 0) {
    return {status: 'adapter_required', kind: 'unsupported', adapter_id: null,
      reason: stringValue(profile.requires_model_adapter), source_files: sourceFiles};
  }
  return {status: 'renderable_unverified', kind: 'sentence_transformers', adapter_id: null,
    reason: 'The renderer permits the declared sentence-transformers path; fresh serving validation is still required.', source_files: sourceFiles};
}

/** Derives finite container budgets from the approved observed host capacity. */
export function containerBudget(manifest: JsonObject): {args: string[]; evidence: JsonObject} {
  const host = asRecord(manifest.host, 'host');
  const memory = asRecord(asRecord(host.memory ?? {}).value ?? {});
  const total = memory.MemTotal;
  const available = memory.MemAvailable;
  const args: string[] = [];
  const evidence: JsonObject = {source: 'manifest host memory and CPU observations'};
  if (typeof total === 'number' && Number.isSafeInteger(total) && typeof available === 'number' && Number.isSafeInteger(available) && Math.min(total, available) > 0) {
    const limit = Math.floor(Math.min(total * 0.6, available * 0.75));
    args.push('--memory', String(limit), '--memory-swap', String(limit));
    Object.assign(evidence, {memory_bytes: limit, swap_disabled: true, rationale: 'At most 60% of total RAM and 75% of observed available RAM; preserve host headroom.'});
  }
  const cores = asRecord(asRecord(host.cpu ?? {}).value ?? {}).logical_cores;
  if (typeof cores === 'number' && Number.isSafeInteger(cores) && cores > 0) {
    const cpus = Math.max(1, cores * 0.75);
    args.push('--cpus', String(cpus));
    evidence.cpus = cpus;
  }
  if (args.length === 0) gate('resource_budget_unobserved', 'A container budget requires observed CPU or memory capacity.');
  return {args, evidence};
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function recoveryScope(cfg: JsonObject): string {
  if (cfg.campaign_owner !== undefined) {
    const owner = asRecord(cfg.campaign_owner);
    return digest({kind: 'campaign', path: absolutePath(stringValue(owner.campaign_path)), cell: stringValue(owner.cell_id), receipt: cfg.receipt_identity});
  }
  const parent = path.dirname(path.dirname(absolutePath(stringValue(cfg.source_snapshot_path))));
  return digest({kind: 'direct', group: parent, receipt: cfg.receipt_identity});
}

function sameProcessIdentity(left: JsonObject, rightValue: unknown): boolean {
  const right = asRecord(rightValue, 'process identity');
  return integerValue(left.pid, 'worker PID') > 0 && left.pid === right.pid && stringValue(left.boot_id, 'worker boot ID') === right.boot_id && stringValue(left.start_ticks, 'worker start ticks') === right.start_ticks && stringValue(left.pid_namespace, 'worker PID namespace') === right.pid_namespace;
}

function processHasEnded(record: JsonObject): boolean {
  const observed = observeProcess(record);
  if (observed.state === 'unavailable') gate('recovery_worker_unobserved', `Worker liveness could not be observed; an observation failure is not interruption evidence: ${observed.reason}`);
  return observed.state === 'ended';
}

function verifyUnstartedIntent(state: JsonObject, active: JsonObject, invocation: JsonObject): void {
  if (active.process !== null || invocation.worker !== null) gate('recovery_intent_worker', 'Pre-worker recovery requires explicit null worker identities in the untouched intent.');
  const journey = arrayValue(state.journey, 'campaign journey').map((item) => asRecord(item));
  const related = journey.filter((item) => item.operation_id === active.operation_id || item.invocation_id === active.invocation_id);
  const intents = related.filter((item) => item.event === 'phase_intent');
  const original = intents[0];
  if (intents.length !== 1 || !original || digest(omitRecordKeys(original, ['sequence', 'at', 'event'])) !== digest(active) || related.some((item) => item.event === 'phase_started')) gate('recovery_intent_changed', 'Missing worker identity is recoverable only from its exact original phase_intent with no phase_started record.');
  if (!processHasEnded(asRecord(invocation.caller, 'original intent caller'))) gate('recovery_caller_alive', 'The original intent caller is still alive; it may still spawn its worker.');
}

function boundFailure(directory: string, settings: JsonObject, filename = path.join(directory, 'failure.json')): boolean {
  if (!fs.existsSync(filename)) return false;
  const failure = loadRecord(filename);
  if (failure.schema !== 'embedding-attempt-failure/1') {
    return failure.input_identity === settings.input_identity && failure.condition_digest === digest(condition(settings)) && typeof failure.message === 'string' && ['build', 'serve', 'bench'].includes(String(failure.phase));
  }
  if (failure.attempt !== absolutePath(directory) || failure.attempt_id !== settings.id || failure.strategy_id !== settings.strategy_id || failure.receipt_identity !== settings.receipt_identity || failure.input_identity !== settings.input_identity || failure.condition_digest !== digest(condition(settings)) || settings.campaign_owner === undefined || digest(failure.campaign_owner) !== digest(settings.campaign_owner)) gate('recovery_failure_binding', 'Campaign failure evidence is bound to another attempt, input or receipt.', [filename]);
  const source = asRecord(failure.evidence, 'campaign failure source');
  const sourcePath = stringValue(source.path, 'campaign evidence path');
  if (sha256Bytes(fs.readFileSync(sourcePath)) !== source.sha256) gate('recovery_failure_evidence_changed', 'The verified worker or reconciliation evidence changed after failure recording.', [sourcePath]);
  const observed = loadRecord(sourcePath);
  if (digest(observed.operation) !== digest(failure.operation) || digest(observed.error) !== digest(failure.error) || (observed.interrupted === true) !== (failure.interrupted === true) || (observed.interrupted_before_worker === true) !== (failure.interrupted_before_worker === true)) gate('recovery_failure_evidence_changed', 'Preserved campaign failure no longer matches its original worker evidence.', [filename, sourcePath]);
  for (const [name, value] of Object.entries(asRecord(failure.artifacts ?? {}))) {
    const artifact = asRecord(value, 'preserved failure artifact');
    const artifactPath = absolutePath(stringValue(artifact.path));
    if (!FAILURE_ARTIFACTS.includes(name) || !artifactPath.startsWith(path.join(absolutePath(directory), 'failure-evidence') + path.sep) || path.basename(artifactPath) !== name || sha256Bytes(fs.readFileSync(artifactPath)) !== artifact.sha256) gate('recovery_failure_evidence_changed', 'Preserved command or runtime failure bytes changed.', [artifactPath]);
  }
  return true;
}

function readCampaignFailures(attempt: CheckedAttempt, cutoff = Infinity): JsonObject[] {
  const filenames = [path.join(attempt.path, 'failure.json')];
  const archive = path.join(attempt.path, 'failure-history');
  if (fs.existsSync(archive)) filenames.push(...fs.readdirSync(archive).filter((name) => name.endsWith('.json')).map((name) => path.join(archive, name)));
  const candidates = filenames.filter((filename) => fs.existsSync(filename)).map((filename) => ({filename, failure: loadRecord(filename)}))
    .filter((item) => item.failure.schema === 'embedding-attempt-failure/1' && typeof item.failure.at === 'string' && Date.parse(item.failure.at) <= cutoff)
    .toSorted((left, right) => Date.parse(stringValue(right.failure.at)) - Date.parse(stringValue(left.failure.at)) || digest(left.failure).localeCompare(digest(right.failure)));
  const seen = new Set<string>();
  const failures: JsonObject[] = [];
  for (const candidate of candidates) {
    if (!boundFailure(attempt.path, attempt.settings, candidate.filename)) continue;
    const key = digest(candidate.failure);
    if (seen.has(key)) continue;
    seen.add(key);
    failures.push(candidate.failure);
  }
  return failures;
}

/** Returns every bound campaign failure through the cutoff, newest first and without digest duplicates. */
export function campaignFailures(attempt: CheckedAttempt, asOf: string): JsonObject[] {
  const cutoff = Date.parse(asOf);
  if (!Number.isFinite(cutoff)) gate('recovery_failure_time', 'Campaign failure history requires a finite observation time.');
  return readCampaignFailures(attempt, cutoff);
}

function preserveFailureArtifacts(directory: string, operation: JsonObject): JsonObject {
  const destination = path.join(directory, 'failure-evidence', digest(operation));
  const artifacts: JsonObject = {};
  for (const name of FAILURE_ARTIFACTS) {
    const source = path.join(directory, name);
    if (!fs.existsSync(source)) continue;
    const content = fs.readFileSync(source);
    fs.mkdirSync(destination, {recursive: true});
    const target = path.join(destination, name);
    if (fs.existsSync(target)) {
      if (!fs.readFileSync(target).equals(content)) gate('recovery_failure_evidence_changed', 'An operation cannot replace its already preserved failure bytes.', [target]);
    } else fs.writeFileSync(target, content, {flag: 'wx'});
    artifacts[name] = {path: target, sha256: sha256Bytes(content)};
  }
  return artifacts;
}

/** Seals a failure only while its original campaign operation and actual leases still own the attempt. */
export async function recordCampaignFailure(attemptPath: string, evidencePath: string, options: CampaignFailureOptions = {}): Promise<void> {
  const original = readAttemptIdentity(attemptPath, true);
  if (original.settings.schema !== 'embedding-attempt/2') gate('recovery_failure_schema', 'Campaign failure binding requires a prepared schema-2 attempt.', [original.path]);
  const owner = asRecord(original.settings.campaign_owner, 'campaign owner');
  const campaignPath = absolutePath(stringValue(owner.campaign_path));
  if (!hasExecutionLease(path.join(campaignPath, '.execution.lock'))) gate('campaign_owned_attempt', 'Recording campaign failure requires its actual held execution lease.', [campaignPath]);
  await withExecutionLease({attempt: original.path}, async () => {
    const attempt = readAttemptIdentity(original.path, true);
    const state = loadRecord(path.join(campaignPath, 'checkpoint.json'));
    const active = asRecord(state.active, 'original active operation');
    const cell = asRecord(asRecord(state.cells)[stringValue(owner.cell_id)], 'original campaign cell');
    const operationId = stringValue(active.operation_id, 'original operation ID');
    if (active.cell_id !== owner.cell_id || absolutePath(stringValue(cell.attempt)) !== attempt.path || absolutePath(stringValue(cell.strategy)) !== absolutePath(stringValue(attempt.settings.strategy_path))) gate('recovery_failure_owner', 'The original active campaign cell does not own this attempt and receipt.', [campaignPath, attempt.path]);
    if (!['build', 'serve', 'bench', 'stop'].includes(stringValue(active.phase))) gate('recovery_failure_phase', 'Only an operation on an existing attempt can record its execution failure.', [campaignPath]);
    const invocations = arrayValue(state.invocations, 'campaign invocations').map((item) => asRecord(item)).filter((item) => item.id === active.invocation_id);
    const invocation = invocations[0];
    if (invocations.length !== 1 || !invocation || invocation.cell_id !== owner.cell_id || invocation.phase !== active.phase || absolutePath(stringValue(invocation.attempt)) !== attempt.path) gate('recovery_failure_invocation', 'The original invocation does not bind this operation to the approved attempt.', [campaignPath]);
    const interruptedBeforeWorker = options.interruptedBeforeWorker === true;
    const worker = interruptedBeforeWorker ? null : asRecord(active.process, 'original worker process');
    if (interruptedBeforeWorker) {
      if (options.interrupted !== true) gate('recovery_failure_kind', 'An unstarted worker can only be reconciled as an interruption.');
      if (cell.phase !== active.phase) gate('recovery_failure_phase', 'The interrupted intent disagrees with its current campaign cell phase.', [campaignPath]);
      verifyUnstartedIntent(state, active, invocation);
    } else if (!worker || !sameProcessIdentity(worker, asRecord(invocation.worker))) gate('recovery_failure_invocation', 'The original invocation does not bind this worker identity to the approved attempt.', [campaignPath]);
    const sourcePath = absolutePath(evidencePath);
    if (path.dirname(sourcePath) !== path.join(campaignPath, 'workers') || !path.basename(sourcePath).startsWith(`${operationId}.`) || !sourcePath.endsWith('.json')) gate('recovery_failure_evidence_path', 'Failure evidence must belong to this original operation in the campaign worker directory.', [sourcePath]);
    const evidence = loadRecord(sourcePath);
    const error = asRecord(evidence.error, 'worker error');
    if (!stringValue(error.message, 'worker error message').trim() || digest(evidence.operation) !== digest(active)) gate('recovery_failure_operation', 'Worker evidence does not describe the original active operation and error.', [sourcePath]);
    if (!Number.isFinite(Date.parse(stringValue(evidence.finished_at))) || Date.parse(stringValue(evidence.finished_at)) < Date.parse(stringValue(active.started_at))) gate('recovery_failure_time', 'Worker failure evidence has an invalid completion time.', [sourcePath]);
    if (evidence.observed !== null && evidence.observed !== undefined && absolutePath(stringValue(asRecord(evidence.observed).attempt)) !== attempt.path) gate('recovery_failure_observation', 'Worker resource observations belong to another attempt.', [sourcePath]);
    const interrupted = options.interrupted === true;
    if (interrupted !== (evidence.interrupted === true) || interruptedBeforeWorker !== (evidence.interrupted_before_worker === true)) gate('recovery_failure_kind', 'Failure kind does not match its worker evidence.', [sourcePath]);
    if (interrupted) {
      if (error.code !== 'worker_interrupted' || (!interruptedBeforeWorker && (!worker || !processHasEnded(worker)))) gate('recovery_worker_alive', 'Interruption requires an observed ended original worker or its verified unstarted intent.', [sourcePath]);
      const commandPath = path.join(attempt.path, 'active.json');
      if (fs.existsSync(commandPath)) {
        const command = loadRecord(commandPath);
        if ((command.process === undefined || command.process === null) && command.state === 'running') gate('recovery_command_unobserved', 'A recorded running command has no observable process identity.', [commandPath]);
        if (command.process !== undefined && command.process !== null && !processHasEnded(asRecord(command.process))) gate('recovery_command_alive', 'A surviving original command must finish before interruption recovery.', [commandPath]);
      }
    } else if (!worker || !alive(worker) || !sameProcessIdentity(worker, identity())) {
      gate('recovery_worker_owner', 'Only the actual live operation worker may record its completed error.', [sourcePath]);
    }
    // The worker can end after binding a failure but before committing its
    // checkpoint. Validate its immutable record and reuse those bytes; the
    // live event stream already includes campaign_failure_bound at this point.
    const history = readCampaignFailures(attempt);
    const previousOperations = history.filter((record) => asRecord(record.operation).operation_id === operationId);
    for (const record of previousOperations) {
      if (digest(record.operation) !== digest(active)) gate('recovery_failure_operation', 'An operation cannot replace its previously bound execution inputs.', [sourcePath]);
    }
    const evidenceReference = {path: sourcePath, sha256: sha256Bytes(fs.readFileSync(sourcePath))};
    if (previousOperations.some((record) => digest(record.evidence) === digest(evidenceReference))) return;
    const preserved = previousOperations.filter((record) => record.artifacts !== undefined);
    const originalArtifacts = preserved[0]?.artifacts;
    if (preserved.some((record) => digest(record.artifacts) !== digest(originalArtifacts))) gate('recovery_failure_evidence_changed', 'An operation has conflicting preserved failure artifacts.', [attempt.path]);
    const failure: JsonObject = {schema: 'embedding-attempt-failure/1', at: now(), attempt: attempt.path, attempt_id: attempt.settings.id,
      strategy_id: attempt.settings.strategy_id, receipt_identity: attempt.receiptIdentity, input_identity: attempt.settings.input_identity,
      condition_digest: digest(condition(attempt.settings)), campaign_owner: owner, operation: active, invocation, error,
      phase: active.phase, message: error.message, interrupted, interrupted_before_worker: interruptedBeforeWorker, recorded_by: identity(), evidence: evidenceReference};
    failure.artifacts = originalArtifacts ?? preserveFailureArtifacts(attempt.path, active);
    const filename = path.join(attempt.path, 'failure.json');
    if (fs.existsSync(filename)) {
      const previous = loadRecord(filename);
      const archive = path.join(attempt.path, 'failure-history', `${digest(previous)}.json`);
      if (!fs.existsSync(archive)) save(archive, previous);
    }
    save(filename, failure);
    event(attempt.path, 'campaign_failure_bound', {operation_id: operationId, phase: active.phase, interrupted, interrupted_before_worker: interruptedBeforeWorker, evidence: failure.evidence});
  });
}

function failedAttempt(directory: string, settings: JsonObject): boolean {
  if (boundFailure(directory, settings) || ['build_failed', 'startup_failed', 'interrupted', 'bench_failed'].includes(stringValue(settings.state)) || typeof settings.error === 'string') return true;
  const resultPath = path.join(directory, 'result.json');
  return fs.existsSync(resultPath) && ['FAIL', 'UNVERIFIED'].includes(String(loadRecord(resultPath).verdict));
}

function priorScopedAttempts(cfg: JsonObject): Array<{path: string; settings: JsonObject}> {
  const directory = path.dirname(absolutePath(stringValue(cfg.source_snapshot_path)));
  const parent = path.dirname(directory);
  const scope = recoveryScope(cfg);
  const attempts: Array<{path: string; settings: JsonObject}> = [];
  for (const name of fs.readdirSync(parent)) {
    const candidate = path.join(parent, name, 'settings.yaml');
    if (!fs.existsSync(candidate) || path.dirname(candidate) === directory) continue;
    const settings = loadRecord(candidate);
    if (settings.schema === 'embedding-attempt/2' && settings.strategy_id === cfg.strategy_id && recoveryScope(settings) === scope) attempts.push({path: path.dirname(candidate), settings});
  }
  return attempts;
}

function recoveryRecord(options: RecoveryOptions | undefined, cfg: JsonObject): JsonObject | null {
  if (!options) return null;
  for (const [label, value] of Object.entries({reason: options.reason, hypothesis: options.hypothesis, change: options.change})) {
    if (!value.trim()) gate('recovery_reason_required', `Recovery ${label} must describe the evidence-based adjustment.`);
  }
  const previous = readAttemptIdentity(options.previousAttempt, true);
  if (previous.settings.schema !== 'embedding-attempt/2' || recoveryScope(previous.settings) !== recoveryScope(cfg)) gate('recovery_scope_mismatch', 'A recovery must remain inside its original campaign cell or direct receipt evaluation group.', [previous.path]);
  if (previous.strategy.id !== cfg.strategy_id || !failedAttempt(previous.path, previous.settings)) gate('recovery_previous_failure', 'Recovery requires a preserved failure under the same approval.');
  const scoped = priorScopedAttempts(cfg);
  if (!scoped.some((item) => item.path === previous.path)) gate('recovery_scope_mismatch', 'The prior failure must exist in the preserved attempt directory for this scope.', [previous.path]);
  const prior = asRecord(previous.settings.recovery ?? {});
  const count = Math.max(scoped.length + 1, typeof prior.attempt_number === 'number' ? positiveAttemptInteger(prior.attempt_number, 'prior attempt') + 1 : 2);
  const starts = scoped.map((item) => stringValue(asRecord(item.settings.recovery ?? {}).started_at ?? item.settings.created_at)).toSorted();
  const started = stringValue(starts[0], 'scope start time');
  if (count > MAX_RECOVERY_ATTEMPTS || (Date.now() - Date.parse(started)) / 1000 > MAX_RECOVERY_SECONDS || !Number.isFinite(Date.parse(started))) gate('recovery_budget_exhausted', 'The finite attempt/time budget for this recovery lineage is exhausted.', [previous.path]);
  const observations: JsonObject[] = [];
  for (const file of options.observationPaths ?? []) {
    const filename = fs.realpathSync(file);
    const bytes = fs.readFileSync(filename);
    if (bytes.length === 0) gate('recovery_empty_observation', 'A new observation cannot be an empty file.', [filename]);
    observations.push({path: filename, sha256: sha256Bytes(bytes)});
  }
  const currentCondition = digest(condition(cfg));
  const previousCondition = digest(condition(previous.settings));
  const seenObservations = new Set<string>();
  for (const item of scoped) {
    const recovery = asRecord(item.settings.recovery ?? {});
    for (const observation of arrayValue(recovery.observations ?? [])) seenObservations.add(stringValue(asRecord(observation).sha256));
  }
  const identicalFailure = scoped.some((item) => failedAttempt(item.path, item.settings) && digest(condition(item.settings)) === currentCondition);
  if (identicalFailure && !observations.some((observation) => !seenObservations.has(stringValue(observation.sha256)))) gate('recovery_identical_retry', 'Identical failed conditions require a recorded new observation; restating or copying prior evidence does not change them.', [previous.path]);
  return {previous_attempt: previous.path, previous_failure: previous.settings.error ?? previous.settings.state,
    reason: options.reason, hypothesis: options.hypothesis, change: options.change, observations,
    previous_condition_digest: previousCondition, condition_digest: currentCondition, attempt_number: count,
    started_at: started, scope: recoveryScope(cfg), scoped_prior_attempts: scoped.length, max_attempts: MAX_RECOVERY_ATTEMPTS, max_elapsed_seconds: MAX_RECOVERY_SECONDS};
}

function assertRecoveryLink(cfg: JsonObject, recovery: RecoveryOptions | undefined): void {
  if (recovery) return;
  for (const previous of priorScopedAttempts(cfg)) {
    if (failedAttempt(previous.path, previous.settings)) gate('recovery_link_required', 'This campaign cell or direct receipt evaluation group already has a failed attempt. Changed builders or recipes must retain its bounded recovery lineage.', [previous.path]);
  }
}

/** Renders one sealed native TEI/ST attempt using existing approval and frozen preparation. */
export async function render(strategyPath: string, output: string, options: RenderOptions = {}): Promise<string> {
  const checked = checkedStrategy(strategyPath);
  const strategy = checked.strategy;
  const manifest = checked.manifest;
  const owner = options.campaignOwner ? {campaign_path: absolutePath(options.campaignOwner.campaign_path), cell_id: options.campaignOwner.cell_id} : undefined;
  const ownerCfg: JsonObject = owner ? {campaign_owner: owner} : {};
  campaignGate(ownerCfg, undefined, 'prepare', strategyPath);
  const sourcePath = fs.realpathSync(options.releaseSnapshotPath ?? path.join(ROOT, 'output/host/upstream-lock.json'));
  const snapshot = validateFrozenSources(loadRecord(sourcePath));
  const architecture = asRecord(asRecord(manifest.host).architecture).value;
  if (snapshot.observed_architecture !== architecture) gate('upstream_architecture_mismatch', 'Frozen binary dependencies were prepared for a different observed architecture.', [sourcePath]);
  const profile = asRecord(strategy.profile, 'profile');
  const modules = arrayValue(profile.modules ?? [], 'ST modules');
  const support = runtimeSupport(strategy);
  if (support.status === 'adapter_required') gate('model_adapter_required', support.reason, [strategyPath]);
  const selected = selectPlatform(manifest, stringValue(strategy.device), snapshot.platforms);
  if (selected.status === 'adapter_required') gate('platform_adapter_required', stringValue(selected.reason), [sourcePath]);
  let engine = options.engine ?? (selected.tei_image ? 'tei' : 'sentence-transformers');
  let reason = options.reason;
  if (!ENGINES.has(engine)) gate('invalid_engine', 'Engine must be tei or sentence-transformers.');
  if (engine === 'tei' && !selected.tei_image) gate('tei_platform_unavailable', 'No frozen TEI image matches this approved device.');
  if (options.engine === 'sentence-transformers' && selected.tei_image && !reason?.trim()) gate('tei_fallback_evidence_required', 'Same-device ST fallback requires stored TEI incompatibility or failure evidence.');
  const supportedModules = new Set(['Transformer', 'Pooling', 'Dense', 'Normalize'].map((name) => `sentence_transformers.models.${name}`));
  const unsupported = modules.map((module) => stringValue(asRecord(module).type, 'module type')).filter((type) => !supportedModules.has(type));
  if (options.engine === 'sentence-transformers' && selected.tei_image && unsupported.length === 0 && (!options.recovery || !hasTeiFailure(options.recovery.previousAttempt, snapshot.id))) {
    gate('tei_fallback_unsubstantiated', 'ST fallback needs a native TEI failure from this frozen upstream snapshot, or an observed unsupported model module.', [strategyPath], 'preserve the failed TEI attempt and request a typed recovery');
  }
  if (engine === 'tei' && unsupported.length > 0) {
    reason = `TEI cannot preserve declared custom ST modules: ${unsupported.join(', ')}; use same-device ST.`;
    if (options.engine === 'tei') gate('tei_module_incompatible', reason, [strategyPath]);
    engine = 'sentence-transformers';
  }
  const dtype = options.dtype ?? chooseDtype(strategy, engine);
  if (!DTYPES.has(dtype) || (strategy.device === 'cpu' && dtype !== 'float32')) gate('invalid_dtype', 'Dtype is unsupported for the selected execution path.');
  if (options.dtype && !options.recovery) gate('dtype_recovery_required', 'A dtype adjustment must be linked to a prior failed attempt and hypothesis.');
  const budget = containerBudget(manifest);
  const platform = recordClone(selected);
  platform.docker_args = [...strings(platform.docker_args ?? [], 'platform Docker arguments'), ...budget.args];
  const longContext = positiveAttemptInteger(strategy.context_window, 'context window') >= 16384;
  const limits: JsonObject = {build_timeout_seconds: 1800, startup_timeout_seconds: longContext ? 1800 : 600, functional_timeout_seconds: longContext ? 1800 : 600, container: budget.evidence, source: 'Finite initial host-derived execution limits; revisions require recovery evidence.'};
  if (options.limits) {
    if (!options.recovery) gate('limits_recovery_required', 'Timeout changes require a linked recovery hypothesis.');
    for (const [key, value] of Object.entries(options.limits)) {
      if (!['build_timeout_seconds', 'startup_timeout_seconds', 'functional_timeout_seconds'].includes(key)) gate('unsupported_recovery_knob', `Unsupported execution limit: ${key}`);
      const seconds = positiveAttemptInteger(value, key);
      if (seconds > MAX_RECOVERY_SECONDS) gate('recovery_timeout_exceeded', 'A phase timeout exceeds the total recovery time bound.');
      limits[key] = seconds;
    }
  }
  return withExecutionLease({}, async () => {
    const id = now().replaceAll(':', '').replaceAll('+', '_') + '_' + randomUUID().slice(0, 8);
    const directory = path.join(path.resolve(output), stringValue(strategy.model), 'attempts', id);
    fs.mkdirSync(directory, {recursive: true});
    fs.cpSync(path.join(ROOT, 'runtime'), path.join(directory, 'runtime'), {recursive: true, filter: (source) => path.basename(source) !== '__pycache__'});
    save(path.join(directory, 'strategy.yaml'), strategy);
    save(path.join(directory, 'manifest.yaml'), manifest);
    save(path.join(directory, 'upstream-lock.json'), snapshot);
    const cfg: JsonObject = {
      schema: 'embedding-attempt/2', id, created_at: now(), strategy_path: absolutePath(strategyPath), strategy_id: strategy.id,
      evidence_kind: manifest.evidence_kind === 'mock' || snapshot.evidence_kind === 'mock' ? 'mock' : 'measured',
      receipt_identity: checked.receiptIdentity, engine, engine_reason: reason ?? (engine === 'tei' ? 'TEI first; native runtime verification pending.' : 'No matching frozen TEI adapter; same-device ST.'),
      dtype, dtype_reason: options.dtype ? 'Recorded evidence-based recovery adjustment.' : 'CPU float32; TEI Gemma3 float32; contextual ST bf16; preserve checkpoint exponent range.',
      platform, versions: snapshot.versions, limits, builder: options.builder ?? null, state: 'prepared',
      source_snapshot_path: path.join(directory, 'upstream-lock.json'), source_origin_path: sourcePath, source_snapshot_digest: digest(snapshot), upstream_id: snapshot.id,
      recovery_policy: {schema: 'embedding-recovery/1', knobs: ['engine', 'dtype', 'build_timeout_seconds', 'startup_timeout_seconds', 'functional_timeout_seconds', 'builder', 'declared_recipe'], max_attempts: MAX_RECOVERY_ATTEMPTS, max_elapsed_seconds: MAX_RECOVERY_SECONDS, invariant: 'Device, input tokens and output dimensions remain bound to the actual approval receipt.'},
    };
    if (owner) cfg.campaign_owner = owner;
    cfg.harness_source = harnessSource();
    const assets = nativeAssets(cfg, snapshot, options.recipes, path.join(directory, 'runtime'));
    for (const [filename, content] of Object.entries(assets.dependencies)) fs.writeFileSync(path.join(directory, filename), stringValue(content));
    cfg.dependency_locks = assets.dependencyLocks;
    const localConfig = loadRecord(path.join(stringValue(strategy.model_path), 'config.json'));
    if (engine === 'tei' && profile.model_type === 'nomic_bert' && !localConfig.max_position_embeddings && typeof localConfig.n_positions === 'number' && Number.isSafeInteger(localConfig.n_positions) && localConfig.n_positions >= positiveAttemptInteger(strategy.context_window, 'context window')) {
      cfg.model_config_overrides = {max_position_embeddings: localConfig.n_positions};
      cfg.model_config_override_reason = 'Standard alias for observed Nomic n_positions; preserve trained limits and approved context.';
    }
    if (engine === 'tei' && profile.model_type === 'qwen3' && typeof localConfig.max_position_embeddings === 'number' && localConfig.max_position_embeddings > positiveAttemptInteger(strategy.context_window, 'context window')) {
      cfg.model_config_overrides = {max_position_embeddings: strategy.context_window};
      cfg.model_config_override_reason = 'Align router capacity to approved model-card context; preserve weights and RoPE parameters.';
    }
    cfg.recipe_snapshots = assets.recipeSnapshots;
    for (const [name, content] of Object.entries(assets.recipes)) fs.writeFileSync(path.join(directory, name), stringValue(content));
    cfg.compatibility_key = currentCompatibility(directory, cfg);
    cfg.previous_compatible_pass = findCompatiblePass(output, stringValue(cfg.compatibility_key));
    assertRecoveryLink(cfg, options.recovery);
    cfg.recovery = recoveryRecord(options.recovery, cfg);
    cfg.input_identity = inputIdentity(cfg);
    save(path.join(directory, 'settings.yaml'), cfg);
    fs.writeFileSync(path.join(directory, 'serve.env'), 'EMB_API_BIND=127.0.0.1\nEMB_API_PORT=8080\n');
    fs.writeFileSync(path.join(directory, 'run.sh'), `#!/usr/bin/env bash\nset -euo pipefail\nsource ${shellQuote(path.join(directory, 'serve.env'))}\nexec ${shellQuote(process.execPath)} ${shellQuote(path.join(ROOT, '.agents/skills/embedding-explorer/src/cli.ts'))} serve --attempt ${shellQuote(directory)} --bind "$EMB_API_BIND" --port "$EMB_API_PORT" "$@"\n`, {mode: 0o755});
    event(directory, 'attempt_prepared', {engine, reason: cfg.engine_reason, upstream_id: snapshot.id, previous_compatible_pass: cfg.previous_compatible_pass});
    return directory;
  });
}

/** Persists finite effect intent and real command identity under the original attempt lease. */
export async function executeAttemptCommand(attemptPath: string, label: string, argv: string[], timeoutSeconds = 1800): Promise<void> {
  if (!hasExecutionLease(path.join(attemptPath, '.execution.lock'))) gate('execution_lease_required', 'Effect commands require the validated per-attempt execution lease.');
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > MAX_RECOVERY_SECONDS) gate('invalid_attempt_limit', 'Command deadline must be finite and within the recovery bound.');
  if (!/^[a-z][a-z0-9-]*$/.test(label)) gate('invalid_phase_label', 'Effect log labels must be simple phase names.');
  event(attemptPath, 'command_started', {phase: label, argv, timeout_seconds: timeoutSeconds});
  const logPath = path.join(attemptPath, `${label}.log`);
  save(path.join(attemptPath, 'active.json'), {phase: label, argv, started_at: now(), state: 'intent', timeout_seconds: timeoutSeconds});
  const cfg = loadRecord(path.join(attemptPath, 'settings.yaml'));
  const cleanup = label.startsWith('stop-') || label === 'remove-network';
  const recovery = asRecord(cfg.recovery ?? {});
  const remaining = MAX_RECOVERY_SECONDS - (Date.now() - Date.parse(stringValue(recovery.started_at ?? cfg.created_at))) / 1000;
  const boundedTimeout = cleanup ? timeoutSeconds : Math.min(timeoutSeconds, remaining);
  if (!Number.isFinite(boundedTimeout) || boundedTimeout <= 0) gate('recovery_budget_exhausted', 'The recovery deadline expired before the next external command.', [attemptPath]);
  const result = await runCommand(argv, {logPath, timeoutSeconds: boundedTimeout, effect: 'mutate', onSpawn: (owner) => {
    save(path.join(attemptPath, 'active.json'), {phase: label, argv, started_at: now(), state: 'running', pid: owner.pid, process: owner, timeout_seconds: timeoutSeconds});
  }});
  save(path.join(attemptPath, 'active.json'), {phase: label, finished_at: now(), returncode: result.code, timed_out: result.timedOut, process: result.process, spawn_error: result.spawnError ?? null});
  event(attemptPath, 'command_finished', {phase: label, returncode: result.code, timed_out: result.timedOut, log: logPath});
  if (result.code !== 0 || result.timedOut || result.spawnError) {
    gate('attempt_command_failed', `${label} failed (${result.code}${result.timedOut ? ', timeout' : ''}); inspect the retained command evidence.`, [logPath]);
  }
}

/** Preserves a failed phase and its sealed attempt inputs before retry assessment. */
export function retainAttemptFailure(attempt: CheckedAttempt, phase: string, error: unknown): void {
  const message = errorMessage(error);
  attempt.settings.state = phase === 'build' ? 'build_failed' : 'startup_failed';
  attempt.settings.error = message;
  save(path.join(attempt.path, 'failure.json'), {at: now(), phase, message, condition_digest: digest(condition(attempt.settings)), input_identity: attempt.settings.input_identity});
  save(path.join(attempt.path, 'settings.yaml'), attempt.settings);
  event(attempt.path, 'phase_failed', {phase, error: message});
}

/** Locates the newest built attempt for an unchanged approval, without creating one. */
export function resolveAttempt(strategyPath: string, output: string): string {
  const {strategy} = checkedStrategy(strategyPath);
  const parent = path.join(output, stringValue(strategy.model), 'attempts');
  let selected: {path: string; modified: bigint} | undefined;
  if (fs.existsSync(parent)) {
    for (const name of fs.readdirSync(parent)) {
      const filename = path.join(parent, name, 'settings.yaml');
      if (!fs.existsSync(filename) || !fs.existsSync(path.join(parent, name, 'images.json'))) continue;
      const cfg = loadRecord(filename);
      const modified = fs.statSync(filename, {bigint: true}).mtimeNs;
      if (cfg.strategy_id === strategy.id && (!selected || modified > selected.modified)) selected = {path: path.join(parent, name), modified};
    }
  }
  if (!selected) gate('attempt_not_built', 'No built attempt exists for this strategy.', [strategyPath], 'build a new attempt');
  return fs.realpathSync(selected.path);
}
