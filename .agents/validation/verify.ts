#!/usr/bin/env node
/** Fixed checks with durable logs; absent local tests never count as PASS. */
import {globSync} from 'node:fs';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {ROOT, now, save} from '../harness/common.ts';
import type {JsonObject} from '../harness/common.ts';
import {runCommand} from '../harness/processes.ts';

const args = parseArgs({options: {suite: {type: 'string', default: 'all'}}, strict: true, allowPositionals: false});
const commands: {[key: string]: string[]} = {
  typecheck: [process.execPath, join(ROOT, 'node_modules/typescript/bin/tsc'), '--noEmit'],
  lint: [process.execPath, join(ROOT, 'node_modules/oxlint/bin/oxlint'), '-c', 'oxlintrc.jsonc',
    '.agents/harness', '.agents/validation', '.agents/skills/terraforming-node/src', '.agents/skills/embedding-upstream/src',
    '.agents/skills/embedding-explorer/src', '.agents/skills/embedding-lite-bench/src'],
  // Tests exercise the actual single-host lease; keep those files sequential too.
  harness: [process.execPath, '--test', '--test-concurrency=1', ...globSync(join(ROOT, 'tests/ts-*.test.ts')).toSorted()],
  wiki: [process.execPath, '--test', ...globSync(join(ROOT, '.agents/skills/wiki-desk/tests/*.test.ts')).toSorted()],
};
const selected = args.values.suite === 'all' ? Object.keys(commands) : [args.values.suite ?? 'all'];
if (selected.some(suite => !Object.hasOwn(commands, suite))) throw new Error('suite must be all, typecheck, lint, harness, or wiki');
const output = join(ROOT, 'output/validation/verify', now().replaceAll(':', '').replaceAll('.', '-'));
const records: JsonObject[] = [];
for (const suite of selected) {
  const command = commands[suite];
  if (!command) throw new Error('Missing fixed verification command');
  const log = join(output, `${suite}.log`);
  const record: JsonObject = {suite, command, log, status: 'running'};
  records.push(record); save(join(output, 'result.json'), records);
  if ((suite === 'harness' && command.length === 3) || (suite === 'wiki' && command.length === 2)) {
    record.status = 'UNAVAILABLE'; record.error = 'Local test sources are absent. No tests ran.';
  } else {
    const result = await runCommand(command, {cwd: ROOT, logPath: log, timeoutSeconds: 300, effect: 'observe'});
    record.status = result.code === 0 && !result.timedOut && !result.spawnError ? 'PASS' : 'FAIL';
    record.returncode = result.code; record.timed_out = result.timedOut;
    if (result.spawnError) record.error = result.spawnError.message;
  }
  save(join(output, 'result.json'), records); process.stdout.write(`${JSON.stringify(record)}\n`);
}
process.exitCode = records.some(record => record.status === 'FAIL') ? 1 : records.some(record => record.status === 'UNAVAILABLE') ? 2 : 0;
