/** Model metadata and approval receipts. No model weights are loaded for inference here. */
import {existsSync, readFileSync, realpathSync} from 'node:fs';
import {basename, isAbsolute, join, relative, resolve} from 'node:path';
import {homedir} from 'node:os';
import {GateError, ROOT, absolutePath, arrayValue, asRecord, digest, integerValue, load, loadRecord, now, omitRecordKeys, optionalString, parseJson, save, sha256Bytes, stringValue} from '../../../harness/common.ts';
import type {JsonObject} from '../../../harness/common.ts';
import {fingerprintModel} from './model-fingerprint.ts';
import type {ModelFingerprint} from './model-fingerprint.ts';
import {parseManifest} from '../../terraforming-node/src/hardware.ts';

/** The only human-owned serving-device axis. */
export type Device = 'cpu' | 'gpu';

/** A declared sentence-transformers processing module. */
export interface ModelModule extends JsonObject { path: string; type: string; }

/** Inspected recommendations are evidence, not permission to choose a strategy. */
export interface ModelProfile extends JsonObject {
  schema: string;
  model: string;
  path: string;
  inspected_at: string;
  fingerprint: ModelFingerprint;
  model_type: string | null;
  modules: ModelModule[];
  pooling: string | null;
  checkpoint_dtype: string | null;
  recommended_context_window: number | null;
  native_dimensions: number | null;
  reduction: JsonObject;
  prompts: JsonObject;
  default_input_type: string | null;
  normalize: boolean;
  layer_norm_before_truncate: boolean;
  requires_model_adapter: string | null;
  source: JsonObject;
}

/** Schema-1 disk spelling is retained so historical receipts remain verifiable. */
export interface Strategy extends JsonObject {
  schema: string;
  id: string;
  approved_at: string;
  approval_reference: string;
  model: string;
  model_path: string;
  model_fingerprint: ModelFingerprint;
  manifest_path: string;
  manifest_source_path: string;
  manifest_digest: string;
  device: Device;
  context_window: number;
  dimensions: number;
  native_dimensions: number;
  api: string;
  input_policy: string;
  engine_policy: string;
  profile: ModelProfile;
}

/** Options must describe choices actually made by the user. */
export interface ApprovalOptions {
  model: string;
  manifest: string;
  device: string;
  contextWindow: number;
  dimensions: string | number;
  approvalReference: string;
  output: string;
}

/** A persisted strategy reference, not an inference success result. */
export interface StrategyReference {
  strategy: string;
  id: string;
  device: Device;
  context_window: number;
  dimensions: number;
}

/** Includes source evidence identity separately from the unchanged legacy strategy ID. */
export interface CheckedStrategy {
  strategy: Strategy;
  manifest: JsonObject;
  receiptIdentity: string;
}

function readRecordIfPresent(path: string): JsonObject { return existsSync(path) ? loadRecord(path) : {}; }
function positiveOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null; }
function nullableString(value: unknown): string | null { return value === undefined || value === null ? null : stringValue(value); }

function modelModules(value: unknown): ModelModule[] {
  return arrayValue(value, 'modules').map((item) => {
    const module = asRecord(item, 'ST module');
    const path = stringValue(module.path, 'module.path');
    const type = stringValue(module.type, 'module.type');
    if (isAbsolute(path) || path.split(/[\\/]/u).includes('..')) throw new GateError('INVALID_MODEL_METADATA', 'Model module paths must stay in the model directory.');
    return {...module, path, type};
  });
}

/** Inspects native dimensions, prompts, modules and documented context without importing model code. */
export function inspectModel(model: string): ModelProfile {
  const root = realpathSync(model);
  const config = loadRecord(join(root, 'config.json'));
  const text = config.text_config === undefined ? config : asRecord(config.text_config, 'text_config');
  const st = readRecordIfPresent(join(root, 'config_sentence_transformers.json'));
  const transformer = readRecordIfPresent(join(root, 'sentence_bert_config.json'));
  const tokenizer = readRecordIfPresent(join(root, 'tokenizer_config.json'));
  const modules = existsSync(join(root, 'modules.json')) ? modelModules(load(join(root, 'modules.json'))) : [];
  let dimension = positiveOrNull(text.embedding_dim ?? text.hidden_size ?? text.n_embd);
  let pooling: string | null = null;
  for (const module of modules) {
    const directory = join(root, module.path);
    if (existsSync(directory) && relative(root, realpathSync(directory)).split(/[\\/]/u).includes('..')) throw new GateError('INVALID_MODEL_METADATA', 'A model module symlink escapes its model directory.');
    const settings = readRecordIfPresent(join(directory, 'config.json'));
    if (module.type.endsWith('Pooling')) {
      dimension = positiveOrNull(settings.word_embedding_dimension) ?? dimension;
      for (const [name, flag] of [['mean', 'pooling_mode_mean_tokens'], ['cls', 'pooling_mode_cls_token'], ['last-token', 'pooling_mode_lasttoken']]) {
        if (flag && settings[flag] === true) { pooling = name ?? null; break; }
      }
    }
    if (module.type.endsWith('Dense')) dimension = positiveOrNull(settings.out_features) ?? dimension;
  }
  const lengths: JsonObject = {
    'sentence_bert_config.json:max_seq_length': transformer.max_seq_length ?? null,
    'tokenizer_config.json:model_max_length': tokenizer.model_max_length ?? null,
    'config.json:text.max_position_embeddings': text.max_position_embeddings ?? null,
  };
  const defaults = asRecord(loadRecord(join(ROOT, 'config/model_defaults.yaml'))[basename(root)] ?? {});
  let context = positiveOrNull(defaults.context_window) ?? positiveOrNull(transformer.max_seq_length);
  if (context === null) {
    const candidates = Object.values(lengths).filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < 1_000_000);
    context = candidates.length > 0 ? Math.min(...candidates) : null;
  }
  dimension = positiveOrNull(defaults.native_dimensions) ?? dimension;
  const prompts = asRecord(defaults.prompts ?? st.prompts ?? {}, 'prompts');
  for (const value of Object.values(prompts)) stringValue(value, 'prompt');
  return {
    schema: 'embedding-model/1', model: basename(root), path: root, inspected_at: now(), fingerprint: fingerprintModel(root),
    architecture: config.architectures ?? null, model_type: nullableString(config.model_type), modules, pooling,
    checkpoint_dtype: nullableString(text.dtype ?? text.torch_dtype ?? config.torch_dtype), context_candidates: lengths,
    recommended_context_window: context, native_dimensions: dimension,
    reduction: asRecord(defaults.reduction ?? {supported: false, reason: 'No confirmed model recommendation; retain native.'}), prompts,
    default_input_type: nullableString(defaults.default_input_type ?? ('query' in prompts ? 'query' : null)),
    normalize: defaults.normalize === undefined ? modules.some(module => module.type.endsWith('Normalize')) : defaults.normalize === true,
    layer_norm_before_truncate: defaults.layer_norm_before_truncate === true,
    requires_model_adapter: nullableString(defaults.requires_model_adapter),
    source: {files: ['config.json', 'modules.json', 'README.md'].map(name => join(root, name)).filter(path => existsSync(path)), curated: defaults.source ?? null, settings_without_recommendation: 'engine default; validate at runtime'},
  };
}

function checkedDevice(value: unknown): Device {
  if (value !== 'cpu' && value !== 'gpu') throw new GateError('INVALID_INPUT', 'Device must be cpu or gpu.');
  return value;
}

function checkChoices(profile: ModelProfile, device: unknown, context: unknown, dimensions: unknown): {device: Device; context: number; dimensions: number} {
  const selectedDevice = checkedDevice(device);
  const selectedContext = integerValue(context, 'context_window');
  if (selectedContext <= 0 || profile.recommended_context_window === null || selectedContext > profile.recommended_context_window) {
    throw new GateError('APPROVAL_SCOPE_CHANGED', 'Input limit lacks model recommendation/support evidence.', {nextAction: 'human_input_required'});
  }
  const native = profile.native_dimensions;
  const selectedDimensions = dimensions === 'native' ? native : typeof dimensions === 'string' && /^\d+$/u.test(dimensions) ? Number(dimensions) : dimensions;
  if (native === null || typeof selectedDimensions !== 'number' || !Number.isSafeInteger(selectedDimensions) || selectedDimensions <= 0 || selectedDimensions > native) throw new GateError('APPROVAL_SCOPE_CHANGED', 'Output dimension must be known and within model capacity.', {nextAction: 'human_input_required'});
  if (selectedDimensions !== native) {
    const reduction = profile.reduction;
    const choices = Array.isArray(reduction.choices) ? reduction.choices : [];
    const inRange = typeof reduction.min === 'number' && typeof reduction.max === 'number' && reduction.min <= selectedDimensions && selectedDimensions <= reduction.max;
    if (reduction.supported !== true || (!choices.includes(selectedDimensions) && !inRange)) throw new GateError('APPROVAL_SCOPE_CHANGED', 'Dimension reduction is not supported by model evidence.', {nextAction: 'human_input_required'});
  }
  return {device: selectedDevice, context: selectedContext, dimensions: selectedDimensions};
}

/** Validates the exact preserved user message referenced by an approval selection. */
export function validateUserSource(value: unknown): JsonObject {
  const source = asRecord(value, 'user message source');
  const path = absolutePath(stringValue(source.path, 'source.path'));
  const line = integerValue(source.line, 'source.line');
  if (line < 1) throw new GateError('APPROVAL_PROVENANCE_INVALID', 'Source lines are one-based.');
  const lines = readFileSync(path, 'utf8').split('\n');
  const raw = lines[line - 1];
  if (!raw || sha256Bytes(raw) !== source.sha256) throw new GateError('APPROVAL_PROVENANCE_INVALID', 'The actual user-message source is missing or changed.');
  const envelope = asRecord(parseJson(raw));
  const message = asRecord(envelope.payload ?? envelope);
  if (message.role !== 'user' || message.type !== 'message') throw new GateError('APPROVAL_PROVENANCE_INVALID', 'Approval source must be a user message, not a tool or assistant statement.');
  const body = arrayValue(message.content).map(item => stringValue(asRecord(item).text)).join('\n');
  const quote = stringValue(source.quote, 'source.quote');
  if (!quote.trim() || !body.includes(quote)) throw new GateError('APPROVAL_PROVENANCE_INVALID', 'Approval quote does not occur in the actual user message.');
  if (source.evidence_kind === 'mock') return {path, line, sha256: source.sha256, quote, evidence_kind: 'mock'};
  if (source.evidence_kind !== undefined && source.evidence_kind !== 'measured') throw new GateError('APPROVAL_PROVENANCE_INVALID', 'Unknown user-source evidence kind.');
  const codexDirectory = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const allowedRoots = ['sessions', 'archived_sessions'].map(name => join(codexDirectory, name)).filter(directory => existsSync(directory)).map(directory => realpathSync(directory));
  const insideSessionStore = allowedRoots.some(directory => {
    const child = relative(directory, path);
    return child.length > 0 && child !== '..' && !child.startsWith('../') && !isAbsolute(child);
  });
  if (!insideSessionStore || !path.endsWith('.jsonl')) throw new GateError('APPROVAL_PROVENANCE_INVALID', 'Production approval sources must be actual canonical Codex session or archived-session files.');
  const sessionIds: string[] = [];
  for (const [index, text] of lines.entries()) {
    if (!text.trim()) continue;
    let item: JsonObject;
    try { item = asRecord(parseJson(text)); }
    catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      if (index === lines.length - 1) continue;
      throw new GateError('APPROVAL_PROVENANCE_INVALID', 'Actual session contains a malformed nonfinal record.');
    }
    if (item.type === 'session_meta') sessionIds.push(stringValue(asRecord(item.payload).id, 'actual session ID'));
  }
  const sessionId = sessionIds[0];
  if (!sessionId || sessionIds.some(id => id !== sessionId) || !basename(path).endsWith(`${sessionId}.jsonl`)) {
    throw new GateError('APPROVAL_PROVENANCE_INVALID', 'User source lacks matching actual session metadata and filename identity.');
  }
  return {path, line, sha256: source.sha256, quote, session_id: sessionId};
}

function legacyAuthorization(receipt: JsonObject): string {
  const index = loadRecord(join(ROOT, 'config/legacy-approvals.json'));
  if (index.schema !== 'embedding-legacy-approval-index/1') throw new GateError('APPROVAL_PROVENANCE_INVALID', 'Unknown historical approval index.');
  const receiptDigest = digest(receipt);
  const match = arrayValue(index.receipts).map(item => asRecord(item)).find(item => item.receipt_id === receipt.id && item.receipt_digest === receiptDigest);
  if (!match || !/^[a-f0-9]{64}$/u.test(stringValue(match.authorization_sha256))) {
    throw new GateError('APPROVAL_PROVENANCE_INVALID', 'This receipt is not an original indexed historical approval; new approvals require actual ordered user-message sources.');
  }
  return stringValue(match.authorization_sha256);
}

function approvalEvidence(reference: string, target: {model: string; model_path: string; device: Device; context_window: number; dimensions: number; native_dimensions: number; profile: ModelProfile}, manifestIsMock: boolean, historicalAuthorizationHash?: string): JsonObject {
  if (!reference.trim()) throw new GateError('APPROVAL_PROVENANCE_INVALID', 'A structured actual user approval is required.');
  const referenceRecord = reference.trimStart().startsWith('{') ? asRecord(parseJson(reference), 'approval reference') : null;
  const sourcePath = absolutePath(referenceRecord ? stringValue(referenceRecord.source) : reference.split(';')[0]?.trim() ?? '');
  const authorization = loadRecord(sourcePath);
  const sourceDigest = sha256Bytes(readFileSync(sourcePath));
  if (historicalAuthorizationHash && historicalAuthorizationHash !== sourceDigest) throw new GateError('APPROVAL_PROVENANCE_INVALID', 'The indexed original historical authorization bytes changed.');
  if (authorization.schema === 'embedding-user-approval/1') {
    if (absolutePath(stringValue(authorization.model_path)) !== target.model_path) throw new GateError('APPROVAL_PROVENANCE_INVALID', 'Approval source targets another model.');
    const selections = arrayValue(authorization.selections, 'selections');
    const expected = [{key: 'device', value: target.device}, {key: 'context_window', value: target.context_window}, {key: 'dimensions', value: target.dimensions}];
    if (selections.length !== expected.length) throw new GateError('APPROVAL_PROVENANCE_INVALID', 'Exactly three ordered human selections are required.');
    const sources = expected.map((choice, index) => {
      const selection = asRecord(selections[index]);
      const value = choice.key === 'dimensions' && selection.value === 'native' ? target.native_dimensions : selection.value;
      if (selection.key !== choice.key || value !== choice.value) throw new GateError('APPROVAL_PROVENANCE_INVALID', 'Approval selections must match device → context → dimensions.');
      return validateUserSource(selection.source);
    });
    if (manifestIsMock || authorization.evidence_kind === 'mock' || sources.some(source => source.evidence_kind === 'mock')) {
      if (!manifestIsMock || authorization.evidence_kind !== 'mock' || sources.some(source => source.evidence_kind !== 'mock')) {
        throw new GateError('APPROVAL_PROVENANCE_INVALID', 'Synthetic approvals require explicit mock sources, mock authorization and mock manifest together.');
      }
      return {path: sourcePath, sha256: sourceDigest, kind: 'mock-user-message-selections', evidence_kind: 'mock', sources};
    }
    return {path: sourcePath, sha256: sourceDigest, kind: 'user-message-selections', sources};
  }
  if (!historicalAuthorizationHash || historicalAuthorizationHash !== sourceDigest) throw new GateError('APPROVAL_PROVENANCE_INVALID', 'New or modified historical authorizations are not accepted; preserve the indexed originals.');
  // Existing authorized matrix/delegation artifacts are checked, not converted into new approvals.
  const sourceCommit = optionalString(authorization.source_commit);
  if (!sourceCommit || !/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new GateError('APPROVAL_PROVENANCE_INVALID', 'Legacy approval lacks its source commit.');
  if (Array.isArray(authorization.matrix)) {
    const messages = arrayValue(authorization.user_messages).map(item => stringValue(item));
    const matching = authorization.matrix.map(item => asRecord(item)).find(row => row.model === target.model);
    if (messages.length === 0 || messages.some(message => !message.trim()) || !matching || !arrayValue(matching.devices).includes(target.device) || matching.context_window !== target.context_window || matching.native_dimensions !== target.dimensions) {
      throw new GateError('APPROVAL_PROVENANCE_INVALID', 'Historical approval matrix does not authorize this model/device/context/dimension tuple.');
    }
  } else {
    const quote = stringValue(authorization.user_request_verbatim, 'historical user request');
    const order = arrayValue(authorization.selection_order).map(item => stringValue(item));
    const selected = arrayValue(authorization.selected_models);
    if (!quote.trim() || !referenceRecord || referenceRecord.user_request !== quote || !selected.includes(target.model) || order.length !== 3 || !order[0]?.startsWith('device: both cpu and gpu') || !order[1]?.startsWith('context_window: local model recommended default') || !order[2]?.startsWith('dimensions: native default') || target.context_window !== target.profile.recommended_context_window || target.dimensions !== target.native_dimensions || referenceRecord.resolved_device !== target.device || referenceRecord.resolved_context_window !== target.context_window || referenceRecord.resolved_dimensions !== 'native') {
      throw new GateError('APPROVAL_PROVENANCE_INVALID', 'Historical delegation does not match this resolved strategy.');
    }
  }
  return {path: sourcePath, sha256: sourceDigest, kind: 'historical-user-authorization', source_commit: sourceCommit, trust_boundary: 'Preserved operator record; file hashes establish integrity, not adversarial same-user authentication.'};
}

/** Persists only an evidenced three-axis human decision; execution permission alone is insufficient. */
export function approve(options: ApprovalOptions): StrategyReference {
  const profile = inspectModel(options.model);
  const choices = checkChoices(profile, options.device, options.contextWindow, options.dimensions);
  if (profile.native_dimensions === null) throw new GateError('INVALID_MODEL_METADATA', 'Native dimension is unknown.');
  const target = {model: profile.model, model_path: profile.path, device: choices.device, context_window: choices.context, dimensions: choices.dimensions, native_dimensions: profile.native_dimensions, profile};
  const manifest = parseManifest(loadRecord(options.manifest));
  if (manifest.schema !== 'embedding-manifest/1') throw new GateError('INVALID_INPUT', 'A measured embedding-manifest/1 is required.');
  const evidence = approvalEvidence(options.approvalReference, target, manifest.evidence_kind === 'mock');
  const manifestDigest = digest(manifest);
  const snapshot = resolve(options.output, 'host/manifests', `${manifestDigest}.yaml`);
  if (existsSync(snapshot) && digest(loadRecord(snapshot)) !== manifestDigest) throw new GateError('MANIFEST_TAMPERED', 'Existing immutable host snapshot changed.');
  if (!existsSync(snapshot)) save(snapshot, manifest);
  const strategy: JsonObject = {schema: 'embedding-strategy/1', approved_at: now(), approval_reference: options.approvalReference, approval_evidence: evidence, ...target,
    model_fingerprint: profile.fingerprint, manifest_path: snapshot, manifest_source_path: absolutePath(options.manifest), manifest_digest: manifestDigest,
    api: '/v1/embeddings', input_policy: 'reject_over_limit', engine_policy: 'tei_first_then_sentence_transformers_same_device'};
  if (evidence.evidence_kind === 'mock') strategy.evidence_kind = 'mock';
  const id = digest(strategy).slice(0, 16);
  strategy.id = id;
  const path = resolve(options.output, profile.model, 'strategies', `${id}.yaml`);
  if (existsSync(path)) throw new GateError('RECEIPT_EXISTS', 'Never overwrite an existing approval receipt.');
  save(path, strategy);
  return {strategy: path, id, device: choices.device, context_window: choices.context, dimensions: choices.dimensions};
}

function validatedProfile(value: unknown): ModelProfile {
  const profile = asRecord(value, 'profile');
  for (const key of ['schema', 'model', 'path', 'inspected_at']) stringValue(profile[key], key);
  const fingerprint = asRecord(profile.fingerprint); stringValue(fingerprint.method); stringValue(fingerprint.digest);
  for (const key of ['model_type', 'pooling', 'checkpoint_dtype', 'default_input_type', 'requires_model_adapter']) if (profile[key] !== null) stringValue(profile[key], key);
  for (const key of ['recommended_context_window', 'native_dimensions']) if (profile[key] !== null && positiveOrNull(profile[key]) === null) throw new GateError('INVALID_MODEL_METADATA', `${key} is invalid.`);
  modelModules(profile.modules);
  for (const key of ['reduction', 'prompts', 'source']) asRecord(profile[key], key);
  for (const key of ['normalize', 'layer_norm_before_truncate']) if (typeof profile[key] !== 'boolean') throw new GateError('INVALID_MODEL_METADATA', `${key} must be boolean.`);
  // Every declared profile field is validated above; retain the original object's numeric tokens.
  return profile as ModelProfile;
}

function checkStoredStrategy(path: string, requireCurrentModel: boolean): CheckedStrategy {
  const receipt = loadRecord(path);
  if (receipt.schema !== 'embedding-strategy/1' || typeof receipt.id !== 'string' || digest(omitRecordKeys(receipt, ['id'])).slice(0, 16) !== receipt.id) throw new GateError('RECEIPT_TAMPERED', 'The strategy receipt identity is invalid.', {evidence: [path]});
  for (const key of ['approved_at', 'approval_reference', 'model', 'model_path', 'manifest_path', 'manifest_source_path', 'manifest_digest']) stringValue(receipt[key], key);
  const profile = validatedProfile(receipt.profile);
  const choices = checkChoices(profile, receipt.device, receipt.context_window, receipt.dimensions);
  if (integerValue(receipt.native_dimensions) !== profile.native_dimensions || receipt.model !== profile.model || absolutePath(stringValue(receipt.model_path)) !== profile.path || receipt.api !== '/v1/embeddings' || receipt.input_policy !== 'reject_over_limit' || receipt.engine_policy !== 'tei_first_then_sentence_transformers_same_device') throw new GateError('RECEIPT_TAMPERED', 'Receipt identity/policy disagrees with the approved profile.');
  const fingerprint = asRecord(receipt.model_fingerprint);
  if (fingerprint.method !== 'metadata-sha256+weight-size-mtime' || typeof fingerprint.digest !== 'string') throw new GateError('RECEIPT_TAMPERED', 'Unknown model fingerprint contract.');
  if (requireCurrentModel && digest(fingerprintModel(profile.path)) !== digest(fingerprint)) throw new GateError('MODEL_CHANGED', 'Model files changed since the actual approval.', {evidence: [path], nextAction: 'human_input_required'});
  const manifestPath = stringValue(receipt.manifest_path);
  const manifest = loadRecord(manifestPath);
  if (digest(manifest) !== receipt.manifest_digest) throw new GateError('MANIFEST_TAMPERED', 'Approved manifest snapshot changed.', {evidence: [manifestPath]});
  const historicalHash = receipt.approval_evidence === undefined ? legacyAuthorization(receipt) : undefined;
  const evidence = approvalEvidence(stringValue(receipt.approval_reference), {model: profile.model, model_path: profile.path, device: choices.device, context_window: choices.context, dimensions: choices.dimensions, native_dimensions: integerValue(receipt.native_dimensions), profile}, manifest.evidence_kind === 'mock', historicalHash);
  if (receipt.approval_evidence !== undefined && digest(evidence) !== digest(receipt.approval_evidence)) throw new GateError('APPROVAL_PROVENANCE_INVALID', 'The recorded user authorization changed.');
  if ((receipt.evidence_kind === 'mock') !== (evidence.evidence_kind === 'mock')) throw new GateError('APPROVAL_PROVENANCE_INVALID', 'Mock approval evidence cannot be relabeled as a production strategy.');
  // All public strategy fields were checked; preserving this object is necessary for legacy hashes.
  const strategy = receipt as Strategy;
  return {strategy, manifest, receiptIdentity: digest({strategy: receipt, authorization: evidence})};
}

/** Checks approval integrity, current model identity and preserved actual authorization scope. */
export function checkedStrategy(path: string): CheckedStrategy { return checkStoredStrategy(path, true); }

/** Checks original approval for owned cleanup only; changed model files do not prevent resource removal. */
export function checkedStrategyForCleanup(path: string): CheckedStrategy { return checkStoredStrategy(path, false); }

/** Rejects a strategy that belongs to another declared comparison condition. */
export function assertStrategyMatchesCell(spec: JsonObject, strategy: Strategy): void {
  if (absolutePath(stringValue(spec.model_path)) !== strategy.model_path) throw new GateError('APPROVAL_SCOPE_CHANGED', 'Strategy belongs to another model.', {nextAction: 'human_input_required'});
  for (const [key, raw] of Object.entries(asRecord(spec.comparison ?? {}))) {
    if (!['device', 'context_window', 'dimensions'].includes(key)) throw new GateError('INVALID_INPUT', `Unknown comparison axis ${key}.`);
    const expected = key === 'dimensions' && raw === 'native' ? strategy.native_dimensions : raw;
    if (strategy[key] !== expected) throw new GateError('APPROVAL_SCOPE_CHANGED', `Strategy violates comparison ${key}.`, {nextAction: 'human_input_required'});
  }
}
