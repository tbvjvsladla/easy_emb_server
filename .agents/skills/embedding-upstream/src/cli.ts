#!/usr/bin/env node
/** Upstream-owned immutable source preparation, recipe validation and image builds. */
import {GateError, asRecord, loadRecord} from '../../../harness/common.ts';
import {DEFAULT_MANIFEST, DEFAULT_OUTPUT, DEFAULT_RELEASES, isMain, numericOption, options, print, runEntry, textOption} from '../../../harness/cli.ts';
import {prepareAttempt} from '../../embedding-explorer/src/attempt-options.ts';
import {build} from './build.ts';
import {resolveReleases, validateFrozenSources} from './upstream.ts';

function help(): void {
  process.stdout.write('Usage: node .agents/skills/embedding-upstream/src/cli.ts <prepare|check|build> [options]\n');
}

/** Runs only source preparation/checks or a receipt-checked build. */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === '--help' || command === 'help') { help(); return 0; }
  const fields: {[key: string]: string[]} = {
    prepare: ['out', 'source-root', 'manifest', 'timeout'], check: ['lock'],
    build: ['strategy', 'attempt', 'output', 'engine', 'reason', 'builder', 'release-lock', 'previous-attempt', 'hypothesis', 'change', 'observation', 'dtype', 'limits'],
  };
  if (!command || !fields[command]) throw new GateError('INVALID_ARGUMENT', 'A supported upstream command is required.');
  const args = options(rest, fields[command]);
  if (args.help) { help(); print({command, options: fields[command]}); return 0; }
  if (command === 'check') {
    const result = validateFrozenSources(loadRecord(textOption(args, 'lock', DEFAULT_RELEASES)));
    print({valid: true, id: result.id});
  } else if (command === 'prepare') {
    const result = await resolveReleases({outputPath: textOption(args, 'out', DEFAULT_RELEASES), manifestPath: textOption(args, 'manifest', DEFAULT_MANIFEST), timeoutSeconds: numericOption(args, 'timeout', 180, 1, 1800), ...(args['source-root'] === undefined ? {} : {sourceRoot: textOption(args, 'source-root')})});
    print({lock: textOption(args, 'out', DEFAULT_RELEASES), id: result.id, releases: Object.fromEntries(Object.entries(result.releases).map(([name, value]) => { const release = asRecord(value); return [name, {version: release.version, commit: release.commit}]; }))});
  } else {
    const attempt = await prepareAttempt(args, textOption(args, 'output', DEFAULT_OUTPUT));
    print(await build(attempt, args.builder === undefined ? {} : {builder: textOption(args, 'builder')}));
  }
  return 0;
}

/** Presents the shared classified error contract for this skill's entrypoint. */
export async function entry(argv = process.argv.slice(2)): Promise<void> { await runEntry(main, argv); }
if (isMain(import.meta.url)) await entry();
