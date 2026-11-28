const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { createPreferences } = require('../build/preferences.cjs');
const { createUpdates, describeRelease } = require('../build/updates.cjs');
const { defaultPreferences, inferenceBackends } = require('../build/engine/preferences.js');
const { selectDevice, deviceOption } = require('../build/engine/inference-devices.js');
const { windowsDevices } = require('../build/inference-environment.cjs');
const { cpuThreadCount, batchShape } = require('../build/otter.cjs');

async function profile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'redactor-preferences-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, 'preferences', 'settings.json') };
}

test('CPU 线程数按核心数自适应且不低于 4 核基线，DirectML 分桶仅对 6 GiB+ 独显启用', () => {
  assert.deepEqual([2, 4, 6, 8, 12, 16, 24, 32].map(cpuThreadCount), [2, 4, 4, 4, 6, 8, 8, 8]);
  const rtx4070 = { backend: 'dml', memoryMiB: 11997 };
  const rtx2060 = { backend: 'dml', memoryMiB: 5980 };
  const gtx1650 = { backend: 'dml', memoryMiB: 3962 };
  const igpu = { backend: 'dml' };
  assert.deepEqual(batchShape(rtx4070, 62, 1), { tokenCount: 128, batchSize: 1 });
  assert.deepEqual(batchShape(rtx4070, 140, 3), { tokenCount: 192, batchSize: 8 });
  assert.deepEqual(batchShape(rtx2060, 210, 8), { tokenCount: 256, batchSize: 8 });
  assert.deepEqual(batchShape(rtx4070, 300, 3), { tokenCount: 300, batchSize: 3 });
  assert.deepEqual(batchShape(gtx1650, 140, 3), { tokenCount: 140, batchSize: 3 });
  assert.deepEqual(batchShape(igpu, 140, 3), { tokenCount: 140, batchSize: 3 });
  assert.deepEqual(batchShape({ backend: 'webgpu', memoryMiB: 11997 }, 140, 3), { tokenCount: 140, batchSize: 3 });
  assert.deepEqual(batchShape({ backend: 'cpu' }, 140, 3), { tokenCount: 140, batchSize: 3 });
});

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
  const igpuOnly = windowsDevices('0\t0\tintel-uhd\tIntel(R) UHD Graphics 770\t1\t128\n', true, true);
  assert.equal(igpuOnly.length, 3);
  assert.equal(selectDevice(igpuOnly, 'auto').backend, 'cpu');
  assert.equal(selectDevice(igpuOnly, igpuOnly[0].id), igpuOnly[0]);
  assert.equal(igpuOnly[0].memoryMiB, undefined);
  assert.equal(deviceOption(igpuOnly[0]).label, 'Intel(R) UHD Graphics 770 · DirectML');
  const lowVram = windowsDevices('0\t0\tgt-1030\tNVIDIA GeForce GT 1030\t0\t2048\n', true, true);
  assert.equal(selectDevice(lowVram, 'auto').backend, 'cpu');
  assert.equal(selectDevice(lowVram, lowVram[0].id).memoryMiB, 2048);
  const entry4G = windowsDevices('0\t0\tgtx-1650\tNVIDIA GeForce GTX 1650\t0\t3962\n', true, true);
  assert.equal(selectDevice(entry4G, 'auto').name, 'NVIDIA GeForce GTX 1650');
  assert.equal(entry4G[0].memoryMiB, 3962);
  const dualGpu = windowsDevices(
    '1\t1\tintel-uhd\tIntel(R) UHD Graphics 770\t1\t128\n0\t0\tnvidia-rtx\tNVIDIA GeForce RTX 4070 SUPER\t0\t12012\n',
    true, true,
  );
  assert.equal(selectDevice(dualGpu, 'auto').name, 'NVIDIA GeForce RTX 4070 SUPER');
  assert.equal(dualGpu[0].memoryMiB, 12012);
  assert.equal(selectDevice(dualGpu, dualGpu[1].id).name, 'Intel(R) UHD Graphics 770');
  assert.equal(dualGpu.find(device => device.id === 'webgpu').automatic, undefined);
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
