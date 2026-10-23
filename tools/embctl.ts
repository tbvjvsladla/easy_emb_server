#!/usr/bin/env node
/** Fixed embedding lifecycle commands. Every effect delegates to a checked gate. */
import {existsSync, globSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {GateError, ROOT, arrayValue, asRecord, loadRecord, now, parseJson, save, stringValue} from './embedding/common.ts';
import type {JsonObject} from './embedding/common.ts';
import * as attempts from './embedding/attempts.ts';
import * as bench from './embedding/bench.ts';
import * as campaign from './embedding/campaign.ts';
import * as hardware from './embedding/hardware.ts';
import * as models from './embedding/models.ts';
import * as upstream from './embedding/upstream.ts';

const DEFAULT_OUTPUT = join(ROOT, 'output');
const DEFAULT_MODELS = '/mnt/llm_model/Model/Embedding_model';
const DEFAULT_MANIFEST = join(ROOT, 'manifest.yaml');
const DEFAULT_RELEASES = join(ROOT, 'output/host/upstream-lock.json');

interface Options { [key: string]: string | boolean | Array<string | boolean> | undefined; }

function options(argv: string[], names: string[]): Options {
  const definitions: {[key: string]: {type: 'string' | 'boolean'; multiple?: boolean}} = {help: {type: 'boolean'}};
  for (const name of names) definitions[name] = {type: 'string', ...(name === 'observation' ? {multiple: true} : {})};
  return parseArgs({args: argv, options: definitions, strict: true, allowPositionals: false}).values;
}

function textOption(args: Options, name: string, fallback?: string): string {
  const value = args[name] ?? fallback;
  if (typeof value !== 'string' || !value.trim()) throw new GateError('INVALID_ARGUMENT', `--${name} requires a nonempty value.`);
  return value;
}

function numericOption(args: Options, name: string, fallback: number, min: number, max: number): number {
  const raw = args[name];
  const value = raw === undefined ? fallback : typeof raw === 'string' && /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new GateError('INVALID_ARGUMENT', `--${name} must be an integer between ${min} and ${max}.`);
  return value;
}

function optionalText(args: Options, name: string): string | undefined { return args[name] === undefined ? undefined : textOption(args, name); }

function print(result: unknown): void { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); }

function help(): void {
  process.stdout.write('Usage: node tools/embctl.ts <command> [options]\nCommands: init inventory inspect approve upstream render build serve bench capture stop report campaign\n'
    + 'upstream: prepare | check\ncampaign: init status step run answer attach retry resolve reopen report (private _work)\n'
    + 'Use approved strategy receipts. New approvals require ordered actual user-message sources.\n');
}

async function campaignCommand(argv: string[]): Promise<unknown> {
  const [action, ...rest] = argv;
  const fields: {[key: string]: string[]} = {
    init: ['spec', 'output'], status: ['campaign'], step: ['campaign'], report: ['campaign'],
    run: ['campaign', 'timeout'], answer: ['campaign', 'answer'], attach: ['campaign', 'cell', 'strategy'],
    retry: ['campaign', 'cell', 'reason', 'hypothesis', 'change', 'engine', 'phase', 'dtype', 'limits', 'builder', 'observation'],
    resolve: ['campaign', 'cell', 'outcome', 'reason', 'evidence', 'resume-condition'], reopen: ['campaign', 'cell', 'reason'],
    _work: ['campaign', 'operation-id', 'lease-bindings'],
  };
  if (!action || !fields[action]) throw new GateError('INVALID_ARGUMENT', 'A supported campaign action is required.');
  const args = options(rest, fields[action]);
  if (args.help) { help(); return {command: `campaign ${action}`, options: fields[action]}; }
  if (action === 'init') return await campaign.initialize(textOption(args, 'spec'), textOption(args, 'output', DEFAULT_OUTPUT));
  const base = textOption(args, 'campaign');
  switch (action) {
    case 'status': return await campaign.status(base);
    case 'step': return await campaign.step(base);
    case 'report': return await campaign.report(base);
    case 'run': return await campaign.run(base, numericOption(args, 'timeout', 600, 1, 86400));
    case 'answer': return await campaign.answer(base, textOption(args, 'answer'));
    case 'attach': return await campaign.attachStrategy(base, textOption(args, 'cell'), textOption(args, 'strategy'));
    case 'reopen': return await campaign.reopen(base, textOption(args, 'cell'), textOption(args, 'reason'));
    case 'resolve': return await campaign.resolve(base, textOption(args, 'cell'), {outcome: textOption(args, 'outcome'), reason: textOption(args, 'reason'), evidence: textOption(args, 'evidence'), resumeCondition: textOption(args, 'resume-condition')});
    case '_work': return await campaign.work(base, textOption(args, 'operation-id'), parseJson(textOption(args, 'lease-bindings')));
    case 'retry': {
      const knobs: campaign.RetryOptions = {reason: textOption(args, 'reason'), hypothesis: textOption(args, 'hypothesis'), change: textOption(args, 'change')};
      for (const key of ['engine', 'phase', 'dtype', 'builder'] as const) if (args[key] !== undefined) knobs[key] = textOption(args, key);
      if (args.limits !== undefined) knobs.limits = loadRecord(textOption(args, 'limits'));
      if (args.observation !== undefined) knobs.observationPaths = arrayValue(args.observation).map(item => stringValue(item));
      return await campaign.retry(base, textOption(args, 'cell'), knobs);
    }
    default: throw new GateError('INVALID_ARGUMENT', 'Unsupported campaign action.');
  }
}

function report(inventoryPath: string, output: string): JsonObject {
  const inventory = loadRecord(inventoryPath);
  const rows = arrayValue(inventory.models).map(item => {
    const profile = asRecord(item);
    const history = globSync(join(output, stringValue(profile.model), 'attempts/*/settings.yaml')).toSorted().map(path => {
      const cfg = loadRecord(path);
      const attempt = resolve(path, '..');
      const validation = bench.validateResult(attempt);
      return {attempt, engine: cfg.engine, state: cfg.state, verdict: validation.valid && validation.fresh ? 'PASS' : 'UNVERIFIED', validation};
    });
    return {model: profile.model, history, verdict: history.at(-1)?.verdict ?? 'NOT_ATTEMPTED'};
  });
  return {schema: 'embedding-campaign/2', at: now(), models: rows, pass_count: rows.filter(row => row.verdict === 'PASS').length,
    note: 'Only freshly bound measured evidence counts as current PASS. Historical outcomes remain separately inspectable.'};
}

/** Runs one fixed command; returns its exit status without terminating callers importing this module. */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === '--help' || command === 'help') { help(); return 0; }
  if (command === 'campaign') { print(await campaignCommand(rest)); return 0; }
  if (command === 'upstream') {
    const [action, ...tail] = rest;
    if (action !== 'prepare' && action !== 'check') throw new GateError('INVALID_ARGUMENT', 'upstream requires prepare or check.');
    const args = options(tail, action === 'prepare' ? ['out', 'source-root', 'manifest', 'timeout'] : ['lock']);
    if (args.help) { help(); return 0; }
    if (action === 'check') { const result = upstream.validateFrozenSources(loadRecord(textOption(args, 'lock', DEFAULT_RELEASES))); print({valid: true, id: result.id}); }
    else { const result = await upstream.resolveReleases({outputPath: textOption(args, 'out', DEFAULT_RELEASES), manifestPath: textOption(args, 'manifest', DEFAULT_MANIFEST), timeoutSeconds: numericOption(args, 'timeout', 180, 1, 1800), ...(args['source-root'] === undefined ? {} : {sourceRoot: textOption(args, 'source-root')})}); print({lock: textOption(args, 'out', DEFAULT_RELEASES), id: result.id, releases: Object.fromEntries(Object.entries(result.releases).map(([name, value]) => { const release = asRecord(value); return [name, {version: release.version, commit: release.commit}]; }))}); }
    return 0;
  }
  const fields: {[key: string]: string[]} = {
    init: ['out', 'model-root'], inventory: ['model-root', 'out'], inspect: ['model'],
    approve: ['model', 'manifest', 'device', 'context-window', 'dimensions', 'approval-reference', 'output'],
    render: ['strategy', 'output', 'engine', 'reason', 'release-lock', 'previous-attempt', 'hypothesis', 'change', 'observation', 'dtype', 'limits'],
    build: ['strategy', 'attempt', 'output', 'engine', 'reason', 'builder', 'release-lock', 'previous-attempt', 'hypothesis', 'change', 'observation', 'dtype', 'limits'],
    serve: ['attempt', 'strategy', 'output', 'port', 'bind'], bench: ['attempt', 'strategy', 'output', 'base-url', 'routine'],
    capture: ['attempt'], stop: ['attempt'], report: ['inventory', 'output', 'out'],
  };
  if (!command || !fields[command]) throw new GateError('INVALID_ARGUMENT', 'A supported lifecycle command is required.');
  const args = options(rest, fields[command]);
  if (args.help) { help(); print({command, options: fields[command]}); return 0; }
  const output = textOption(args, 'output', DEFAULT_OUTPUT);
  let result: unknown;
  switch (command) {
    case 'init': {
      const modelRoot = optionalText(args, 'model-root');
      const manifest = await hardware.scan(modelRoot === undefined ? {} : {diskPath: modelRoot});
      const destination = textOption(args, 'out', DEFAULT_MANIFEST);
      save(destination, manifest);
      result = {manifest: resolve(destination), measured_at: manifest.measured_at, architecture: manifest.host.architecture, accelerators: manifest.accelerators, runtime_status: Object.fromEntries(Object.entries(manifest.runtimes).map(([name, value]) => [name, asRecord(value).status]))}; break;
    }
    case 'inventory': {
      const modelRoot = resolve(textOption(args, 'model-root', DEFAULT_MODELS));
      const profiles = readdirSync(modelRoot, {withFileTypes: true}).filter(item => item.isDirectory() && existsSync(join(modelRoot, item.name, 'config.json'))).map(item => models.inspectModel(join(modelRoot, item.name)));
      const destination = textOption(args, 'out', join(DEFAULT_OUTPUT, 'inventory.yaml'));
      save(destination, {schema: 'embedding-inventory/1', created_at: now(), root: modelRoot, models: profiles});
      result = {inventory: resolve(destination), count: profiles.length, models: profiles.map(profile => ({model: profile.model, recommended_context_window: profile.recommended_context_window, native_dimensions: profile.native_dimensions, reduction: profile.reduction, requires_model_adapter: profile.requires_model_adapter}))}; break;
    }
    case 'inspect': result = models.inspectModel(textOption(args, 'model')); break;
    case 'approve': result = models.approve({model: textOption(args, 'model'), manifest: textOption(args, 'manifest', DEFAULT_MANIFEST), device: textOption(args, 'device'), contextWindow: numericOption(args, 'context-window', 0, 1, 1048576), dimensions: textOption(args, 'dimensions'), approvalReference: textOption(args, 'approval-reference'), output}); break;
    case 'render': case 'build': {
      if (args.attempt !== undefined && args.strategy !== undefined) throw new GateError('INVALID_ARGUMENT', 'Select exactly one --attempt or --strategy.');
      let attempt = optionalText(args, 'attempt');
      if (attempt === undefined) {
        const knobs: attempts.RenderOptions = {};
        if (args.engine !== undefined) knobs.engine = textOption(args, 'engine');
        if (args.reason !== undefined) knobs.reason = textOption(args, 'reason');
        if (args['release-lock'] !== undefined) knobs.releaseSnapshotPath = textOption(args, 'release-lock');
        if (args.builder !== undefined) knobs.builder = textOption(args, 'builder');
        if (args.dtype !== undefined) knobs.dtype = textOption(args, 'dtype');
        if (args.limits !== undefined) knobs.limits = loadRecord(textOption(args, 'limits'));
        if (args['previous-attempt'] !== undefined) {
          knobs.recovery = {previousAttempt: textOption(args, 'previous-attempt'), reason: textOption(args, 'reason'), hypothesis: textOption(args, 'hypothesis'), change: textOption(args, 'change')};
          if (args.observation !== undefined) knobs.recovery.observationPaths = arrayValue(args.observation).map(item => stringValue(item));
        } else if (args.hypothesis !== undefined || args.change !== undefined || args.observation !== undefined) throw new GateError('INVALID_ARGUMENT', 'Recovery evidence requires --previous-attempt.');
        attempt = await attempts.render(textOption(args, 'strategy'), output, knobs);
        print({attempt, state: 'prepared'});
      } else if (['engine', 'reason', 'release-lock', 'previous-attempt', 'hypothesis', 'change', 'observation', 'dtype', 'limits'].some(name => args[name] !== undefined)) throw new GateError('INVALID_ARGUMENT', 'An existing attempt has frozen rendering inputs. Create another attempt to change them.');
      result = command === 'build' ? await attempts.build(attempt, args.builder === undefined ? {} : {builder: textOption(args, 'builder')}) : {attempt, state: 'prepared'}; break;
    }
    case 'serve': case 'bench': {
      if ((args.attempt === undefined) === (args.strategy === undefined)) throw new GateError('INVALID_ARGUMENT', 'Select exactly one --attempt or --strategy.');
      const attempt = optionalText(args, 'attempt') ?? attempts.resolveAttempt(textOption(args, 'strategy'), output);
      if (command === 'serve') result = await attempts.serve(attempt, {port: numericOption(args, 'port', 8080, 1, 65535), bind: textOption(args, 'bind', '127.0.0.1')});
      else {
        const baseUrl = optionalText(args, 'base-url') ?? stringValue(loadRecord(join(attempt, 'containers.json')).base_url);
        const measured = await bench.run(attempt, baseUrl, textOption(args, 'routine', join(ROOT, 'config/lite.yaml')));
        print(measured); return measured.verdict === 'PASS' ? 0 : 1;
      }
      break;
    }
    case 'capture': await attempts.capture(textOption(args, 'attempt')); result = {attempt: textOption(args, 'attempt'), captured: true}; break;
    case 'stop': result = await attempts.stop(textOption(args, 'attempt')); break;
    case 'report': result = report(textOption(args, 'inventory', join(DEFAULT_OUTPUT, 'inventory.yaml')), output); save(textOption(args, 'out', join(DEFAULT_OUTPUT, 'campaign-report.json')), result); break;
    default: throw new GateError('INVALID_ARGUMENT', 'Unsupported lifecycle command.');
  }
  print(result); return 0;
}

/** Presents classified failures; no unhandled promise or silent successful partial run. */
export async function entry(argv = process.argv.slice(2)): Promise<void> {
  try { process.exitCode = await main(argv); }
  catch (error: unknown) {
    const record = error instanceof GateError ? {error: error.message, code: error.code, evidence: error.evidence, next_action: error.nextAction, retryable: error.retryable} : {error: error instanceof Error ? error.message : String(error), code: 'COMMAND_FAILED'};
    process.stderr.write(`${JSON.stringify(record)}\n`); process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await entry();
