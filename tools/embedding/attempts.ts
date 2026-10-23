/** Generates native serving assets and gates every external effect on its evidence. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {GateError, ROOT, absolutePath, appendEvent, arrayValue, asRecord, cloneJson, digest, integerValue, load, loadRecord, now, omitRecordKeys, save, sha256Bytes, stringValue} from './common.ts';
import type {JsonObject} from './common.ts';
import {assertCurrentCompatibility, selectPlatform} from './hardware.ts';
import {checkedStrategy, checkedStrategyForCleanup} from './models.ts';
import {alive, hasExecutionLease, identity, observeProcess, runCommand, withExecutionLease} from './processes.ts';
import {validateFrozenSources} from './upstream.ts';
import type {ReleaseSnapshot} from './upstream.ts';

const ENGINES = new Set(['tei', 'sentence-transformers']);
const DTYPES = new Set(['float32', 'float16', 'bfloat16']);
const MAX_RECOVERY_ATTEMPTS = 8;
const MAX_RECOVERY_SECONDS = 14_400;
const RECIPE_NAMES = new Set(['Dockerfile', 'Dockerfile.gateway']);

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

/** Provides the one typed build knob already recorded in the attempt condition. */
export interface BuildOptions { builder?: string; }

/** Defines the local API binding for a concrete container attempt. */
export interface ServeOptions { port?: number; bind?: string; }

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

interface Inspection {
  status: 'present' | 'absent';
  info?: JsonObject;
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

function positiveInteger(value: unknown, label: string): number {
  const integer = integerValue(value, label);
  if (integer <= 0) gate('invalid_attempt_limit', `${label} must be positive.`);
  return integer;
}

function textFiles(directory: string, predicate: (name: string) => boolean): JsonObject {
  const records: JsonObject = {};
  for (const name of fs.readdirSync(directory).filter((entry) => predicate(entry)).toSorted()) {
    const filename = path.join(directory, name);
    if (!fs.statSync(filename).isFile()) continue;
    records[name] = fs.readFileSync(filename, 'utf8');
  }
  return records;
}

function recipesAt(attemptPath: string): JsonObject {
  return textFiles(attemptPath, (name) => name.startsWith('Dockerfile'));
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
  const runtime = textFiles(inputs.runtimeRoot ?? path.join(ROOT, 'runtime'), (name) => name.endsWith('.py'));
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
  for (const directory of ['tools', 'config', 'rules']) visit(path.join(ROOT, directory));
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

function nativeRecipes(cfg: JsonObject, snapshot: ReleaseSnapshot): JsonObject {
  const platform = asRecord(cfg.platform);
  if (cfg.engine === 'tei') return {
    Dockerfile: `FROM ${stringValue(platform.tei_image)}\n`,
    'Dockerfile.gateway': `FROM ${stringValue(snapshot.gateway_base)}\nWORKDIR /app\nCOPY requirements.gateway.txt /app/requirements.txt\nRUN pip install --no-cache-dir --timeout 120 --retries 5 --require-hashes -r /app/requirements.txt\nCOPY runtime /app/runtime\nENTRYPOINT ["python","-m","runtime.server"]\n`,
  };
  return {Dockerfile: `FROM ${stringValue(platform.st_base)}\nWORKDIR /app\nCOPY requirements.backend.txt /app/requirements.txt\nRUN pip install --no-cache-dir --timeout 120 --retries 5 --require-hashes -r /app/requirements.txt\nCOPY runtime /app/runtime\nENTRYPOINT ["python","-m","runtime.server"]\n`};
}

function validateRecipe(content: string, snapshot: ReleaseSnapshot, nativeContent: string): void {
  const bases = new Set(Object.values(snapshot.images).map((value) => stringValue(asRecord(value).pinned)));
  const stages = new Set<string>();
  const lines = content.split(/\r?\n/);
  let found = false;
  for (const line of lines) {
    const matched = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
    if (!matched) continue;
    found = true;
    const base = matched[1];
    if (!base || (!bases.has(base) && !stages.has(base))) gate('recipe_base_unfrozen', 'Recipe base images must occur in the immutable upstream snapshot.');
    if (matched[2]) stages.add(matched[2]);
  }
  if (!found) gate('recipe_missing_base', 'Dockerfile has no valid frozen FROM input.');
  const instructions: string[] = [];
  for (const source of lines) {
    const line = source.trim();
    if (/^#\s*(?:syntax|escape|check)\s*=/i.test(line)) gate('recipe_unfrozen_directive', 'Declared recipes cannot change the frozen Dockerfile parser or fetch a new frontend.');
    if (!line || line.startsWith('#')) continue;
    if (/^LABEL easy-emb\.note[.-][a-z0-9.-]+="[A-Za-z0-9 ._:/-]*"$/.test(line)) continue;
    if (/^ENV (?:OMP_NUM_THREADS|MKL_NUM_THREADS)=[1-9][0-9]{0,3}$/.test(line) || /^ENV TOKENIZERS_PARALLELISM=(?:true|false)$/.test(line) || /^ENV (?:HF_HUB_OFFLINE|TRANSFORMERS_OFFLINE)=1$/.test(line)) continue;
    instructions.push(line);
  }
  const nativeInstructions = nativeContent.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (digest(instructions) !== digest(nativeInstructions)) gate('recipe_dependencies_unfrozen', 'Declared recipes must preserve the native base, entrypoint and exact hashed dependency installation. Only explicit offline/thread/tokenizer settings and easy-emb.note annotations may be added.', [], 'prepare and review a new frozen source contract for additional package or code changes');
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

function boundFailure(directory: string, settings: JsonObject): boolean {
  const filename = path.join(directory, 'failure.json');
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
  return true;
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
    const failure: JsonObject = {schema: 'embedding-attempt-failure/1', at: now(), attempt: attempt.path, attempt_id: attempt.settings.id,
      strategy_id: attempt.settings.strategy_id, receipt_identity: attempt.receiptIdentity, input_identity: attempt.settings.input_identity,
      condition_digest: digest(condition(attempt.settings)), campaign_owner: owner, operation: active, invocation, error,
      phase: active.phase, message: error.message, interrupted, interrupted_before_worker: interruptedBeforeWorker, recorded_by: identity(), evidence: {path: sourcePath, sha256: sha256Bytes(fs.readFileSync(sourcePath))}};
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
  const count = Math.max(scoped.length + 1, typeof prior.attempt_number === 'number' ? positiveInteger(prior.attempt_number, 'prior attempt') + 1 : 2);
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
  if (profile.requires_model_adapter && modules.length === 0 && !['qwen3_vl', 'kanana2vec'].includes(String(profile.model_type))) gate('model_adapter_required', stringValue(profile.requires_model_adapter), [strategyPath]);
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
  const longContext = positiveInteger(strategy.context_window, 'context window') >= 16384;
  const limits: JsonObject = {build_timeout_seconds: 1800, startup_timeout_seconds: longContext ? 1800 : 600, functional_timeout_seconds: longContext ? 1800 : 600, container: budget.evidence, source: 'Finite initial host-derived execution limits; revisions require recovery evidence.'};
  if (options.limits) {
    if (!options.recovery) gate('limits_recovery_required', 'Timeout changes require a linked recovery hypothesis.');
    for (const [key, value] of Object.entries(options.limits)) {
      if (!['build_timeout_seconds', 'startup_timeout_seconds', 'functional_timeout_seconds'].includes(key)) gate('unsupported_recovery_knob', `Unsupported execution limit: ${key}`);
      const seconds = positiveInteger(value, key);
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
    const dependencies = asRecord(snapshot.dependency_locks, 'frozen dependency locks');
    const dependencyLocks: JsonObject = {};
    for (const role of engine === 'tei' ? ['gateway'] : ['backend']) {
      const key = role === 'gateway' ? 'gateway' : stringValue(platform.id);
      const lock = asRecord(dependencies[key], 'engine dependency lock');
      const filename = `requirements.${role}.txt`;
      fs.writeFileSync(path.join(directory, filename), stringValue(lock.content));
      dependencyLocks[role] = {file: filename, sha256: lock.sha256, source: lock.path};
    }
    cfg.dependency_locks = dependencyLocks;
    const localConfig = loadRecord(path.join(stringValue(strategy.model_path), 'config.json'));
    if (engine === 'tei' && profile.model_type === 'nomic_bert' && !localConfig.max_position_embeddings && typeof localConfig.n_positions === 'number' && Number.isSafeInteger(localConfig.n_positions) && localConfig.n_positions >= positiveInteger(strategy.context_window, 'context window')) {
      cfg.model_config_overrides = {max_position_embeddings: localConfig.n_positions};
      cfg.model_config_override_reason = 'Standard alias for observed Nomic n_positions; preserve trained limits and approved context.';
    }
    if (engine === 'tei' && profile.model_type === 'qwen3' && typeof localConfig.max_position_embeddings === 'number' && localConfig.max_position_embeddings > positiveInteger(strategy.context_window, 'context window')) {
      cfg.model_config_overrides = {max_position_embeddings: strategy.context_window};
      cfg.model_config_override_reason = 'Align router capacity to approved model-card context; preserve weights and RoPE parameters.';
    }
    const native = nativeRecipes(cfg, snapshot);
    const recipes = recordClone(native);
    const snapshots: JsonObject = {};
    for (const [name, value] of Object.entries(options.recipes ?? {})) {
      if (!RECIPE_NAMES.has(name) || (name === 'Dockerfile.gateway' && engine !== 'tei')) gate('unsupported_recipe', `Recipe ${name} is not supported by this engine.`);
      const recipe = asRecord(value, 'declared recipe');
      const content = stringValue(recipe.content, 'recipe content');
      if (recipe.digest !== digest(content)) gate('recipe_snapshot_changed', 'Declared recipe content does not match its digest.');
      recipes[name] = content;
      snapshots[name] = recipe;
    }
    cfg.recipe_snapshots = snapshots;
    for (const [name, value] of Object.entries(recipes)) {
      const content = stringValue(value, name);
      validateRecipe(content, snapshot, stringValue(native[name], 'native recipe'));
      fs.writeFileSync(path.join(directory, name), content);
    }
    cfg.compatibility_key = currentCompatibility(directory, cfg);
    cfg.previous_compatible_pass = findCompatiblePass(output, stringValue(cfg.compatibility_key));
    assertRecoveryLink(cfg, options.recovery);
    cfg.recovery = recoveryRecord(options.recovery, cfg);
    cfg.input_identity = inputIdentity(cfg);
    save(path.join(directory, 'settings.yaml'), cfg);
    fs.writeFileSync(path.join(directory, 'serve.env'), 'EMB_API_BIND=127.0.0.1\nEMB_API_PORT=8080\n');
    fs.writeFileSync(path.join(directory, 'run.sh'), `#!/usr/bin/env bash\nset -euo pipefail\nsource ${shellQuote(path.join(directory, 'serve.env'))}\nexec ${shellQuote(process.execPath)} ${shellQuote(path.join(ROOT, 'tools/embctl.ts'))} serve --attempt ${shellQuote(directory)} --bind "$EMB_API_BIND" --port "$EMB_API_PORT" "$@"\n`, {mode: 0o755});
    event(directory, 'attempt_prepared', {engine, reason: cfg.engine_reason, upstream_id: snapshot.id, previous_compatible_pass: cfg.previous_compatible_pass});
    return directory;
  });
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) throw error;
  return error.message;
}

function inspectionPresent(inspection: Inspection, label: string): JsonObject {
  if (inspection.status !== 'present' || !inspection.info) gate('resource_missing', `${label} is absent; reconcile the stored resource intent before retry.`);
  return inspection.info;
}

async function inspectDocker(kind: 'container' | 'image' | 'network', name: string): Promise<Inspection> {
  const result = await runCommand(['docker', kind, 'inspect', name], {timeoutSeconds: 30, effect: 'observe'});
  if (result.code !== 0 || result.timedOut || result.spawnError) {
    const text = result.stderr.trim();
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const absence = new RegExp(`^(?:Error response from daemon: |Error: )?(?:No such (?:object|${kind}): ${escaped}|network ${escaped} not found)$`, 'i');
    if (!result.timedOut && !result.spawnError && result.code === 1 && text.split(/\r?\n/).every((line) => absence.test(line))) return {status: 'absent'};
    gate('docker_observation_failed', `Docker ${kind} observation failed; this is not evidence of absence: ${text || result.spawnError?.message || result.stdout}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch (error: unknown) {
    gate('docker_invalid_response', `Docker inspect returned invalid JSON: ${errorMessage(error)}`);
  }
  const values = arrayValue(value, 'Docker inspect list');
  if (values.length !== 1) gate('docker_invalid_response', 'Docker inspect must identify exactly one resource.');
  return {status: 'present', info: asRecord(values[0], 'Docker resource')};
}

/** Reads one exact Docker image identity without converting daemon failures to absence. */
export async function inspectImage(name: string): Promise<JsonObject> {
  return inspectionPresent(await inspectDocker('image', name), `Image ${name}`);
}

function labelsOf(info: JsonObject, kind: 'container' | 'network'): JsonObject {
  return asRecord(kind === 'container' ? asRecord(info.Config, 'container config').Labels ?? {} : info.Labels ?? {}, 'resource labels');
}

function assertOwned(info: JsonObject, attempt: CheckedAttempt, kind: 'container' | 'network'): void {
  const labels = labelsOf(info, kind);
  const legacyNetwork = kind === 'network' && attempt.settings.schema === 'embedding-attempt/1' && labels['easy-emb.strategy'] === undefined && creationRecorded(attempt, 'network', stringValue(info.Id));
  if (labels['easy-emb.attempt'] !== attempt.settings.id || (labels['easy-emb.strategy'] !== attempt.strategy.id && !legacyNetwork)) {
    gate('resource_owner_mismatch', `Refusing ${kind} operation: its attempt and strategy labels do not match this receipt.`, [attempt.path]);
  }
}

function creationRecorded(attempt: CheckedAttempt, role: string, id: string): boolean {
  const filename = path.join(attempt.path, role === 'network' ? 'network-create.log' : `start-${role}.log`);
  return fs.existsSync(filename) && fs.readFileSync(filename, 'utf8').split(/\r?\n/).some((line) => line.trim() === id);
}

async function assertNoOtherContainers(attempt: CheckedAttempt): Promise<void> {
  const result = await runCommand(['docker', 'ps', '--quiet', '--filter', 'label=easy-emb.attempt'], {timeoutSeconds: 30, effect: 'observe'});
  if (result.code !== 0 || result.timedOut || result.spawnError) gate('docker_observation_failed', `Cannot reconcile other harness resources: ${result.stderr || result.spawnError?.message || result.stdout}`);
  for (const id of result.stdout.split(/\s+/).filter((value) => value.length > 0)) {
    const observed = await inspectDocker('container', id);
    if (observed.status === 'absent') continue;
    const info = inspectionPresent(observed, id);
    const labels = labelsOf(info, 'container');
    if (labels['easy-emb.attempt'] !== attempt.settings.id) {
      gate('harness_resource_busy', `Another harness attempt still owns a running container: ${id}`, [attempt.path], 'capture and stop the owning attempt through its campaign before continuing');
    }
  }
}

/** Persists intent before a finite external effect and retains actual process identity. */
async function execute(attemptPath: string, label: string, argv: string[], timeoutSeconds = 1800): Promise<void> {
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

function retainFailure(attempt: CheckedAttempt, phase: string, error: unknown): void {
  const message = errorMessage(error);
  attempt.settings.state = phase === 'build' ? 'build_failed' : 'startup_failed';
  attempt.settings.error = message;
  save(path.join(attempt.path, 'failure.json'), {at: now(), phase, message, condition_digest: digest(condition(attempt.settings)), input_identity: attempt.settings.input_identity});
  save(path.join(attempt.path, 'settings.yaml'), attempt.settings);
  event(attempt.path, 'phase_failed', {phase, error: message});
}

function buildRecipe(attemptPath: string, filename: string): string {
  return digest({dockerfile: fs.readFileSync(path.join(attemptPath, filename), 'utf8'), runtime: textFiles(path.join(attemptPath, 'runtime'), (name) => name.endsWith('.py')), dependencies: textFiles(attemptPath, (name) => name.startsWith('requirements.') && name.endsWith('.txt'))}).slice(0, 16);
}

/** Builds native container recipes after validating approval, ownership, input pins and limits. */
export async function build(attemptPath: string, options: BuildOptions = {}): Promise<JsonObject> {
  return withAttemptExecution(attemptPath, 'build', async (attempt) => {
    const cfg = attempt.settings;
    const builder = options.builder ?? (typeof cfg.builder === 'string' ? cfg.builder : undefined);
    if ((builder ?? null) !== cfg.builder) gate('builder_condition_changed', 'Builder differs from the sealed attempt; render a new declared condition.');
    if (['build_failed', 'startup_failed', 'interrupted'].includes(stringValue(cfg.state))) gate('recovery_required', 'A failed attempt needs a new bounded recovery attempt.');
    if (['built', 'serving', 'stopped'].includes(stringValue(cfg.state)) && fs.existsSync(path.join(attempt.path, 'images.json'))) return {attempt: attempt.path, state: cfg.state, images: await validateImages(attempt), reconciled: true};
    if (cfg.state !== 'prepared') gate('build_state_unreconciled', 'An interrupted build must be reconciled and linked to a new recovery attempt before another build command.', [attempt.path]);
    const roles = cfg.engine === 'tei' ? ['backend', 'gateway'] : ['backend'];
    const intent: JsonObject = {};
    for (const role of roles) {
      const filename = role === 'backend' ? 'Dockerfile' : 'Dockerfile.gateway';
      const recipe = buildRecipe(attempt.path, filename);
      intent[role] = {tag: `easy-emb-${role}:${recipe}`, recipe, dockerfile: filename};
    }
    save(path.join(attempt.path, 'image-intent.json'), {at: now(), attempt_id: cfg.id, strategy_id: attempt.strategy.id, images: intent});
    cfg.state = 'building';
    save(path.join(attempt.path, 'settings.yaml'), cfg);
    invalidateValidation(attempt.path, 'New build requires a fresh serving verification.');
    const images: JsonObject = {};
    try {
      for (const role of roles) {
        const planned = asRecord(intent[role]);
        const tag = stringValue(planned.tag);
        const argv = ['docker', 'buildx', 'build', '--load', '--progress=plain', '--label', `easy-emb.recipe=${planned.recipe}`, '--label', 'easy-emb.project=easy_emb_server'];
        if (builder) argv.push('--builder', builder);
        argv.push('-t', tag, '-f', path.join(attempt.path, stringValue(planned.dockerfile)), attempt.path);
        await execute(attempt.path, `build-${role}`, argv, positiveInteger(asRecord(cfg.limits).build_timeout_seconds, 'build timeout'));
        const info = await inspectImage(tag);
        const labels = asRecord(asRecord(info.Config).Labels ?? {});
        if (labels['easy-emb.recipe'] !== planned.recipe) gate('built_image_recipe_mismatch', 'Built image does not carry this exact recipe identity.', [attempt.path]);
        images[role] = {tag, id: stringValue(info.Id, 'built image ID'), repo_digests: info.RepoDigests ?? null, recipe: planned.recipe};
        save(path.join(attempt.path, 'images.json'), images);
      }
      cfg.state = 'built';
      delete cfg.error;
      save(path.join(attempt.path, 'settings.yaml'), cfg);
    } catch (error: unknown) {
      retainFailure(attempt, 'build', error);
      throw error;
    }
    return {attempt: attempt.path, state: cfg.state, images};
  });
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

async function validateImages(attempt: CheckedAttempt): Promise<JsonObject> {
  const images = loadRecord(path.join(attempt.path, 'images.json'));
  const roles = attempt.settings.engine === 'tei' ? ['backend', 'gateway'] : ['backend'];
  if (Object.keys(images).toSorted().join(',') !== roles.toSorted().join(',')) gate('image_roles_mismatch', 'Recorded images do not cover exactly the native engine roles.');
  for (const role of roles) {
    const recorded = asRecord(images[role], 'recorded image');
    const filename = role === 'backend' ? 'Dockerfile' : 'Dockerfile.gateway';
    if (recorded.recipe !== buildRecipe(attempt.path, filename)) gate('image_recipe_mismatch', 'Recorded image was built from another recipe.', [attempt.path]);
    const id = stringValue(recorded.id, 'recorded image ID');
    const actual = await inspectImage(id);
    if (actual.Id !== id || asRecord(asRecord(actual.Config).Labels ?? {})['easy-emb.recipe'] !== recorded.recipe) gate('image_identity_mismatch', 'Recorded build identity is absent or no longer matches the recipe.', [attempt.path]);
  }
  return images;
}

function containerNames(attempt: CheckedAttempt, options: ServeOptions): JsonObject {
  const port = options.port ?? 8080;
  const bind = options.bind ?? '127.0.0.1';
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(bind) || bind.split('.').some((part) => Number(part) > 255)) gate('invalid_api_binding', 'Provide a valid IPv4 API bind and port in 1..65535.');
  const name = `easy-emb-${digest(attempt.path).slice(0, 12)}`;
  return {api: name, backend: attempt.settings.engine === 'tei' ? `${name}-backend` : null,
    network: attempt.settings.engine === 'tei' ? `${name}-net` : null,
    base_url: `http://127.0.0.1:${port}`, bind, port};
}

function checkedContainerNames(attempt: CheckedAttempt): JsonObject {
  const filename = path.join(attempt.path, 'containers.json');
  const recorded = loadRecord(filename);
  const expected = containerNames(attempt, {port: integerValue(recorded.port, 'recorded API port'), bind: stringValue(recorded.bind, 'recorded API bind')});
  if (digest(recorded) !== digest(expected)) gate('container_binding_changed', 'Recorded resource names must match this exact attempt path and binding.', [filename]);
  return recorded;
}

function resourceIdentity(attempt: CheckedAttempt, role: string, info: JsonObject): void {
  const kind = role === 'network' ? 'network' : 'container';
  assertOwned(info, attempt, kind);
  const names = checkedContainerNames(attempt);
  const name = stringValue(names[role], 'owned resource name');
  const actualName = stringValue(info.Name, 'observed resource name');
  if (actualName !== name && actualName !== `/${name}`) gate('resource_name_mismatch', 'Docker returned a resource with another canonical name.', [attempt.path]);
  const id = stringValue(info.Id, 'resource ID');
  const filename = path.join(attempt.path, 'resource-identities.json');
  const ledger = fs.existsSync(filename) ? loadRecord(filename) : {schema: 'embedding-resource-identities/1', attempt_id: attempt.settings.id, strategy_id: attempt.strategy.id, input_identity: attempt.settings.input_identity ?? null, resources: {}};
  if (ledger.attempt_id !== attempt.settings.id || ledger.strategy_id !== attempt.strategy.id || ledger.input_identity !== (attempt.settings.input_identity ?? null) || (ledger.digest !== undefined && ledger.digest !== digest(omitRecordKeys(ledger, ['digest'])))) gate('resource_identity_record_changed', 'Preserved resource identity does not match this approved attempt.', [filename]);
  const resources = asRecord(ledger.resources, 'owned resources');
  const recorded = resources[role] === undefined ? undefined : asRecord(resources[role], 'original resource');
  const image = kind === 'container' ? stringValue(info.Image, 'container image') : null;
  if (recorded && (recorded.id !== id || recorded.image !== image || recorded.name !== name)) gate('resource_identity_changed', 'The named Docker resource has been replaced since its original identity was recorded.', [filename]);
  if (kind === 'container') {
    const imageRole = role === 'api' && attempt.settings.engine === 'tei' ? 'gateway' : 'backend';
    const originalImage = asRecord(loadRecord(path.join(attempt.path, 'images.json'))[imageRole], 'original built image');
    if (image !== originalImage.id) gate('container_image_mismatch', 'The owned container differs from its recorded native build.', [filename]);
    const priorPath = path.join(attempt.path, `container-${role}.json`);
    if (!recorded && fs.existsSync(priorPath)) {
      const prior = asRecord(arrayValue(load(priorPath), 'original container observation')[0]);
      assertOwned(prior, attempt, 'container');
      if (prior.Id !== id || prior.Image !== image) gate('resource_identity_changed', 'The named resource differs from the preserved original container observation.', [priorPath]);
    } else if (!recorded && !creationRecorded(attempt, role, id)) {
      gate('resource_identity_missing', 'Cleanup or reconciliation requires an original ID in the creation log or preserved container observation.', [priorPath]);
    }
  }
  if (!recorded && kind === 'network' && !creationRecorded(attempt, role, id)) gate('resource_identity_missing', 'Network cleanup or reconciliation requires its original ID in the retained creation log.', [attempt.path]);
  if (!recorded) {
    resources[role] = {id, image, name, labels: {'easy-emb.attempt': attempt.settings.id, 'easy-emb.strategy': attempt.strategy.id}, observed_at: now()};
    ledger.digest = digest(omitRecordKeys(ledger, ['digest']));
    save(filename, ledger);
    event(attempt.path, 'resource_identity_preserved', {role, id, image, name});
  }
}

function assertResourceUncreated(attempt: CheckedAttempt, role: string): void {
  const filename = path.join(attempt.path, 'resource-identities.json');
  if (fs.existsSync(filename) && asRecord(loadRecord(filename).resources)[role] !== undefined) gate('resource_recreation_requires_attempt', 'An original Docker resource disappeared; a replacement must use a new attempt so original IDs remain valid for cleanup and results.', [filename], 'capture and stop remaining owned resources, then render a new attempt');
}

function overlayModel(attempt: CheckedAttempt): string {
  if (attempt.settings.engine !== 'tei' || attempt.settings.model_config_overrides === undefined) return '/model';
  const source = stringValue(attempt.strategy.model_path);
  const directory = path.join(attempt.path, 'model-overlay');
  fs.mkdirSync(directory, {recursive: true});
  for (const name of fs.readdirSync(source)) {
    if (name === 'config.json') continue;
    const target = path.join(directory, name);
    if (fs.lstatSync(directory).isSymbolicLink()) gate('model_overlay_collision', 'Model overlay directory cannot be a symbolic link.', [directory]);
    try {
      fs.symlinkSync(`/model/${name}`, target);
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      if (!('code' in error) || error.code !== 'EEXIST' || fs.readlinkSync(target) !== `/model/${name}`) throw error;
    }
  }
  const model = loadRecord(path.join(source, 'config.json'));
  Object.assign(model, asRecord(attempt.settings.model_config_overrides));
  save(path.join(directory, 'config.json'), model);
  save(path.join(attempt.path, 'model-config-patch.json'), {source, changes: attempt.settings.model_config_overrides, reason: attempt.settings.model_config_override_reason});
  return '/run/embedding/model-overlay';
}

function assertRunningContainer(info: JsonObject, attempt: CheckedAttempt, imageId: string, role: string): void {
  assertOwned(info, attempt, 'container');
  if (info.Image !== imageId) gate('container_image_mismatch', `Owned ${role} container uses another image.`, [attempt.path]);
  if (asRecord(info.State).Running !== true) gate('owned_container_stopped', `Owned ${role} container stopped; capture evidence and clean it through its owner before recovery.`, [attempt.path]);
}

function getLocalJson(address: string, timeoutMs: number): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const request = http.get(address, {agent: false}, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 2_000_000) request.destroy(new Error('Readiness response exceeds its finite size bound.'));
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Readiness HTTP ${response.statusCode ?? 'unknown'}`));
          return;
        }
        try {
          const value: unknown = JSON.parse(body);
          resolve(asRecord(value, 'readiness response'));
        } catch (error: unknown) {
          if (!(error instanceof Error)) throw error;
          reject(error);
        }
      });
      response.on('error', (error: Error) => { reject(error); });
    });
    request.setTimeout(timeoutMs, () => { request.destroy(new Error('Readiness request timed out.')); });
    const deadline = setTimeout(() => { request.destroy(new Error('Readiness request exceeded its wall-clock deadline.')); }, timeoutMs);
    request.once('close', () => { clearTimeout(deadline); });
    request.on('error', (error: Error) => { reject(error); });
  });
}

/** Starts or reconciles only owned native containers, then verifies bounded readiness. */
export async function serve(attemptPath: string, options: ServeOptions = {}): Promise<JsonObject> {
  return withAttemptExecution(attemptPath, 'serve', async (attempt) => {
    const cfg = attempt.settings;
    if (['build_failed', 'startup_failed', 'interrupted', 'stopped'].includes(stringValue(cfg.state))) gate('recovery_required', 'A failed or stopped serving process needs a new attempt before starting another process.');
    const images = await validateImages(attempt);
    const names = containerNames(attempt, options);
    const recordPath = path.join(attempt.path, 'containers.json');
    if (fs.existsSync(recordPath) && digest(loadRecord(recordPath)) !== digest(names)) gate('container_binding_changed', 'Stored resource names and binding differ; stop the owned resources before changing them.', [recordPath]);
    const runtime = recordClone(attempt.strategy);
    Object.assign(runtime, {engine: cfg.engine, attempt_id: cfg.id, torch_device: asRecord(cfg.platform).torch_device,
      dtype: cfg.dtype, backend_timeout_seconds: asRecord(cfg.limits).functional_timeout_seconds});
    save(path.join(attempt.path, 'runtime.json'), runtime);
    const modelId = overlayModel(attempt);
    const mount = ['--mount', `type=bind,src=${attempt.strategy.model_path},dst=/model,readonly`, '--mount', `type=bind,src=${attempt.path},dst=/run/embedding,readonly`];
    const owner = ['--label', `easy-emb.attempt=${cfg.id}`, '--label', `easy-emb.strategy=${attempt.strategy.id}`];
    const dockerArgs = strings(asRecord(cfg.platform).docker_args ?? [], 'platform Docker args');
    const apiName = stringValue(names.api);
    const backendImage = stringValue(asRecord(images.backend).id);
    const apiImage = cfg.engine === 'tei' ? stringValue(asRecord(images.gateway).id) : backendImage;
    const api = await inspectDocker('container', apiName);
    if (api.status === 'absent') assertResourceUncreated(attempt, 'api');
    save(recordPath, names);
    try {
      if (api.status === 'present') {
        const info = inspectionPresent(api, apiName);
        assertRunningContainer(info, attempt, apiImage, 'API');
        resourceIdentity(attempt, 'api', info);
        const ports = asRecord(asRecord(info.NetworkSettings).Ports);
        const bindings = arrayValue(ports['8080/tcp'], 'actual API binding').map((binding) => asRecord(binding));
        if (!bindings.some((binding) => binding.HostIp === names.bind && binding.HostPort === String(names.port))) gate('container_binding_changed', 'Running API port differs from the stored binding.', [recordPath]);
        if (typeof names.backend === 'string') {
          const backend = inspectionPresent(await inspectDocker('container', names.backend), names.backend);
          assertRunningContainer(backend, attempt, backendImage, 'backend');
          resourceIdentity(attempt, 'backend', backend);
          resourceIdentity(attempt, 'network', inspectionPresent(await inspectDocker('network', stringValue(names.network)), 'network'));
        }
        event(attempt.path, 'running_container_reconciled', {container: apiName, state: info.State});
      } else {
        cfg.state = 'starting';
        save(path.join(attempt.path, 'settings.yaml'), cfg);
        invalidateValidation(attempt.path, 'New container process requires fresh verification.');
        let apiArgs = dockerArgs;
        if (cfg.engine === 'tei') {
          const networkName = stringValue(names.network);
          const network = await inspectDocker('network', networkName);
          if (network.status === 'absent') {
            assertResourceUncreated(attempt, 'network');
            await execute(attempt.path, 'network-create', ['docker', 'network', 'create', ...owner, networkName], 30);
          }
          else assertOwned(inspectionPresent(network, networkName), attempt, 'network');
          resourceIdentity(attempt, 'network', inspectionPresent(await inspectDocker('network', networkName), networkName));
          const backendName = stringValue(names.backend);
          const backend = await inspectDocker('container', backendName);
          if (backend.status === 'absent') {
            assertResourceUncreated(attempt, 'backend');
            await execute(attempt.path, 'start-backend', ['docker', 'run', '-d', '--name', backendName, ...owner, '--network', networkName, ...mount, ...dockerArgs, backendImage,
              '--model-id', modelId, '--port', '80', '--dtype', stringValue(cfg.dtype), '--auto-truncate', 'false', '--max-batch-tokens', String(Math.max(16384, positiveInteger(attempt.strategy.context_window, 'context window'))), '--json-output'], 60);
          } else assertRunningContainer(inspectionPresent(backend, backendName), attempt, backendImage, 'backend');
          resourceIdentity(attempt, 'backend', inspectionPresent(await inspectDocker('container', backendName), backendName));
          apiArgs = ['--network', networkName, '-e', `EMB_TEI_URL=http://${backendName}:80`];
        }
        await execute(attempt.path, 'start-api', ['docker', 'run', '-d', '--name', apiName, ...owner, ...apiArgs, ...mount,
          '-p', `${names.bind}:${names.port}:8080`, '-e', 'HF_HUB_OFFLINE=1', '-e', 'TRANSFORMERS_OFFLINE=1', apiImage, '--config', '/run/embedding/runtime.json'], 60);
        resourceIdentity(attempt, 'api', inspectionPresent(await inspectDocker('container', apiName), apiName));
      }
      const deadline = performance.now() + Math.min(positiveInteger(asRecord(cfg.limits).startup_timeout_seconds, 'startup timeout'), remainingAttemptSeconds(attempt)) * 1000;
      let last = 'No readiness response';
      while (performance.now() < deadline) {
        try {
          const baseUrl = stringValue(names.base_url);
          await getLocalJson(`${baseUrl}/health`, Math.min(5000, Math.max(1, deadline - performance.now())));
          const info = await getLocalJson(`${baseUrl}/info`, Math.min(5000, Math.max(1, deadline - performance.now())));
          if (info.attempt_id !== cfg.id || info.strategy_id !== attempt.strategy.id || info.context_window !== attempt.strategy.context_window || info.dimensions !== attempt.strategy.dimensions) gate('runtime_identity_mismatch', 'Ready endpoint belongs to another strategy or settings.', [recordPath]);
          cfg.state = 'serving';
          delete cfg.error;
          save(path.join(attempt.path, 'settings.yaml'), cfg);
          await capture(attempt.path);
          return {attempt: attempt.path, state: 'serving', base_url: names.base_url};
        } catch (error: unknown) {
          if (error instanceof GateError) throw error;
          last = errorMessage(error);
        }
        for (const role of ['api', 'backend']) {
          if (typeof names[role] !== 'string') continue;
          const observed = inspectionPresent(await inspectDocker('container', stringValue(names[role])), role);
          assertRunningContainer(observed, attempt, role === 'api' ? apiImage : backendImage, role);
        }
        await delay(Math.min(2000, Math.max(1, deadline - performance.now())));
      }
      gate('startup_deadline', `Readiness deadline expired: ${last}`, [attempt.path]);
    } catch (error: unknown) {
      retainFailure(attempt, 'serve', error);
      await capture(attempt.path);
      throw error;
    }
  });
}

async function captureOwned(attempt: CheckedAttempt): Promise<void> {
  const containers = checkedContainerNames(attempt);
  let observedBackend = false;
  for (const role of ['api', 'backend']) {
    const name = containers[role];
    if (typeof name !== 'string') continue;
    const inspected = await inspectDocker('container', name);
    if (inspected.status === 'absent') {
      event(attempt.path, 'capture_resource_absent', {role, name});
      continue;
    }
    const info = inspectionPresent(inspected, name);
    resourceIdentity(attempt, role, info);
    save(path.join(attempt.path, `container-${role}.json`), [info]);
    const logPath = path.join(attempt.path, 'captures', randomUUID(), `container-${role}.log`);
    const logs = await runCommand(['docker', 'logs', stringValue(info.Id)], {timeoutSeconds: 30, effect: 'observe', logPath});
    if (logs.code !== 0 || logs.timedOut || logs.spawnError) {
      event(attempt.path, 'capture_probe_failed', {role, verb: 'logs', returncode: logs.code, stdout: logs.stdout, stderr: logs.stderr, timed_out: logs.timedOut});
      continue;
    }
    fs.copyFileSync(logPath, path.join(attempt.path, `container-${role}.log`));
    if (role === 'backend') observedBackend = true;
  }
  if (observedBackend) collectDeviceEvidence(attempt.path);
}

/** Captures owned resources under the same lease and campaign phase as its caller. */
export async function capture(attemptPath: string): Promise<void> {
  await withAttemptExecution(attemptPath, 'capture', async (attempt) => {
    if (fs.existsSync(path.join(attempt.path, 'containers.json'))) await captureOwned(attempt);
  });
}

/** Freezes corroborating TEI device observations; approval alone is never device proof. */
export function collectDeviceEvidence(attemptPath: string): void {
  const cfg = loadRecord(path.join(attemptPath, 'settings.yaml'));
  if (cfg.engine !== 'tei') return;
  const strategy = loadRecord(path.join(attemptPath, 'strategy.yaml'));
  const info = asRecord(arrayValue(load(path.join(attemptPath, 'container-backend.json')))[0], 'backend observation');
  const labels = labelsOf(info, 'container');
  if (labels['easy-emb.attempt'] !== cfg.id || labels['easy-emb.strategy'] !== strategy.id || asRecord(info.State).Running !== true || info.Image !== asRecord(loadRecord(path.join(attemptPath, 'images.json')).backend).id) return;
  const logs = fs.readFileSync(path.join(attemptPath, 'container-backend.log'), 'utf8');
  const selected = /Starting \w+ model on (Cpu|Cuda)/.exec(logs);
  let reason: string | undefined;
  let excerpt: string | undefined;
  const sources: Array<{name: string; content: string; excerpt: string}> = [];
  if (selected && (selected[1] === 'Cpu') === (strategy.device === 'cpu')) {
    reason = 'Observed TEI Candle model device in current backend startup log';
    excerpt = selected[0];
  } else if (strategy.device === 'cpu' && !selected) {
    const filename = path.join(attemptPath, 'build-backend.log');
    if (!fs.existsSync(filename)) return;
    const buildLog = fs.readFileSync(filename, 'utf8');
    const cpuSource = stringValue(asRecord(cfg.platform).tei_image);
    const ready = logs.split('\n').find((line) => line.includes('"message":"Ready"'));
    const hostConfig = asRecord(info.HostConfig);
    const requests = hostConfig.DeviceRequests;
    const devices = hostConfig.Devices;
    if (cpuSource.includes(':cpu-') && buildLog.includes(cpuSource) && ready && (requests === null || requests === undefined || arrayValue(requests).length === 0) && (devices === null || devices === undefined || arrayValue(devices).length === 0)) {
      reason = 'Observed CPU artifact, matching running image, no accelerator assignment and completed model warmup; not a direct provider API probe';
      excerpt = ready;
      sources.push({name: 'build.log', content: buildLog, excerpt: cpuSource});
    }
  }
  if (!reason || !excerpt) return;
  const token = digest({container: info.Id, started: asRecord(info.State).StartedAt ?? null, logs}).slice(0, 20);
  sources.push({name: 'startup.log', content: logs, excerpt}, {name: 'container.json', content: JSON.stringify(info, null, 2), excerpt: stringValue(info.Image)});
  const observations: JsonObject[] = [];
  for (const source of sources) {
    const relative = path.join('device-observations', token, source.name);
    fs.mkdirSync(path.dirname(path.join(attemptPath, relative)), {recursive: true});
    fs.writeFileSync(path.join(attemptPath, relative), source.content);
    observations.push({file: relative, digest: digest(source.content), excerpt: source.excerpt});
  }
  save(path.join(attemptPath, 'device-evidence.json'), {attempt_id: cfg.id, device: strategy.device, observed_at: now(), basis: reason, observations});
}

/** Removes only this exact attempt's labeled resources after successful ownership probes. */
export async function stop(attemptPath: string): Promise<JsonObject> {
  return withAttemptExecution(attemptPath, 'stop', async (attempt) => {
    const filename = path.join(attempt.path, 'containers.json');
    if (!fs.existsSync(filename)) return {attempt: attempt.path, state: 'stopped', evidence: 'No containers created'};
    await captureOwned(attempt);
    const containers = checkedContainerNames(attempt);
    const removals: Array<{role: string; id: string}> = [];
    for (const role of ['api', 'backend']) {
      const name = containers[role];
      if (typeof name !== 'string') continue;
      const observed = await inspectDocker('container', name);
      if (observed.status === 'absent') continue;
      const info = inspectionPresent(observed, name);
      resourceIdentity(attempt, role, info);
      removals.push({role, id: stringValue(info.Id, 'owned container ID')});
    }
    if (typeof containers.network === 'string') {
      const observed = await inspectDocker('network', containers.network);
      if (observed.status === 'present') {
        const info = inspectionPresent(observed, containers.network);
        resourceIdentity(attempt, 'network', info);
        removals.push({role: 'network', id: stringValue(info.Id, 'owned network ID')});
      }
    }
    for (const removal of removals) {
      const argv = removal.role === 'network' ? ['docker', 'network', 'rm', removal.id] : ['docker', 'rm', '-f', removal.id];
      await execute(attempt.path, removal.role === 'network' ? 'remove-network' : `stop-${removal.role}`, argv, removal.role === 'network' ? 30 : 60);
    }
    attempt.settings.state = 'stopped';
    save(path.join(attempt.path, 'settings.yaml'), attempt.settings);
    return {attempt: attempt.path, state: 'stopped', evidence: 'retained'};
  });
}
