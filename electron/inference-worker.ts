type InferenceDevice = import('../engine/inference-devices.js').InferenceDevice;

type InferenceRequest = { id: number; op: 'discover' } | {
  id: number; op: 'prepare' | 'predict'; directory: string; device: InferenceDevice;
  texts?: string[]; labels?: string[];
};

type Session = {
  directory: string;
  device: string;
  model: { release(): Promise<void>; predict(texts: string[], labels: string[]): Promise<unknown> };
};
let loaded: Session | undefined;

function explain(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function ensureSession(request: Exclude<InferenceRequest, {op: 'discover'}>, send: (message: object) => void) {
  const {directory, device} = request;
  const existing = loaded;
  if (existing?.directory === directory && existing.device === device.id) return {reusedSession: true, loadMs: 0};
  send({phase: '正在加载模型'});
  const start = performance.now();
  loaded = undefined;
  await existing?.model.release();
  const { NativeOtter } = require('./otter.cjs');
  loaded = {directory, device: device.id, model: await NativeOtter.load(directory, device)};
  return {reusedSession: false, loadMs: performance.now() - start};
}

async function dispatch(request: InferenceRequest, send: (message: object) => void) {
  if (request.op === 'discover') return require('./inference-environment.cjs').discoverInferenceEnvironment();
  const route = await ensureSession(request, send);
  if (request.op === 'prepare') return route;
  return loaded!.model.predict(request.texts!, request.labels!);
}

const parentPort = (process as NodeJS.Process & { parentPort: { on: Function; postMessage: Function } }).parentPort;
let queue = Promise.resolve();
parentPort.on('message', (event: { data: InferenceRequest }) => {
  const request = event.data;
  const send = (message: object) => parentPort.postMessage({id: request.id, ...message});
  queue = queue.then(async () => {
    try {
      send({result: await dispatch(request, send)});
    } catch (error) {
      send({error: explain(error)});
    }
  });
});
