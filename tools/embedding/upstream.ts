/** Resolves official inputs once and verifies their immutable preparation snapshot. */
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {ROOT, GateError, arrayValue, asRecord, cloneJson, digest, loadRecord, now, omitRecordKeys, save, stringValue} from './common.ts';
import type {JsonObject} from './common.ts';
import {selectPlatform} from './hardware.ts';
import {runCommand, withExecutionLease} from './processes.ts';

const RELEASES = [
  {key: 'tei', repository: 'huggingface/text-embeddings-inference'},
  {key: 'sentence_transformers', repository: 'huggingface/sentence-transformers'},
];
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const PYPI_INDEX = 'https://pypi.org/simple';
const DEPENDENCY_CONTRACT = 'pypi-with-frozen-pytorch-wheels/1';

/** Frozen official source and distribution identities; snake_case preserves disk contracts. */
export interface ReleaseSnapshot extends JsonObject {
  schema: string;
  id: string;
  resolved_at: string;
  releases: JsonObject;
  versions: JsonObject;
  platforms: JsonObject[];
  images: JsonObject;
  distributions: JsonObject;
}

/** Preparation inputs; the default output is the explicit lock consumed by render. */
export interface ResolveOptions {
  outputPath?: string;
  sourceRoot?: string;
  manifestPath?: string;
  platformsPath?: string;
  versionsPath?: string;
  timeoutSeconds?: number;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function fail(code: string, message: string, evidence: string[] = []): never {
  throw new GateError(code, message, {evidence, nextAction: 'upstream prepare', retryable: true});
}

function recordClone(value: unknown, label: string): JsonObject {
  return asRecord(cloneJson(value), label);
}

function officialUrl(value: unknown, domains: readonly string[], label: string): string {
  const address = stringValue(value, label);
  const url = new URL(address);
  if (url.protocol !== 'https:' || !domains.includes(url.hostname) || url.username || url.password) {
    fail('upstream_untrusted_source', `${label} must use its official HTTPS distribution host.`);
  }
  return address;
}

async function command(argv: string[], timeoutSeconds: number, cwd?: string, effect: 'observe' | 'mutate' = 'observe'): Promise<string> {
  const result = await runCommand(argv, {cwd, timeoutSeconds, effect});
  if (result.code !== 0 || result.timedOut || result.spawnError) {
    fail('upstream_observation_failed', `Official input observation failed: ${argv.join(' ')}\n${result.stderr || result.spawnError?.message || result.stdout}`);
  }
  return result.stdout;
}

async function remoteJson(address: string, timeoutSeconds: number): Promise<{value: JsonObject; raw: string}> {
  const raw = await command(['curl', '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '15', '--max-time', String(timeoutSeconds), '-H', 'Accept: application/vnd.github+json', '-H', 'User-Agent: easy-emb-upstream', address], timeoutSeconds + 5);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    fail('upstream_invalid_response', `Invalid JSON from ${address}: ${error.message}`);
  }
  return {value: asRecord(value, address), raw};
}

function sourceFiles(directory: string, prefix = ''): JsonObject[] {
  const files: JsonObject[] = [];
  const names = fs.readdirSync(directory).toSorted();
  for (const name of names) {
    if (name === '.git') continue;
    const fullPath = path.join(directory, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      files.push({path: relative, kind: 'symlink', target: fs.readlinkSync(fullPath)});
    } else if (stat.isDirectory()) {
      files.push(...sourceFiles(fullPath, relative));
    } else if (stat.isFile()) {
      files.push({path: relative, kind: 'file', executable: Boolean(stat.mode & 0o111), sha256: sha256(fs.readFileSync(fullPath))});
    } else {
      fail('upstream_source_type', `Unsupported entry in frozen source: ${fullPath}`);
    }
  }
  return files;
}

async function checkoutRelease(repository: string, commit: string, sourceRoot: string, timeoutSeconds: number): Promise<JsonObject> {
  const target = path.join(sourceRoot, `${repository.split('/')[1]}-${commit}`);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, {recursive: true});
    await command(['git', 'init', '--quiet', target], timeoutSeconds, undefined, 'mutate');
    await command(['git', '-C', target, 'remote', 'add', 'origin', `https://github.com/${repository}.git`], timeoutSeconds, undefined, 'mutate');
    await command(['git', '-C', target, 'fetch', '--depth', '1', 'origin', commit], timeoutSeconds, undefined, 'mutate');
    await checkoutNativeSource(target, timeoutSeconds);
  }
  const actualOrigin = (await command(['git', '-C', target, 'remote', 'get-url', 'origin'], timeoutSeconds)).trim();
  if (actualOrigin !== `https://github.com/${repository}.git` || fs.lstatSync(target).isSymbolicLink()) fail('upstream_source_changed', `Source checkout ownership/remote changed: ${target}`, [target]);
  const head = await runCommand(['git', '-C', target, 'rev-parse', '--verify', 'HEAD'], {timeoutSeconds, effect: 'observe'});
  if (head.code !== 0 && !head.timedOut && !head.spawnError && fs.readdirSync(target).some((name) => name !== '.git')) {
    const files = await verifiedPartialCheckout(target, commit, timeoutSeconds);
    const preserved = `${target}-interrupted-${now().replaceAll(':', '').replaceAll('.', '-')}`;
    const recoveryPath = path.join(sourceRoot, 'recovery-evidence', `${repository.replace('/', '-')}-${now().replaceAll(':', '').replaceAll('.', '-')}.json`);
    save(recoveryPath, {at: now(), repository, commit, target, preserved, evidence_kind: 'measured', files,
      decision: 'Every materialized file matches a fetched commit blob; preserve interrupted LFS checkout unchanged and retry native source with LFS pointer blobs.'});
    fs.renameSync(target, preserved);
    return await checkoutRelease(repository, commit, sourceRoot, timeoutSeconds);
  }
  if (head.code !== 0 && !head.timedOut && !head.spawnError && fs.readdirSync(target).every((name) => name === '.git')) {
    const recoveryPath = path.join(sourceRoot, 'recovery-evidence', `${repository.replace('/', '-')}-${now().replaceAll(':', '').replaceAll('.', '-')}.json`);
    save(recoveryPath, {at: now(), repository, commit, target, evidence_kind: 'measured', previous_head_probe: {code: head.code, stdout: head.stdout, stderr: head.stderr},
      decision: 'Resume interrupted initial fetch only after exact official origin and empty worktree verification.'});
    await command(['git', '-C', target, 'fetch', '--depth', '1', 'origin', commit], timeoutSeconds, undefined, 'mutate');
    await checkoutNativeSource(target, timeoutSeconds);
  }
  const actualCommit = (await command(['git', '-C', target, 'rev-parse', '--verify', 'HEAD'], timeoutSeconds)).trim();
  const dirty = (await command(['git', '-C', target, 'status', '--porcelain', '--untracked-files=all'], timeoutSeconds)).trim();
  if (actualOrigin !== `https://github.com/${repository}.git` || actualCommit !== commit || dirty) {
    fail('upstream_source_changed', `Existing source checkout differs from its official immutable commit: ${target}`, [target]);
  }
  const files = sourceFiles(target);
  return {path: fs.realpathSync(target), commit, files_digest: digest(files), files,
    lfs_policy: 'Native source is checked out exactly; optional Git LFS media retain their committed pointer blobs.'};
}

async function checkoutNativeSource(target: string, timeoutSeconds: number): Promise<void> {
  await command(['git', '-C', target, '-c', 'filter.lfs.process=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.required=false', 'checkout', '--detach', '--quiet', 'FETCH_HEAD'], timeoutSeconds, undefined, 'mutate');
}

async function verifiedPartialCheckout(target: string, commit: string, timeoutSeconds: number): Promise<JsonObject[]> {
  const raw = await command(['git', '-C', target, 'ls-tree', '-r', '-z', '--full-tree', commit], timeoutSeconds);
  const expected = new Map<string, string>();
  for (const row of raw.split('\0')) {
    if (!row) continue;
    const item = /^\d+ blob ([a-f0-9]{40})\t(.+)$/s.exec(row);
    if (item?.[1] && item[2]) expected.set(item[2], item[1]);
  }
  const verified: JsonObject[] = [];
  for (const entry of sourceFiles(target)) {
    const name = stringValue(entry.path);
    const filename = path.join(target, name);
    const bytes = entry.kind === 'symlink' ? Buffer.from(stringValue(entry.target)) : fs.readFileSync(filename);
    const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (expected.get(name) !== actual) fail('upstream_partial_source_changed', 'Interrupted checkout contains content not verified against the fetched official commit; preserve it for inspection.', [filename]);
    verified.push({path: name, git_blob: actual});
  }
  if (verified.length === 0) fail('upstream_partial_source_empty', 'No materialized source file could be verified.', [target]);
  return verified;
}

async function resolveRelease(repository: string, sourceRoot: string, evidenceRoot: string, timeoutSeconds: number): Promise<JsonObject> {
  const apiUrl = `https://api.github.com/repos/${repository}/releases/latest`;
  const release = await remoteJson(apiUrl, timeoutSeconds);
  if (release.value.draft !== false || release.value.prerelease !== false) {
    fail('upstream_not_stable', `The official latest release for ${repository} is not a published stable release.`);
  }
  const tag = stringValue(release.value.tag_name, 'release tag');
  if (!/^v?\d+\.\d+\.\d+$/.test(tag)) {
    fail('upstream_release_version', `Unsupported stable release tag: ${tag}`);
  }
  const releaseUrl = officialUrl(release.value.html_url, ['github.com'], 'release URL');
  if (!releaseUrl.startsWith(`https://github.com/${repository}/releases/tag/`)) {
    fail('upstream_release_repository', `Release metadata does not belong to ${repository}.`);
  }
  const resolved = await remoteJson(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(tag)}`, timeoutSeconds);
  const commit = stringValue(resolved.value.sha, 'release commit');
  if (!COMMIT_PATTERN.test(commit)) fail('upstream_release_commit', 'Official release did not resolve to a full commit SHA.');
  const source = await checkoutRelease(repository, commit, sourceRoot, timeoutSeconds);
  const prefix = repository.replace('/', '-');
  fs.mkdirSync(evidenceRoot, {recursive: true});
  const releaseFile = path.join(evidenceRoot, `${prefix}-release.json`);
  const commitFile = path.join(evidenceRoot, `${prefix}-commit.json`);
  fs.writeFileSync(releaseFile, release.raw);
  fs.writeFileSync(commitFile, resolved.raw);
  return {
    repository, tag, version: tag.replace(/^v/, ''), commit,
    api_url: apiUrl, release_url: releaseUrl,
    published_at: stringValue(release.value.published_at, 'published_at'),
    draft: false, prerelease: false, observed_at: now(), source,
    evidence: [{path: releaseFile, sha256: sha256(release.raw)}, {path: commitFile, sha256: sha256(resolved.raw)}],
  };
}

function versionedTeiImage(reference: string, release: JsonObject): string {
  const mutable = reference.split('@')[0];
  if (!mutable || !mutable.startsWith('ghcr.io/huggingface/text-embeddings-inference:')) {
    fail('upstream_tei_repository', 'TEI image must be an official Hugging Face image.');
  }
  const version = stringValue(release.version, 'TEI version');
  const line = version.split('.').slice(0, 2).join('.');
  return mutable.replace(/\d+\.\d+(?:\.\d+)?$/, line);
}

async function resolveImage(reference: string, timeoutSeconds: number): Promise<JsonObject> {
  const mutable = reference.split('@')[0];
  if (!mutable) fail('upstream_image_reference', 'An image reference is required.');
  const raw = await command(['docker', 'buildx', 'imagetools', 'inspect', mutable, '--format', '{{json .Manifest}}'], timeoutSeconds);
  let descriptor: unknown;
  try {
    descriptor = JSON.parse(raw);
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    fail('upstream_image_descriptor', `Cannot parse image descriptor: ${error.message}`);
  }
  const metadata = asRecord(descriptor, 'image descriptor');
  const imageDigest = stringValue(metadata.digest ?? metadata.Digest, 'image manifest digest');
  if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) {
    fail('upstream_image_digest', `Image did not resolve to an immutable SHA256 digest: ${mutable}`);
  }
  const pinned = `${mutable}@${imageDigest}`;
  const imageRaw = await command(['docker', 'buildx', 'imagetools', 'inspect', pinned, '--format', '{{json .Image}}'], timeoutSeconds);
  let imageMetadata: unknown;
  try {
    imageMetadata = JSON.parse(imageRaw);
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    fail('upstream_image_config', `Cannot parse image configuration: ${error.message}`);
  }
  return {reference: mutable, pinned, digest: imageDigest, descriptor: metadata, image_metadata: imageMetadata, observed_at: now()};
}

function verifyTeiImage(image: JsonObject, release: JsonObject): void {
  const metadata = asRecord(image.image_metadata, 'TEI image metadata');
  const variants = 'config' in metadata ? [metadata] : Object.values(metadata).map((value) => asRecord(value, 'TEI image platform'));
  if (variants.length === 0) fail('upstream_image_release_unverified', 'TEI image configuration is absent.');
  for (const variant of variants) {
    const labels = asRecord(asRecord(variant.config, 'TEI image configuration').Labels, 'TEI OCI labels');
    const version = stringValue(labels['org.opencontainers.image.version'], 'TEI OCI version');
    const expected = stringValue(release.version, 'TEI stable version');
    if (labels['org.opencontainers.image.revision'] !== release.commit || (version !== expected && !version.endsWith(`-${expected}`)) || labels['org.opencontainers.image.source'] !== `https://github.com/${release.repository}`) {
      fail('upstream_image_release_unverified', 'Official TEI image labels do not match the latest stable source commit and version.');
    }
  }
}

async function distributions(packageName: string, version: string, timeoutSeconds: number): Promise<JsonObject> {
  const address = `https://pypi.org/pypi/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}/json`;
  const response = await remoteJson(address, timeoutSeconds);
  const info = asRecord(response.value.info, 'PyPI package info');
  if (stringValue(info.version, 'PyPI version') !== version) {
    fail('upstream_package_version', `PyPI resolved a different ${packageName} version.`);
  }
  const files: JsonObject[] = [];
  for (const item of arrayValue(response.value.urls, 'PyPI distributions')) {
    const file = asRecord(item, 'PyPI distribution');
    if (file.yanked !== false) continue;
    const hashes = asRecord(file.digests, 'PyPI file hashes');
    const hash = stringValue(hashes.sha256, 'PyPI SHA256');
    if (!HASH_PATTERN.test(hash)) fail('upstream_wheel_hash', `Missing official SHA256 for ${packageName}.`);
    files.push({filename: stringValue(file.filename, 'distribution filename'), url: officialUrl(file.url, ['files.pythonhosted.org'], 'distribution URL'), sha256: hash, packagetype: stringValue(file.packagetype, 'package type'), requires_python: file.requires_python ?? null});
  }
  if (files.length === 0) fail('upstream_package_unavailable', `No unyanked official distribution exists for ${packageName}==${version}.`);
  return {package: packageName, version, source: address, metadata_sha256: sha256(response.raw), files};
}

async function verifyTorchWheels(versions: JsonObject, platforms: JsonObject[], architecture: string, timeoutSeconds: number): Promise<void> {
  const wheels = asRecord(versions.torch_wheels ?? {}, 'torch wheel map');
  for (const platform of platforms) {
    const key = `${stringValue(platform.torch_device, 'torch device')}:${architecture}:cp312`;
    const entry = wheels[key];
    if (entry === undefined) continue;
    const wheel = asRecord(entry, key);
    const address = officialUrl(wheel.url, ['download.pytorch.org', 'download-r2.pytorch.org'], 'torch wheel');
    const hash = stringValue(wheel.sha256, 'torch SHA256');
    if (!HASH_PATTERN.test(hash)) fail('upstream_wheel_hash', 'Torch wheel hash must be a full SHA256.');
    const index = officialUrl(wheel.source_index, ['download.pytorch.org', 'download-r2.pytorch.org'], 'torch index');
    const raw = await command(['curl', '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', String(timeoutSeconds), index], timeoutSeconds + 5);
    const filename = decodeURIComponent(new URL(address).pathname.split('/').at(-1) ?? '');
    const links = Array.from(raw.matchAll(/href=["']([^"']+)["']/g), (match) => match[1]);
    const verified = links.some((link) => {
      if (!link) return false;
      const url = new URL(link.replaceAll('&amp;', '&'), index);
      return decodeURIComponent(url.pathname.split('/').at(-1) ?? '') === filename && url.hash === `#sha256=${hash}`;
    });
    if (!verified) fail('upstream_wheel_index_mismatch', `Pinned torch wheel is not present with its exact SHA256 in the official index: ${key}`);
    wheel.verified_at = now();
    wheel.index_sha256 = sha256(raw);
  }
}

function pythonPlatform(architecture: string): string {
  const aliases: Record<string, string> = {x86_64: 'x86_64-unknown-linux-gnu', AMD64: 'x86_64-unknown-linux-gnu', aarch64: 'aarch64-unknown-linux-gnu', arm64: 'aarch64-unknown-linux-gnu', riscv64: 'riscv64-unknown-linux'};
  const target = aliases[architecture];
  if (!target) fail('upstream_dependency_platform', `No sourced binary dependency resolver target matches observed architecture ${architecture}; add an adapter.`);
  return target;
}

async function resolveDependencyLocks(versions: JsonObject, platforms: JsonObject[], architecture: string, root: string, timeoutSeconds: number): Promise<JsonObject> {
  const directory = path.join(root, 'dependencies');
  fs.mkdirSync(directory, {recursive: true});
  const locks: JsonObject = {};
  const resolver = (await command(['uv', '--version'], 15)).trim();
  const targets = new Map<string, JsonObject>();
  targets.set('gateway', {});
  for (const platform of platforms) targets.set(stringValue(platform.id, 'platform ID'), platform);
  for (const [key, platform] of targets) {
    if (!/^[a-z0-9-]+$/.test(key)) fail('upstream_platform_id', 'Platform IDs must be simple names.');
    const requirements: string[] = [];
    if (key === 'gateway') {
      requirements.push(`tokenizers==${stringValue(versions.tokenizers)}`);
    } else {
      const wheelKey = `${stringValue(platform.torch_device)}:${architecture}:cp312`;
      const wheel = asRecord(asRecord(versions.torch_wheels ?? {})[wheelKey] ?? {});
      requirements.push(typeof wheel.url === 'string' ? `torch @ ${wheel.url}#sha256=${stringValue(wheel.sha256)}` : `torch==${stringValue(versions.torch)}`);
      for (const [versionKey, packageName] of [['sentence_transformers', 'sentence-transformers'], ['transformers', 'transformers'], ['tokenizers', 'tokenizers'], ['pillow', 'pillow'], ['torchvision', 'torchvision']]) {
        if (versionKey && packageName && versions[versionKey] !== undefined) requirements.push(`${packageName}==${stringValue(versions[versionKey])}`);
      }
    }
    const inputPath = path.join(directory, `${key}.in`);
    const outputPath = path.join(directory, `${key}.txt`);
    const rawPath = path.join(directory, `${key}.uv.txt`);
    fs.writeFileSync(inputPath, requirements.join('\n') + '\n');
    const argv = ['uv', 'pip', 'compile', '--cache-dir', path.join(root, 'uv-cache'), '--only-binary', ':all:', '--no-python-downloads', '--python-version', '3.12', '--python-platform', pythonPlatform(architecture), '--default-index', 'https://pypi.org/simple', '--prerelease', 'disallow', '--generate-hashes', '--emit-index-url', '--emit-index-annotation', '--no-header', '--output-file', rawPath];
    if (typeof platform.torch_index === 'string') {
      officialUrl(platform.torch_index, ['download.pytorch.org'], 'torch dependency index');
      const backend = new URL(platform.torch_index).pathname.split('/').findLast((part) => part.length > 0);
      if (backend && /^(?:cpu|cu\d+|rocm\d+(?:\.\d+)*)$/.test(backend)) argv.push('--torch-backend', backend);
      else fail('upstream_dependency_backend', 'The observed adapter needs an explicit official binary dependency resolver backend.');
    }
    argv.push(inputPath);
    const result = await runCommand(argv, {timeoutSeconds: Math.max(timeoutSeconds, 600), effect: 'mutate', logPath: path.join(directory, `${key}.log`)});
    if (result.code !== 0 || result.timedOut || result.spawnError) fail('upstream_dependency_resolution', `Binary dependency freezing failed for ${key}: ${result.stderr || result.spawnError?.message || result.stdout}`, [path.join(directory, `${key}.log`)]);
    const raw = fs.readFileSync(rawPath, 'utf8');
    const torchIndex = platform.torch_index === undefined ? undefined : stringValue(platform.torch_index);
    const indexes = new Map<string, DependencyIndexEvidence>();
    const indexPaths = new Map<string, string>();
    for (const requirement of backendRequirements(raw, torchIndex)) {
      const name = dependencyName(requirement.name);
      const address = `${dependencyIndexUrl(stringValue(torchIndex))}/${name}/`;
      const indexPath = path.join(directory, `${key}.${name}.index.html`);
      const content = await command(['curl', '--fail', '--silent', '--show-error', '--proto', '=https', '--connect-timeout', '15', '--max-time', String(timeoutSeconds), address], timeoutSeconds + 5);
      fs.writeFileSync(indexPath, content, {flag: 'wx'});
      indexes.set(name, {url: address, content});
      indexPaths.set(name, indexPath);
    }
    const frozen = materializeDependencyWheels(raw, {architecture, torchIndex, indexes});
    const content = frozen.content;
    fs.writeFileSync(outputPath, content);
    if (!content.includes('--hash=sha256:')) fail('upstream_dependency_hashes', 'Resolver output lacks required distribution hashes.', [outputPath]);
    locks[key] = {path: outputPath, sha256: sha256(content), content, resolver, input_path: inputPath, input_sha256: sha256(requirements.join('\n') + '\n'),
      installation_contract: DEPENDENCY_CONTRACT, raw_resolution: {path: rawPath, sha256: sha256(raw)},
      pytorch_wheels: frozen.wheels.map((wheel) => ({...wheel, index_path: stringValue(indexPaths.get(wheel.name))})),
      source: 'Official PyPI primary only; exact official PyTorch wheel URLs selected from the original uv version/hash set and retained index evidence.',
      python_version: '3.12', python_platform: pythonPlatform(architecture), architecture};
  }
  return locks;
}

function validateDependencyUrls(content: string): void {
  for (const match of content.matchAll(/https?:\/\/[^\s\\]+/g)) {
    officialUrl(match[0], ['pypi.org', 'files.pythonhosted.org', 'download.pytorch.org', 'download-r2.pytorch.org'], 'dependency source');
  }
}

interface DependencyRequirement {
  name: string;
  version?: string;
  specifier: string;
  directUrl?: string;
  localVersion: boolean;
  indexes: string[];
  hashes: Set<string>;
}

interface DependencySources {
  primaryIndex: string;
  extraIndexes: Set<string>;
  effectiveExtraIndexes: Set<string>;
  requirements: DependencyRequirement[];
}

function dependencyRequirement(line: string): DependencyRequirement | undefined {
  const match = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:\[[a-zA-Z0-9,._-]+\])?\s*(?:==([a-zA-Z0-9][a-zA-Z0-9.!+_-]*)|@\s*(https?:\/\/[^\s\\]+))/u.exec(line);
  if (!match?.[1]) return undefined;
  // Target-specific uv output has already evaluated markers. Accept only its
  // hash/continuation suffix, not additional pip instructions after a valid pin.
  if (!/^(?:\s+--hash=sha256:[a-f0-9]{64})*(?:\s*\\)?$/u.test(line.slice(match[0].length))) {
    fail('upstream_dependency_install_contract', `Unsupported suffix on the pinned requirement for ${match[1]}.`);
  }
  return {name: match[1], specifier: match[0], localVersion: match[2]?.includes('+') ?? false, indexes: [], hashes: new Set<string>(),
    ...(match[2] === undefined ? {} : {version: match[2]}),
    ...(match[3] === undefined ? {} : {directUrl: match[3]})};
}

function dependencyIndexUrl(address: string): string {
  const url = new URL(officialUrl(address, ['pypi.org', 'download.pytorch.org'], 'dependency index'));
  const pathname = url.pathname.replace(/\/+$/u, '');
  if (url.search || url.hash || url.port || (url.hostname === 'pypi.org' ? pathname !== '/simple' : !/^\/whl\/(?:cpu|cu\d+|rocm\d+(?:\.\d+)*)$/u.test(pathname))) {
    fail('upstream_dependency_index', 'Dependency indexes must be the official PyPI index or an exact PyTorch backend index.');
  }
  return `${url.origin}${pathname}`;
}

function dependencySources(content: string): DependencySources {
  let primaryIndex: string | undefined;
  const extraIndexes = new Set<string>();
  const effectiveExtraIndexes = new Set<string>();
  const requirements: DependencyRequirement[] = [];
  let current: DependencyRequirement | undefined;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const annotation = /^# from (\S+)$/u.exec(line);
    if (annotation?.[1]) {
      if (!current) fail('upstream_dependency_source', 'A dependency source annotation has no package.');
      current.indexes.push(dependencyIndexUrl(annotation[1]));
    }
    if (line.startsWith('#')) continue;
    const directive = /^(--index-url|--extra-index-url)(?:=|\s+)(\S+)$/u.exec(line);
    if (directive?.[1] && directive[2]) {
      const address = dependencyIndexUrl(directive[2]);
      if (directive[1] === '--index-url') {
        if (primaryIndex !== undefined) fail('upstream_dependency_index', 'Dependency locks must declare at most one primary index.');
        primaryIndex = address;
        // A later --index-url discards earlier extra indexes in native pip.
        // https://github.com/pypa/pip/blob/25.0.1/src/pip/_internal/req/req_file.py#L234-L237
        effectiveExtraIndexes.clear();
      } else {
        extraIndexes.add(address);
        effectiveExtraIndexes.add(address);
      }
      continue;
    }
    const requirement = dependencyRequirement(line);
    if (requirement) {
      current = requirement;
      requirements.push(current);
    } else if (!/^--hash=sha256:[a-f0-9]{64}(?:\s*\\)?$/u.test(line)) {
      fail('upstream_dependency_install_contract', `Unsupported dependency install instruction: ${line}`);
    }
    if (!current) fail('upstream_dependency_hashes', 'A dependency hash has no package.');
    for (const hash of line.matchAll(/--hash=([^\s\\]+)/gu)) {
      const value = hash[1];
      if (!value?.startsWith('sha256:') || !HASH_PATTERN.test(value.slice(7))) fail('upstream_dependency_hashes', 'Every dependency hash must be a full SHA256.');
      current.hashes.add(value.slice(7));
    }
  }
  if (requirements.length === 0) fail('upstream_dependency_install_contract', 'Dependency lock contains no pinned packages.');
  return {primaryIndex: primaryIndex ?? PYPI_INDEX, extraIndexes, effectiveExtraIndexes, requirements};
}

function validateDependencyIndexes(sources: DependencySources, expectedTorchIndex: string | undefined): void {
  if (sources.primaryIndex !== PYPI_INDEX || [...sources.extraIndexes].some((index) => index !== expectedTorchIndex)) {
    fail('upstream_dependency_backend_mismatch', 'Dependency installer indexes differ from the frozen PyPI and selected PyTorch backend.');
  }
}

/** Checks pip sources; delegated URLs must already be proved against their frozen backend index. */
export function validateDependencyInstallSources(content: string, torchIndex?: string, verifiedWheelUrls: ReadonlySet<string> = new Set()): void {
  validateDependencyUrls(content);
  const expectedTorchIndex = torchIndex === undefined ? undefined : dependencyIndexUrl(torchIndex);
  const sources = dependencySources(content);
  validateDependencyIndexes(sources, expectedTorchIndex);
  if ([...sources.extraIndexes].some((index) => !sources.effectiveExtraIndexes.has(index))) {
    fail('upstream_dependency_index_order', 'The primary index discards an earlier extra index; declare PyPI before the selected PyTorch index.');
  }
  const effectiveIndexes = new Set([sources.primaryIndex, ...sources.effectiveExtraIndexes]);
  for (const requirement of sources.requirements) {
    if (requirement.hashes.size === 0) fail('upstream_dependency_hashes', `Missing frozen artifact hashes for ${requirement.name}.`);
    if (requirement.directUrl) {
      const url = new URL(officialUrl(requirement.directUrl, ['files.pythonhosted.org', 'download.pytorch.org', 'download-r2.pytorch.org'], 'dependency artifact'));
      if (url.hostname !== 'files.pythonhosted.org' && !verifiedWheelUrls.has(requirement.directUrl) &&
          (!expectedTorchIndex || !url.pathname.startsWith(`${new URL(expectedTorchIndex).pathname}/`))) {
        fail('upstream_dependency_backend_mismatch', `Direct wheel for ${requirement.name} differs from the selected PyTorch backend.`);
      }
      if (url.hash && (!url.hash.startsWith('#sha256=') || !requirement.hashes.has(url.hash.slice(8)))) {
        fail('upstream_dependency_hashes', `Direct URL and requirement SHA256 disagree for ${requirement.name}.`);
      }
    }
    for (const index of requirement.indexes) {
      if (index !== PYPI_INDEX && index !== expectedTorchIndex) fail('upstream_dependency_backend_mismatch', `${requirement.name} was resolved from a different PyTorch backend.`);
      if (!requirement.directUrl && !effectiveIndexes.has(index)) fail('upstream_dependency_index_missing', `Native pip cannot reach the frozen source of ${requirement.name}: ${index}`);
    }
    if (requirement.localVersion && !requirement.directUrl && (!expectedTorchIndex || !effectiveIndexes.has(expectedTorchIndex))) {
      fail('upstream_dependency_index_missing', `Local backend version of ${requirement.name} requires the selected PyTorch index.`);
    }
  }
}

/** Emits PyPI then uv's implicit PyTorch index before hashing the pip installation lock. */
export function materializeDependencyIndexes(content: string, torchIndex?: string): string {
  const sources = dependencySources(content);
  const expectedTorchIndex = torchIndex === undefined ? undefined : dependencyIndexUrl(torchIndex);
  validateDependencyIndexes(sources, expectedTorchIndex);
  const indexes = [`--index-url ${PYPI_INDEX}`];
  if (expectedTorchIndex) indexes.push(`--extra-index-url ${expectedTorchIndex}`);
  const body = content.split('\n').filter((line) => !/^(--index-url|--extra-index-url)(?:=|\s+)\S+$/u.test(line.trim())).join('\n');
  const result = `${indexes.join('\n')}\n${body}`;
  validateDependencyInstallSources(result, expectedTorchIndex);
  return result;
}

/** Carries an official package index response for deterministic wheel selection. */
export interface DependencyIndexEvidence {
  url: string;
  content: string;
}

/** Selects only the frozen resolver's PyTorch packages for this CPython/Linux target. */
export interface DependencyWheelOptions {
  architecture: string;
  torchIndex?: string;
  indexes: ReadonlyMap<string, DependencyIndexEvidence>;
}

/** Retains the exact official href, resolver version/hash and target wheel tags. */
export interface DependencyWheel extends JsonObject {
  name: string;
  version: string;
  url: string;
  sha256: string;
  filename: string;
  python_tag: string;
  abi_tag: string;
  platform_tag: string;
  index_url: string;
  index_sha256: string;
  index_href: string;
}

function dependencyName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/gu, '-');
}

function backendRequirements(content: string, torchIndex: string | undefined): DependencyRequirement[] {
  validateDependencyUrls(content);
  const sources = dependencySources(content);
  const expected = torchIndex === undefined ? undefined : dependencyIndexUrl(torchIndex);
  validateDependencyIndexes(sources, expected);
  const names = new Set<string>();
  const selected: DependencyRequirement[] = [];
  for (const requirement of sources.requirements) {
    const name = dependencyName(requirement.name);
    if (names.has(name)) fail('upstream_dependency_source', `Duplicate resolved package: ${name}`);
    names.add(name);
    if (!requirement.hashes.size) fail('upstream_dependency_hashes', `Missing frozen artifact hashes for ${name}.`);
    if (requirement.directUrl) continue;
    const indexes = [...new Set(requirement.indexes)];
    if (indexes.length !== 1) fail('upstream_dependency_source', `The original uv output must identify exactly one resolved index for ${name}.`);
    const index = indexes[0];
    if (index !== PYPI_INDEX && index !== expected) fail('upstream_dependency_backend_mismatch', `${name} was resolved from another backend.`);
    if (requirement.localVersion && index === PYPI_INDEX) fail('upstream_dependency_source', `Local backend version of ${name} lacks its PyTorch source annotation.`);
    if (index !== PYPI_INDEX) selected.push(requirement);
  }
  return selected;
}

function linuxWheelPlatform(tag: string, architecture: string): boolean {
  const aliases: Record<string, string> = {AMD64: 'x86_64', arm64: 'aarch64'};
  const target = aliases[architecture] ?? architecture;
  pythonPlatform(architecture);
  return tag.split('.').every((part) => {
    const match = /^(linux|manylinux1|manylinux2010|manylinux2014|manylinux_2_\d+)_(.+)$/u.exec(part);
    return match?.[2] === target;
  });
}

function selectDependencyWheel(requirement: DependencyRequirement, evidence: DependencyIndexEvidence, architecture: string, torchIndex: string): DependencyWheel {
  const name = dependencyName(requirement.name);
  const version = stringValue(requirement.version, `resolved ${name} version`);
  const indexUrl = `${dependencyIndexUrl(torchIndex)}/${name}/`;
  if (evidence.url !== indexUrl) fail('upstream_dependency_wheel_source', `Wheel evidence belongs to another backend or package: ${name}`);
  const candidates = new Map<string, DependencyWheel>();
  for (const anchor of evidence.content.matchAll(/<a\b([^>]*)>/giu)) {
    const attributes = anchor[1] ?? '';
    if (/\bdata-yanked(?:\s|=|$)/iu.test(attributes)) continue;
    const href = /\bhref=["']([^"']+)["']/iu.exec(attributes)?.[1];
    if (!href) continue;
    const url = new URL(href.replaceAll('&amp;', '&'), indexUrl);
    const filename = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
    const wheel = /^([^-]+)-([^-]+)-(?:\d[^-]*-)?([^-]+)-([^-]+)-([^-]+)\.whl$/u.exec(filename);
    if (!wheel || dependencyName(wheel[1] ?? '') !== name || wheel[2] !== version || wheel[3] !== 'cp312' || wheel[4] !== 'cp312' || !wheel[5] || !linuxWheelPlatform(wheel[5], architecture)) continue;
    if (url.protocol !== 'https:' || !['download.pytorch.org', 'download-r2.pytorch.org'].includes(url.hostname) || url.username || url.password || url.port || url.search) {
      fail('upstream_dependency_wheel_source', `Selected ${name} wheel is not an exact official PyTorch HTTPS artifact.`);
    }
    const hash = url.hash.startsWith('#sha256=') ? url.hash.slice(8) : '';
    if (!HASH_PATTERN.test(hash) || !requirement.hashes.has(hash)) continue;
    candidates.set(url.href, {name, version, url: url.href, sha256: hash, filename, python_tag: wheel[3], abi_tag: wheel[4], platform_tag: wheel[5],
      index_url: indexUrl, index_sha256: sha256(evidence.content), index_href: href});
  }
  if (candidates.size !== 1) fail('upstream_dependency_wheel_ambiguous', `Expected one official locked ${name} ${version} CPython 3.12 Linux/${architecture} wheel; found ${candidates.size}.`);
  const selected = candidates.values().next().value;
  if (!selected) fail('upstream_dependency_wheel_ambiguous', `No supported wheel for ${name}.`);
  return selected;
}

/** Replaces only uv's selected PyTorch pins with exact wheels, retaining all package hashes and PyPI-only lookup. */
export function materializeDependencyWheels(content: string, options: DependencyWheelOptions): {content: string; wheels: DependencyWheel[]} {
  pythonPlatform(options.architecture);
  const selected = backendRequirements(content, options.torchIndex);
  const wheels = selected.map((requirement) => {
    const evidence = options.indexes.get(dependencyName(requirement.name));
    if (!evidence) fail('upstream_dependency_wheel_source', `Missing retained official index for ${requirement.name}.`);
    return selectDependencyWheel(requirement, evidence, options.architecture, stringValue(options.torchIndex));
  });
  if (options.indexes.size !== wheels.length) fail('upstream_dependency_wheel_source', 'Wheel evidence contains packages that uv did not resolve from the selected PyTorch index.');
  const byName = new Map(wheels.map((wheel) => [wheel.name, wheel]));
  const body = content.split('\n').filter((line) => !/^(--index-url|--extra-index-url)(?:=|\s+)\S+$/u.test(line.trim())).map((line) => {
    if (!line.trim() || line.trim().startsWith('#') || line.trim().startsWith('--hash=')) return line;
    const requirement = dependencyRequirement(line.trim());
    const wheel = requirement ? byName.get(dependencyName(requirement.name)) : undefined;
    if (!requirement || !wheel) return line;
    const name = requirement.specifier.slice(0, requirement.specifier.indexOf('==')).trimEnd();
    return line.replace(requirement.specifier, `${name} @ ${wheel.url}`);
  }).join('\n');
  const result = `--index-url ${PYPI_INDEX}\n${body}`;
  validateDependencyInstallSources(result, options.torchIndex, new Set(wheels.map((wheel) => wheel.url)));
  return {content: result, wheels};
}

function validateDependencyWheelLock(lock: JsonObject, torchIndex: string | undefined, architecture: string): void {
  if (lock.installation_contract !== DEPENDENCY_CONTRACT || lock.architecture !== architecture || lock.python_version !== '3.12' || lock.python_platform !== pythonPlatform(architecture)) {
    fail('upstream_dependency_install_contract', 'Frozen dependency wheel target or installation contract changed.');
  }
  const raw = asRecord(lock.raw_resolution, 'original uv resolution');
  const rawPath = stringValue(raw.path, 'original uv path');
  const rawContent = fs.readFileSync(rawPath, 'utf8');
  if (sha256(rawContent) !== raw.sha256) fail('upstream_dependencies_changed', 'Original uv resolution bytes changed.', [rawPath]);
  const recorded = arrayValue(lock.pytorch_wheels, 'frozen PyTorch wheels').map((item) => asRecord(item));
  const indexes = new Map<string, DependencyIndexEvidence>();
  for (const wheel of recorded) {
    const name = stringValue(wheel.name);
    if (indexes.has(name)) fail('upstream_dependency_wheel_source', `Duplicate frozen wheel evidence for ${name}.`);
    const filename = stringValue(wheel.index_path, 'official wheel index evidence');
    const content = fs.readFileSync(filename, 'utf8');
    if (sha256(content) !== wheel.index_sha256) fail('upstream_evidence_changed', 'Frozen official wheel index bytes changed.', [filename]);
    indexes.set(name, {url: stringValue(wheel.index_url), content});
  }
  const frozen = materializeDependencyWheels(rawContent, {architecture, torchIndex, indexes});
  if (frozen.content !== lock.content || digest(frozen.wheels) !== digest(recorded.map((wheel) => omitRecordKeys(wheel, ['index_path'])))) {
    fail('upstream_dependency_wheel_binding', 'Installer bytes or exact wheel proof differ from the original uv pins and official indexes.');
  }
}

function parseSnapshot(value: unknown): ReleaseSnapshot {
  const record = asRecord(value, 'upstream lock');
  if (record.schema !== 'embedding-upstream-lock/1') fail('upstream_lock_schema', 'Unsupported or missing upstream lock.');
  const platforms = arrayValue(record.platforms, 'frozen platforms').map((platform) => asRecord(platform, 'frozen platform'));
  return {...record, schema: stringValue(record.schema, 'upstream schema'), id: stringValue(record.id, 'upstream ID'), resolved_at: stringValue(record.resolved_at, 'upstream resolved time'), releases: asRecord(record.releases, 'frozen releases'), versions: asRecord(record.versions, 'frozen versions'), platforms, images: asRecord(record.images, 'frozen images'), distributions: asRecord(record.distributions, 'frozen distributions')};
}

/** Rejects altered source trees, source evidence, mutable image pins, and snapshot fields. */
export function validateFrozenSources(value: unknown): ReleaseSnapshot {
  const snapshot = parseSnapshot(value);
  if (digest(omitRecordKeys(snapshot, ['id'])) !== snapshot.id) {
    fail('upstream_lock_changed', 'The frozen upstream snapshot no longer matches its immutable identity.');
  }
  for (const {key, repository} of RELEASES) {
    const release = asRecord(snapshot.releases[key], `release ${key}`);
    if (release.repository !== repository || release.draft !== false || release.prerelease !== false || !COMMIT_PATTERN.test(stringValue(release.commit, 'release commit'))) {
      fail('upstream_release_provenance', `Invalid official stable release provenance for ${key}.`);
    }
    const source = asRecord(release.source, 'frozen checkout');
    const directory = stringValue(source.path, 'source checkout path');
    if (source.commit !== release.commit || digest(sourceFiles(directory)) !== source.files_digest || digest(source.files) !== source.files_digest) {
      fail('upstream_source_changed', `Frozen source contents changed: ${directory}`, [directory]);
    }
    for (const item of arrayValue(release.evidence, 'source evidence')) {
      const evidence = asRecord(item, 'source evidence file');
      const evidencePath = stringValue(evidence.path, 'evidence path');
      if (sha256(fs.readFileSync(evidencePath)) !== evidence.sha256) fail('upstream_evidence_changed', `Official release evidence changed: ${evidencePath}`, [evidencePath]);
    }
  }
  for (const item of Object.values(snapshot.images)) {
    const image = asRecord(item, 'frozen image');
    if (!/^sha256:[a-f0-9]{64}$/.test(stringValue(image.digest, 'frozen image digest')) || !stringValue(image.pinned, 'frozen image reference').endsWith(`@${image.digest}`)) {
      fail('upstream_image_unpinned', 'Frozen base images must identify exact registry manifests.');
    }
    if (stringValue(image.pinned).startsWith('ghcr.io/huggingface/text-embeddings-inference:')) verifyTeiImage(image, asRecord(snapshot.releases.tei));
  }
  for (const item of Object.values(snapshot.distributions)) {
    const distribution = asRecord(item, 'frozen package');
    for (const file of arrayValue(distribution.files, 'frozen distribution files')) {
      const entry = asRecord(file, 'frozen distribution');
      officialUrl(entry.url, ['files.pythonhosted.org'], 'frozen distribution URL');
      if (!HASH_PATTERN.test(stringValue(entry.sha256, 'distribution SHA256'))) fail('upstream_wheel_hash', 'Frozen distribution lacks its exact SHA256.');
    }
  }
  const locks = asRecord(snapshot.dependency_locks, 'frozen transitive dependencies');
  for (const [key, item] of Object.entries(locks)) {
    const lock = asRecord(item, 'dependency lock');
    const filename = stringValue(lock.path, 'dependency lock path');
    const content = stringValue(lock.content, 'dependency lock contents');
    const platform = snapshot.platforms.find((candidate) => candidate.id === key);
    if (key !== 'gateway' && !platform) fail('upstream_dependency_platform', 'Dependency lock has no frozen platform.', [filename]);
    const torchIndex = platform?.torch_index === undefined ? undefined : stringValue(platform.torch_index);
    if (lock.installation_contract !== undefined || lock.raw_resolution !== undefined || lock.pytorch_wheels !== undefined) {
      validateDependencyWheelLock(lock, torchIndex, stringValue(snapshot.observed_architecture));
    } else validateDependencyInstallSources(content, torchIndex);
    if (sha256(content) !== lock.sha256 || sha256(fs.readFileSync(filename)) !== lock.sha256 || sha256(fs.readFileSync(stringValue(lock.input_path))) !== lock.input_sha256) fail('upstream_dependencies_changed', 'Frozen transitive dependency inputs or hashes changed.', [filename]);
  }
  return snapshot;
}

/** Resolves latest TEI/ST stable releases and freezes sources and official distribution inputs. */
export async function resolveReleases(options: ResolveOptions = {}): Promise<ReleaseSnapshot> {
  const outputPath = path.resolve(options.outputPath ?? path.join(ROOT, 'output/host/upstream-lock.json'));
  const preparationRoot = path.join(path.dirname(outputPath), 'upstream', now().replaceAll(':', '').replaceAll('.', '-') + '-' + process.pid);
  const sourceRoot = path.resolve(options.sourceRoot ?? path.join(path.dirname(outputPath), 'upstream/sources'));
  const timeoutSeconds = options.timeoutSeconds ?? 180;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 1800) fail('upstream_timeout', 'Preparation timeout must be finite and between 1 and 1800 seconds.');
  return withExecutionLease({}, async () => {
    const manifest = loadRecord(options.manifestPath ?? path.join(ROOT, 'manifest.yaml'));
    const config = loadRecord(options.platformsPath ?? path.join(ROOT, 'config/platforms.yaml'));
    const versions = recordClone(loadRecord(options.versionsPath ?? path.join(ROOT, 'config/versions.yaml')), 'versions');
    const host = asRecord(manifest.host, 'manifest host');
    const architecture = stringValue(asRecord(host.architecture, 'host architecture').value, 'host architecture value');
    const platforms: JsonObject[] = [];
    for (const device of ['cpu', 'gpu']) {
      const platform = selectPlatform(manifest, device, config.profiles);
      if (platform.status !== 'adapter_required') platforms.push(recordClone(platform, 'selected platform'));
    }
    const releases: JsonObject = {};
    for (const {key, repository} of RELEASES) {
      releases[key] = await resolveRelease(repository, sourceRoot, preparationRoot, timeoutSeconds);
    }
    versions.sentence_transformers = asRecord(releases.sentence_transformers, 'ST release').version;
    versions.checked_at = now();
    const images: JsonObject = {};
    const pin = async (reference: string): Promise<string> => {
      if (images[reference] === undefined) images[reference] = await resolveImage(reference, timeoutSeconds);
      return stringValue(asRecord(images[reference], 'resolved image').pinned, 'pinned image');
    };
    for (const platform of platforms) {
      if (typeof platform.tei_image === 'string') {
        const reference = versionedTeiImage(platform.tei_image, asRecord(releases.tei, 'TEI release'));
        platform.tei_image = await pin(reference);
        verifyTeiImage(asRecord(images[reference], 'TEI image'), asRecord(releases.tei, 'TEI release'));
      }
      platform.st_base = await pin(stringValue(platform.st_base, 'ST base'));
    }
    const gatewayBase = await pin('python:3.12-slim');
    const packageFiles: JsonObject = {};
    for (const [key, packageName] of [['sentence_transformers', 'sentence-transformers'], ['transformers', 'transformers'], ['torch', 'torch'], ['tokenizers', 'tokenizers'], ['pillow', 'pillow'], ['torchvision', 'torchvision']]) {
      if (!key || !packageName || versions[key] === undefined) continue;
      packageFiles[key] = await distributions(packageName, stringValue(versions[key], packageName), timeoutSeconds);
    }
    await verifyTorchWheels(versions, platforms, architecture, timeoutSeconds);
    const dependencyLocks = await resolveDependencyLocks(versions, platforms, architecture, preparationRoot, timeoutSeconds);
    const record: JsonObject = {
      schema: 'embedding-upstream-lock/1', resolved_at: now(), evidence_kind: 'measured', releases, versions, platforms, images,
      distributions: packageFiles, dependency_locks: dependencyLocks, gateway_base: gatewayBase, observed_architecture: architecture,
      config_inputs: {platforms: digest(config), previous_versions: loadRecord(options.versionsPath ?? path.join(ROOT, 'config/versions.yaml'))},
      source_policy: 'Official latest stable TEI and sentence-transformers, exact source commits and registry manifests; existing compatible ancillary versions verified at official distribution indexes.',
    };
    record.id = digest(record);
    const snapshot = parseSnapshot(record);
    validateFrozenSources(snapshot);
    fs.mkdirSync(preparationRoot, {recursive: true});
    save(path.join(preparationRoot, 'upstream-lock.json'), snapshot);
    save(outputPath, snapshot);
    return snapshot;
  });
}
