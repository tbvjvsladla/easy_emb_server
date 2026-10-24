#!/usr/bin/env node
/** Owns bounded embedding verification and evidence-based aggregate reporting. */
import {globSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {GateError, ROOT, arrayValue, asRecord, loadRecord, now, save, stringValue} from '../../../harness/common.ts';
import type {JsonObject} from '../../../harness/common.ts';
import {DEFAULT_OUTPUT, isMain, options, optionalText, print, runEntry, textOption} from '../../../harness/cli.ts';
import {resolveAttempt} from '../../embedding-explorer/src/attempts.ts';
import {run, validateResult} from './bench.ts';

const COMMAND_OPTIONS = {
  bench: ['attempt', 'strategy', 'output', 'base-url', 'routine'],
  report: ['inventory', 'output', 'out'],
};

function help(): void {
  process.stdout.write('Usage: node .agents/skills/embedding-lite-bench/src/cli.ts <bench|report> [options]\n'
    + 'bench: --attempt <path> | --strategy <receipt>, --output <directory>, --base-url <url>, --routine <file>\n'
    + 'report: --inventory <file>, --output <directory>, --out <file>\n');
}

function report(inventoryPath: string, output: string): JsonObject {
  const inventory = loadRecord(inventoryPath);
  const rows = arrayValue(inventory.models).map(item => {
    const profile = asRecord(item);
    const history = globSync(join(output, stringValue(profile.model), 'attempts/*/settings.yaml')).toSorted().map(path => {
      const cfg = loadRecord(path);
      const attempt = resolve(path, '..');
      const validation = validateResult(attempt);
      return {attempt, engine: cfg.engine, state: cfg.state,
        verdict: validation.valid && validation.fresh ? 'PASS' : 'UNVERIFIED', validation};
    });
    return {model: profile.model, history, verdict: history.at(-1)?.verdict ?? 'NOT_ATTEMPTED'};
  });
  return {schema: 'embedding-campaign/2', at: now(), models: rows,
    pass_count: rows.filter(row => row.verdict === 'PASS').length,
    note: 'Only freshly bound measured evidence counts as current PASS. Historical outcomes remain separately inspectable.'};
}

/** Runs only the lightweight verification skill's existing bench and report commands. */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === '--help' || command === 'help') { help(); return 0; }
  if (command !== 'bench' && command !== 'report') throw new GateError('INVALID_ARGUMENT', 'embedding-lite-bench supports only bench or report.');
  const args = options(rest, COMMAND_OPTIONS[command]);
  if (args.help) { help(); print({command, options: COMMAND_OPTIONS[command]}); return 0; }
  const output = textOption(args, 'output', DEFAULT_OUTPUT);
  if (command === 'report') {
    const result = report(textOption(args, 'inventory', join(DEFAULT_OUTPUT, 'inventory.yaml')), output);
    save(textOption(args, 'out', join(DEFAULT_OUTPUT, 'campaign-report.json')), result);
    print(result);
    return 0;
  }
  if ((args.attempt === undefined) === (args.strategy === undefined)) throw new GateError('INVALID_ARGUMENT', 'Select exactly one --attempt or --strategy.');
  const attempt = optionalText(args, 'attempt') ?? resolveAttempt(textOption(args, 'strategy'), output);
  const baseUrl = optionalText(args, 'base-url') ?? stringValue(loadRecord(join(attempt, 'containers.json')).base_url);
  const measured = await run(attempt, baseUrl, textOption(args, 'routine', join(ROOT, 'config/lite.yaml')));
  print(measured);
  return measured.verdict === 'PASS' ? 0 : 1;
}

/** Preserves the shared classified error and exit-status contract. */
export async function entry(argv = process.argv.slice(2)): Promise<void> {
  await runEntry(main, argv);
}

if (isMain(import.meta.url)) await entry();
