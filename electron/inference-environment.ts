const { execFile } = require('node:child_process') as typeof import('node:child_process');
const { existsSync } = require('node:fs') as typeof import('node:fs');
const { dirname, join } = require('node:path') as typeof import('node:path');
const { cpus } = require('node:os') as typeof import('node:os');
const { promisify } = require('node:util') as typeof import('node:util');
const { automaticGpu } = require('./engine/inference-devices.js') as typeof import('../engine/inference-devices.js');
type InferenceDevice = import('../engine/inference-devices.js').InferenceDevice;
type Backend = import('../engine/inference-devices.js').Backend;

const command = promisify(execFile);
async function output(executable: string, args: string[] = []) {
  try { return (await command(executable, args, { timeout: 5000, windowsHide: true })).stdout; }
  catch { return ''; }
}

function gpu(backend: Backend, name = automaticGpu, automatic = true): InferenceDevice {
  return automatic ? { id: backend, backend, name } : { id: backend, backend, name, automatic };
}

// Shared-memory adapters stay selectable, but measured Otter runs on them were slower than on the CPU.
function windowsDevices(probe: string, directML: boolean, webgpu: boolean): InferenceDevice[] {
  const adapters = probe.trim().split('\n').flatMap(line => {
    const [index, rank, key, name, shared] = line.trimEnd().split('\t');
    return key && name ? [{ index: Number(index), rank: Number(rank), key, name, shared: shared === '1' }] : [];
  }).sort((first, second) => first.rank - second.rank);
  if (!adapters.length) return [];
  const dedicated = adapters.some(adapter => !adapter.shared);
  const devices: InferenceDevice[] = [];
  if (directML) {
    for (const { index, key, name, shared } of adapters) {
      if (adapters.filter(adapter => adapter.key === key).length !== 1) continue;
      devices.push({ id: 'dml:' + Buffer.from(key).toString('base64url'), backend: 'dml', name, index,
        ...(shared ? { automatic: false } : {}) });
    }
    devices.push(gpu('dml', automaticGpu, dedicated));
  }
  if (webgpu) devices.push(gpu('webgpu', automaticGpu, dedicated));
  return devices;
}

async function discoverInferenceEnvironment(): Promise<{ devices: InferenceDevice[]; backends: string[] }> {
  const ort = require('onnxruntime-node') as typeof import('onnxruntime-node');
  const backends = ort.listSupportedBackends().map(backend => backend.name);
  const binding = join(dirname(require.resolve('onnxruntime-node/package.json')), 'bin', 'napi-v6', process.platform, process.arch);
  const devices: InferenceDevice[] = [];

  if (process.platform === 'win32') {
    const probe = await output(join(__dirname, 'inference-probe.exe'));
    devices.push(...windowsDevices(probe, backends.includes('dml') && existsSync(join(binding, 'DirectML.dll')),
      backends.includes('webgpu')));
  }

  if (process.platform === 'linux') {
    const helper = join(__dirname, 'inference-probe');
    const [vulkan, cuda, tensors] = await Promise.all([
      backends.includes('webgpu') ? existsSync(helper) ? output(helper, ['vulkan'])
        : output('vulkaninfo', ['--summary']).then(info => /PHYSICAL_DEVICE_TYPE_(DISCRETE|INTEGRATED|VIRTUAL)_GPU/u.test(info) ? 'GPU' : '') : '',
      backends.includes('cuda') ? linuxProviderAvailable(binding, 'cuda') : false,
      backends.includes('tensorrt') ? linuxProviderAvailable(binding, 'tensorrt') : false,
    ]);
    const cards = cuda || tensors ? (await output(helper, ['cuda'])).trim().split('\n').flatMap(line => {
      const [index, uuid, name] = line.split('\t');
      return uuid && name ? [{ index: Number(index), uuid, name }] : [];
    }) : [];
    if (cuda && cards.length) devices.push(...cards.map(({ index, uuid, name }) =>
      ({ id: 'cuda:' + uuid, backend: 'cuda' as const, name, index })), gpu('cuda'));
    if (vulkan.trim()) devices.push(gpu('webgpu'));
    if (tensors && cards.length) devices.push(...cards.map(({ index, uuid, name }) =>
      ({ id: 'tensorrt:' + uuid, backend: 'tensorrt' as const, name, index })), gpu('tensorrt'));
  }

  if (process.platform === 'darwin' && process.arch === 'arm64') {
    if (backends.includes('coreml')) devices.push(gpu('coreml', cpus()[0]?.model || 'Apple 芯片'));
    if (backends.includes('webgpu')) devices.push(gpu('webgpu'));
  }
  return { devices, backends };
}

async function linuxProviderAvailable(binding: string, name: string) {
  const library = join(binding, `libonnxruntime_providers_${name}.so`);
  if (!existsSync(library) || !existsSync(join(binding, 'libonnxruntime_providers_shared.so'))) return false;
  const libraries = await output('ldd', [library]);
  return !!libraries && !/not found|not a dynamic executable/u.test(libraries);
}

export = { discoverInferenceEnvironment, windowsDevices };
