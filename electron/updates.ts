type UpdateStatus = import('../engine/preferences.js').UpdateStatus;
const homepage = 'https://github.com/zhuziqi97/legal-redactor';
const endpoint = 'https://api.github.com/repos/zhuziqi97/legal-redactor/releases/latest';

function versionParts(version: string) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  return match?.slice(1).map(Number);
}

function newer(latest: number[], current: number[]) {
  const difference = latest.findIndex((part, index) => part !== current[index]);
  return difference !== -1 && latest[difference] > current[difference];
}

function describeRelease(release: { tag_name?: string; assets?: { name: string; size: number; state: string }[] },
  current: string, platform: string, arch: string) {
  const tag = release.tag_name ?? '';
  const version = tag.replace(/^v/u, '');
  const latest = versionParts(tag);
  const installed = versionParts(current);
  if (!latest || !installed) throw new Error('无效的发行版本');
  if (!newer(latest, installed)) return { status: { kind: 'current' } as UpdateStatus };
  const target = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform;
  const suffix = target === 'linux' ? 'tar.gz' : 'zip';
  const name = `LegalRedactor-${version}-${target}-${arch}.${suffix}`;
  const asset = release.assets?.find(item => item.name === name && item.state === 'uploaded' && item.size > 0);
  const releaseUrl = `${homepage}/releases/tag/${tag}`;
  return {
    status: asset ? { kind: 'available', version, size: asset.size } as UpdateStatus : { kind: 'unavailable', version } as UpdateStatus,
    releaseUrl, downloadUrl: asset && `${homepage}/releases/download/${tag}/${name}`,
  };
}

function createUpdates(fetchRelease: typeof fetch, current: string, notify: (status: UpdateStatus) => void) {
  let result: ReturnType<typeof describeRelease> = { status: { kind: 'idle' } };
  let pending: { controller: AbortController; manual: boolean; task: Promise<void> } | undefined;

  function check(manual: boolean) {
    if (pending) {
      pending.manual ||= manual;
      return pending.task;
    }
    const controller = new AbortController();
    const task = Promise.resolve().then(async () => {
      notify({ kind: 'checking' });
      try {
        const response = await fetchRelease(endpoint, {
          headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        if (!response.ok) throw new Error('无法读取发行信息');
        const release = await response.json();
        if (!controller.signal.aborted) result = describeRelease(release, current, process.platform, process.arch);
      } catch {
        if (!controller.signal.aborted) result = { status: { kind: 'error', message: '暂时无法检查更新，请稍后重试。' } };
      } finally {
        pending = undefined;
        notify(result.status);
      }
    });
    pending = { controller, manual, task };
    return task;
  }

  return {
    get status(): UpdateStatus { return pending ? { kind: 'checking' } : result.status; },
    check,
    stopAutomatic: () => { if (pending && !pending.manual) pending.controller.abort(); },
    url: (target: 'homepage' | 'release' | 'download') =>
      target === 'homepage' ? homepage : target === 'release' ? result.releaseUrl : result.downloadUrl,
  };
}

module.exports = { createUpdates, describeRelease };
