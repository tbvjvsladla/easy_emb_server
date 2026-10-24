/** Parses approved attempt inputs for explorer render and upstream build. */
import {GateError, arrayValue, loadRecord, stringValue} from '../../../harness/common.ts';
import {optionalText, print, textOption} from '../../../harness/cli.ts';
import type {Options} from '../../../harness/cli.ts';
import * as attempts from './attempts.ts';

/** Creates a checked attempt, or accepts an existing attempt without changing frozen knobs. */
export async function prepareAttempt(args: Options, output: string): Promise<string> {
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

  return attempt;
}
