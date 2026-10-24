/** Verifies the exact NVIDIA wheel delegated by the frozen official PyTorch index. */
import {arrayValue, asRecord, parseJson, sha256Bytes, stringValue} from '../../../harness/common.ts';
import type {JsonObject} from '../../../harness/common.ts';

/** Identifies one artifact actually recorded by native pip. */
export interface InstalledArtifactIdentity {
  name: string;
  version: string;
  url: string;
  sha256: string;
}

/** Supplies retained official responses without fetching or executing during verification. */
export interface NvidiaDelegationSources {
  torchIndex: string;
  indexUrl: string;
  indexHtml: string;
  pypiUrl: string;
  pypiJson: string;
  lockedHashes: ReadonlySet<string>;
}

function packageName(value: string): string {
  return value.toLowerCase().replace(/[-_.]+/gu, '-');
}

function plainHttps(address: string, host: string): URL {
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password || url.port || url.search) {
    throw new Error(`Unexpected official provenance URL: ${address}`);
  }
  return url;
}

/** Requires exact delegation, package/version/filename identity, and three agreeing SHA256 sources. */
export function validateNvidiaDelegation(artifact: InstalledArtifactIdentity, sources: NvidiaDelegationSources): JsonObject {
  if (artifact.name !== packageName(artifact.name) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(artifact.name) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]*$/u.test(artifact.version) || !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
      !sources.lockedHashes.has(artifact.sha256)) throw new Error('NVIDIA artifact lacks its exact frozen package hash or identity.');
  const download = plainHttps(artifact.url, 'pypi.nvidia.com');
  if (download.hash && download.hash !== `#sha256=${artifact.sha256}`) throw new Error('NVIDIA artifact URL hash differs from its locked SHA256.');
  download.hash = '';
  const filename = decodeURIComponent(download.pathname.split('/').at(-1) ?? '');
  if (!filename.endsWith('.whl') || packageName(filename.split('-')[0] ?? '') !== artifact.name || filename.split('-')[1] !== artifact.version) {
    throw new Error('NVIDIA artifact filename differs from its installed package/version.');
  }
  const backend = plainHttps(sources.torchIndex, 'download.pytorch.org');
  if (backend.hash || !/^\/whl\/cu\d+\/?$/u.test(backend.pathname)) throw new Error('NVIDIA delegation requires the exact frozen CUDA backend index.');
  const expectedIndex = `${backend.href.replace(/\/$/u, '')}/${artifact.name}/`;
  if (sources.indexUrl !== expectedIndex) throw new Error('NVIDIA delegation was queried from another backend or package index.');
  const matchedLink = Array.from(sources.indexHtml.matchAll(/href=["']([^"']+)["']/gu), (match) => match[1]).find((link) => {
    if (!link) return false;
    const delegated = new URL(link.replaceAll('&amp;', '&'), sources.indexUrl);
    if (delegated.hash !== `#sha256=${artifact.sha256}`) return false;
    delegated.hash = '';
    return delegated.href === download.href;
  });
  if (!matchedLink) throw new Error('Official PyTorch index does not delegate this exact NVIDIA artifact URL and locked SHA256.');
  const expectedPypi = `https://pypi.org/pypi/${artifact.name}/${encodeURIComponent(artifact.version)}/json`;
  if (sources.pypiUrl !== expectedPypi) throw new Error('NVIDIA PyPI evidence names another package or release.');
  const release = asRecord(parseJson(sources.pypiJson), 'PyPI release');
  const info = asRecord(release.info, 'PyPI metadata');
  if (packageName(stringValue(info.name)) !== artifact.name || info.version !== artifact.version) throw new Error('PyPI release identity differs from the installed NVIDIA artifact.');
  const files = arrayValue(release.urls, 'PyPI distributions').map((value) => asRecord(value)).filter((file) => file.filename === filename);
  const file = files[0];
  if (files.length !== 1 || !file || file.packagetype !== 'bdist_wheel' || file.yanked !== false || asRecord(file.digests).sha256 !== artifact.sha256) {
    throw new Error('PyPI does not publish this exact NVIDIA wheel filename with the frozen SHA256.');
  }
  const canonical = plainHttps(stringValue(file.url), 'files.pythonhosted.org');
  if (canonical.hash || decodeURIComponent(canonical.pathname.split('/').at(-1) ?? '') !== filename) throw new Error('PyPI canonical artifact URL differs from its NVIDIA wheel filename.');
  return {schema: 'embedding-nvidia-artifact-provenance/1', artifact: {...artifact},
    delegating_index: {url: sources.indexUrl, sha256: sha256Bytes(sources.indexHtml), artifact_link: matchedLink},
    pypi_release: {url: sources.pypiUrl, sha256: sha256Bytes(sources.pypiJson), filename, artifact_url: canonical.href, artifact_sha256: artifact.sha256}};
}
