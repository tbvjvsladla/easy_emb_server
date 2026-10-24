/** Builds and reconciles native images from approved immutable attempt recipes. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {GateError, asRecord, digest, loadRecord, now, save, stringValue} from '../../../harness/common.ts';
import type {JsonObject} from '../../../harness/common.ts';
import {executeAttemptCommand, invalidateValidation, positiveAttemptInteger, retainAttemptFailure, withAttemptExecution} from '../../embedding-explorer/src/attempts.ts';
import type {CheckedAttempt} from '../../embedding-explorer/src/attempts.ts';
import {inspectDocker, inspectionPresent} from '../../embedding-explorer/src/resources.ts';
import {backendBuildInputs, readNativeTextFiles} from './recipes.ts';

/** Provides the one typed build knob already recorded in the attempt condition. */
export interface BuildOptions { builder?: string; }

function gate(code: string, message: string, evidence: string[] = [], nextAction = 'inspect evidence and create a justified recovery attempt'): never {
  throw new GateError(code, message, {evidence, nextAction, retryable: false});
}

function buildRecipe(attemptPath: string, filename: string): string {
  if (filename === 'Dockerfile') return digest(backendBuildInputs(attemptPath)).slice(0, 16);
  return digest({dockerfile: fs.readFileSync(path.join(attemptPath, filename), 'utf8'), runtime: readNativeTextFiles(path.join(attemptPath, 'runtime'), (name) => name.endsWith('.py')), dependencies: readNativeTextFiles(attemptPath, (name) => name.startsWith('requirements.') && name.endsWith('.txt'))}).slice(0, 16);
}

/** Reads one exact Docker image identity without converting daemon failures to absence. */
export async function inspectImage(name: string): Promise<JsonObject> {
  return inspectionPresent(await inspectDocker('image', name), `Image ${name}`);
}

/** Rechecks exact native image roles, recipe preimages and immutable Docker IDs. */
export async function validateImages(attempt: CheckedAttempt): Promise<JsonObject> {
  const images = loadRecord(path.join(attempt.path, 'images.json'));
  const roles = attempt.settings.engine === 'tei' ? ['backend', 'gateway'] : ['backend'];
  if (Object.keys(images).toSorted().join(',') !== roles.toSorted().join(',')) gate('image_roles_mismatch', 'Recorded images do not cover exactly the native engine roles.');
  for (const role of roles) {
    const recorded = asRecord(images[role], 'recorded image');
    const filename = role === 'backend' ? 'Dockerfile' : 'Dockerfile.gateway';
    if (recorded.recipe !== buildRecipe(attempt.path, filename)) gate('image_recipe_mismatch', 'Recorded image was built from another recipe.', [attempt.path]);
    const id = stringValue(recorded.id, 'recorded image ID');
    const actual = await inspectImage(id);
    if (actual.Id !== id || asRecord(asRecord(actual.Config).Labels ?? {})['easy-emb.recipe'] !== recorded.recipe) gate('image_identity_mismatch', 'Recorded build identity is absent or no longer matches the recipe.', [attempt.path]);
  }
  return images;
}

/** Builds native container recipes after validating approval, ownership, input pins and limits. */
export async function build(attemptPath: string, options: BuildOptions = {}): Promise<JsonObject> {
  return withAttemptExecution(attemptPath, 'build', async (attempt) => {
    const cfg = attempt.settings;
    const builder = options.builder ?? (typeof cfg.builder === 'string' ? cfg.builder : undefined);
    if ((builder ?? null) !== cfg.builder) gate('builder_condition_changed', 'Builder differs from the sealed attempt; render a new declared condition.');
    if (['build_failed', 'startup_failed', 'interrupted'].includes(stringValue(cfg.state))) gate('recovery_required', 'A failed attempt needs a new bounded recovery attempt.');
    if (['built', 'serving', 'stopped'].includes(stringValue(cfg.state)) && fs.existsSync(path.join(attempt.path, 'images.json'))) return {attempt: attempt.path, state: cfg.state, images: await validateImages(attempt), reconciled: true};
    if (cfg.state !== 'prepared') gate('build_state_unreconciled', 'An interrupted build must be reconciled and linked to a new recovery attempt before another build command.', [attempt.path]);
    const roles = cfg.engine === 'tei' ? ['backend', 'gateway'] : ['backend'];
    const intent: JsonObject = {};
    for (const role of roles) {
      const filename = role === 'backend' ? 'Dockerfile' : 'Dockerfile.gateway';
      const recipe = buildRecipe(attempt.path, filename);
      intent[role] = {tag: `easy-emb-${role}:${recipe}`, recipe, dockerfile: filename};
    }
    save(path.join(attempt.path, 'image-intent.json'), {at: now(), attempt_id: cfg.id, strategy_id: attempt.strategy.id, images: intent});
    cfg.state = 'building';
    save(path.join(attempt.path, 'settings.yaml'), cfg);
    invalidateValidation(attempt.path, 'New build requires a fresh serving verification.');
    const images: JsonObject = {};
    try {
      for (const role of roles) {
        const planned = asRecord(intent[role]);
        const tag = stringValue(planned.tag);
        const argv = ['docker', 'buildx', 'build', '--load', '--progress=plain', '--label', `easy-emb.recipe=${planned.recipe}`, '--label', 'easy-emb.project=easy_emb_server'];
        if (builder) argv.push('--builder', builder);
        argv.push('-t', tag, '-f', path.join(attempt.path, stringValue(planned.dockerfile)), attempt.path);
        await executeAttemptCommand(attempt.path, `build-${role}`, argv, positiveAttemptInteger(asRecord(cfg.limits).build_timeout_seconds, 'build timeout'));
        const info = await inspectImage(tag);
        const labels = asRecord(asRecord(info.Config).Labels ?? {});
        if (labels['easy-emb.recipe'] !== planned.recipe) gate('built_image_recipe_mismatch', 'Built image does not carry this exact recipe identity.', [attempt.path]);
        images[role] = {tag, id: stringValue(info.Id, 'built image ID'), repo_digests: info.RepoDigests ?? null, recipe: planned.recipe};
        save(path.join(attempt.path, 'images.json'), images);
      }
      cfg.state = 'built';
      delete cfg.error;
      save(path.join(attempt.path, 'settings.yaml'), cfg);
    } catch (error: unknown) {
      retainAttemptFailure(attempt, 'build', error);
      throw error;
    }
    return {attempt: attempt.path, state: cfg.state, images};
  });
}
