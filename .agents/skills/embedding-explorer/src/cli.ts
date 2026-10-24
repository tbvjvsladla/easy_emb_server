#!/usr/bin/env node
/** Explorer-owned model approval, attempt preparation, serving and campaign lifecycle. */
import {existsSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {GateError, arrayValue, loadRecord, now, parseJson, save, stringValue} from '../../../harness/common.ts';
import {DEFAULT_MANIFEST, DEFAULT_MODELS, DEFAULT_OUTPUT, isMain, numericOption, options, optionalText, print, runEntry, textOption} from '../../../harness/cli.ts';
import * as models from './models.ts';
import * as attempts from './attempts.ts';
import * as campaign from './campaign.ts';
import {capture, serve, stop} from './serving.ts';
import {prepareAttempt} from './attempt-options.ts';

function help(): void {
  process.stdout.write('Usage: node .agents/skills/embedding-explorer/src/cli.ts <command> [options]\nCommands: inventory inspect approve render serve capture stop campaign\ncampaign: init status step run answer attach retry resolve reopen report (private _work)\n');
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


/** Executes an explorer command; business effects remain in this skill's modules. */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === '--help' || command === 'help') { help(); return 0; }
  if (command === 'campaign') { print(await campaignCommand(rest)); return 0; }
  const fields: {[key: string]: string[]} = {
    inventory: ['model-root', 'out'], inspect: ['model'],
    approve: ['model', 'manifest', 'device', 'context-window', 'dimensions', 'approval-reference', 'output'],
    render: ['strategy', 'output', 'engine', 'reason', 'release-lock', 'previous-attempt', 'hypothesis', 'change', 'observation', 'dtype', 'limits'],
    serve: ['attempt', 'strategy', 'output', 'port', 'bind'], capture: ['attempt'], stop: ['attempt'],
  };
  if (!command || !fields[command]) throw new GateError('INVALID_ARGUMENT', 'A supported explorer command is required.');
  const args = options(rest, fields[command]);
  if (args.help) { help(); print({command, options: fields[command]}); return 0; }
  const output = textOption(args, 'output', DEFAULT_OUTPUT);
  let result: unknown;
  switch (command) {
    case 'inventory': {
      const modelRoot = resolve(textOption(args, 'model-root', DEFAULT_MODELS));
      const profiles = readdirSync(modelRoot, {withFileTypes: true}).filter(item => item.isDirectory() && existsSync(join(modelRoot, item.name, 'config.json'))).map(item => models.inspectModel(join(modelRoot, item.name)));
      const destination = textOption(args, 'out', join(DEFAULT_OUTPUT, 'inventory.yaml'));
      save(destination, {schema: 'embedding-inventory/1', created_at: now(), root: modelRoot, models: profiles});
      result = {inventory: resolve(destination), count: profiles.length, models: profiles.map(profile => ({model: profile.model, recommended_context_window: profile.recommended_context_window, native_dimensions: profile.native_dimensions, reduction: profile.reduction, requires_model_adapter: profile.requires_model_adapter}))}; break;
    }
    case 'inspect': result = models.inspectModel(textOption(args, 'model')); break;
    case 'approve': result = models.approve({model: textOption(args, 'model'), manifest: textOption(args, 'manifest', DEFAULT_MANIFEST), device: textOption(args, 'device'), contextWindow: numericOption(args, 'context-window', 0, 1, 1048576), dimensions: textOption(args, 'dimensions'), approvalReference: textOption(args, 'approval-reference'), output}); break;

    case 'render': result = {attempt: await prepareAttempt(args, output), state: 'prepared'}; break;
    case 'serve': {
      if ((args.attempt === undefined) === (args.strategy === undefined)) throw new GateError('INVALID_ARGUMENT', 'Select exactly one --attempt or --strategy.');
      const attempt = optionalText(args, 'attempt') ?? attempts.resolveAttempt(textOption(args, 'strategy'), output);
      result = await serve(attempt, {port: numericOption(args, 'port', 8080, 1, 65535), bind: textOption(args, 'bind', '127.0.0.1')}); break;
    }
    case 'capture': await capture(textOption(args, 'attempt')); result = {attempt: textOption(args, 'attempt'), captured: true}; break;
    case 'stop': result = await stop(textOption(args, 'attempt')); break;
    default: throw new GateError('INVALID_ARGUMENT', 'Unsupported explorer command.');
  }
  print(result); return 0;
}

/** Presents the shared classified error contract for this skill's entrypoint. */
export async function entry(argv = process.argv.slice(2)): Promise<void> { await runEntry(main, argv); }
if (isMain(import.meta.url)) await entry();
