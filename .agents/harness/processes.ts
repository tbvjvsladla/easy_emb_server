/** Owns bounded processes and kernel leases inherited by detached commands. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {spawn, spawnSync} from 'node:child_process';
import type {ChildProcess, StdioOptions} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {GateError, ROOT, now, save} from './common.ts';

/** Binds a PID to the observer's PID namespace, boot and process creation time. */
export interface ProcessIdentity {
  pid: number;
  state: string;
  boot_id?: string;
  start_ticks?: string;
  pid_namespace?: string;
}

/** Separates an observed ended process from a process this caller cannot observe. */
export interface ProcessObservation {
  state: 'alive' | 'ended' | 'unavailable';
  reason: string;
  process: ProcessIdentity | null;
}

/** Describes an inherited descriptor in the child's descriptor table. */
export interface LeaseBinding {
  path: string;
  childFd: number;
}

interface HeldLease {
  readonly path: string;
  readonly fd: number;
  readonly device: bigint;
  readonly inode: bigint;
  readonly transferable: boolean;
}

/** Configures a bounded lease acquisition, optionally adopting an inherited fd. */
export interface FileLeaseOptions {
  waitMs?: number;
  inheritedFd?: number;
  transferable?: boolean;
}

/** Names the resources belonging to one finite execution phase. */
export interface ExecutionScope {
  campaign?: string;
  attempt?: string;
}

/** Records the actual outcome of a bounded argv invocation. */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  process: ProcessIdentity;
  signal?: NodeJS.Signals;
  spawnError?: {code: string; message: string};
}

/** Configures an argv command; mutation commands require an execution lease. */
export interface CommandOptions {
  cwd?: string;
  logPath?: string;
  timeoutSeconds: number;
  effect?: 'observe' | 'mutate';
  onSpawn?: (owner: ProcessIdentity) => void;
  input?: string;
}

/** Configures detached worker output without caller-owned pipes. */
export interface DetachedOptions {
  cwd?: string;
  logPath: string;
}

/** Signals live execution ownership; callers should observe rather than replay. */
export class LeaseBusyError extends GateError {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super('EXECUTION_BUSY', `A live process owns ${lockPath}`, {nextAction: 'observe', retryable: true});
    this.name = 'LeaseBusyError';
    this.lockPath = lockPath;
  }
}

const leaseScope = new AsyncLocalStorage<readonly HeldLease[]>();
const NODE_LEASE = path.join(ROOT, 'output', 'host', '.execution.lock');
const LOCK_CONFLICT_CODE = 73;
const CAPTURE_LIMIT = 8 * 1024 * 1024;

function errorCode(error: Error): string {
  return 'code' in error && typeof error.code === 'string' ? error.code : error.name;
}

/** Observes a Linux process identity without treating PID existence as ownership. */
export function identity(pid = process.pid): ProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return {pid, state: 'absent'};
  }
  let observer: {pid_namespace: string; boot_id: string};
  try {
    observer = {pid_namespace: fs.readlinkSync('/proc/self/ns/pid'),
      boot_id: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()};
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    return {pid, state: 'unknown'};
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    const state = fields[0];
    const startTicks = fields[19];
    if (!state || !startTicks) return {pid, state: 'unknown', ...observer};
    return {
      pid,
      state,
      start_ticks: startTicks,
      ...observer,
    };
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    return {pid, state: errorCode(error) === 'ENOENT' ? 'absent' : 'unknown', ...observer};
  }
}

/** Observes liveness only in the PID namespace that supplied the recorded identity. */
export function observeProcess(record: unknown): ProcessObservation {
  if (record === null || typeof record !== 'object' || !('pid' in record) ||
      typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
      !('boot_id' in record) || !('start_ticks' in record) ||
      typeof record.boot_id !== 'string' || typeof record.start_ticks !== 'string') {
    return {state: 'unavailable', reason: 'Recorded process identity is incomplete.', process: null};
  }
  const observer = identity();
  if (!observer.boot_id || !observer.pid_namespace || observer.state === 'unknown') {
    return {state: 'unavailable', reason: 'The caller cannot observe its own process namespace and boot.', process: observer};
  }
  if (record.boot_id !== observer.boot_id) return {state: 'ended', reason: 'The recorded boot has ended.', process: observer};
  if (!('pid_namespace' in record) || typeof record.pid_namespace !== 'string' || record.pid_namespace !== observer.pid_namespace) {
    return {state: 'unavailable', reason: 'The recorded PID namespace is missing or differs from this caller; resume from the original execution environment.', process: observer};
  }
  const actual = identity(record.pid);
  if (actual.state === 'unknown') return {state: 'unavailable', reason: 'The recorded process could not be observed.', process: actual};
  if (['Z', 'X', 'absent'].includes(actual.state) || actual.start_ticks !== record.start_ticks || actual.boot_id !== record.boot_id) {
    return {state: 'ended', reason: 'The original process ended or this PID was reused in the same namespace.', process: actual};
  }
  return {state: 'alive', reason: 'PID namespace, boot and process start identity match.', process: actual};
}

/** Returns true only for an identity positively observed alive in its own namespace. */
export function alive(record: unknown): boolean {
  return observeProcess(record).state === 'alive';
}

/** Rejects only the observed temporary Codex sandbox launcher before detached work begins. */
export function assertPersistentExecutionEnvironment(): void {
  if (process.platform !== 'linux') return;
  let command: Buffer;
  try { command = fs.readFileSync('/proc/1/cmdline'); }
  catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    return;
  }
  const separator = command.indexOf(0);
  const argv0 = command.subarray(0, separator < 0 ? command.length : separator).toString('utf8');
  if (path.basename(argv0) === 'codex-linux-sandbox') {
    throw new GateError('EPHEMERAL_EXECUTION_NAMESPACE', 'The observed PID 1 argv[0] is codex-linux-sandbox; its temporary namespace cannot retain a detached campaign worker.',
      {evidence: ['/proc/1/cmdline'], nextAction: 'Use the approved node .agents/skills/embedding-explorer/src/cli.ts campaign step/run entrypoint as a plain shell command without extra quotes around its executable or fixed arguments. Preserve existing permission rules; restart the trusted Codex session if its project rules changed.', retryable: true});
  }
}

function canonicalLock(filename: string, createParent: boolean): string {
  const absolute = path.resolve(filename);
  if (createParent) fs.mkdirSync(path.dirname(absolute), {recursive: true});
  const result = path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
  if (fs.existsSync(result) && fs.lstatSync(result).isSymbolicLink()) {
    throw new GateError('LOCK_IDENTITY', 'A lock path must not be a symbolic link.');
  }
  return result;
}

function validateLease(lease: HeldLease): void {
  const descriptor = fs.fstatSync(lease.fd, {bigint: true});
  const file = fs.statSync(lease.path, {bigint: true});
  if (descriptor.dev !== lease.device || descriptor.ino !== lease.inode ||
      descriptor.dev !== file.dev || descriptor.ino !== file.ino || !descriptor.isFile()) {
    throw new GateError('LOCK_IDENTITY', 'The execution descriptor no longer identifies its lock file.');
  }
}

function tryLock(fd: number): boolean {
  const result = spawnSync('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', String(LOCK_CONFLICT_CODE), '3'], {
    stdio: ['ignore', 'ignore', 'pipe', fd], encoding: 'utf8', timeout: 5000,
  });
  if (result.error) throw new GateError('LOCK_HELPER_FAILED', `flock failed: ${result.error.message}`);
  if (result.status === LOCK_CONFLICT_CODE) return false;
  if (result.status !== 0) throw new GateError('LOCK_HELPER_FAILED', `flock failed: ${result.stderr.trim()}`);
  return true;
}

/** Runs under a kernel lock; closing a parent copy never unlocks child copies. */
export async function withFileLease<T>(filename: string, action: () => Promise<T>, options: FileLeaseOptions = {}): Promise<T> {
  const lockPath = canonicalLock(filename, options.inheritedFd === undefined);
  const held = leaseScope.getStore() ?? [];
  const existing = held.find((lease) => lease.path === lockPath);
  if (existing) {
    validateLease(existing);
    if (options.inheritedFd !== undefined && options.inheritedFd !== existing.fd) {
      throw new GateError('LOCK_IDENTITY', 'Nested inherited lease refers to another descriptor.');
    }
    return await action();
  }
  const waitMs = options.waitMs ?? 0;
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 60_000) {
    throw new GateError('LOCK_TIMEOUT', 'Lock wait must be finite and within 0..60000 milliseconds.');
  }
  const inherited = options.inheritedFd;
  if (inherited !== undefined && (!Number.isSafeInteger(inherited) || inherited < 3)) {
    throw new GateError('LOCK_IDENTITY', 'Inherited execution descriptors must be integers at least 3.');
  }
  const fd = inherited ?? fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const observed = fs.fstatSync(fd, {bigint: true});
    const lease: HeldLease = {
      path: lockPath, fd, device: observed.dev, inode: observed.ino,
      transferable: options.transferable ?? inherited !== undefined,
    };
    validateLease(lease);
    const deadline = performance.now() + waitMs;
    while (!tryLock(fd)) {
      if (performance.now() >= deadline) throw new LeaseBusyError(lockPath);
      await delay(Math.min(25, Math.max(1, deadline - performance.now())));
    }
    return await leaseScope.run([...held, lease], action);
  } finally {
    // flock LOCK_UN would release the shared open-file-description lock in children.
    fs.closeSync(fd);
  }
}

/** Runs a phase under the shared node, campaign and attempt execution leases. */
export async function withExecutionLease<T>(scope: ExecutionScope, action: () => Promise<T>): Promise<T> {
  const files = [NODE_LEASE];
  if (scope.campaign) files.push(path.join(scope.campaign, '.execution.lock'));
  if (scope.attempt) files.push(path.join(scope.attempt, '.execution.lock'));
  const enter = async (index: number): Promise<T> => {
    const filename = files[index];
    if (!filename) return await action();
    return await withFileLease(filename, async () => await enter(index + 1), {transferable: true});
  };
  return await enter(0);
}

/** Checks an actual live descriptor in the current execution scope. */
export function hasExecutionLease(filename: string): boolean {
  try {
    const canonical = canonicalLock(filename, false);
    const lease = leaseScope.getStore()?.find((item) => item.path === canonical && item.transferable);
    if (!lease) return false;
    validateLease(lease);
    return true;
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

function transferableLeases(): readonly HeldLease[] {
  const leases = (leaseScope.getStore() ?? []).filter((lease) => lease.transferable);
  for (const lease of leases) validateLease(lease);
  return leases;
}

/** Returns the exact fd mapping that the next leased spawn will inherit. */
export function inheritedLeaseBindings(): readonly LeaseBinding[] {
  return transferableLeases().map((lease, index) => ({path: lease.path, childFd: index + 3}));
}

/** Adopts child fd bindings after checking their paths against required locks. */
export async function withInheritedLeases<T>(value: unknown, expectedPaths: readonly string[], action: () => Promise<T>): Promise<T> {
  if (!Array.isArray(value) || value.length !== expectedPaths.length) {
    throw new GateError('LOCK_IDENTITY', 'Worker must inherit every declared execution lease.');
  }
  const bindings: LeaseBinding[] = [];
  const paths = new Set<string>();
  const descriptors = new Set<number>();
  for (const item of value) {
    if (item === null || typeof item !== 'object' || !('path' in item) || typeof item.path !== 'string' ||
        !('childFd' in item) || typeof item.childFd !== 'number' || !Number.isSafeInteger(item.childFd) || item.childFd < 3) {
      throw new GateError('LOCK_IDENTITY', 'Invalid inherited execution lease binding.');
    }
    const canonical = canonicalLock(item.path, false);
    if (paths.has(canonical) || descriptors.has(item.childFd)) throw new GateError('LOCK_IDENTITY', 'Duplicate lease binding.');
    paths.add(canonical);
    descriptors.add(item.childFd);
    bindings.push({path: canonical, childFd: item.childFd});
  }
  if (expectedPaths.some((filename) => !paths.has(canonicalLock(filename, false)))) {
    throw new GateError('LOCK_IDENTITY', 'Worker inherited leases for different resources.');
  }
  const enter = async (index: number): Promise<T> => {
    const binding = bindings[index];
    if (!binding) return await action();
    return await withFileLease(binding.path, async () => await enter(index + 1), {inheritedFd: binding.childFd, transferable: true});
  };
  return await enter(0);
}

/** Names required resource lock paths in their fixed acquisition order. */
export function executionLeasePaths(scope: ExecutionScope): string[] {
  return [NODE_LEASE, ...(scope.campaign ? [path.join(scope.campaign, '.execution.lock')] : []),
    ...(scope.attempt ? [path.join(scope.attempt, '.execution.lock')] : [])];
}

function commandParts(argv: readonly string[]): {executable: string; args: string[]} {
  const executable = argv[0];
  if (!executable || argv.some((value) => typeof value !== 'string' || value.includes('\0'))) {
    throw new GateError('COMMAND_INPUT', 'Commands require a nonempty executable and NUL-free argv.');
  }
  return {executable, args: argv.slice(1)};
}

/** Starts an independent finite worker while retaining all execution leases. */
export function spawnDetached(argv: readonly string[], options: DetachedOptions): ChildProcess {
  assertPersistentExecutionEnvironment();
  const command = commandParts(argv);
  const leases = transferableLeases();
  if (!leases.length) throw new GateError('EXECUTION_LEASE_REQUIRED', 'Detached campaign workers need an execution lease.');
  fs.mkdirSync(path.dirname(options.logPath), {recursive: true});
  const log = fs.openSync(options.logPath, 'a');
  try {
    const child = spawn(command.executable, command.args, {
      cwd: options.cwd ?? ROOT,
      detached: true,
      stdio: ['ignore', log, log, ...leases.map((lease) => lease.fd)],
    });
    // Retain a diagnostic even if spawn reports asynchronously after the caller returns.
    child.once('error', (error) => {
      fs.appendFileSync(options.logPath, `${now()} worker_spawn_error ${error.message}\n`);
    });
    child.unref();
    return child;
  } finally {
    fs.closeSync(log);
  }
}

/** Signals only a still-matching process identity and its detached process group. */
export function signalOwnedGroup(owner: ProcessIdentity, signal: NodeJS.Signals): boolean {
  if (!alive(owner)) return false;
  try {
    process.kill(-owner.pid, signal);
    return true;
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    if (errorCode(error) === 'ESRCH') return false;
    throw error;
  }
}

function groupMembers(groupId: number): ProcessIdentity[] {
  const members: ProcessIdentity[] = [];
  for (const entry of fs.readdirSync('/proc', {withFileTypes: true})) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry.name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
      if (fields[2] === String(groupId)) members.push(identity(Number(entry.name)));
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      if (!['ENOENT', 'ESRCH', 'EACCES'].includes(errorCode(error))) throw error;
    }
  }
  return members;
}

function signalObservedGroup(groupId: number, members: readonly ProcessIdentity[], signal: NodeJS.Signals): void {
  // An original matching member keeps this process-group identity alive even
  // after its leader exits. PID existence alone never authorizes a signal.
  const actual = groupMembers(groupId);
  if (!members.some((member) => alive(member) && actual.some((entry) => entry.pid === member.pid && entry.start_ticks === member.start_ticks))) return;
  try { process.kill(-groupId, signal); }
  catch (error: unknown) {
    if (!(error instanceof Error) || errorCode(error) !== 'ESRCH') throw error;
  }
}

/** Executes argv with a finite timeout, inherited leases, and complete file logs. */
export async function runCommand(argv: readonly string[], options: CommandOptions): Promise<CommandResult> {
  const command = commandParts(argv);
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
    throw new GateError('COMMAND_TIMEOUT', 'A finite positive command timeout is required.');
  }
  const leases = transferableLeases();
  if (options.effect === 'mutate' && !hasExecutionLease(NODE_LEASE)) {
    throw new GateError('EXECUTION_LEASE_REQUIRED', 'A mutation command requires the node execution lease.');
  }
  let log: number | undefined;
  if (options.logPath) {
    fs.mkdirSync(path.dirname(options.logPath), {recursive: true});
    save(`${options.logPath}.intent.json`, {at: now(), argv, cwd: options.cwd ?? ROOT,
      timeout_seconds: options.timeoutSeconds, effect: options.effect ?? 'observe', owner: identity()});
    log = fs.openSync(options.logPath, 'a');
    fs.writeSync(log, `\n${now()} ${JSON.stringify(argv)}\n`);
  }
  const stdio: StdioOptions = ['pipe', 'pipe', 'pipe', ...leases.map((lease) => lease.fd)];
  try {
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command.executable, command.args, {cwd: options.cwd ?? ROOT, detached: true, stdio});
      let owner: ProcessIdentity = {pid: child.pid ?? 0, state: 'absent'};
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let spawnFailure: CommandResult['spawnError'];
      let callbackFailure: Error | undefined;
      let forceTimer: NodeJS.Timeout | undefined;
      let remainingMembers: ProcessIdentity[] = [];
      const deadline = setTimeout(() => {
        timedOut = true;
        if (alive(owner)) remainingMembers = groupMembers(owner.pid);
        signalObservedGroup(owner.pid, remainingMembers, 'SIGTERM');
        forceTimer = setTimeout(() => { signalObservedGroup(owner.pid, remainingMembers, 'SIGKILL'); }, 2000);
      }, options.timeoutSeconds * 1000);
      child.once('exit', () => {
        // Pipes can outlive the group leader. Keep exact descendant identities
        // so the finite timeout can kill a child that ignores SIGTERM.
        remainingMembers = [...remainingMembers, ...groupMembers(owner.pid)];
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        try { if (log !== undefined) fs.writeSync(log, chunk); }
        catch (error: unknown) { callbackFailure = error instanceof Error ? error : new Error('Command log write failed.', {cause: error}); signalOwnedGroup(owner, 'SIGKILL'); }
        stdout = (stdout + chunk.toString('utf8')).slice(-CAPTURE_LIMIT);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        try { if (log !== undefined) fs.writeSync(log, chunk); }
        catch (error: unknown) { callbackFailure = error instanceof Error ? error : new Error('Command log write failed.', {cause: error}); signalOwnedGroup(owner, 'SIGKILL'); }
        stderr = (stderr + chunk.toString('utf8')).slice(-CAPTURE_LIMIT);
      });
      child.stdin?.once('error', (error) => { callbackFailure = error; signalOwnedGroup(owner, 'SIGKILL'); });
      child.once('spawn', () => {
        owner = identity(child.pid);
        try {
          options.onSpawn?.(owner);
          if (options.input) child.stdin?.write(options.input);
          child.stdin?.end();
        } catch (error: unknown) {
          clearTimeout(deadline);
          signalOwnedGroup(owner, 'SIGKILL');
          callbackFailure = error instanceof Error ? error : new Error('Command onSpawn callback failed.', {cause: error});
        }
      });
      child.once('error', (error) => {
        spawnFailure = {code: errorCode(error), message: error.message};
        stderr += error.message;
      });
      child.once('close', (code, signal) => {
        clearTimeout(deadline);
        if (forceTimer) clearTimeout(forceTimer);
        if (callbackFailure) { reject(callbackFailure); return; }
        const result: CommandResult = {code: spawnFailure ? 127 : code ?? 128, stdout, stderr, timedOut, process: owner};
        if (signal) result.signal = signal;
        if (spawnFailure) result.spawnError = spawnFailure;
        resolve(result);
      });
    });
  } finally {
    if (log !== undefined) { fs.fsyncSync(log); fs.closeSync(log); }
  }
}
