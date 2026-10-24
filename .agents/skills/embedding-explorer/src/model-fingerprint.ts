/** Explorer-owned model identity, preserving historical receipt fingerprints. */
import {lstatSync, readFileSync, readdirSync, realpathSync, statSync} from 'node:fs';
import {extname, join} from 'node:path';
import {GateError, compareCodePoints, digest, sha256Bytes} from '../../../harness/common.ts';
import type {JsonObject} from '../../../harness/common.ts';

/** Model identity hashes metadata content and observes weight sizes/mtimes, not all weight bytes. */
export interface ModelFingerprint { method: string; digest: string; }

/** Matches Python Path ordering and exact nanosecond timestamps without rounding through Number. */
export function fingerprintModel(model: string): ModelFingerprint {
  const root = realpathSync(model);
  const records: JsonObject[] = [];
  function visit(directory: string): void {
    for (const name of readdirSync(directory).toSorted(compareCodePoints)) {
      const path = join(directory, name);
      const entry = lstatSync(path);
      if (entry.isDirectory()) { visit(path); continue; }
      const extension = extname(name);
      if (!['.json', '.py', '.safetensors', '.bin'].includes(extension)) continue;
      const stats = statSync(path, {bigint: true});
      if (!stats.isFile()) continue;
      const row: JsonObject = {path: path.slice(root.length + 1), size: stats.size, mtime_ns: stats.mtimeNs};
      if (extension === '.json' || extension === '.py') row.sha256 = sha256Bytes(readFileSync(path));
      const after = statSync(path, {bigint: true});
      if (stats.mtimeNs !== after.mtimeNs || stats.size !== after.size) throw new GateError('MODEL_CHANGED_DURING_SCAN', `Model changed while reading ${path}.`);
      records.push(row);
    }
  }
  visit(root);
  return {method: 'metadata-sha256+weight-size-mtime', digest: digest(records)};
}
