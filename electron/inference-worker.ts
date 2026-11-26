const { NativeOtter } = require('./otter.cjs');

type InferenceRequest = {
  id: number; op: 'prepare' | 'predict'; directory: string; provider: string;
  texts?: string[]; labels?: string[];
};
type Route = { provider: string; fallbackReason?: string; reusedSession: boolean; loadMs: number };

type Session = {
  directory: string; requested: string; provider: string; fallbackReason?: string;
  model: InstanceType<typeof NativeOtter>;
};
let loaded: Session | undefined;

function explain(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function ensureSession(request: InferenceRequest, send: (message: object) => void): Promise<Route> {
  const {directory, provider} = request;
  const mayFallback = provider === 'auto' && request.op !== 'predict';
  const existing = loaded;
  if (existing?.directory === directory && (existing.provider === provider || (mayFallback && existing.requested === provider))) {
    return {provider: existing.provider, fallbackReason: mayFallback ? existing.fallbackReason : undefined, reusedSession: true, loadMs: 0};
  }
  send({phase: '正在加载模型'});
  const start = performance.now();
  loaded = undefined;
  await existing?.model.release();
  try {
    const model = await NativeOtter.load(directory, provider);
    loaded = {directory, requested: provider, provider, model};
  } catch (error) {
    if (!mayFallback) throw error;
    const fallbackReason = explain(error);
    send({phase: '正在加载模型 · 自动初始化失败，正在尝试 cpu'});
    try {
      const model = await NativeOtter.load(directory, 'cpu');
      loaded = {directory, requested: provider, provider: 'cpu', fallbackReason, model};
    } catch (cpuError) {
      throw new Error(`自动初始化失败：${fallbackReason}。尝试 cpu 失败：${explain(cpuError)}`);
    }
  }
  return {provider: loaded.provider, fallbackReason: loaded.fallbackReason, reusedSession: false, loadMs: performance.now() - start};
}

async function dispatch(request: InferenceRequest, send: (message: object) => void) {
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
