/** Shared argument parsing and error presentation; no lifecycle dispatch. */
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {GateError, ROOT} from './common.ts';

export const DEFAULT_OUTPUT = join(ROOT, 'output');
export const DEFAULT_MODELS = '/mnt/llm_model/Model/Embedding_model';
export const DEFAULT_MANIFEST = join(ROOT, 'manifest.yaml');
export const DEFAULT_RELEASES = join(ROOT, 'output/host/upstream-lock.json');

/** Strictly parsed fixed CLI options. */
export interface Options { [key: string]: string | boolean | Array<string | boolean> | undefined; }

export function options(argv: string[], names: string[]): Options {
  const definitions: {[key: string]: {type: 'string' | 'boolean'; multiple?: boolean}} = {help: {type: 'boolean'}};
  for (const name of names) definitions[name] = {type: 'string', ...(name === 'observation' ? {multiple: true} : {})};
  return parseArgs({args: argv, options: definitions, strict: true, allowPositionals: false}).values;
}

export function textOption(args: Options, name: string, fallback?: string): string {
  const value = args[name] ?? fallback;
  if (typeof value !== 'string' || !value.trim()) throw new GateError('INVALID_ARGUMENT', `--${name} requires a nonempty value.`);
  return value;
}

export function numericOption(args: Options, name: string, fallback: number, min: number, max: number): number {
  const raw = args[name];
  const value = raw === undefined ? fallback : typeof raw === 'string' && /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new GateError('INVALID_ARGUMENT', `--${name} must be an integer between ${min} and ${max}.`);
  return value;
}

export function optionalText(args: Options, name: string): string | undefined { return args[name] === undefined ? undefined : textOption(args, name); }

export function print(result: unknown): void { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); }


/** Presents classified failures without terminating an importing caller. */
export async function runEntry(main: (argv: string[]) => Promise<number>, argv = process.argv.slice(2)): Promise<void> {
  try { process.exitCode = await main(argv); }
  catch (error: unknown) {
    const record = error instanceof GateError ? {error: error.message, code: error.code, evidence: error.evidence, next_action: error.nextAction, retryable: error.retryable} : {error: error instanceof Error ? error.message : String(error), code: 'COMMAND_FAILED'};
    process.stderr.write(JSON.stringify(record) + '\n'); process.exitCode = 1;
  }
}

/** Distinguishes direct execution from a role importing another role's API. */
export function isMain(url: string): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(url);
}
