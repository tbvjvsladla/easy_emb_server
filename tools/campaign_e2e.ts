#!/usr/bin/env node
/** Frozen real Luna CLI evaluation; control success never substitutes for model evidence. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {ROOT, GateError, absolutePath, arrayValue, asRecord, digest, integerValue, load,
  loadRecord, now, optionalString, parseJson, save, sha256Bytes, stringValue} from './embedding/common.ts';
import type {JsonObject} from './embedding/common.ts';
import {alive, identity, observeProcess, runCommand, signalOwnedGroup} from './embedding/processes.ts';
import type {ProcessIdentity} from './embedding/processes.ts';
import * as campaign from './embedding/campaign.ts';
import {validateResult} from './embedding/bench.ts';
import {checkedStrategy} from './embedding/models.ts';

/** Keeps the three separately measured groups distinct from shared conditions. */
export type EvaluationGroup = 'full36' | 'representative6' | 'strict3';

/** Binds a condition to the original approved tuple and its acceptance rule. */
export interface CoverageCondition extends JsonObject {
  condition_id: string;
  model: string;
  model_path: string;
  device: string;
  context_window: number;
  dimensions: number;
  prior_outcome: string;
  allowed_outcomes: string[];
}

interface ControlInvocation {
  child: ChildProcess;
  owner: ProcessIdentity;
  target: string;
  completion: Promise<JsonObject>;
}

interface EvaluationContext {
  directory: string;
  frozen: JsonObject;
}

const MODEL = 'gpt-6-luna';
const EFFORT = 'none';
const SKILLS = ['terraforming-node', 'embedding-upstream', 'embedding-explorer', 'embedding-lite-bench']
  .map((name) => `.agents/skills/${name}/SKILL.md`);
const BASELINE = path.join(ROOT, 'output/e2e/nas-all-defaults-261022');
const REPRESENTATIVE = ['multilingual-e5-small-cpu', 'multilingual-e5-small-gpu',
  'multilingual-e5-base-cpu', 'multilingual-e5-base-gpu', 'embeddinggemma-300m-cpu', 'embeddinggemma-300m-gpu'];
const STRICT = ['multilingual-e5-small-cpu', 'multilingual-e5-small-gpu', 'multilingual-e5-base-cpu'];
const SOURCE_POLICY = {schema: 'embedding-evaluation-inputs/1',
  directories: ['tools', 'runtime', 'config', 'rules', '.agents', '.codex', 'campaigns'],
  files: ['AGENTS.md', 'README.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'oxlintrc.jsonc'],
  exclusion: 'Result publication under docs/report, generated output and unrelated assets are not execution inputs.'};

/** Defines the execution/policy freeze without invalidating later result publication. */
export function isExecutionInput(relative: string): boolean {
  return SOURCE_POLICY.files.includes(relative) || SOURCE_POLICY.directories.some(directory => relative.startsWith(`${directory}/`));
}

function records(value: unknown, label = 'records'): JsonObject[] {
  return arrayValue(value, label).map((entry) => asRecord(entry, label));
}

function groupValue(value: unknown): EvaluationGroup {
  if (value === 'full36' || value === 'representative6' || value === 'strict3') return value;
  throw new GateError('EVALUATION_GROUP', 'Choose full36, representative6 or strict3.');
}

/** Hashes tracked/nonignored execution and policy inputs, including new harness files. */
export async function sourceSnapshot(workspace = ROOT): Promise<JsonObject> {
  const listing = await runCommand(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {cwd: workspace, timeoutSeconds: 20});
  if (listing.code !== 0 || listing.timedOut) throw new GateError('SOURCE_SNAPSHOT', `git source enumeration failed: ${listing.stderr}`);
  const result: JsonObject = {};
  for (const relative of new Set(listing.stdout.split('\0').filter(Boolean))) {
    if (!isExecutionInput(relative)) continue;
    const filename = path.join(workspace, relative);
    if (fs.existsSync(filename) && fs.statSync(filename).isFile()) result[relative] = sha256Bytes(fs.readFileSync(filename));
  }
  return result;
}

function frozenArtifact(filename: string): JsonObject {
  return {path: absolutePath(filename), sha256: sha256Bytes(fs.readFileSync(filename))};
}

/** Owns the exact release-lock bytes instead of depending on a mutable preparation head. */
export function captureUpstreamInput(directory: string, upstreamSnapshot: string): JsonObject {
  const origin = absolutePath(upstreamSnapshot);
  const bytes = fs.readFileSync(origin);
  const upstream = asRecord(parseJson(bytes.toString('utf8')), 'frozen upstream lock');
  stringValue(upstream.id, 'frozen upstream identity');
  const inputs = path.join(directory, 'inputs');
  fs.mkdirSync(inputs, {recursive: true});
  const target = path.join(inputs, 'upstream-lock.json');
  const descriptor = fs.openSync(target, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  const parent = fs.openSync(inputs, 'r');
  try { fs.fsyncSync(parent); }
  finally { fs.closeSync(parent); }
  return {path: absolutePath(target), origin_path: origin, sha256: sha256Bytes(bytes), id: upstream.id, digest: digest(upstream)};
}

/** Creates an immutable evaluation identity before any actual control call. */
export async function freeze(directory: string, upstreamSnapshot: string): Promise<JsonObject> {
  const version = await runCommand(['codex', '--version'], {timeoutSeconds: 20});
  if (version.code !== 0 || version.spawnError || version.timedOut) throw new GateError('CODEX_CLI_NOT_FOUND', 'A real Codex CLI is required; no fallback is accepted.');
  const sources = await sourceSnapshot();
  fs.mkdirSync(path.dirname(path.resolve(directory)), {recursive: true});
  fs.mkdirSync(directory);
  const upstream = captureUpstreamInput(directory, upstreamSnapshot);
  const artifact: JsonObject = {schema: 'embedding-luna-evaluation/1', evaluation_id: path.basename(path.resolve(directory)),
    frozen_at: now(), model: MODEL, reasoning_effort: EFFORT, source_policy: SOURCE_POLICY, source_snapshot: sources, source_digest: digest(sources),
    upstream_snapshot: upstream,
    baseline_receipts: frozenArtifact(path.join(BASELINE, 'receipts.json')),
    baseline_results: frozenArtifact(path.join(BASELINE, 'results.json')),
    codex_version: version.stdout.trim(), node_version: process.version,
    acceptance: {full36: '34 original PASS conditions need new PASS; only original nomic-xlm CPU/GPU may remain evidenced BLOCKED',
      representative6: 'Six separate new measured PASS results', strict3: 'Three new PASS results with actual caller death and distinct real Luna resume'},
    control_policy: 'Actual gpt-6-luna / none only; preserve project permissions; no model, mock, or script fallback; source changes invalidate this evaluation.'};
  save(path.join(directory, 'evaluation.json'), artifact);
  return artifact;
}

async function checkedEvaluation(directory: string): Promise<EvaluationContext> {
  const canonical = absolutePath(directory);
  const frozen = loadRecord(path.join(canonical, 'evaluation.json'));
  if (frozen.schema !== 'embedding-luna-evaluation/1' || frozen.model !== MODEL || frozen.reasoning_effort !== EFFORT ||
      digest(frozen.source_snapshot) !== frozen.source_digest || digest(frozen.source_policy) !== digest(SOURCE_POLICY) || !Number.isFinite(Date.parse(stringValue(frozen.frozen_at)))) {
    throw new GateError('EVALUATION_FREEZE', 'Invalid frozen evaluation identity.');
  }
  const context = {directory: canonical, frozen};
  if (!(await unchanged(context))) throw new GateError('EVALUATION_INVALIDATED', 'Frozen source or upstream evidence changed; preserve this evaluation and start a new one after refreezing.');
  return context;
}

async function unchanged(context: EvaluationContext): Promise<boolean> {
  const changes: string[] = [];
  if (digest(await sourceSnapshot()) !== context.frozen.source_digest) changes.push('source_snapshot');
  for (const key of ['upstream_snapshot', 'baseline_receipts', 'baseline_results']) {
    const artifact = asRecord(context.frozen[key]);
    const filename = stringValue(artifact.path);
    if (!fs.existsSync(filename) || sha256Bytes(fs.readFileSync(filename)) !== artifact.sha256) changes.push(key);
  }
  if (changes.length) {
    const invalidation = path.join(context.directory, 'invalidation.json');
    if (!fs.existsSync(invalidation)) save(invalidation, {at: now(), changes, action: 'Preserve failed evaluation; refreeze corrected source into a new evaluation identity.'});
  }
  return changes.length === 0 && !fs.existsSync(path.join(context.directory, 'invalidation.json'));
}

function eventRecords(filename: string): JsonObject[] {
  if (!fs.existsSync(filename)) return [];
  const result: JsonObject[] = [];
  for (const line of fs.readFileSync(filename, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { result.push(asRecord(parseJson(line))); }
    catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      // A killed CLI may leave its final event line incomplete.
    }
  }
  return result;
}

/** Extracts actual CLI thread identifiers, independent of the final model response. */
export function eventThreads(filename: string): string[] {
  return [...new Set(eventRecords(filename).filter((item) => item.type === 'thread.started')
    .map((item) => optionalString(item.thread_id)).filter((value): value is string => value !== undefined))];
}

/** Preserves actual control/provider failures without replacing them with another model. */
export function controlErrors(filename: string): string[] {
  return [...new Set(eventRecords(filename).filter((item) => item.type === 'error' || item.type === 'turn.failed')
    .map((item) => optionalString(item.message) ?? (item.error ? optionalString(asRecord(item.error).message) : undefined))
    .filter((value): value is string => value !== undefined))];
}

function outsideAssistance(toolName: string, command: string): string | null {
  if (/collab|(?:^|[._])(?:spawn_agent|send_message|followup_task|delegate_task|delegate|ask_model|invoke_model|run_agent)(?:$|[._])|claude[-_]sub[-_]router/iu.test(toolName)) {
    return 'LLM delegation or external agent assistance was invoked';
  }
  if (/(?:^|(?:&&|\|\||[;|\n])\s*|(?:-c|-lc)\s+["'])\s*(?:[\w./-]+\/)?(?:codex|claude(?:-sub-router)?|gemini|ollama|aider)\s+(?:exec|review|run|chat|-p|--print|--model|-m)/iu.test(command) ||
      /(?:^|(?:&&|\|\||[;|\n])\s*|(?:-c|-lc)\s+["'])\s*(?:[\w./-]+\/)?node\s+(?:[^\s]+\/)?tools\/(?:review|campaign_e2e)\.ts\b/u.test(command) ||
      /(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*["'](?:codex|claude|gemini|ollama)["']/u.test(command) ||
      /(?:api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|openrouter\.ai)\/(?:v1|v1beta|api)\b/iu.test(command)) {
    return 'An additional model/provider control invocation was observed';
  }
  return null;
}

/** Audits actual emitted tool/command events without mistaking viewed file text for commands. */
export function controlIndependence(filename: string): JsonObject {
  const violations: JsonObject[] = [];
  for (const event of eventRecords(filename)) {
    if (!event.item) continue;
    const item = asRecord(event.item);
    const name = [item.type, item.server, item.tool, item.name].filter(value => typeof value === 'string').join('.');
    const command = optionalString(item.command) ?? '';
    const reason = outsideAssistance(name, command);
    if (reason) violations.push({event_type: event.type ?? null, item_id: item.id ?? null, tool: name, command_sha256: sha256Bytes(command), reason});
  }
  return {verified: violations.length === 0, violations, scope: 'Observed structured tool calls and executed commands; response claims are not evidence.'};
}

function sessionFiles(directory: string, threadId: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const found: string[] = [];
  const pending = [directory];
  while (pending.length) {
    const next = pending.pop();
    if (!next) break;
    for (const item of fs.readdirSync(next, {withFileTypes: true})) {
      const filename = path.join(next, item.name);
      if (item.isDirectory()) pending.push(filename);
      else if (item.isFile() && item.name.endsWith('.jsonl') && item.name.includes(threadId)) found.push(filename);
    }
  }
  return found;
}

/** Checks observed session metadata and raw turn_context model/effort records. */
export function runtimeProof(filename: string, threadId: string): JsonObject {
  const contexts: JsonObject[] = [];
  const rawContexts: string[] = [];
  let sessionMatches = false;
  let malformed = false;
  const assistance: JsonObject[] = [];
  const lines = fs.readFileSync(filename, 'utf8').trimEnd().split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const envelope = asRecord(parseJson(line));
      if (envelope.type === 'session_meta') sessionMatches = asRecord(envelope.payload).id === threadId;
      if (envelope.type === 'turn_context') {
        const payload = asRecord(envelope.payload);
        contexts.push({model: payload.model ?? null, effort: payload.effort ?? null, turn_id: payload.turn_id ?? null});
        rawContexts.push(line);
      }
      if (envelope.type === 'response_item') {
        const payload = asRecord(envelope.payload);
        if (payload.type === 'function_call') {
          const toolName = optionalString(payload.name) ?? '';
          let command = '';
          if (typeof payload.arguments === 'string') {
            try {
              const argumentsRecord = asRecord(parseJson(payload.arguments));
              command = optionalString(argumentsRecord.cmd) ?? optionalString(argumentsRecord.command) ?? '';
            } catch (error: unknown) { if (!(error instanceof Error)) throw error; }
          }
          const reason = outsideAssistance(toolName, command);
          if (reason) assistance.push({line: index + 1, tool: toolName, reason});
        }
      }
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      if (index !== lines.length - 1) malformed = true;
    }
  }
  return {thread_id: threadId, session_file: filename, session_sha256: sha256Bytes(fs.readFileSync(filename)),
    session_matches: sessionMatches, contexts, raw_contexts: rawContexts,
    independence_verified: assistance.length === 0, assistance,
    malformed_records: malformed,
    verified: !malformed && sessionMatches && contexts.length > 0 && contexts.every((item) => item.model === MODEL && item.effort === EFFORT)};
}

async function observedRuntime(target: string, threads: readonly string[]): Promise<JsonObject> {
  const sessionRoot = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions');
  const evidence: JsonObject[] = [];
  for (const threadId of threads) {
    let candidates: string[] = [];
    for (let attempt = 0; attempt < 20 && !candidates.length; attempt += 1) {
      candidates = sessionFiles(sessionRoot, threadId);
      if (!candidates.length) await delay(100);
    }
    const matches = candidates.map((filename) => runtimeProof(filename, threadId)).filter((item) => item.session_matches === true);
    if (matches.length !== 1) { evidence.push({thread_id: threadId, verified: false, reason: 'Missing or ambiguous actual persisted session'}); continue; }
    const proof = matches[0];
    if (!proof) continue;
    const rawPath = path.join(target, `turn-context-${threadId}.jsonl`);
    fs.writeFileSync(rawPath, `${arrayValue(proof.raw_contexts).map((line) => stringValue(line)).join('\n')}\n`);
    delete proof.raw_contexts;
    proof.raw_evidence = rawPath;
    evidence.push(proof);
  }
  return {verified: threads.length > 0 && evidence.length === threads.length && evidence.every((item) => item.verified === true),
    independence_verified: threads.length > 0 && evidence.every(item => item.independence_verified === true), threads: evidence};
}

/** Builds the fixed real-model command while preserving project permission policy. */
export function controlArgv(target: string, readOnly: boolean): string[] {
  return ['codex', 'exec', '-C', ROOT, '--model', MODEL, '-c', `model_reasoning_effort="${EFFORT}"`,
    ...(readOnly ? ['--sandbox', 'read-only'] : []), '--json', '--color', 'never',
    '--output-schema', path.join(target, 'response.schema.json'), '-o', path.join(target, 'last.json'), '-'];
}

async function launch(parent: string, label: string, prompt: string, readOnly: boolean, schema: JsonObject, timeout: number): Promise<ControlInvocation> {
  const target = path.join(parent, label);
  fs.mkdirSync(target, {recursive: false});
  save(path.join(target, 'response.schema.json'), schema);
  const argv = controlArgv(target, readOnly);
  save(path.join(target, 'intent.json'), {at: now(), argv, prompt, cwd: ROOT, model: MODEL, reasoning_effort: EFFORT,
    fallback_used: 'none', timeout_seconds: timeout, permissions: readOnly ? 'explicit read-only' : 'existing project default_permissions'});
  const stdout = fs.openSync(path.join(target, 'events.jsonl'), 'w');
  const stderr = fs.openSync(path.join(target, 'stderr.log'), 'w');
  let child: ChildProcess;
  try { child = spawn('codex', argv.slice(1), {cwd: ROOT, detached: true, stdio: ['pipe', stdout, stderr]}); }
  finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  let owner: ProcessIdentity = {pid: child.pid ?? 0, state: 'unknown'};
  let failure: string | null = null;
  let timedOut = false;
  child.once('error', (error) => { failure = error.message; });
  child.stdin?.once('error', (error) => { failure = error.message; });
  const completion = new Promise<JsonObject>((complete) => {
    const timer = setTimeout(() => { timedOut = true; signalOwnedGroup(owner, 'SIGKILL'); }, timeout * 1000);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      complete({returncode: code ?? 128, signal: signal ?? null, timed_out: timedOut, spawn_error: failure, finished_at: now()});
    });
  });
  await new Promise<void>((ready) => {
    child.once('spawn', () => { owner = identity(child.pid); save(path.join(target, 'process.json'), owner); child.stdin?.end(prompt); ready(); });
    child.once('error', () => { ready(); });
  });
  return {child, owner, target, completion};
}

async function finish(invocation: ControlInvocation): Promise<JsonObject> {
  const result = await invocation.completion;
  const events = path.join(invocation.target, 'events.jsonl');
  const threads = eventThreads(events);
  result.thread_ids = threads;
  result.errors = controlErrors(events);
  result.runtime = await observedRuntime(invocation.target, threads);
  result.runtime_verified = asRecord(result.runtime).verified;
  result.independence = controlIndependence(events);
  result.independence_verified = asRecord(result.independence).verified === true && asRecord(result.runtime).independence_verified === true;
  result.primary_invoked = true; result.fallback_used = 'none'; result.events = events;
  if (arrayValue(result.errors).some((message) => stringValue(message).includes('Selected model is at capacity'))) result.blocked_reason = 'codex-provider-model-capacity';
  const last = path.join(invocation.target, 'last.json');
  if (fs.existsSync(last)) {
    try { result.response = load(last); }
    catch (error: unknown) { if (!(error instanceof Error)) throw error; result.response_error = error.message; }
  }
  save(path.join(invocation.target, 'control-result.json'), result);
  return result;
}

function responseSchema(fields: JsonObject): JsonObject {
  return {type: 'object', properties: fields, required: Object.keys(fields), additionalProperties: false};
}

/** Runs real read-only discovery of all four skills and the TypeScript entrypoint. */
export async function discovery(context: EvaluationContext, timeout: number): Promise<JsonObject> {
  const out = path.join(context.directory, `discovery-${Date.now()}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(out);
  const schema = responseSchema({workspace: {type: 'string'}, context_file: {type: 'string'}, campaign_contract: {type: 'string'},
    checkpoint_root: {type: 'string'}, entrypoint: {type: 'string'}, skill_paths: {type: 'array', items: {type: 'string'}}});
  const prompt = 'Read AGENTS.md, campaigns/README.md and the four task skill instructions identified by AGENTS.md. ' +
    'This is read-only discovery: do not run models or alter files/configuration. Return the absolute workspace path, context filename, ' +
    'campaign contract path, the parent directory containing campaign folders, the native host CLI entrypoint path and all four skill paths. ' +
    'For checkpoint_root return only that parent directory, with no campaign ID, placeholder, trailing slash or checkpoint.json filename. Use repository-relative paths except workspace. ' +
    'Perform this yourself as the selected Luna/none model. Do not change model/provider or delegate to another LLM, subagent, external assistant, router or nested Codex invocation.';
  const invoked = await launch(out, 'call', prompt, true, schema, Math.min(timeout, 600));
  const control = await finish(invoked);
  const response = control.response ? asRecord(control.response) : {};
  const skills = response.skill_paths ? arrayValue(response.skill_paths).map((item) => stringValue(item)) : [];
  const sourceUnchanged = await unchanged(context);
  const passed = control.returncode === 0 && control.runtime_verified === true && control.independence_verified === true && sourceUnchanged &&
    response.workspace === ROOT && response.context_file === 'AGENTS.md' && response.campaign_contract === 'campaigns/README.md' &&
    response.checkpoint_root === 'output/campaigns' && response.entrypoint === 'tools/embctl.ts' &&
    skills.length === SKILLS.length && SKILLS.every((filename) => skills.includes(filename));
  const result = {passed, control, source_unchanged: sourceUnchanged, evaluation_id: context.frozen.evaluation_id, evidence_kind: 'real-codex-cli-discovery'};
  save(path.join(out, 'result.json'), result);
  if (passed) save(path.join(context.directory, 'discovery.json'), {passed, evidence: path.join(out, 'result.json'), evaluation_id: context.frozen.evaluation_id});
  return result;
}

/** Rejects count-only coverage, relaxed exceptions and incorrectly ordered continuity cells. */
export function validateCoverage(value: unknown, group: EvaluationGroup): CoverageCondition[] {
  let raw = records(asRecord(value).conditions, 'coverage conditions');
  if (raw.some((condition) => condition.groups !== undefined)) raw = raw.filter((condition) => arrayValue(condition.groups ?? []).includes(group));
  const result: CoverageCondition[] = raw.map((condition) => ({...condition,
    condition_id: campaign.safeId(condition.condition_id), model: stringValue(condition.model), model_path: absolutePath(stringValue(condition.model_path)),
    device: stringValue(condition.device), context_window: integerValue(condition.context_window), dimensions: integerValue(condition.dimensions),
    prior_outcome: stringValue(condition.prior_outcome), allowed_outcomes: arrayValue(condition.allowed_outcomes).map((item) => stringValue(item))}));
  if (new Set(result.map((item) => item.condition_id)).size !== result.length ||
      result.some((item) => !['cpu', 'gpu'].includes(item.device) || item.context_window <= 0 || item.dimensions <= 0)) {
    throw new GateError('EVALUATION_COVERAGE', 'Coverage needs unique condition IDs and valid approved tuples.');
  }
  const expected = group === 'full36' ? 36 : group === 'representative6' ? 6 : 3;
  if (result.length !== expected) throw new GateError('EVALUATION_COVERAGE', `Group ${group} requires exactly ${expected} declared conditions.`);
  const permitted = new Set(['nomic-xlm-2048-cpu', 'nomic-xlm-2048-gpu']);
  for (const item of result) {
    const allowed = group === 'full36' && permitted.has(item.condition_id) ? ['PASS', 'BLOCKED'] : ['PASS'];
    if (digest([...new Set(item.allowed_outcomes)].toSorted()) !== digest(allowed.toSorted()) ||
        item.prior_outcome !== (permitted.has(item.condition_id) ? 'BLOCKED' : 'PASS')) {
      throw new GateError('EVALUATION_COVERAGE', 'Coverage cannot weaken required new PASS outcomes or add blocked exceptions.');
    }
  }
  const ids = result.map((item) => item.condition_id);
  if (group === 'representative6' && digest(ids.toSorted()) !== digest(REPRESENTATIVE.toSorted())) throw new GateError('EVALUATION_COVERAGE', 'Representative coverage must be the named three models on CPU/GPU.');
  if (group === 'strict3' && digest(ids) !== digest(STRICT)) throw new GateError('EVALUATION_COVERAGE', 'Continuity order is small-cpu, small-gpu, base-cpu.');
  if (group === 'full36' && result.filter((item) => item.prior_outcome === 'BLOCKED').length !== 2) throw new GateError('EVALUATION_COVERAGE', 'Full coverage must preserve the original 34 PASS and two blocked conditions.');
  return result;
}

function compareBaseline(context: EvaluationContext, conditions: CoverageCondition[]): void {
  const baseline = records(load(stringValue(asRecord(context.frozen.baseline_receipts).path)));
  const results = records(loadRecord(stringValue(asRecord(context.frozen.baseline_results).path)).cells);
  for (const condition of conditions) {
    const receipt = baseline.find((entry) => entry.id === condition.condition_id);
    const outcome = results.find((entry) => entry.cell === condition.condition_id);
    if (!receipt || !outcome || absolutePath(stringValue(receipt.model_path)) !== condition.model_path ||
        digest(receipt.comparison) !== digest({device: condition.device, context_window: condition.context_window, dimensions: condition.dimensions}) ||
        outcome.outcome !== condition.prior_outcome || outcome.model !== condition.model) {
      throw new GateError('EVALUATION_BASELINE', `Condition ${condition.condition_id} differs from the frozen original matrix.`);
    }
  }
}

async function registerGroup(context: EvaluationContext, base: string, group: EvaluationGroup, coveragePath: string): Promise<{out: string; conditions: CoverageCondition[]}> {
  const discoveryRecord = path.join(context.directory, 'discovery.json');
  if (!fs.existsSync(discoveryRecord) || loadRecord(discoveryRecord).passed !== true) throw new GateError('EVALUATION_DISCOVERY', 'Actual frozen Luna discovery must pass before model groups.');
  await campaign.status(base);
  const state = loadRecord(path.join(base, 'checkpoint.json'));
  const declaration = asRecord(state.declaration);
  const conditions = validateCoverage(load(coveragePath), group);
  compareBaseline(context, conditions);
  const specs = records(declaration.cells);
  if (declaration.evaluation_id !== context.frozen.evaluation_id || declaration.group !== group || specs.length !== conditions.length) {
    throw new GateError('EVALUATION_DECLARATION', 'Campaign must declare this evaluation identity, group and exact ordered conditions.');
  }
  const frozenUpstream = asRecord(context.frozen.upstream_snapshot);
  for (const [index, condition] of conditions.entries()) {
    const spec = specs[index];
    if (!spec || (spec.condition_id ?? spec.id) !== condition.condition_id || absolutePath(stringValue(spec.model_path)) !== condition.model_path ||
        digest(spec.comparison) !== digest({device: condition.device, context_window: condition.context_window, dimensions: condition.dimensions})) {
      throw new GateError('EVALUATION_DECLARATION', `Campaign does not match ordered coverage condition ${condition.condition_id}.`);
    }
    const {strategy} = checkedStrategy(stringValue(spec.strategy));
    if (strategy.model !== condition.model || strategy.device !== condition.device || strategy.context_window !== condition.context_window || strategy.dimensions !== condition.dimensions) {
      throw new GateError('EVALUATION_APPROVAL', 'A genuine approved receipt for the exact condition is required.');
    }
    const snapshot = stringValue(asRecord(spec.build).release_snapshot, 'declared frozen release snapshot');
    if (sha256Bytes(fs.readFileSync(snapshot)) !== frozenUpstream.sha256) throw new GateError('EVALUATION_UPSTREAM', 'Every group must use the same frozen upstream release bytes.');
  }
  const out = path.join(context.directory, 'groups', group);
  fs.mkdirSync(out, {recursive: true});
  const registration = {evaluation_id: context.frozen.evaluation_id, group, campaign: absolutePath(base), campaign_id: state.id,
    declaration_digest: state.declaration_digest, upstream_snapshot: stringValue(frozenUpstream.path),
    coverage: absolutePath(coveragePath), coverage_sha256: sha256Bytes(fs.readFileSync(coveragePath))};
  const filename = path.join(out, 'registration.json');
  if (fs.existsSync(filename) && digest(load(filename)) !== digest(registration)) throw new GateError('EVALUATION_REUSE', 'A frozen group cannot be silently rebound to another campaign or coverage inventory.');
  if (!fs.existsSync(filename)) {
    if (records(state.invocations).length || Object.values(asRecord(state.cells)).some((entry) => arrayValue(asRecord(entry).attempts).length) ||
        !(Date.parse(stringValue(state.created_at)) >= Date.parse(stringValue(context.frozen.frozen_at)))) {
      throw new GateError('EVALUATION_PREEXECUTED', 'Register a new campaign after freezing; prior execution cannot be relabeled as Luna control.');
    }
    save(filename, registration);
  }
  return {out, conditions};
}

function verifiedControlThreads(directory: string): Set<string> {
  const found = new Set<string>();
  const pending = [directory];
  while (pending.length) {
    const next = pending.pop();
    if (!next || !fs.existsSync(next)) continue;
    for (const entry of fs.readdirSync(next, {withFileTypes: true})) {
      const filename = path.join(next, entry.name);
      if (entry.isDirectory()) pending.push(filename);
      else if (entry.isFile() && entry.name === 'control-result.json') {
        const control = loadRecord(filename);
        if (control.runtime_verified === true && control.independence_verified === true && control.fallback_used === 'none') {
          for (const thread of arrayValue(control.thread_ids)) found.add(stringValue(thread));
        }
      }
    }
  }
  return found;
}

/** Renders literal shell arguments while keeping plain words visible to command rules. */
export function shellCommand(argv: readonly string[]): string {
  if (argv.length === 0) throw new GateError('EVALUATION_COMMAND', 'A command needs an executable.');
  return argv.map((argument) => {
    if (argument.includes('\0')) throw new GateError('EVALUATION_COMMAND', 'Shell arguments cannot contain NUL.');
    return /^[A-Za-z0-9_./:@%+,-]+$/u.test(argument) ? argument : `'${argument.replaceAll("'", "'\\''")}'`;
  }).join(' ');
}

function campaignPrompt(base: string, timeout: number): string {
  const argv = [process.execPath, path.join(ROOT, 'tools/embctl.ts'), 'campaign', 'run', '--campaign', absolutePath(base), '--timeout', String(Math.max(1, Math.floor(timeout - 60)))];
  const statusArgv = [process.execPath, path.join(ROOT, 'tools/embctl.ts'), 'campaign', 'status', '--campaign', absolutePath(base)];
  return 'Read AGENTS.md and campaigns/README.md. Operate this already declared campaign using its actual approved receipts and project skills. ' +
    `In working directory ${ROOT}, read its canonical status with this exact shell command:\n${shellCommand(statusArgv)}\n` +
    `Then continue with this exact shell command:\n${shellCommand(argv)}\n` +
    'Copy each command verbatim into the shell tool cmd field; do not add quoting around its words, assignments, redirects or extra wrappers. ' +
    'Continue until a report, actual input-required, or an evidenced unresolved limit. Finite in-strategy diagnosis, declared recovery knobs and attempt-local changes allowed by the frozen skills are authorized. ' +
    'Read actual worker, attempt and resource evidence; record reason, hypothesis, actual change or new observation for recovery. Keep all failed attempts. ' +
    'Use only campaign CLI mutations; observe live owners and let finite workers finish. Do not initialize campaigns, invent approval, answer HITL, edit source/skills/policy/configuration, model files, strategy receipts, checkpoint/declaration, ' +
    'upstream snapshots, comparison conditions or this evaluation driver. Never copy old PASS or fabricate measurement. Missing or unsupported evidence is an unresolved outcome. ' +
    'If an original nomic-xlm condition remains blocked, retain current cause, recovery review or attempt evidence and resume condition. ' +
    'Perform this yourself as the selected Luna/none model. Do not change model/provider or delegate to another LLM, subagent, external assistant, router or nested Codex invocation. ' +
    'If completion is impossible without a harness correction, preserve evidence and stop; a higher-model correction invalidates this evaluation. ' +
    'Return campaign_id, task_state and report path from the canonical campaign JSON; control exit is not model PASS.';
}

/** Validates each actual new attempt and keeps model, report and control outcomes separate. */
export async function validateGroupEvidence(context: EvaluationContext, base: string, group: EvaluationGroup, conditions: CoverageCondition[]): Promise<JsonObject> {
  const state = loadRecord(path.join(base, 'checkpoint.json'));
  const declaration = asRecord(state.declaration);
  const cells = asRecord(state.cells);
  const specs = records(declaration.cells);
  const reasons: string[] = [];
  const outcomes: JsonObject[] = [];
  const attempts = new Set<string>();
  const frozenAt = Date.parse(stringValue(context.frozen.frozen_at));
  const controlThreads = verifiedControlThreads(path.join(context.directory, 'groups', group));
  if (!records(state.invocations).length || records(state.invocations).some((invocation) =>
    typeof invocation.codex_thread_id !== 'string' || !controlThreads.has(invocation.codex_thread_id))) {
    reasons.push('campaign effects include a caller outside the verified actual Luna threads');
  }
  for (const [index, condition] of conditions.entries()) {
    const spec = asRecord(specs[index]);
    const cell = asRecord(cells[stringValue(spec.id)]);
    const attempt = optionalString(cell.attempt);
    const validation = attempt ? validateResult(attempt) : null;
    let unresolvedValidation: campaign.UnresolvedEvidenceValidation | null = null;
    const failures: string[] = [];
    if (cell.phase !== 'done' || !condition.allowed_outcomes.includes(stringValue(cell.outcome))) failures.push('required outcome not achieved');
    if (cell.outcome === 'PASS') {
      if (!attempt || !validation?.valid || !validation.fresh || validation.kind !== 'fresh') failures.push('fresh actual functional and measurement evidence missing');
      if (attempt) {
        const settings = loadRecord(path.join(attempt, 'settings.yaml'));
        const owner = asRecord(settings.campaign_owner ?? {});
        if (settings.schema !== 'embedding-attempt/2' || !(Date.parse(stringValue(settings.created_at)) >= frozenAt) ||
            owner.campaign_path !== absolutePath(base) || owner.cell_id !== spec.id || attempts.has(attempt)) failures.push('attempt is old, reused or belongs to another condition');
        if (settings.source_snapshot_digest !== asRecord(context.frozen.upstream_snapshot).digest) failures.push('attempt differs from frozen upstream snapshot');
        attempts.add(attempt);
      }
    } else if (cell.outcome === 'BLOCKED') {
      unresolvedValidation = campaign.validateUnresolvedEvidence(base, stringValue(spec.id), {
        notBefore: stringValue(context.frozen.frozen_at), evaluationId: stringValue(context.frozen.evaluation_id),
        upstreamDigest: stringValue(asRecord(context.frozen.upstream_snapshot).digest), controlThreads});
      if (!unresolvedValidation.valid || !unresolvedValidation.fresh || unresolvedValidation.kind !== 'fresh') failures.push(
        `blocked condition lacks new evaluation evidence and actionable handoff: ${unresolvedValidation.reasons.join('; ')}`);
    }
    if (failures.length) reasons.push(`${condition.condition_id}: ${failures.join('; ')}`);
    outcomes.push({condition_id: condition.condition_id, cell_id: spec.id, outcome: cell.outcome, attempt: attempt ?? null, validation, unresolved_validation: unresolvedValidation, reasons: failures});
  }
  const groupRoot = path.join(context.directory, 'groups');
  if (fs.existsSync(groupRoot)) {
    for (const other of fs.readdirSync(groupRoot)) {
      if (other === group) continue;
      const registration = path.join(groupRoot, other, 'registration.json');
      if (!fs.existsSync(registration)) continue;
      const otherBase = stringValue(loadRecord(registration).campaign);
      for (const entry of Object.values(asRecord(loadRecord(path.join(otherBase, 'checkpoint.json')).cells))) {
        const otherAttempt = optionalString(asRecord(entry).attempt);
        if (otherAttempt && attempts.has(otherAttempt)) reasons.push(`Attempt reused across evaluation groups: ${otherAttempt}`);
      }
    }
  }
  const reportPath = optionalString(state.report);
  const proof = reportPath && fs.existsSync(reportPath) ? loadRecord(reportPath) : null;
  const taskComplete = proof?.validation_and_report_complete === true && proof.evaluation_id === context.frozen.evaluation_id && proof.group === group &&
    state.active === null && digest(proof.cells) === digest(state.cells);
  if (!taskComplete) reasons.push('canonical complete group report missing');
  return {accepted: reasons.length === 0, task_complete: taskComplete, model_outcomes: outcomes, reasons, report: reportPath ?? null};
}

/** Runs one real Luna control invocation for an already approved measured group. */
export async function runCampaign(context: EvaluationContext, base: string, group: EvaluationGroup, coveragePath: string, timeout: number): Promise<JsonObject> {
  if (group === 'strict3') throw new GateError('EVALUATION_MODE', 'strict3 requires the actual continuity interruption mode.');
  const registered = await registerGroup(context, base, group, coveragePath);
  const run = path.join(registered.out, `${Date.now()}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(run);
  const schema = responseSchema({campaign_id: {type: 'string'}, task_state: {type: 'string'}, report: {type: ['string', 'null']}});
  const control = await finish(await launch(run, 'call', campaignPrompt(base, timeout), false, schema, timeout));
  const sourceUnchanged = await unchanged(context);
  const models = await validateGroupEvidence(context, base, group, registered.conditions);
  const result = {passed: control.returncode === 0 && control.runtime_verified === true && control.independence_verified === true && sourceUnchanged && models.accepted === true,
    evaluation_id: context.frozen.evaluation_id, group, control, model_verification: models, source_unchanged: sourceUnchanged,
    evidence_kind: 'real-luna-none-and-real-model-api', fallback_used: 'none'};
  save(path.join(run, 'result.json'), result);
  save(path.join(registered.out, 'latest.json'), {evidence: path.join(run, 'result.json'), ...result});
  return result;
}

/** Matches only the exact recorded TypeScript campaign coordinator before signalling. */
export function coordinatorMatches(argv: readonly string[], cwd: string, base: string): boolean {
  const index = argv.findIndex((arg) => path.basename(arg) === 'embctl.ts');
  const campaignIndex = argv.indexOf('--campaign');
  const script = argv[index];
  const target = argv[campaignIndex + 1];
  return index >= 0 && script !== undefined && absolutePath(path.resolve(cwd, script)) === path.join(ROOT, 'tools/embctl.ts') &&
    argv[index + 1] === 'campaign' && argv[index + 2] === 'run' && campaignIndex > index && target !== undefined &&
    absolutePath(path.resolve(cwd, target)) === absolutePath(base);
}

/** Restores a recorded coordinator identity without dropping its PID coordinate system. */
export function processRecord(value: unknown): ProcessIdentity {
  const raw = asRecord(value);
  return {pid: integerValue(raw.pid), state: stringValue(raw.state), boot_id: stringValue(raw.boot_id),
    start_ticks: stringValue(raw.start_ticks), pid_namespace: stringValue(raw.pid_namespace, 'recorded PID namespace')};
}

function continuityStart(state: JsonObject, resumeExisting: boolean): void {
  const specs = records(asRecord(state.declaration).cells);
  const cells = asRecord(state.cells);
  const ordered = specs.map((spec) => asRecord(cells[stringValue(spec.id)]));
  if (resumeExisting) {
    const first = asRecord(ordered[0]);
    const second = asRecord(ordered[1]);
    const firstAttempt = optionalString(first.attempt);
    if (first.phase !== 'done' || first.outcome !== 'PASS' || !firstAttempt || !validateResult(firstAttempt).fresh ||
        !['build', 'serve', 'bench'].includes(stringValue(second.phase)) || ordered.slice(2).some((cell) => cell.phase !== 'prepare')) {
      throw new GateError('CONTINUITY_START', 'Resume needs a new measured completed first cell, current second cell and untouched third cell.');
    }
  } else if (state.active || ordered.some((cell) => cell.phase !== 'prepare' || arrayValue(cell.attempts).length)) {
    throw new GateError('CONTINUITY_START', 'Continuity requires a fresh declared campaign or explicit --resume-existing.');
  }
}

/** Kills the real caller/coordinator while retaining its leased finite worker, then resumes in another real thread. */
export async function continuity(context: EvaluationContext, base: string, coveragePath: string, timeout: number, phase: string, resumeExisting: boolean): Promise<JsonObject> {
  if (!['serve', 'bench'].includes(phase)) throw new GateError('CONTINUITY_PHASE', 'Interrupt a live serve or bench phase.');
  const registered = await registerGroup(context, base, 'strict3', coveragePath);
  const initial = loadRecord(path.join(base, 'checkpoint.json'));
  continuityStart(initial, resumeExisting);
  const specs = records(asRecord(initial.declaration).cells);
  const firstId = stringValue(asRecord(specs[0]).id);
  const secondId = stringValue(asRecord(specs[1]).id);
  const run = path.join(registered.out, `${Date.now()}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(run);
  save(path.join(run, 'start.json'), {at: now(), mode: resumeExisting ? 'resume-existing' : 'fresh', campaign: await campaign.status(base), first_cell: asRecord(initial.cells)[firstId]});
  const schema = responseSchema({campaign_id: {type: 'string'}, task_state: {type: 'string'}, report: {type: ['string', 'null']}});
  const first = await launch(run, 'call-1', campaignPrompt(base, timeout), false, schema, timeout);
  let interrupted: JsonObject | null = null;
  let interruptionFailure: JsonObject | null = null;
  const deadline = performance.now() + timeout * 1000;
  try {
    while (performance.now() < deadline && alive(first.owner)) {
      const state = loadRecord(path.join(base, 'checkpoint.json'));
      const active = state.active ? asRecord(state.active) : null;
      if (active?.cell_id === secondId && active.phase === phase && alive(active.process)) {
        const completed = asRecord(asRecord(state.cells)[firstId]);
        const firstAttempt = optionalString(completed.attempt);
        if (completed.phase !== 'done' || completed.outcome !== 'PASS' || !firstAttempt || !validateResult(firstAttempt).fresh) throw new GateError('CONTINUITY_FIRST', 'First condition lacks new measured completion before interruption.');
        const invocation = records(state.invocations).find((item) => item.id === active.invocation_id);
        if (!invocation) throw new GateError('CONTINUITY_OWNER', 'Worker invocation has no recorded caller.');
        const caller = processRecord(invocation.caller);
        const command = alive(caller) ? fs.readFileSync(`/proc/${caller.pid}/cmdline`, 'utf8').split('\0').filter(Boolean) : [];
        const matches = alive(caller) && coordinatorMatches(command, fs.realpathSync(`/proc/${caller.pid}/cwd`), base);
        if (!matches) throw new GateError('CONTINUITY_OWNER', 'Recorded caller is not this live campaign coordinator; no process was signalled.');
        interrupted = {at: now(), codex: first.owner, caller, active, checkpoint_sequence: state.sequence,
          completed_cell: completed, completed_cell_digest: digest(completed), coordinator_command_matched: matches};
        save(path.join(run, 'interruption-before.json'), interrupted);
        signalOwnedGroup(first.owner, 'SIGKILL');
        if (alive(caller)) process.kill(caller.pid, 'SIGKILL');
        for (let count = 0; count < 50 && (alive(caller) || alive(first.owner)); count += 1) await delay(20);
        interrupted.coordinator_confirmed_dead = observeProcess(caller).state === 'ended';
        interrupted.codex_confirmed_dead = observeProcess(first.owner).state === 'ended';
        interrupted.worker_alive_after_caller_death = alive(active.process);
        save(path.join(run, 'interruption-verified.json'), interrupted);
        break;
      }
      await delay(100);
    }
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    interruptionFailure = {code: error instanceof GateError ? error.code : 'CONTINUITY_ERROR', message: error.message};
  } finally {
    if ((!interrupted || interruptionFailure) && alive(first.owner)) signalOwnedGroup(first.owner, 'SIGKILL');
  }
  const firstControl = await finish(first);
  if (!interrupted || interruptionFailure) {
    const result = {passed: false, stage: interruptionFailure ? 'interruption-failed' : 'interruption-not-reached', error: interruptionFailure,
      first: firstControl, campaign: await campaign.status(base), source_unchanged: await unchanged(context)};
    save(path.join(run, 'result.json'), result);
    return result;
  }
  save(path.join(run, 'after-kill.json'), await campaign.status(base));
  const sourceBeforeResume = await unchanged(context);
  if (!sourceBeforeResume) throw new GateError('EVALUATION_INVALIDATED', 'Source changed during the interrupted call; no corrected-source resume is accepted.');
  const secondControl = await finish(await launch(run, 'call-2', campaignPrompt(base, timeout), false, schema, timeout));
  const final = loadRecord(path.join(base, 'checkpoint.json'));
  const completedUnchanged = digest(asRecord(final.cells)[firstId]) === interrupted.completed_cell_digest &&
    (!resumeExisting || digest(asRecord(initial.cells)[firstId]) === interrupted.completed_cell_digest);
  const firstThreads = arrayValue(firstControl.thread_ids).map((item) => stringValue(item));
  const secondThreads = arrayValue(secondControl.thread_ids).map((item) => stringValue(item));
  const distinct = firstThreads.length > 0 && secondThreads.length > 0 && secondThreads.every((thread) => !firstThreads.includes(thread));
  const operation = asRecord(interrupted.active);
  const originalInvocation = records(final.invocations).find((item) => item.id === operation.invocation_id);
  const starts = records(final.journey).filter((event) => event.event === 'phase_started' && event.operation_id === operation.operation_id);
  const workerContinuity = interrupted.worker_alive_after_caller_death === true && originalInvocation?.phase_result === 'done' &&
    originalInvocation.worker !== undefined && digest(originalInvocation.worker) === digest(operation.process) && starts.length === 1;
  const sourceUnchanged = await unchanged(context);
  const models = await validateGroupEvidence(context, base, 'strict3', registered.conditions);
  const passed = secondControl.returncode === 0 && firstControl.runtime_verified === true && secondControl.runtime_verified === true &&
    firstControl.independence_verified === true && secondControl.independence_verified === true && distinct &&
    interrupted.coordinator_confirmed_dead === true && interrupted.codex_confirmed_dead === true && workerContinuity && completedUnchanged && sourceUnchanged && models.accepted === true;
  const result = {passed, evaluation_id: context.frozen.evaluation_id, group: 'strict3', first: firstControl, second: secondControl,
    interruption: interrupted, distinct_real_threads: distinct, completed_cell_unchanged: completedUnchanged, worker_continuity: workerContinuity,
    source_unchanged: sourceUnchanged, model_verification: models, evidence_kind: 'real-luna-none-caller-death-resume-and-real-model-api', fallback_used: 'none'};
  save(path.join(run, 'result.json'), result);
  save(path.join(registered.out, 'latest.json'), {evidence: path.join(run, 'result.json'), ...result});
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs({options: {mode: {type: 'string', default: 'discovery'}, evaluation: {type: 'string'}, campaign: {type: 'string'},
    group: {type: 'string'}, coverage: {type: 'string'}, timeout: {type: 'string', default: '1800'}, 'upstream-snapshot': {type: 'string'},
    'interrupt-phase': {type: 'string', default: 'serve'}, 'resume-existing': {type: 'boolean', default: false}}}).values;
  const directory = absolutePath(stringValue(args.evaluation, '--evaluation'));
  const timeout = Number(args.timeout);
  if (!Number.isFinite(timeout) || timeout <= 60 || timeout > 86_400) throw new GateError('EVALUATION_TIMEOUT', 'Timeout must be finite, over 60 and at most 86400 seconds.');
  let result: JsonObject;
  if (args.mode === 'freeze') result = await freeze(directory, stringValue(args['upstream-snapshot'], '--upstream-snapshot'));
  else {
    const context = await checkedEvaluation(directory);
    if (args.mode === 'discovery') result = await discovery(context, timeout);
    else if (args.mode === 'campaign') result = await runCampaign(context, absolutePath(stringValue(args.campaign, '--campaign')), groupValue(args.group), stringValue(args.coverage, '--coverage'), timeout);
    else if (args.mode === 'continuity') {
      if (args.group && args.group !== 'strict3') throw new GateError('EVALUATION_GROUP', 'Continuity belongs to strict3.');
      result = await continuity(context, absolutePath(stringValue(args.campaign, '--campaign')), stringValue(args.coverage, '--coverage'), timeout, stringValue(args['interrupt-phase']), args['resume-existing']);
    } else throw new GateError('EVALUATION_MODE', 'Choose freeze, discovery, campaign or continuity.');
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.passed === false) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    if (!(error instanceof Error)) throw error;
    process.stderr.write(`${JSON.stringify({passed: false, error: {code: error instanceof GateError ? error.code : 'EVALUATION_ERROR', message: error.message}, fallback_used: 'none'})}\n`);
    process.exitCode = 1;
  });
}
