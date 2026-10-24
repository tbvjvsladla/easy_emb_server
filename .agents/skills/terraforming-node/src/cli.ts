#!/usr/bin/env node
/** Owns node observation and manifest initialization for the terraforming skill. */
import {resolve} from 'node:path';
import {GateError, asRecord, save} from '../../../harness/common.ts';
import {DEFAULT_MANIFEST, isMain, options, optionalText, print, runEntry, textOption} from '../../../harness/cli.ts';
import {scan} from './hardware.ts';

const INIT_OPTIONS = ['out', 'model-root'];

function help(): void {
  process.stdout.write('Usage: node .agents/skills/terraforming-node/src/cli.ts init [--out <manifest>] [--model-root <directory>]\n');
}

/** Observes this node and writes its manifest through the existing hardware gate. */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === '--help' || command === 'help') { help(); return 0; }
  if (command !== 'init') throw new GateError('INVALID_ARGUMENT', 'terraforming-node supports only init.');
  const args = options(rest, INIT_OPTIONS);
  if (args.help) { help(); print({command, options: INIT_OPTIONS}); return 0; }
  const modelRoot = optionalText(args, 'model-root');
  const manifest = await scan(modelRoot === undefined ? {} : {diskPath: modelRoot});
  const destination = textOption(args, 'out', DEFAULT_MANIFEST);
  save(destination, manifest);
  print({manifest: resolve(destination), measured_at: manifest.measured_at, architecture: manifest.host.architecture,
    accelerators: manifest.accelerators,
    runtime_status: Object.fromEntries(Object.entries(manifest.runtimes).map(([name, value]) => [name, asRecord(value).status]))});
  return 0;
}

/** Preserves the shared classified error and exit-status contract. */
export async function entry(argv = process.argv.slice(2)): Promise<void> {
  await runEntry(main, argv);
}

if (isMain(import.meta.url)) await entry();
