/** Assesses the existing same-device ST recovery route from immutable local evidence. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {GateError, absolutePath, arrayValue, asRecord, digest, loadRecord, now, sha256Bytes, stringValue} from '../../../harness/common.ts';
import type {JsonObject} from '../../../harness/common.ts';
import {campaignFailures, chooseDtype, runtimeSupport, validateAttemptIdentityForCleanup} from './attempts.ts';
import {backendBuildInputs, nativeAssets} from '../../embedding-upstream/src/recipes.ts';
import type {CheckedAttempt, RuntimeSupport} from './attempts.ts';
import type {NativeAssets} from '../../embedding-upstream/src/recipes.ts';
import {checkedStrategyForCleanup} from './models.ts';
import {selectPlatform} from '../../terraforming-node/src/hardware.ts';
import {validateFrozenSources} from '../../embedding-upstream/src/upstream.ts';
import type {ReleaseSnapshot} from '../../embedding-upstream/src/upstream.ts';

/** Freezes the policy counters at the handoff time, including failed preparations. */
export interface RecoveryBudget {
  maxAttempts: number;
  maxElapsedSeconds: number;
  startedAt: string | null;
  recoveryDecisions: number;
}

/** Names the campaign-local evidence set that must be replayed at the same assessment time. */
export interface RecoveryInputs {
  campaignPath: string;
  cellId: string;
  evaluationId: string | null;
  declarationDigest: string;
  strategyPath: string;
  releaseSnapshotPath: string;
  currentAttempt: string | null;
  cellAttempts: string[];
  relatedAttempts: string[];
  budget: RecoveryBudget;
  recipes?: JsonObject;
  asOf?: string;
}

/** Exposes one renderer-backed route and an evidence-based disposition. */
export interface RecoveryCandidate extends JsonObject {
  id: string;
  engine: 'sentence-transformers';
  device: string;
  dtype: string | null;
  runtime_support: RuntimeSupport;
  status: 'available' | 'attempted_failed' | 'blocked' | 'unsupported';
  reason_codes: string[];
  evidence: JsonObject[];
  retry_options: JsonObject;
  build_inputs_digest: string | null;
}

/** Provides a read-only gate; an untried available candidate cannot be dismissed by prose. */
export interface RecoveryAssessment extends JsonObject {
  schema: 'embedding-recovery-assessment/1';
  assessed_at: string;
  binding: JsonObject;
  candidates: RecoveryCandidate[];
  resolution: {allowed: boolean; reason_codes: string[]; untried_candidate_ids: string[]};
}

interface FailureEvidence {
  attempt: CheckedAttempt;
  failure: JsonObject;
  record: JsonObject;
}

interface CommandEvidence {
  record: JsonObject;
  log: string;
}

interface CandidatePlan {
  snapshot: ReleaseSnapshot;
  platform: JsonObject;
  assets: NativeAssets;
  builder: string | null;
}

interface SharedEvidence {
  accepted: JsonObject[];
  rejected: JsonObject[];
}

function failureArtifact(failure: FailureEvidence, name: string): string | null {
  const artifact = asRecord(failure.failure.artifacts ?? {})[name];
  if (artifact !== undefined) return stringValue(asRecord(artifact).path);
  // Older records remain readable; newly sealed records never depend on mutable logs.
  if (failure.failure.artifacts !== undefined) return null;
  const filename = path.join(failure.attempt.path, name);
  return fs.existsSync(filename) ? filename : null;
}

function fail(message: string): never {
  throw new GateError('RECOVERY_EVIDENCE_INVALID', message);
}

function evidenceFile(filename: string): JsonObject {
  return {path: absolutePath(filename), sha256: sha256Bytes(fs.readFileSync(filename))};
}

function finiteTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${label} is not a valid time.`);
  return parsed;
}

function attemptEvidence(filename: string, input: RecoveryInputs, asOf: string, cellOnly: boolean): CheckedAttempt {
  const attempt = validateAttemptIdentityForCleanup(filename);
  const owner = asRecord(attempt.settings.campaign_owner, 'recovery campaign owner');
  if (absolutePath(stringValue(owner.campaign_path)) !== absolutePath(input.campaignPath) || (cellOnly && owner.cell_id !== input.cellId)) fail('Recovery attempt belongs to another campaign or cell.');
  if (attempt.settings.schema !== 'embedding-attempt/2' || finiteTime(stringValue(attempt.settings.created_at), 'Attempt creation') > finiteTime(asOf, 'Assessment')) fail('Recovery attempt did not exist at the assessment time.');
  if ((attempt.cleanupDrift ?? []).some((item) => item.code !== 'attempt_harness_changed')) fail('Preserved attempt recipe, dependencies or frozen source changed.');
  return attempt;
}

function applicableNativeFailures(attempt: CheckedAttempt, input: RecoveryInputs, asOf: string, upstreamDigest: string): FailureEvidence[] {
  const failures: FailureEvidence[] = [];
  for (const failure of campaignFailures(attempt, asOf)) {
    // Cleanup may replace failure.json; only preserved execution failures can dispose of this route.
    if (!['build', 'serve', 'bench'].includes(String(failure.phase))) continue;
    const operation = asRecord(failure.operation, 'failed campaign operation');
    const source = loadRecord(stringValue(asRecord(failure.evidence).path));
    const inputs = asRecord(operation.inputs ?? {});
    const owner = asRecord(attempt.settings.campaign_owner);
    const startedAt = finiteTime(stringValue(operation.started_at), 'Failure start');
    const finishedAt = finiteTime(stringValue(source.finished_at), 'Failure finish');
    if (operation.phase !== failure.phase || inputs.schema !== 'embedding-campaign-operation-inputs/1' || inputs.campaign_path !== absolutePath(input.campaignPath) ||
        inputs.cell_id !== owner.cell_id || inputs.evaluation_id !== input.evaluationId || inputs.declaration_digest !== input.declarationDigest ||
        inputs.strategy_id !== attempt.strategy.id || inputs.receipt_identity !== attempt.receiptIdentity ||
        inputs.attempt !== attempt.path || asRecord(inputs.upstream ?? {}).digest !== upstreamDigest ||
        attempt.settings.source_snapshot_digest !== upstreamDigest || startedAt < finiteTime(stringValue(attempt.settings.created_at), 'Attempt creation') ||
        finishedAt < startedAt || finishedAt > finiteTime(asOf, 'Assessment') || failure.interrupted_before_worker === true) continue;
    failures.push({attempt, failure, record: {kind: 'bound_campaign_failure', attempt: attempt.path,
      input_identity: attempt.settings.input_identity, failure_digest: digest(failure), evidence: failure.evidence,
      operation_id: operation.operation_id, invocation_id: operation.invocation_id, phase: failure.phase,
      receipt_identity: attempt.receiptIdentity, evidence_kind: attempt.settings.evidence_kind}});
  }
  return failures;
}

function failedRuntimeCommand(failure: FailureEvidence, events: JsonObject[], filename: string, finish: number): CommandEvidence | null {
  if (!['serve', 'bench'].includes(String(failure.failure.phase))) return null;
  const operationStart = stringValue(asRecord(failure.failure.operation).started_at);
  const start = finiteTime(failure.failure.phase === 'bench' ? stringValue(failure.attempt.settings.created_at) : operationStart, 'Runtime start');
  const relevant = events.filter((entry) => typeof entry.at === 'string' && finiteTime(entry.at, 'Runtime event') >= start && finiteTime(entry.at, 'Runtime event') <= finish);
  const started = relevant.find((entry) => entry.event === 'command_started' && ['start-api', 'start-backend'].includes(String(entry.phase)));
  if (!started || arrayValue(started.argv)[0] !== 'docker') return null;
  const ended = relevant.find((entry) => entry.event === 'command_finished' && entry.phase === started.phase && String(entry.at) >= String(started.at) && entry.returncode === 0 && entry.timed_out === false);
  if (!ended) return null;
  for (const name of ['container-api.log', 'container-backend.log']) {
    const logPath = failureArtifact(failure, name);
    if (logPath !== null && fs.statSync(logPath).size > 0) return {record: {kind: 'failed_native_runtime', events_path: filename, started, finished: ended, log: evidenceFile(logPath)}, log: fs.readFileSync(logPath, 'utf8')};
  }
  return null;
}

function commandEvidence(failure: FailureEvidence, buildOnly = false): CommandEvidence | null {
  const operation = asRecord(failure.failure.operation);
  const source = loadRecord(stringValue(asRecord(failure.failure.evidence).path));
  const start = finiteTime(stringValue(operation.started_at), 'Operation start');
  const finish = finiteTime(stringValue(source.finished_at), 'Operation finish');
  const filename = failureArtifact(failure, 'events.jsonl');
  if (filename === null) return null;
  const events = fs.readFileSync(filename, 'utf8').split('\n').filter((line) => line.trim()).map((line) => asRecord(JSON.parse(line)));
  const relevant = events.filter((entry) => typeof entry.at === 'string' && finiteTime(entry.at, 'Command event') >= start && finiteTime(entry.at, 'Command event') <= finish);
  for (const ended of relevant.filter((entry) => entry.event === 'command_finished' && (!buildOnly || entry.timed_out === false) && typeof entry.returncode === 'number' && entry.returncode !== 0)) {
    const phase = stringValue(ended.phase);
    if (buildOnly ? phase !== 'build-backend' : !['build-backend', 'start-api', 'start-backend'].includes(phase)) continue;
    const starts = relevant.filter((entry) => entry.event === 'command_started' && entry.phase === phase && String(entry.at) <= String(ended.at));
    const started = starts.at(-1);
    if (!started) continue;
    const argv = arrayValue(started.argv).map((item) => stringValue(item));
    if (argv[0] !== 'docker') continue;
    const logPath = failureArtifact(failure, `${phase}.log`);
    if (logPath === null || ended.log !== path.join(failure.attempt.path, `${phase}.log`) || fs.statSync(logPath).size === 0) continue;
    if (phase === 'build-backend') {
      const recipe = digest(backendBuildInputs(failure.attempt.path)).slice(0, 16);
      const expected = ['docker', 'buildx', 'build', '--load', '--progress=plain', '--label', `easy-emb.recipe=${recipe}`, '--label', 'easy-emb.project=easy_emb_server'];
      const builder = failure.attempt.settings.builder;
      if (typeof builder === 'string') expected.push('--builder', builder);
      expected.push('-t', `easy-emb-backend:${recipe}`, '-f', path.join(failure.attempt.path, 'Dockerfile'), failure.attempt.path);
      if (digest(argv) !== digest(expected)) continue;
    }
    return {record: {kind: 'failed_native_command', events_path: filename, started, finished: ended, log: evidenceFile(logPath)}, log: fs.readFileSync(logPath, 'utf8')};
  }
  return buildOnly ? null : failedRuntimeCommand(failure, events, filename, finish);
}

function missingFrozenDistribution(log: string, requirements: string): string | null {
  if (/ReadTimeout|ConnectTimeout|Connection(?:Error|Reset|Aborted)|NewConnectionError|NameResolutionError|Temporary failure|Max retries exceeded|(?:connection|operation|read|request) timed out|SSLError|SSLEOFError|\bEOF\b|IncompleteRead|ProtocolError|connection (?:broken|refused|reset|aborted)|network is unreachable|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout|TLS handshake|CERTIFICATE_VERIFY_FAILED|Could not fetch URL|proxy error/i.test(log)) return null;
  const matches = [...log.matchAll(/ERROR: No matching distribution found for ([A-Za-z0-9_.-]+)==([^\s)]+)/g)];
  const pins = new Set([...requirements.matchAll(/^([A-Za-z0-9_.-]+)==([^\s\\]+)/gm)].map((match) => `${match[1]?.toLowerCase().replaceAll('_', '-')}==${match[2]}`));
  const indices = [...requirements.matchAll(/^--(?:extra-)?index-url(?:=|\s+)(\S+)/gm)].map((match) => stringValue(match[1]).replace(/\/$/, ''));
  const observedIndices = /Looking in indexes:\s*([^\n]+)/.exec(log)?.[1];
  if (indices.length > 0 && (!observedIndices || indices.some((index) => !observedIndices.includes(index)))) return null;
  for (const match of matches) {
    const pin = `${match[1]?.toLowerCase().replaceAll('_', '-')}==${match[2]}`;
    if (pins.has(pin) && log.includes(`Could not find a version that satisfies the requirement ${match[1]}==${match[2]}`)) return pin;
  }
  return null;
}

function budgetEvidence(input: RecoveryInputs, attempts: CheckedAttempt[], asOf: string): JsonObject | null {
  const budget = input.budget;
  if (![budget.maxAttempts, budget.recoveryDecisions].every((value) => Number.isSafeInteger(value)) || budget.maxAttempts <= 0 || budget.recoveryDecisions < 0 || !Number.isFinite(budget.maxElapsedSeconds) || budget.maxElapsedSeconds <= 0) fail('Recovery budget must contain positive finite limits and nonnegative counters.');
  const maximumAttempts = Math.min(8, budget.maxAttempts);
  const maximumSeconds = Math.min(14_400, budget.maxElapsedSeconds);
  const assessmentTime = finiteTime(asOf, 'Assessment');
  const starts = attempts.map((attempt) => finiteTime(stringValue(asRecord(attempt.settings.recovery ?? {}).started_at ?? attempt.settings.created_at), 'Recovery lineage start'));
  if (budget.startedAt !== null) starts.push(finiteTime(budget.startedAt, 'Campaign cell start'));
  if (starts.some((start) => start > assessmentTime)) fail('Recovery starts after the assessment time.');
  const elapsed = starts.length ? (assessmentTime - Math.min(...starts)) / 1000 : 0;
  if (attempts.length >= maximumAttempts || budget.recoveryDecisions >= maximumAttempts || elapsed >= maximumSeconds) {
    return {kind: 'finite_recovery_budget', attempts: attempts.length, recovery_decisions: budget.recoveryDecisions,
      max_attempts: maximumAttempts, elapsed_seconds: elapsed, max_elapsed_seconds: maximumSeconds, assessed_at: asOf};
  }
  return null;
}

function classifiedError(error: unknown): JsonObject {
  if (!(error instanceof Error)) throw error;
  return {kind: 'renderer_gate', code: error instanceof GateError ? error.code : 'RECOVERY_INPUT_UNAVAILABLE', message: error.message};
}

function currentAttempt(attempts: CheckedAttempt[], input: RecoveryInputs, receiptIdentity: string): CheckedAttempt | null {
  if (input.currentAttempt === null) return null;
  const selected = attempts.find((attempt) => attempt.path === absolutePath(stringValue(input.currentAttempt)));
  if (!selected || selected.receiptIdentity !== receiptIdentity || absolutePath(stringValue(selected.settings.strategy_path)) !== absolutePath(input.strategyPath)) fail('The current recovery attempt belongs to another approval receipt.');
  return selected;
}

function candidatePlan(input: RecoveryInputs, strategy: JsonObject, manifest: JsonObject, current: CheckedAttempt | null, candidate: RecoveryCandidate, assessment: RecoveryAssessment): CandidatePlan {
  const snapshot = validateFrozenSources(loadRecord(input.releaseSnapshotPath));
  assessment.binding.upstream = {path: absolutePath(input.releaseSnapshotPath), digest: digest(snapshot), sha256: sha256Bytes(fs.readFileSync(input.releaseSnapshotPath))};
  if (snapshot.observed_architecture !== asRecord(asRecord(manifest.host).architecture).value) throw new GateError('upstream_architecture_mismatch', 'Frozen dependencies target another observed architecture.');
  const platform = selectPlatform(manifest, stringValue(strategy.device), snapshot.platforms);
  if (platform.status === 'adapter_required') throw new GateError('platform_adapter_required', stringValue(platform.reason));
  const assets = nativeAssets({engine: 'sentence-transformers', platform}, snapshot, input.recipes);
  const builder = typeof current?.settings.builder === 'string' ? current.settings.builder : null;
  candidate.dtype = current?.settings.engine === 'sentence-transformers' ? stringValue(current.settings.dtype) : chooseDtype(strategy, 'sentence-transformers');
  candidate.retry_options.dtype = candidate.dtype;
  if (builder !== null) candidate.retry_options.builder = builder;
  candidate.build_inputs_digest = digest(assets.backendInputs);
  return {snapshot, platform, assets, builder};
}

function previousStFailure(failures: FailureEvidence[], candidate: RecoveryCandidate, plan: CandidatePlan): JsonObject[] | null {
  for (const failure of failures) {
    if (failure.attempt.settings.engine !== 'sentence-transformers' || (failure.attempt.settings.builder ?? null) !== plan.builder) continue;
    if (digest(backendBuildInputs(failure.attempt.path)) !== candidate.build_inputs_digest) continue;
    if (failure.failure.phase !== 'build' && failure.attempt.settings.dtype !== candidate.dtype) continue;
    const command = commandEvidence(failure);
    if (command) return [failure.record, command.record];
  }
  return null;
}

function sharedBuildFailure(input: RecoveryInputs, asOf: string, cellPaths: string[], manifest: JsonObject, candidate: RecoveryCandidate, plan: CandidatePlan): SharedEvidence {
  const upstreamDigest = digest(plan.snapshot);
  const rejected: JsonObject[] = [];
  for (const filename of [...new Set(input.relatedAttempts.map((entry) => absolutePath(entry)))].toSorted()) {
    if (cellPaths.includes(filename)) continue;
    try {
      const raw = loadRecord(path.join(filename, 'settings.yaml'));
      if (raw.engine !== 'sentence-transformers' || raw.source_snapshot_digest !== upstreamDigest || asRecord(raw.platform).id !== plan.platform.id || (raw.builder ?? null) !== plan.builder || digest(backendBuildInputs(filename)) !== candidate.build_inputs_digest) continue;
      const attempt = attemptEvidence(filename, input, asOf, false);
      if (attempt.settings.evidence_kind !== manifest.evidence_kind && (attempt.settings.evidence_kind === 'mock' || manifest.evidence_kind === 'mock')) continue;
      for (const failure of applicableNativeFailures(attempt, input, asOf, upstreamDigest)) {
        if (failure.failure.phase !== 'build' || failure.failure.interrupted === true || asRecord(failure.failure.error).code !== 'attempt_command_failed') continue;
        const command = commandEvidence(failure, true);
        if (!command) continue;
        const pin = missingFrozenDistribution(command.log, stringValue(plan.assets.dependencies['requirements.backend.txt']));
        if (!pin) continue;
        return {accepted: [failure.record, command.record,
          {kind: 'identical_frozen_build_inputs', digest: candidate.build_inputs_digest, upstream_digest: upstreamDigest,
            requirement: pin, dependency_locks: plan.assets.dependencyLocks, source_attempt: attempt.path, builder: plan.builder,
            applicability: 'This same-evaluation frozen build failed before model loading; new frozen inputs or a new concrete observation are needed.'}], rejected};
      }
    } catch (error: unknown) {
      rejected.push({attempt: filename, ...classifiedError(error)});
    }
  }
  return {accepted: [], rejected};
}

/** Evaluates only locally preserved evidence, never a device or network probe. */
export function assessRecovery(input: RecoveryInputs): RecoveryAssessment {
  const asOf = input.asOf ?? now();
  finiteTime(asOf, 'Assessment');
  const checked = checkedStrategyForCleanup(input.strategyPath);
  const strategy = checked.strategy;
  const manifest = checked.manifest;
  const cellPaths = [...new Set(input.cellAttempts.map((filename) => absolutePath(filename)))].toSorted();
  if (cellPaths.length !== input.cellAttempts.length || (input.currentAttempt !== null && !cellPaths.includes(absolutePath(input.currentAttempt)))) fail('The current attempt and unique cell history must agree.');
  const attempts = cellPaths.map((filename) => attemptEvidence(filename, input, asOf, true));
  const current = currentAttempt(attempts, input, checked.receiptIdentity);
  const approvedAttempts = attempts.filter((attempt) => attempt.receiptIdentity === checked.receiptIdentity && digest(attempt.strategy.model_fingerprint) === digest(strategy.model_fingerprint));
  const support = runtimeSupport(strategy);
  const assessment: RecoveryAssessment = {schema: 'embedding-recovery-assessment/1', assessed_at: asOf,
    binding: {campaign_path: absolutePath(input.campaignPath), cell_id: input.cellId, evaluation_id: input.evaluationId,
      declaration_digest: input.declarationDigest, strategy_path: absolutePath(input.strategyPath), strategy_id: strategy.id,
      receipt_identity: checked.receiptIdentity, model_fingerprint_digest: digest(strategy.model_fingerprint),
      current_attempt: input.currentAttempt === null ? null : absolutePath(input.currentAttempt),
      attempt_input_identities: attempts.map((attempt) => ({path: attempt.path, input_identity: attempt.settings.input_identity})),
      budget: {...input.budget}, recipes_digest: digest(input.recipes ?? {})},
    candidates: [], resolution: {allowed: true, reason_codes: [], untried_candidate_ids: []}};
  const candidate: RecoveryCandidate = {id: 'same-device-sentence-transformers', engine: 'sentence-transformers',
    device: stringValue(strategy.device), dtype: current ? stringValue(current.settings.dtype) : null,
    runtime_support: support, status: 'available', reason_codes: [], evidence: [],
    retry_options: {engine: 'sentence-transformers', requires: ['reason', 'hypothesis', 'change']}, build_inputs_digest: null};
  const finish = (status: RecoveryCandidate['status'], code: string, evidence: JsonObject[] = [], allowed = status !== 'available'): RecoveryAssessment => {
    candidate.status = status;
    candidate.reason_codes = [code];
    candidate.evidence.push(...evidence);
    assessment.candidates = [candidate];
    assessment.resolution = {allowed, reason_codes: [code], untried_candidate_ids: allowed ? [] : [candidate.id]};
    return assessment;
  };
  const exhausted = budgetEvidence(input, attempts, asOf);
  if (support.status === 'adapter_required') return finish('unsupported', 'MODEL_ADAPTER_REQUIRED');
  if (exhausted) return finish('blocked', 'RECOVERY_BUDGET_EXHAUSTED', [exhausted]);
  let plan: CandidatePlan;
  try {
    plan = candidatePlan(input, strategy, manifest, current, candidate, assessment);
  } catch (error: unknown) {
    return finish('blocked', 'FROZEN_RENDER_INPUT_UNAVAILABLE', [classifiedError(error)]);
  }
  const upstreamDigest = digest(plan.snapshot);
  const failures = approvedAttempts.flatMap((attempt) => applicableNativeFailures(attempt, input, asOf, upstreamDigest));
  const teiFailure = failures.find((failure) => failure.attempt.settings.engine === 'tei' && ['build', 'serve', 'bench'].includes(String(failure.failure.phase)) && ['build-backend.log', 'start-backend.log', 'container-backend.log'].some((name) => {
    const filename = failureArtifact(failure, name);
    return filename !== null && fs.statSync(filename).size > 0;
  }));
  if (!teiFailure) {
    if (!approvedAttempts.some((attempt) => attempt.settings.engine === 'tei')) {
      assessment.resolution.reason_codes = ['NO_TEI_FALLBACK_IN_SCOPE'];
      return assessment;
    }
    return finish('blocked', 'TEI_FAILURE_EVIDENCE_REQUIRED');
  }
  candidate.evidence.push(teiFailure.record);
  const previous = previousStFailure(failures, candidate, plan);
  if (previous) return finish('attempted_failed', 'SAME_DEVICE_ST_ALREADY_FAILED', previous);
  const shared = sharedBuildFailure(input, asOf, cellPaths, manifest, candidate, plan);
  if (shared.accepted.length) return finish('blocked', 'SHARED_FROZEN_DEPENDENCY_UNAVAILABLE', shared.accepted);
  if (shared.rejected.length) candidate.rejected_evidence = shared.rejected;
  return finish('available', 'SAME_DEVICE_ST_UNTRIED');
}
