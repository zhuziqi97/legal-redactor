export const backendLabels = {
  cpu: 'CPU', dml: 'DirectML', webgpu: 'WebGPU', cuda: 'CUDA', tensorrt: 'TensorRT', coreml: 'CoreML',
} as const;

export type Backend = keyof typeof backendLabels;
export type InferenceDevice = {
  id: string;
  backend: Backend;
  name: string;
  index?: number;
  /** Dedicated GPU memory in MiB when known. */
  memoryMiB?: number;
  /** False keeps a device out of the automatic choice while it remains selectable. */
  automatic?: boolean;
};
export type InferenceOption = { id: string; label: string };
export type InferenceStatus = {
  options: InferenceOption[];
  selected: string;
  active: string;
};

export const cpuDevice: InferenceDevice = { id: 'cpu', backend: 'cpu', name: 'CPU' };
export const automaticGpu = 'GPU（自动选择）';

export function deviceOption(device: InferenceDevice): InferenceOption {
  return { id: device.id, label: device.backend === 'cpu' ? 'CPU' : `${device.name} · ${backendLabels[device.backend]}` };
}

export function selectDevice(devices: InferenceDevice[], choice: string) {
  if (choice === 'auto') return devices.find(device => device.automatic !== false) ?? cpuDevice;
  if (choice === 'cpu') return cpuDevice;
  return devices.find(device => device.id === choice);
}

export function previousDeviceLabel(choice: string, label: string) {
  if (label) return label;
  const backend = choice.split(':', 1)[0] as Backend;
  if (backend === 'coreml') return 'Apple 芯片 · CoreML';
  return Object.hasOwn(backendLabels, backend) ? `${automaticGpu} · ${backendLabels[backend]}` : '上次选择的设备';
}
