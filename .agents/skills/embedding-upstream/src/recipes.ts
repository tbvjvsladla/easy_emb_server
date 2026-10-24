/** Owns native Dockerfile generation, declared recipe validation and frozen dependency assets. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {GateError, ROOT, asRecord, cloneJson, digest, stringValue} from '../../../harness/common.ts';
import type {JsonObject} from '../../../harness/common.ts';
import type {ReleaseSnapshot} from './upstream.ts';

/** Contains the exact native files shared by rendering and read-only recovery assessment. */
export interface NativeAssets {
  recipes: JsonObject;
  recipeSnapshots: JsonObject;
  dependencies: JsonObject;
  dependencyLocks: JsonObject;
  backendInputs: JsonObject;
}

const RECIPE_NAMES = new Set(['Dockerfile', 'Dockerfile.gateway']);

function gate(code: string, message: string, evidence: string[] = [], nextAction = 'inspect evidence and create a justified recovery attempt'): never {
  throw new GateError(code, message, {evidence, nextAction, retryable: false});
}

function recordClone(value: unknown): JsonObject {
  return asRecord(cloneJson(value));
}

/** Reads deterministic native text inputs for recipe generation and identity preimages. */
export function readNativeTextFiles(directory: string, predicate: (name: string) => boolean): JsonObject {
  const records: JsonObject = {};
  for (const name of fs.readdirSync(directory).filter((entry) => predicate(entry)).toSorted()) {
    const filename = path.join(directory, name);
    if (!fs.statSync(filename).isFile()) continue;
    records[name] = fs.readFileSync(filename, 'utf8');
  }
  return records;
}

function nativeRecipes(cfg: JsonObject, snapshot: ReleaseSnapshot): JsonObject {
  const platform = asRecord(cfg.platform);
  if (cfg.engine === 'tei') return {
    Dockerfile: `FROM ${stringValue(platform.tei_image)}\n`,
    'Dockerfile.gateway': `FROM ${stringValue(snapshot.gateway_base)}\nWORKDIR /app\nCOPY requirements.gateway.txt /app/requirements.txt\nRUN pip install --no-cache-dir --timeout 120 --retries 5 --require-hashes -r /app/requirements.txt\nCOPY runtime /app/runtime\nENTRYPOINT ["python","-m","runtime.server"]\n`,
  };
  return {Dockerfile: `FROM ${stringValue(platform.st_base)}\nWORKDIR /app\nCOPY requirements.backend.txt /app/requirements.txt\nRUN pip install --no-cache-dir --timeout 120 --retries 5 --require-hashes -r /app/requirements.txt\nCOPY runtime /app/runtime\nENTRYPOINT ["python","-m","runtime.server"]\n`};
}

function validateRecipe(content: string, snapshot: ReleaseSnapshot, nativeContent: string): void {
  const bases = new Set(Object.values(snapshot.images).map((value) => stringValue(asRecord(value).pinned)));
  const stages = new Set<string>();
  const lines = content.split(/\r?\n/);
  let found = false;
  for (const line of lines) {
    const matched = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
    if (!matched) continue;
    found = true;
    const base = matched[1];
    if (!base || (!bases.has(base) && !stages.has(base))) gate('recipe_base_unfrozen', 'Recipe base images must occur in the immutable upstream snapshot.');
    if (matched[2]) stages.add(matched[2]);
  }
  if (!found) gate('recipe_missing_base', 'Dockerfile has no valid frozen FROM input.');
  const instructions: string[] = [];
  for (const source of lines) {
    const line = source.trim();
    if (/^#\s*(?:syntax|escape|check)\s*=/i.test(line)) gate('recipe_unfrozen_directive', 'Declared recipes cannot change the frozen Dockerfile parser or fetch a new frontend.');
    if (!line || line.startsWith('#')) continue;
    if (/^LABEL easy-emb\.note[.-][a-z0-9.-]+="[A-Za-z0-9 ._:/-]*"$/.test(line)) continue;
    if (/^ENV (?:OMP_NUM_THREADS|MKL_NUM_THREADS)=[1-9][0-9]{0,3}$/.test(line) || /^ENV TOKENIZERS_PARALLELISM=(?:true|false)$/.test(line) || /^ENV (?:HF_HUB_OFFLINE|TRANSFORMERS_OFFLINE)=1$/.test(line)) continue;
    instructions.push(line);
  }
  const nativeInstructions = nativeContent.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (digest(instructions) !== digest(nativeInstructions)) gate('recipe_dependencies_unfrozen', 'Declared recipes must preserve the native base, entrypoint and exact hashed dependency installation. Only explicit offline/thread/tokenizer settings and easy-emb.note annotations may be added.', [], 'prepare and review a new frozen source contract for additional package or code changes');
}

/** Validates and constructs frozen native assets without writing or starting a process. */
export function nativeAssets(cfg: JsonObject, snapshot: ReleaseSnapshot, declaredRecipes: JsonObject = {}, runtimeRoot = path.join(ROOT, 'runtime')): NativeAssets {
  const native = nativeRecipes(cfg, snapshot);
  const recipes = recordClone(native);
  const recipeSnapshots: JsonObject = {};
  for (const [name, value] of Object.entries(declaredRecipes)) {
    if (!RECIPE_NAMES.has(name) || (name === 'Dockerfile.gateway' && cfg.engine !== 'tei')) gate('unsupported_recipe', `Recipe ${name} is not supported by this engine.`);
    const recipe = asRecord(value, 'declared recipe');
    const content = stringValue(recipe.content, 'recipe content');
    if (recipe.digest !== digest(content)) gate('recipe_snapshot_changed', 'Declared recipe content does not match its digest.');
    recipes[name] = content;
    recipeSnapshots[name] = recipe;
  }
  for (const [name, value] of Object.entries(recipes)) validateRecipe(stringValue(value, name), snapshot, stringValue(native[name], 'native recipe'));
  const dependencies: JsonObject = {};
  const dependencyLocks: JsonObject = {};
  for (const role of cfg.engine === 'tei' ? ['gateway'] : ['backend']) {
    const key = role === 'gateway' ? 'gateway' : stringValue(asRecord(cfg.platform).id);
    const lock = asRecord(asRecord(snapshot.dependency_locks)[key], 'engine dependency lock');
    const filename = `requirements.${role}.txt`;
    dependencies[filename] = stringValue(lock.content);
    dependencyLocks[role] = {file: filename, sha256: lock.sha256, source: lock.path};
  }
  return {recipes, recipeSnapshots, dependencies, dependencyLocks,
    backendInputs: {dockerfile: recipes.Dockerfile, runtime: readNativeTextFiles(runtimeRoot, (name) => name.endsWith('.py')), dependencies}};
}

/** Reads the full native backend build preimage used by the renderer and build tag. */
export function backendBuildInputs(attemptPath: string): JsonObject {
  return {dockerfile: fs.readFileSync(path.join(attemptPath, 'Dockerfile'), 'utf8'),
    runtime: readNativeTextFiles(path.join(attemptPath, 'runtime'), (name) => name.endsWith('.py')),
    dependencies: readNativeTextFiles(attemptPath, (name) => name.startsWith('requirements.') && name.endsWith('.txt'))};
}
