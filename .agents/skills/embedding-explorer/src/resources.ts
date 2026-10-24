/** Observes native resources and enforces original ownership without creating or mutating them. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {GateError, arrayValue, asRecord, stringValue} from '../../../harness/common.ts';
import type {JsonObject} from '../../../harness/common.ts';
import {runCommand} from '../../../harness/processes.ts';

/** Supplies the original identity required for read-only resource reconciliation. */
export interface ResourceOwner {
  path: string;
  settings: JsonObject;
  strategy: JsonObject;
}

/** Describes an observed present or confirmed absent Docker resource. */
export interface Inspection {
  status: 'present' | 'absent';
  info?: JsonObject;
}

function gate(code: string, message: string, evidence: string[] = [], nextAction = 'inspect evidence and create a justified recovery attempt'): never {
  throw new GateError(code, message, {evidence, nextAction, retryable: false});
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) throw error;
  return error.message;
}

/** Requires a present resource observation without treating unknown state as absence. */
export function inspectionPresent(inspection: Inspection, label: string): JsonObject {
  if (inspection.status !== 'present' || !inspection.info) gate('resource_missing', `${label} is absent; reconcile the stored resource intent before retry.`);
  return inspection.info;
}

/** Observes exactly one Docker resource and preserves daemon errors as unknown state. */
export async function inspectDocker(kind: 'container' | 'image' | 'network', name: string): Promise<Inspection> {
  const result = await runCommand(['docker', kind, 'inspect', name], {timeoutSeconds: 30, effect: 'observe'});
  if (result.code !== 0 || result.timedOut || result.spawnError) {
    const text = result.stderr.trim();
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const absence = new RegExp(`^(?:Error response from daemon: |Error: )?(?:No such (?:object|${kind}): ${escaped}|network ${escaped} not found)$`, 'i');
    if (!result.timedOut && !result.spawnError && result.code === 1 && text.split(/\r?\n/).every((line) => absence.test(line))) return {status: 'absent'};
    gate('docker_observation_failed', `Docker ${kind} observation failed; this is not evidence of absence: ${text || result.spawnError?.message || result.stdout}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch (error: unknown) {
    gate('docker_invalid_response', `Docker inspect returned invalid JSON: ${errorMessage(error)}`);
  }
  const values = arrayValue(value, 'Docker inspect list');
  if (values.length !== 1) gate('docker_invalid_response', 'Docker inspect must identify exactly one resource.');
  return {status: 'present', info: asRecord(values[0], 'Docker resource')};
}

/** Reads the native Docker label location for a container or network. */
export function labelsOf(info: JsonObject, kind: 'container' | 'network'): JsonObject {
  return asRecord(kind === 'container' ? asRecord(info.Config, 'container config').Labels ?? {} : info.Labels ?? {}, 'resource labels');
}

/** Checks a retained native create command for the original resource ID. */
export function creationRecorded(attempt: ResourceOwner, role: string, id: string): boolean {
  const filename = path.join(attempt.path, role === 'network' ? 'network-create.log' : `start-${role}.log`);
  return fs.existsSync(filename) && fs.readFileSync(filename, 'utf8').split(/\r?\n/).some((line) => line.trim() === id);
}

/** Requires original attempt and approval labels before resource use. */
export function assertOwned(info: JsonObject, attempt: ResourceOwner, kind: 'container' | 'network'): void {
  const labels = labelsOf(info, kind);
  const legacyNetwork = kind === 'network' && attempt.settings.schema === 'embedding-attempt/1' && labels['easy-emb.strategy'] === undefined && creationRecorded(attempt, 'network', stringValue(info.Id));
  if (labels['easy-emb.attempt'] !== attempt.settings.id || (labels['easy-emb.strategy'] !== attempt.strategy.id && !legacyNetwork)) {
    gate('resource_owner_mismatch', `Refusing ${kind} operation: its attempt and strategy labels do not match this receipt.`, [attempt.path]);
  }
}

/** Rejects heavy effects while another attempt still owns a running container. */
export async function assertNoOtherContainers(attempt: ResourceOwner): Promise<void> {
  const result = await runCommand(['docker', 'ps', '--quiet', '--filter', 'label=easy-emb.attempt'], {timeoutSeconds: 30, effect: 'observe'});
  if (result.code !== 0 || result.timedOut || result.spawnError) gate('docker_observation_failed', `Cannot reconcile other harness resources: ${result.stderr || result.spawnError?.message || result.stdout}`);
  for (const id of result.stdout.split(/\s+/).filter((value) => value.length > 0)) {
    const observed = await inspectDocker('container', id);
    if (observed.status === 'absent') continue;
    const info = inspectionPresent(observed, id);
    const labels = labelsOf(info, 'container');
    if (labels['easy-emb.attempt'] !== attempt.settings.id) {
      gate('harness_resource_busy', `Another harness attempt still owns a running container: ${id}`, [attempt.path], 'capture and stop the owning attempt through its campaign before continuing');
    }
  }
}
