#!/usr/bin/env node
/** Fixed highest-model source review. Command/configuration overrides are rejected. */
import {join} from 'node:path';
import {ROOT, now, save} from '../harness/common.ts';
import {runCommand} from '../harness/processes.ts';

if (process.argv.length !== 2) throw new Error('The fixed review entrypoint accepts no arguments.');
const output = join(ROOT, 'output/validation/review', now().replaceAll(':', '').replaceAll('.', '-'));
const command = ['codex', '--model', 'gpt-6-astra', '-c', 'model_reasoning_effort="max"', 'review', '--uncommitted'];
save(join(output, 'invocation.json'), {command, started_at: now(), purpose: 'development source review; never a Luna E2E execution'});
const result = await runCommand(command, {cwd: ROOT, logPath: join(output, 'review.log'), timeoutSeconds: 1800, effect: 'observe'});
save(join(output, 'result.json'), result);
process.stdout.write(`${JSON.stringify({output, code: result.code, timed_out: result.timedOut})}\n`);
process.exitCode = result.code === 0 && !result.timedOut ? 0 : 1;
