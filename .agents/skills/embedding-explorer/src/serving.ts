/** Owns native serving, readiness, device capture and exact-owned resource cleanup. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {GateError, arrayValue, asRecord, cloneJson, digest, integerValue, load, loadRecord, now, omitRecordKeys, save, stringValue} from '../../../harness/common.ts';
import type {JsonObject} from '../../../harness/common.ts';
import {runCommand} from '../../../harness/processes.ts';
import {event, executeAttemptCommand, invalidateValidation, positiveAttemptInteger, remainingAttemptSeconds, retainAttemptFailure, withAttemptExecution} from './attempts.ts';
import type {CheckedAttempt} from './attempts.ts';
import {assertOwned, creationRecorded, inspectDocker, inspectionPresent, labelsOf} from './resources.ts';
import {validateImages} from '../../embedding-upstream/src/build.ts';

/** Defines the local API binding for a concrete container attempt. */
export interface ServeOptions { port?: number; bind?: string; }

function gate(code: string, message: string, evidence: string[] = [], nextAction = 'inspect evidence and create a justified recovery attempt'): never {
  throw new GateError(code, message, {evidence, nextAction, retryable: false});
}

function recordClone(value: unknown): JsonObject {
  return asRecord(cloneJson(value));
}

function strings(value: unknown, label: string): string[] {
  return arrayValue(value, label).map((item) => stringValue(item, label));
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) throw error;
  return error.message;
}

function containerNames(attempt: CheckedAttempt, options: ServeOptions): JsonObject {
  const port = options.port ?? 8080;
  const bind = options.bind ?? '127.0.0.1';
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(bind) || bind.split('.').some((part) => Number(part) > 255)) gate('invalid_api_binding', 'Provide a valid IPv4 API bind and port in 1..65535.');
  const name = `easy-emb-${digest(attempt.path).slice(0, 12)}`;
  return {api: name, backend: attempt.settings.engine === 'tei' ? `${name}-backend` : null,
    network: attempt.settings.engine === 'tei' ? `${name}-net` : null,
    base_url: `http://127.0.0.1:${port}`, bind, port};
}

function checkedContainerNames(attempt: CheckedAttempt): JsonObject {
  const filename = path.join(attempt.path, 'containers.json');
  const recorded = loadRecord(filename);
  const expected = containerNames(attempt, {port: integerValue(recorded.port, 'recorded API port'), bind: stringValue(recorded.bind, 'recorded API bind')});
  if (digest(recorded) !== digest(expected)) gate('container_binding_changed', 'Recorded resource names must match this exact attempt path and binding.', [filename]);
  return recorded;
}

function resourceIdentity(attempt: CheckedAttempt, role: string, info: JsonObject): void {
  const kind = role === 'network' ? 'network' : 'container';
  assertOwned(info, attempt, kind);
  const names = checkedContainerNames(attempt);
  const name = stringValue(names[role], 'owned resource name');
  const actualName = stringValue(info.Name, 'observed resource name');
  if (actualName !== name && actualName !== `/${name}`) gate('resource_name_mismatch', 'Docker returned a resource with another canonical name.', [attempt.path]);
  const id = stringValue(info.Id, 'resource ID');
  const filename = path.join(attempt.path, 'resource-identities.json');
  const ledger = fs.existsSync(filename) ? loadRecord(filename) : {schema: 'embedding-resource-identities/1', attempt_id: attempt.settings.id, strategy_id: attempt.strategy.id, input_identity: attempt.settings.input_identity ?? null, resources: {}};
  if (ledger.attempt_id !== attempt.settings.id || ledger.strategy_id !== attempt.strategy.id || ledger.input_identity !== (attempt.settings.input_identity ?? null) || (ledger.digest !== undefined && ledger.digest !== digest(omitRecordKeys(ledger, ['digest'])))) gate('resource_identity_record_changed', 'Preserved resource identity does not match this approved attempt.', [filename]);
  const resources = asRecord(ledger.resources, 'owned resources');
  const recorded = resources[role] === undefined ? undefined : asRecord(resources[role], 'original resource');
  const image = kind === 'container' ? stringValue(info.Image, 'container image') : null;
  if (recorded && (recorded.id !== id || recorded.image !== image || recorded.name !== name)) gate('resource_identity_changed', 'The named Docker resource has been replaced since its original identity was recorded.', [filename]);
  if (kind === 'container') {
    const imageRole = role === 'api' && attempt.settings.engine === 'tei' ? 'gateway' : 'backend';
    const originalImage = asRecord(loadRecord(path.join(attempt.path, 'images.json'))[imageRole], 'original built image');
    if (image !== originalImage.id) gate('container_image_mismatch', 'The owned container differs from its recorded native build.', [filename]);
    const priorPath = path.join(attempt.path, `container-${role}.json`);
    if (!recorded && fs.existsSync(priorPath)) {
      const prior = asRecord(arrayValue(load(priorPath), 'original container observation')[0]);
      assertOwned(prior, attempt, 'container');
      if (prior.Id !== id || prior.Image !== image) gate('resource_identity_changed', 'The named resource differs from the preserved original container observation.', [priorPath]);
    } else if (!recorded && !creationRecorded(attempt, role, id)) {
      gate('resource_identity_missing', 'Cleanup or reconciliation requires an original ID in the creation log or preserved container observation.', [priorPath]);
    }
  }
  if (!recorded && kind === 'network' && !creationRecorded(attempt, role, id)) gate('resource_identity_missing', 'Network cleanup or reconciliation requires its original ID in the retained creation log.', [attempt.path]);
  if (!recorded) {
    resources[role] = {id, image, name, labels: {'easy-emb.attempt': attempt.settings.id, 'easy-emb.strategy': attempt.strategy.id}, observed_at: now()};
    ledger.digest = digest(omitRecordKeys(ledger, ['digest']));
    save(filename, ledger);
    event(attempt.path, 'resource_identity_preserved', {role, id, image, name});
  }
}

function assertResourceUncreated(attempt: CheckedAttempt, role: string): void {
  const filename = path.join(attempt.path, 'resource-identities.json');
  if (fs.existsSync(filename) && asRecord(loadRecord(filename).resources)[role] !== undefined) gate('resource_recreation_requires_attempt', 'An original Docker resource disappeared; a replacement must use a new attempt so original IDs remain valid for cleanup and results.', [filename], 'capture and stop remaining owned resources, then render a new attempt');
}

function overlayModel(attempt: CheckedAttempt): string {
  if (attempt.settings.engine !== 'tei' || attempt.settings.model_config_overrides === undefined) return '/model';
  const source = stringValue(attempt.strategy.model_path);
  const directory = path.join(attempt.path, 'model-overlay');
  fs.mkdirSync(directory, {recursive: true});
  for (const name of fs.readdirSync(source)) {
    if (name === 'config.json') continue;
    const target = path.join(directory, name);
    if (fs.lstatSync(directory).isSymbolicLink()) gate('model_overlay_collision', 'Model overlay directory cannot be a symbolic link.', [directory]);
    try {
      fs.symlinkSync(`/model/${name}`, target);
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      if (!('code' in error) || error.code !== 'EEXIST' || fs.readlinkSync(target) !== `/model/${name}`) throw error;
    }
  }
  const model = loadRecord(path.join(source, 'config.json'));
  Object.assign(model, asRecord(attempt.settings.model_config_overrides));
  save(path.join(directory, 'config.json'), model);
  save(path.join(attempt.path, 'model-config-patch.json'), {source, changes: attempt.settings.model_config_overrides, reason: attempt.settings.model_config_override_reason});
  return '/run/embedding/model-overlay';
}

function assertRunningContainer(info: JsonObject, attempt: CheckedAttempt, imageId: string, role: string): void {
  assertOwned(info, attempt, 'container');
  if (info.Image !== imageId) gate('container_image_mismatch', `Owned ${role} container uses another image.`, [attempt.path]);
  if (asRecord(info.State).Running !== true) gate('owned_container_stopped', `Owned ${role} container stopped; capture evidence and clean it through its owner before recovery.`, [attempt.path]);
}

function getLocalJson(address: string, timeoutMs: number): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const request = http.get(address, {agent: false}, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 2_000_000) request.destroy(new Error('Readiness response exceeds its finite size bound.'));
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Readiness HTTP ${response.statusCode ?? 'unknown'}`));
          return;
        }
        try {
          const value: unknown = JSON.parse(body);
          resolve(asRecord(value, 'readiness response'));
        } catch (error: unknown) {
          if (!(error instanceof Error)) throw error;
          reject(error);
        }
      });
      response.on('error', (error: Error) => { reject(error); });
    });
    request.setTimeout(timeoutMs, () => { request.destroy(new Error('Readiness request timed out.')); });
    const deadline = setTimeout(() => { request.destroy(new Error('Readiness request exceeded its wall-clock deadline.')); }, timeoutMs);
    request.once('close', () => { clearTimeout(deadline); });
    request.on('error', (error: Error) => { reject(error); });
  });
}

/** Freezes corroborating TEI device observations; approval alone is never device proof. */
export function collectDeviceEvidence(attemptPath: string): void {
  const cfg = loadRecord(path.join(attemptPath, 'settings.yaml'));
  if (cfg.engine !== 'tei') return;
  const strategy = loadRecord(path.join(attemptPath, 'strategy.yaml'));
  const info = asRecord(arrayValue(load(path.join(attemptPath, 'container-backend.json')))[0], 'backend observation');
  const labels = labelsOf(info, 'container');
  if (labels['easy-emb.attempt'] !== cfg.id || labels['easy-emb.strategy'] !== strategy.id || asRecord(info.State).Running !== true || info.Image !== asRecord(loadRecord(path.join(attemptPath, 'images.json')).backend).id) return;
  const logs = fs.readFileSync(path.join(attemptPath, 'container-backend.log'), 'utf8');
  const selected = /Starting \w+ model on (Cpu|Cuda)/.exec(logs);
  let reason: string | undefined;
  let excerpt: string | undefined;
  const sources: Array<{name: string; content: string; excerpt: string}> = [];
  if (selected && (selected[1] === 'Cpu') === (strategy.device === 'cpu')) {
    reason = 'Observed TEI Candle model device in current backend startup log';
    excerpt = selected[0];
  } else if (strategy.device === 'cpu' && !selected) {
    const filename = path.join(attemptPath, 'build-backend.log');
    if (!fs.existsSync(filename)) return;
    const buildLog = fs.readFileSync(filename, 'utf8');
    const cpuSource = stringValue(asRecord(cfg.platform).tei_image);
    const ready = logs.split('\n').find((line) => line.includes('"message":"Ready"'));
    const hostConfig = asRecord(info.HostConfig);
    const requests = hostConfig.DeviceRequests;
    const devices = hostConfig.Devices;
    if (cpuSource.includes(':cpu-') && buildLog.includes(cpuSource) && ready && (requests === null || requests === undefined || arrayValue(requests).length === 0) && (devices === null || devices === undefined || arrayValue(devices).length === 0)) {
      reason = 'Observed CPU artifact, matching running image, no accelerator assignment and completed model warmup; not a direct provider API probe';
      excerpt = ready;
      sources.push({name: 'build.log', content: buildLog, excerpt: cpuSource});
    }
  }
  if (!reason || !excerpt) return;
  const token = digest({container: info.Id, started: asRecord(info.State).StartedAt ?? null, logs}).slice(0, 20);
  sources.push({name: 'startup.log', content: logs, excerpt}, {name: 'container.json', content: JSON.stringify(info, null, 2), excerpt: stringValue(info.Image)});
  const observations: JsonObject[] = [];
  for (const source of sources) {
    const relative = path.join('device-observations', token, source.name);
    fs.mkdirSync(path.dirname(path.join(attemptPath, relative)), {recursive: true});
    fs.writeFileSync(path.join(attemptPath, relative), source.content);
    observations.push({file: relative, digest: digest(source.content), excerpt: source.excerpt});
  }
  save(path.join(attemptPath, 'device-evidence.json'), {attempt_id: cfg.id, device: strategy.device, observed_at: now(), basis: reason, observations});
}

async function captureOwned(attempt: CheckedAttempt): Promise<void> {
  const containers = checkedContainerNames(attempt);
  let observedBackend = false;
  for (const role of ['api', 'backend']) {
    const name = containers[role];
    if (typeof name !== 'string') continue;
    const inspected = await inspectDocker('container', name);
    if (inspected.status === 'absent') {
      event(attempt.path, 'capture_resource_absent', {role, name});
      continue;
    }
    const info = inspectionPresent(inspected, name);
    resourceIdentity(attempt, role, info);
    save(path.join(attempt.path, `container-${role}.json`), [info]);
    const logPath = path.join(attempt.path, 'captures', randomUUID(), `container-${role}.log`);
    const logs = await runCommand(['docker', 'logs', stringValue(info.Id)], {timeoutSeconds: 30, effect: 'observe', logPath});
    if (logs.code !== 0 || logs.timedOut || logs.spawnError) {
      event(attempt.path, 'capture_probe_failed', {role, verb: 'logs', returncode: logs.code, stdout: logs.stdout, stderr: logs.stderr, timed_out: logs.timedOut});
      continue;
    }
    fs.copyFileSync(logPath, path.join(attempt.path, `container-${role}.log`));
    if (role === 'backend') observedBackend = true;
  }
  if (observedBackend) collectDeviceEvidence(attempt.path);
}

/** Captures owned resources under the same lease and campaign phase as its caller. */
export async function capture(attemptPath: string): Promise<void> {
  await withAttemptExecution(attemptPath, 'capture', async (attempt) => {
    if (fs.existsSync(path.join(attempt.path, 'containers.json'))) await captureOwned(attempt);
  });
}

/** Starts or reconciles only owned native containers, then verifies bounded readiness. */
export async function serve(attemptPath: string, options: ServeOptions = {}): Promise<JsonObject> {
  return withAttemptExecution(attemptPath, 'serve', async (attempt) => {
    const cfg = attempt.settings;
    if (['build_failed', 'startup_failed', 'interrupted', 'stopped'].includes(stringValue(cfg.state))) gate('recovery_required', 'A failed or stopped serving process needs a new attempt before starting another process.');
    const images = await validateImages(attempt);
    const names = containerNames(attempt, options);
    const recordPath = path.join(attempt.path, 'containers.json');
    if (fs.existsSync(recordPath) && digest(loadRecord(recordPath)) !== digest(names)) gate('container_binding_changed', 'Stored resource names and binding differ; stop the owned resources before changing them.', [recordPath]);
    const runtime = recordClone(attempt.strategy);
    Object.assign(runtime, {engine: cfg.engine, attempt_id: cfg.id, torch_device: asRecord(cfg.platform).torch_device,
      dtype: cfg.dtype, backend_timeout_seconds: asRecord(cfg.limits).functional_timeout_seconds});
    save(path.join(attempt.path, 'runtime.json'), runtime);
    const modelId = overlayModel(attempt);
    const mount = ['--mount', `type=bind,src=${attempt.strategy.model_path},dst=/model,readonly`, '--mount', `type=bind,src=${attempt.path},dst=/run/embedding,readonly`];
    const owner = ['--label', `easy-emb.attempt=${cfg.id}`, '--label', `easy-emb.strategy=${attempt.strategy.id}`];
    const dockerArgs = strings(asRecord(cfg.platform).docker_args ?? [], 'platform Docker args');
    const apiName = stringValue(names.api);
    const backendImage = stringValue(asRecord(images.backend).id);
    const apiImage = cfg.engine === 'tei' ? stringValue(asRecord(images.gateway).id) : backendImage;
    const api = await inspectDocker('container', apiName);
    if (api.status === 'absent') assertResourceUncreated(attempt, 'api');
    save(recordPath, names);
    try {
      if (api.status === 'present') {
        const info = inspectionPresent(api, apiName);
        assertRunningContainer(info, attempt, apiImage, 'API');
        resourceIdentity(attempt, 'api', info);
        const ports = asRecord(asRecord(info.NetworkSettings).Ports);
        const bindings = arrayValue(ports['8080/tcp'], 'actual API binding').map((binding) => asRecord(binding));
        if (!bindings.some((binding) => binding.HostIp === names.bind && binding.HostPort === String(names.port))) gate('container_binding_changed', 'Running API port differs from the stored binding.', [recordPath]);
        if (typeof names.backend === 'string') {
          const backend = inspectionPresent(await inspectDocker('container', names.backend), names.backend);
          assertRunningContainer(backend, attempt, backendImage, 'backend');
          resourceIdentity(attempt, 'backend', backend);
          resourceIdentity(attempt, 'network', inspectionPresent(await inspectDocker('network', stringValue(names.network)), 'network'));
        }
        event(attempt.path, 'running_container_reconciled', {container: apiName, state: info.State});
      } else {
        cfg.state = 'starting';
        save(path.join(attempt.path, 'settings.yaml'), cfg);
        invalidateValidation(attempt.path, 'New container process requires fresh verification.');
        let apiArgs = dockerArgs;
        if (cfg.engine === 'tei') {
          const networkName = stringValue(names.network);
          const network = await inspectDocker('network', networkName);
          if (network.status === 'absent') {
            assertResourceUncreated(attempt, 'network');
            await executeAttemptCommand(attempt.path, 'network-create', ['docker', 'network', 'create', ...owner, networkName], 30);
          }
          else assertOwned(inspectionPresent(network, networkName), attempt, 'network');
          resourceIdentity(attempt, 'network', inspectionPresent(await inspectDocker('network', networkName), networkName));
          const backendName = stringValue(names.backend);
          const backend = await inspectDocker('container', backendName);
          if (backend.status === 'absent') {
            assertResourceUncreated(attempt, 'backend');
            await executeAttemptCommand(attempt.path, 'start-backend', ['docker', 'run', '-d', '--name', backendName, ...owner, '--network', networkName, ...mount, ...dockerArgs, backendImage,
              '--model-id', modelId, '--port', '80', '--dtype', stringValue(cfg.dtype), '--auto-truncate', 'false', '--max-batch-tokens', String(Math.max(16384, positiveAttemptInteger(attempt.strategy.context_window, 'context window'))), '--json-output'], 60);
          } else assertRunningContainer(inspectionPresent(backend, backendName), attempt, backendImage, 'backend');
          resourceIdentity(attempt, 'backend', inspectionPresent(await inspectDocker('container', backendName), backendName));
          apiArgs = ['--network', networkName, '-e', `EMB_TEI_URL=http://${backendName}:80`];
        }
        await executeAttemptCommand(attempt.path, 'start-api', ['docker', 'run', '-d', '--name', apiName, ...owner, ...apiArgs, ...mount,
          '-p', `${names.bind}:${names.port}:8080`, '-e', 'HF_HUB_OFFLINE=1', '-e', 'TRANSFORMERS_OFFLINE=1', apiImage, '--config', '/run/embedding/runtime.json'], 60);
        resourceIdentity(attempt, 'api', inspectionPresent(await inspectDocker('container', apiName), apiName));
      }
      const deadline = performance.now() + Math.min(positiveAttemptInteger(asRecord(cfg.limits).startup_timeout_seconds, 'startup timeout'), remainingAttemptSeconds(attempt)) * 1000;
      let last = 'No readiness response';
      while (performance.now() < deadline) {
        try {
          const baseUrl = stringValue(names.base_url);
          await getLocalJson(`${baseUrl}/health`, Math.min(5000, Math.max(1, deadline - performance.now())));
          const info = await getLocalJson(`${baseUrl}/info`, Math.min(5000, Math.max(1, deadline - performance.now())));
          if (info.attempt_id !== cfg.id || info.strategy_id !== attempt.strategy.id || info.context_window !== attempt.strategy.context_window || info.dimensions !== attempt.strategy.dimensions) gate('runtime_identity_mismatch', 'Ready endpoint belongs to another strategy or settings.', [recordPath]);
          cfg.state = 'serving';
          delete cfg.error;
          save(path.join(attempt.path, 'settings.yaml'), cfg);
          await capture(attempt.path);
          return {attempt: attempt.path, state: 'serving', base_url: names.base_url};
        } catch (error: unknown) {
          if (error instanceof GateError) throw error;
          last = errorMessage(error);
        }
        for (const role of ['api', 'backend']) {
          if (typeof names[role] !== 'string') continue;
          const observed = inspectionPresent(await inspectDocker('container', stringValue(names[role])), role);
          assertRunningContainer(observed, attempt, role === 'api' ? apiImage : backendImage, role);
        }
        await delay(Math.min(2000, Math.max(1, deadline - performance.now())));
      }
      gate('startup_deadline', `Readiness deadline expired: ${last}`, [attempt.path]);
    } catch (error: unknown) {
      retainAttemptFailure(attempt, 'serve', error);
      await capture(attempt.path);
      throw error;
    }
  });
}

/** Removes only this exact attempt's labeled resources after successful ownership probes. */
export async function stop(attemptPath: string): Promise<JsonObject> {
  return withAttemptExecution(attemptPath, 'stop', async (attempt) => {
    const filename = path.join(attempt.path, 'containers.json');
    if (!fs.existsSync(filename)) return {attempt: attempt.path, state: 'stopped', evidence: 'No containers created'};
    await captureOwned(attempt);
    const containers = checkedContainerNames(attempt);
    const removals: Array<{role: string; id: string}> = [];
    for (const role of ['api', 'backend']) {
      const name = containers[role];
      if (typeof name !== 'string') continue;
      const observed = await inspectDocker('container', name);
      if (observed.status === 'absent') continue;
      const info = inspectionPresent(observed, name);
      resourceIdentity(attempt, role, info);
      removals.push({role, id: stringValue(info.Id, 'owned container ID')});
    }
    if (typeof containers.network === 'string') {
      const observed = await inspectDocker('network', containers.network);
      if (observed.status === 'present') {
        const info = inspectionPresent(observed, containers.network);
        resourceIdentity(attempt, 'network', info);
        removals.push({role: 'network', id: stringValue(info.Id, 'owned network ID')});
      }
    }
    for (const removal of removals) {
      const argv = removal.role === 'network' ? ['docker', 'network', 'rm', removal.id] : ['docker', 'rm', '-f', removal.id];
      await executeAttemptCommand(attempt.path, removal.role === 'network' ? 'remove-network' : `stop-${removal.role}`, argv, removal.role === 'network' ? 30 : 60);
    }
    attempt.settings.state = 'stopped';
    save(path.join(attempt.path, 'settings.yaml'), attempt.settings);
    return {attempt: attempt.path, state: 'stopped', evidence: 'retained'};
  });
}
