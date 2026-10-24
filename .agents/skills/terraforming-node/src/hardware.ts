/** Observes host capabilities without turning an unobserved device into absence. */
import {accessSync, constants, readFileSync, readdirSync, statfsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {cpus, machine, release, type} from 'node:os';
import {delimiter, join} from 'node:path';

import {GateError, ROOT, asRecord, arrayValue, digest, integerValue, now, numberValue, save, stringValue} from '../../../harness/common.ts';
import type {JsonObject} from '../../../harness/common.ts';
import {runCommand} from '../../../harness/processes.ts';

/** Describes what a probe actually established. */
export type ProbeStatus = 'observed' | 'absent' | 'tool_missing' | 'query_failed' | 'unavailable' | 'unknown';

/** Keeps a measured value together with its source and observation outcome. */
export interface Observation<T> extends JsonObject {
  value: T;
  status: ProbeStatus;
  source: string;
  error?: string;
}

/** Records a vendor-neutral accelerator, including partially observed devices. */
export interface Accelerator extends JsonObject {
  vendor?: string;
  uuid?: string;
  address?: string;
  name?: string;
  index?: number;
  vendor_id?: string;
  device_id?: string;
  compute_capability?: string;
  memory_total_mib?: number;
  driver_version?: string;
  runtime_status?: string;
}

/** Preserves command output, including failures and unavailable executables. */
export interface CommandObservation extends JsonObject {
  status: 'ok' | 'tool_missing' | 'query_failed';
  command: string[];
  observed_at: string;
  stdout: string;
  stderr: string;
  returncode?: number;
  timed_out?: boolean;
  error?: string;
}

/** Couples accelerator inventory with the actual probe outcome. */
export interface DeviceProbe extends JsonObject {
  status: ProbeStatus;
  devices: Accelerator[];
  source?: string;
  error?: string;
}

/** Defines the stable manifest shell; observation payloads retain their evidence. */
export interface Manifest extends JsonObject {
  schema: string;
  measured_at: string;
  evidence_kind?: 'measured' | 'mock';
  host: JsonObject;
  accelerators: Accelerator[];
  probes: JsonObject;
  runtimes: JsonObject;
  verification: JsonObject;
}

/** Defines an implemented route without making its hardware list a support limit. */
export interface PlatformProfile extends JsonObject {
  id: string;
  device: string;
  architectures?: string[];
  vendor?: string;
  compute_capabilities?: string[];
  docker_args?: string[];
}

/** Binds the selected route to the accelerator that actually matched it. */
export interface PlatformSelection extends PlatformProfile {
  architecture: string;
  accelerator?: Accelerator | null;
  status?: string;
  reason?: string;
  evidence?: string;
}

/** Reports a material hardware change or an unresolved current observation. */
export interface ApplicabilityReason extends JsonObject {
  code: string;
  message: string;
  evidence: string;
  next_action: string;
}

/** Separates execution applicability from immutable strategy approval. */
export interface HardwareApplicability extends JsonObject {
  applicable: boolean;
  reasons: ApplicabilityReason[];
  next_action: string;
}

/** Allows synthetic probe fixtures to exercise classification without real hardware. */
export type ProbeRunner = (argv: string[], timeoutSeconds?: number) => Promise<CommandObservation>;

/** Selects observation sources; injected probes mark mock evidence, while diskPath is a real target. */
export interface ScanOptions {
  runner?: ProbeRunner;
  executable?: (name: string, searchPath?: string) => string | undefined;
  sysfsPath?: string;
  meminfoPath?: string;
  osReleasePath?: string;
  diskPath?: string;
}

/** Finds an executable without a shell and without assuming a vendor is installed. */
export function findExecutable(name: string, searchPath = process.env.PATH ?? ''): string | undefined {
  const candidates = name.includes('/') ? [name] : searchPath.split(delimiter).filter(Boolean).map((part) => join(part, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      // A missing or inaccessible candidate is not executable; the probe records tool_missing.
    }
  }
  return undefined;
}

/** Executes only an argv probe and preserves timeout/spawn/nonzero outcomes. */
export async function probeCommand(argv: string[], timeoutSeconds = 20): Promise<CommandObservation> {
  const result = await runCommand(argv, {timeoutSeconds, effect: 'observe'});
  return {
    status: result.spawnError?.code === 'ENOENT' ? 'tool_missing' : (result.code === 0 && !result.timedOut ? 'ok' : 'query_failed'),
    command: argv,
    observed_at: now(),
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim().slice(-2000),
    returncode: result.code,
    timed_out: result.timedOut,
    ...(result.spawnError ? {error: result.spawnError.message} : {}),
  };
}

function observe<T>(value: T, source: string, status: ProbeStatus = 'observed', error?: string): Observation<T> {
  return {value, status, source, ...(error ? {error} : {})};
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) throw error;
  return error.message;
}

function csvFields(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      fields.push(field.trim());
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('Unclosed quoted NVIDIA CSV field');
  fields.push(field.trim());
  return fields;
}

/** Distinguishes no NVIDIA devices from a missing tool or a failed driver query. */
export async function nvidiaProbe(executable?: string, runner: ProbeRunner = probeCommand): Promise<DeviceProbe> {
  if (!executable) return {status: 'tool_missing', devices: [], source: 'nvidia-smi PATH + WSL path'};
  const result = await runner([executable, '--query-gpu=index,name,uuid,compute_cap,memory.total,driver_version', '--format=csv,noheader,nounits']);
  if (result.status !== 'ok') {
    const absent = !result.timed_out && /no devices were found/i.test(result.stdout + result.stderr);
    return {...result, status: absent ? 'absent' : result.status, devices: []};
  }
  const devices: Accelerator[] = [];
  try {
    for (const line of result.stdout.split(/\r?\n/).filter((value) => value.trim())) {
      const fields = csvFields(line);
      if (fields.length !== 6) throw new Error('NVIDIA probe returned an unexpected CSV column count');
      const [rawIndex, name, uuid, capability, rawMemory, driver] = fields;
      const index = Number(rawIndex);
      const memory = Number(rawMemory);
      if (!rawIndex || !rawMemory || !Number.isSafeInteger(index) || index < 0 || !Number.isFinite(memory) || memory <= 0 || !name || !uuid || !capability || !driver) {
        throw new Error('NVIDIA probe returned invalid or missing device fields');
      }
      devices.push({index, name, uuid, vendor: 'nvidia', compute_capability: capability, memory_total_mib: memory, driver_version: driver});
    }
  } catch (error: unknown) {
    return {...result, status: 'query_failed', devices: [], error: errorText(error)};
  }
  return {...result, status: devices.length > 0 ? 'observed' : 'absent', devices};
}

/** Inventories PCI display and processing accelerators, preserving unknown vendors. */
export function pciDevices(sysfsPath = '/sys/bus/pci/devices'): DeviceProbe {
  const devices: Accelerator[] = [];
  const errors: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(sysfsPath).toSorted();
  } catch (error: unknown) {
    return {status: 'unavailable', source: sysfsPath, devices, error: errorText(error)};
  }
  for (const address of entries) {
    const source = join(sysfsPath, address);
    try {
      const pciClass = readFileSync(join(source, 'class'), 'utf8').trim();
      if (!/^0x[0-9a-f]{6}$/i.test(pciClass)) throw new Error(`Invalid PCI class at ${source}`);
      if (!['03', '12', '0b'].includes(pciClass.slice(2, 4).toLowerCase())) continue;
      devices.push({address, class: pciClass, vendor_id: readFileSync(join(source, 'vendor'), 'utf8').trim(), device_id: readFileSync(join(source, 'device'), 'utf8').trim(), source});
    } catch (error: unknown) {
      errors.push(errorText(error));
    }
  }
  return {status: errors.length > 0 ? 'query_failed' : (devices.length > 0 ? 'observed' : 'absent'), devices, errors, source: sysfsPath};
}

function memoryObservation(path: string): Observation<JsonObject> {
  try {
    const memory: JsonObject = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const matched = /^(MemTotal|MemAvailable):\s+(\d+)\s+kB\s*$/.exec(line);
      if (matched) {
        const value = Number(matched[2]) * 1024;
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('Memory value exceeds a safe byte count');
        memory[stringValue(matched[1], 'memory field')] = value;
      }
    }
    if (typeof memory.MemTotal !== 'number' || memory.MemTotal <= 0) throw new Error('MemTotal was not observed');
    return observe(memory, path);
  } catch (error: unknown) {
    return observe({}, path, 'unavailable', errorText(error));
  }
}

function osObservation(path: string): Observation<JsonObject | string> {
  try {
    const values: JsonObject = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line);
      if (!match) continue;
      const key = stringValue(match[1], 'os release key');
      let value = stringValue(match[2], 'os release value');
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
      values[key] = value;
    }
    if (Object.keys(values).length === 0) throw new Error('OS release file contains no fields');
    return observe(values, path);
  } catch (error: unknown) {
    return observe(type(), 'node:os.type; OS release unavailable', 'observed', errorText(error));
  }
}

function diskObservation(path: string): Observation<JsonObject> {
  try {
    const usage = statfsSync(path, {bigint: true});
    const total = usage.blocks * usage.bsize;
    const free = usage.bavail * usage.bsize;
    if (total > BigInt(Number.MAX_SAFE_INTEGER) || free > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Disk capacity exceeds safe numeric byte count');
    return observe({total_bytes: Number(total), free_bytes: Number(free)}, `node:fs.statfs(${path})`);
  } catch (error: unknown) {
    return observe({}, `node:fs.statfs(${path})`, 'unavailable', errorText(error));
  }
}

/** Scans the current single host; this inventory is never itself a serving PASS. */
export async function scan(options: ScanOptions = {}): Promise<Manifest> {
  const runner = options.runner ?? probeCommand;
  const executable = options.executable ?? findExecutable;
  const nvidiaExecutable = executable('nvidia-smi', `${process.env.PATH ?? ''}${delimiter}/usr/lib/wsl/lib`);
  const dockerExecutable = executable('docker');
  const [nvidia, docker] = await Promise.all([
    nvidiaProbe(nvidiaExecutable, runner),
    dockerExecutable ? runner([dockerExecutable, 'info', '--format', '{{json .}}']) : Promise.resolve({status: 'tool_missing', source: 'docker PATH'}),
  ]);
  const pci = pciDevices(options.sysfsPath);
  const accelerators = [...nvidia.devices];
  const vendors = new Map([['0x10de', 'nvidia'], ['0x1002', 'amd'], ['0x8086', 'intel']]);
  for (const device of pci.devices) {
    if (device.vendor_id === '0x10de' && nvidia.devices.length > 0) continue;
    accelerators.push({...device, vendor: vendors.get(device.vendor_id ?? '') ?? device.vendor_id ?? 'unknown', runtime_status: 'unprobed'});
  }
  const kernel = release();
  const processors = cpus();
  const injectedProbe = [options.runner, options.executable, options.sysfsPath, options.meminfoPath, options.osReleasePath].some((value) => value !== undefined);
  return {
    schema: 'embedding-manifest/1', measured_at: now(), evidence_kind: injectedProbe ? 'mock' : 'measured',
    host: {
      os: osObservation(options.osReleasePath ?? '/etc/os-release'),
      kernel: observe(kernel, 'node:os.release'),
      environment: observe(/microsoft/i.test(kernel) || Boolean(process.env.WSL_INTEROP) ? 'wsl' : 'native', 'kernel + WSL_INTEROP presence'),
      architecture: observe(machine(), 'node:os.machine'),
      cpu: observe({logical_cores: processors.length, processor: machine(), ...(processors[0] ? {model: processors[0].model} : {})}, 'node:os.cpus + machine', processors.length > 0 ? 'observed' : 'unavailable'),
      memory: memoryObservation(options.meminfoPath ?? '/proc/meminfo'),
      disk: diskObservation(options.diskPath ?? '/'),
    },
    accelerators, probes: {nvidia, pci}, runtimes: {docker},
    verification: {physical_e2e: [], note: 'Inventory is not a serving PASS or a hardware scope limit.'},
  };
}

/** Validates a persisted manifest without rewriting legacy numeric metadata. */
export function parseManifest(value: unknown): Manifest {
  const record = asRecord(value, 'manifest');
  if (record.schema !== 'embedding-manifest/1') throw new Error('Manifest schema must be embedding-manifest/1');
  if (record.evidence_kind !== undefined && !['measured', 'mock'].includes(stringValue(record.evidence_kind, 'manifest evidence kind'))) throw new Error('Manifest evidence kind must be measured or mock');
  if (typeof record.measured_at !== 'string' || !Number.isFinite(Date.parse(record.measured_at))) throw new Error('Manifest measured_at must be a valid timestamp');
  const host = asRecord(record.host, 'manifest.host');
  const statuses = new Set(['observed', 'absent', 'tool_missing', 'query_failed', 'unavailable', 'unknown']);
  for (const key of ['os', 'kernel', 'environment', 'architecture', 'cpu', 'memory', 'disk']) {
    const observation = asRecord(host[key], `manifest.host.${key}`);
    if (!statuses.has(stringValue(observation.status, `manifest.host.${key}.status`))) throw new Error(`Unknown manifest.host.${key}.status`);
    stringValue(observation.source, `manifest.host.${key}.source`);
    if (!Object.hasOwn(observation, 'value')) throw new Error(`manifest.host.${key}.value is missing`);
    if (observation.status !== 'observed') continue;
    if (['kernel', 'environment', 'architecture'].includes(key) && !stringValue(observation.value, `manifest.host.${key}.value`)) throw new Error(`Observed ${key} must not be empty`);
    if (key === 'os') {
      if (typeof observation.value !== 'string') {
        for (const field of Object.values(asRecord(observation.value, 'OS observation'))) stringValue(field, 'OS field');
      } else if (!observation.value) throw new Error('Observed OS must not be empty');
    }
    if (key === 'cpu' && integerValue(asRecord(observation.value, 'CPU observation').logical_cores, 'logical CPU count') < 1) throw new Error('Observed CPU count must be positive');
    if (key === 'memory') {
      const memory = asRecord(observation.value, 'memory observation');
      if (integerValue(memory.MemTotal, 'total host memory') < 1) throw new Error('Observed host memory must be positive');
      if (memory.MemAvailable !== undefined && integerValue(memory.MemAvailable, 'available host memory') < 0) throw new Error('Available memory must be nonnegative');
    }
    if (key === 'disk') {
      const disk = asRecord(observation.value, 'disk observation');
      for (const field of ['total_bytes', 'free_bytes']) if (integerValue(disk[field], `disk.${field}`) < 0) throw new Error('Observed disk bytes must be nonnegative');
    }
  }
  const accelerators = arrayValue(record.accelerators, 'manifest.accelerators').map((device) => asRecord(device, 'manifest accelerator'));
  for (const device of accelerators) {
    for (const key of ['vendor', 'uuid', 'address', 'name', 'vendor_id', 'device_id', 'compute_capability', 'driver_version', 'runtime_status']) {
      if (device[key] !== undefined && !stringValue(device[key], `accelerator.${key}`)) throw new Error(`accelerator.${key} must not be empty`);
    }
    if (device.vendor === undefined && device.vendor_id === undefined) throw new Error('An accelerator must retain its observed vendor identity');
    if (![device.uuid, device.address, device.device_id, device.name].some((identity) => typeof identity === 'string' && identity.length > 0)) throw new Error('An accelerator must retain a device identity');
    if (device.index !== undefined && integerValue(device.index, 'accelerator.index') < 0) throw new Error('Accelerator index must be nonnegative');
    if (device.memory_total_mib !== undefined && numberValue(device.memory_total_mib, 'accelerator.memory_total_mib') <= 0) throw new Error('Observed accelerator memory must be positive');
    if (device.runtime_status !== undefined && device.runtime_status !== 'unprobed' && !statuses.has(stringValue(device.runtime_status, 'accelerator runtime status'))) throw new Error('Unknown accelerator runtime observation status');
  }
  // The original record is retained because legacy digest metadata is associated with its objects.
  const probes = asRecord(record.probes, 'manifest.probes');
  const runtimes = asRecord(record.runtimes, 'manifest.runtimes');
  for (const [name, probe] of Object.entries(probes)) {
    if (!statuses.has(stringValue(asRecord(probe, `probe.${name}`).status, `probe.${name}.status`))) throw new Error(`Unknown probe.${name}.status`);
  }
  for (const [name, runtime] of Object.entries(runtimes)) {
    const status = stringValue(asRecord(runtime, `runtime.${name}`).status, `runtime.${name}.status`);
    if (status !== 'ok' && !statuses.has(status)) throw new Error(`Unknown runtime.${name}.status`);
  }
  if (!Object.hasOwn(runtimes, 'docker')) throw new Error('Manifest must record the Docker runtime probe outcome');
  asRecord(record.verification, 'manifest.verification');
  return record as Manifest; // Every required manifest field is validated above; preserve its original object identity.
}

function optionalRecord(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? asRecord(value, 'record') : {};
}

function profile(value: unknown): PlatformProfile {
  const record = asRecord(value, 'platform profile');
  const result: PlatformProfile = {...record, id: stringValue(record.id, 'platform id'), device: stringValue(record.device, 'platform device')};
  for (const key of ['architectures', 'compute_capabilities', 'docker_args']) {
    if (record[key] !== undefined) result[key] = arrayValue(record[key], key).map((entry) => stringValue(entry, key));
  }
  if (record.vendor !== undefined) result.vendor = stringValue(record.vendor, 'platform vendor');
  return result;
}

/** Selects the first sourced matching route and binds NVIDIA access to its UUID. */
export function selectPlatform(manifestValue: unknown, device: string, profilesValue: unknown): PlatformSelection {
  if (!['cpu', 'gpu'].includes(device)) throw new Error('Device must be cpu or gpu');
  const manifest = asRecord(manifestValue, 'manifest');
  const host = asRecord(manifest.host, 'manifest.host');
  const architecture = stringValue(asRecord(host.architecture, 'architecture').value, 'architecture.value');
  const candidates: Array<Accelerator | null> = device === 'gpu' ? arrayValue(manifest.accelerators ?? [], 'accelerators').map((entry) => asRecord(entry, 'accelerator')) : [null];
  for (const entry of arrayValue(profilesValue, 'platform profiles')) {
    const selected = profile(entry);
    if (selected.device !== device || (selected.architectures && !selected.architectures.includes(architecture))) continue;
    for (const accelerator of candidates) {
      if (selected.vendor && accelerator?.vendor !== selected.vendor) continue;
      if (selected.compute_capabilities && !selected.compute_capabilities.includes(accelerator?.compute_capability ?? '')) continue;
      return {
        ...selected, accelerator, architecture,
        evidence: 'manifest observations + versioned platform profile; runtime validation required',
        ...(accelerator?.vendor === 'nvidia' && accelerator.uuid ? {docker_args: ['--gpus', `device=${accelerator.uuid}`]} : {}),
      };
    }
  }
  return {id: 'adapter-required', device, architecture, status: 'adapter_required', reason: 'No implemented route matches observed runtime; add a sourced profile, preserve selected device.'};
}

function runtimeIdentity(manifest: JsonObject): JsonObject | undefined {
  const docker = optionalRecord(optionalRecord(manifest.runtimes).docker);
  if (!['ok', 'observed'].includes(String(docker.status))) return undefined;
  try {
    const parsed = docker.value === undefined ? JSON.parse(stringValue(docker.stdout, 'Docker probe stdout')) : docker.value;
    return asRecord(parsed, 'Docker info');
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    return undefined;
  }
}

function observationValue(manifest: JsonObject, key: string): unknown {
  return optionalRecord(optionalRecord(manifest.host)[key]).value;
}

/** Compares only execution-relevant conditions, ignoring time and free-memory churn. */
export function checkApplicability(approvedValue: unknown, currentValue: unknown, device: string, selectedValue?: unknown): HardwareApplicability {
  const approved = asRecord(approvedValue, 'approved manifest');
  const current = asRecord(currentValue, 'current manifest');
  const selected = optionalRecord(selectedValue);
  const reasons: ApplicabilityReason[] = [];
  const addReason = (code: string, message: string, evidence: string): void => {
    reasons.push({code, message, evidence, next_action: 'Inspect current observation and reconcile material conditions before resuming the existing strategy.'});
  };
  const compare = (before: unknown, after: unknown, field: string): void => {
    if (before === undefined || after === undefined) {
      addReason('observation_unavailable', `Required ${field} was not observed in both manifests.`, field);
    } else if (digest(before) !== digest(after)) {
      addReason('hardware_changed', `Execution-relevant ${field} changed.`, field);
    }
  };
  for (const key of ['architecture', 'environment', 'kernel', 'cpu', 'memory']) {
    const observation = optionalRecord(optionalRecord(current.host)[key]);
    if (observation.status !== 'observed') addReason('observation_unavailable', `Current ${key} observation is ${String(observation.status ?? 'unknown')}.`, `host.${key}`);
  }
  for (const key of ['architecture', 'environment', 'kernel']) compare(observationValue(approved, key), observationValue(current, key), `host.${key}`);
  compare(optionalRecord(observationValue(approved, 'cpu')).logical_cores, optionalRecord(observationValue(current, 'cpu')).logical_cores, 'host.cpu.logical_cores');
  compare(optionalRecord(observationValue(approved, 'memory')).MemTotal, optionalRecord(observationValue(current, 'memory')).MemTotal, 'host.memory.MemTotal');
  const previousOs = optionalRecord(observationValue(approved, 'os'));
  const currentOs = optionalRecord(observationValue(current, 'os'));
  for (const key of ['ID', 'VERSION_ID']) {
    if (previousOs[key] !== undefined) compare(previousOs[key], currentOs[key], `host.os.${key}`);
  }
  const oldRuntime = runtimeIdentity(approved);
  const newRuntime = runtimeIdentity(current);
  if (!oldRuntime || !newRuntime) {
    addReason('runtime_unavailable', 'Docker daemon/runtime identity is not established by a successful current and approved probe.', 'runtimes.docker');
  } else {
    for (const key of ['ID', 'ServerVersion', 'Architecture', 'OSType', 'KernelVersion', 'Driver', 'CgroupDriver', 'CgroupVersion', 'DefaultRuntime']) {
      if (oldRuntime[key] !== undefined) compare(oldRuntime[key], newRuntime[key], `runtimes.docker.${key}`);
    }
    const runtimeNames = new Set<string>();
    if (typeof oldRuntime.DefaultRuntime === 'string') runtimeNames.add(oldRuntime.DefaultRuntime);
    if (device === 'gpu' && optionalRecord(selected.accelerator).vendor === 'nvidia') runtimeNames.add('nvidia');
    for (const name of runtimeNames) compare(optionalRecord(oldRuntime.Runtimes)[name], optionalRecord(newRuntime.Runtimes)[name], `runtimes.docker.Runtimes.${name}`);
  }
  if (device === 'gpu') {
    const oldDevices = arrayValue(approved.accelerators ?? [], 'approved accelerators').map((entry) => asRecord(entry, 'accelerator'));
    const before = selected.accelerator === undefined || selected.accelerator === null ? oldDevices[0] : asRecord(selected.accelerator, 'selected accelerator');
    if (!before) {
      addReason('device_unobserved', 'The approved GPU strategy has no selected accelerator observation.', 'accelerators');
    } else {
      const newDevices = arrayValue(current.accelerators ?? [], 'current accelerators').map((entry) => asRecord(entry, 'accelerator'));
      const identityKey = before.uuid ? 'uuid' : (before.address ? 'address' : undefined);
      const candidates = newDevices.filter((entry) => identityKey ? entry[identityKey] === before[identityKey] : entry.vendor === before.vendor && entry.name === before.name && entry.device_id === before.device_id);
      const after = candidates.length === 1 ? candidates[0] : undefined;
      if (!after) {
        addReason('selected_device_unavailable', 'The selected accelerator cannot be uniquely observed on the current host.', 'accelerators');
      } else {
        for (const key of ['vendor', 'uuid', 'address', 'device_id', 'name', 'compute_capability', 'memory_total_mib', 'driver_version', 'runtime_status']) {
          if (before[key] !== undefined) compare(before[key], after[key], `accelerators.selected.${key}`);
        }
        if (before.vendor === 'nvidia' && optionalRecord(optionalRecord(current.probes).nvidia).status !== 'observed') {
          addReason('device_probe_failed', 'Selected NVIDIA device needs a successful current driver query.', 'probes.nvidia');
        }
        if (before.vendor !== 'nvidia' && after.runtime_status !== 'observed') addReason('device_runtime_unverified', 'Selected accelerator has inventory evidence but no successful current runtime observation.', 'accelerators.selected.runtime_status');
      }
    }
  } else if (device !== 'cpu') {
    addReason('invalid_device', 'Strategy device must be cpu or gpu.', 'strategy.device');
  }
  return {applicable: reasons.length === 0, reasons, next_action: reasons.length === 0 ? 'Continue within the existing approved strategy.' : 'Reconcile current hardware observations; do not manufacture a new approval.'};
}

/** Blocks effects on materially changed or unobserved current host conditions. */
export async function assertCurrentCompatibility(strategyValue: unknown, manifest: unknown, platform: unknown): Promise<Manifest> {
  const strategy = asRecord(strategyValue, 'strategy');
  const current = await scan();
  const applicability = checkApplicability(manifest, current, stringValue(strategy.device, 'strategy.device'), platform);
  const evidencePath = join(ROOT, 'output', 'host', 'observations', `${now().replaceAll(':', '')}-${randomUUID().slice(0, 8)}.json`);
  save(evidencePath, {schema: 'embedding-host-applicability/1', strategy_id: strategy.id, approved_manifest_digest: digest(manifest), observed: current, applicability});
  if (!applicability.applicable) {
    throw new GateError('hardware_not_applicable', applicability.reasons.map((reason) => `${reason.code}: ${reason.message}`).join(' '), {retryable: true, nextAction: applicability.next_action, evidence: [evidencePath]});
  }
  return current;
}
