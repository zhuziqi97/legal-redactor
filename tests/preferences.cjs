const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { createPreferences } = require('../build/preferences.cjs');
const { createUpdates, describeRelease } = require('../build/updates.cjs');
const { defaultPreferences, inferenceBackends } = require('../build/engine/preferences.js');
const { selectDevice, deviceOption } = require('../build/engine/inference-devices.js');

async function profile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'redactor-preferences-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, 'preferences', 'settings.json') };
}

test('正式发行目标使用预置后端选项', () => {
  assert.deepEqual(inferenceBackends('win32', 'x64'), ['auto', 'cpu', 'dml', 'webgpu']);
  assert.deepEqual(inferenceBackends('linux', 'x64'), ['auto', 'cpu', 'webgpu', 'cuda', 'tensorrt']);
  assert.deepEqual(inferenceBackends('darwin', 'arm64'), ['auto', 'cpu', 'coreml', 'webgpu']);
});

test('自动优先使用探测到的 GPU，手动选择保持设备和后端', async t => {
  const {directory} = await profile(t);
  const cuda = { id: 'cuda:test-gpu', name: 'NVIDIA GPU', backend: 'cuda', index: 1 };
  const trt = { ...cuda, id: 'tensorrt:test-gpu', backend: 'tensorrt' };
  assert.equal(selectDevice([cuda, trt], 'auto'), cuda);
  assert.equal(selectDevice([], 'auto').backend, 'cpu');
  assert.equal(selectDevice([cuda, trt], trt.id), trt);
  assert.equal(selectDevice([cuda], trt.id), undefined);
  assert.equal(deviceOption(trt).label, 'NVIDIA GPU · TensorRT');
  const store = createPreferences(directory);
  await store.load();
  await store.update(next => { next.inference = { provider: trt.id, label: deviceOption(trt).label }; });
  const reopened = createPreferences(directory);
  await reopened.load();
  assert.deepEqual(reopened.value.inference, { provider: trt.id, label: 'NVIDIA GPU · TensorRT' });
});

test('迁移旧配置并保存不同窗口的改动，恢复默认后重启不再读取旧值', async t => {
  const {directory, file} = await profile(t);
  await writeFile(join(directory, 'view-settings.json'), '{"lineNumbers":true,"wrap":false}');
  await writeFile(join(directory, 'inference-settings.json'), '{"provider":"cpu"}');
  const store = createPreferences(directory);
  await store.load();
  assert.deepEqual(store.value.view, { ...defaultPreferences().view, lineNumbers: true, wrap: false });
  assert.equal(store.value.inference.provider, 'cpu');
  await Promise.all([
    store.update(next => { next.view.fontSize = 20; }),
    store.update(next => { next.usage.sidebarCollapsed = true; next.usage.rememberFolders = true; next.usage.folders.redactExport = directory; }),
  ]);
  const saved = JSON.parse(await readFile(file));
  assert.equal(saved.view.fontSize, 20);
  assert.equal(saved.usage.sidebarCollapsed, true);
  assert.equal(saved.usage.folders.redactExport, directory);
  await store.update(defaultPreferences, true);
  const restarted = createPreferences(directory);
  await restarted.load();
  assert.deepEqual(restarted.value, defaultPreferences());
});

test('损坏的设置文件可重建，单项错误和写入失败分别处理', async t => {
  const {directory, file} = await profile(t);
  const store = createPreferences(directory);
  await store.load();
  await writeFile(file, '{');
  await store.load();
  assert.match(store.snapshot().warning, /设置文件损坏/u);
  assert.deepEqual(JSON.parse(await readFile(file)), defaultPreferences());
  await writeFile(file, '{"view":{"fontSize":-2,"lineNumbers":true},"usage":{"mappingScope":"current"}}');
  await store.load();
  assert.equal(store.value.view.fontSize, 15);
  assert.equal(store.value.view.lineNumbers, true);
  assert.equal(store.value.usage.mappingScope, 'current');
  await rm(file);
  await mkdir(file);
  await assert.rejects(store.update(next => { next.view.lineNumbers = false; }), /无法保存设置/u);
  assert.equal(store.value.view.lineNumbers, true);
});

test('版本检查按数字比较正式版本，并使用当前平台的发行包', () => {
  const release = {tag_name:'v0.0.10', assets:[{name:'LegalRedactor-0.0.10-windows-x64.zip', size:1_345_000_000, state:'uploaded'}]};
  assert.deepEqual(describeRelease(release, '0.0.9', 'win32', 'x64').status, {kind:'available', version:'0.0.10', size:1_345_000_000});
  assert.deepEqual(describeRelease(release, '0.0.9', 'darwin', 'arm64').status, {kind:'unavailable', version:'0.0.10'});
  assert.deepEqual(describeRelease(release, '0.0.10', 'win32', 'x64').status, {kind:'current'});
});

test('重复检查合并，关闭自动检查时中止后台请求', async () => {
  let calls = 0;
  const service = createUpdates((_url, {signal}) => {
    calls++;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true}));
  }, '0.0.7', () => {});
  const task = service.check(false);
  assert.equal(task, service.check(false));
  await Promise.resolve();
  service.stopAutomatic();
  await task;
  assert.equal(calls, 1);
  assert.equal(service.status.kind, 'idle');
});
