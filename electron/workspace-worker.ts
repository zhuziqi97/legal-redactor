type Prediction = import('../engine/model.js').Prediction;
type Request = import('../engine/workspace-types.js').Request;
type Workspace = import('../engine/workspace-types.js').Workspace;

type Job = {id: number; state: Workspace; request: Request; provider: string; rulesOnly: boolean};
type Reply = {id: number; predictions?: Prediction[][]; inferenceError?: string};

const port = (process as NodeJS.Process & {parentPort: {on: Function; postMessage: Function}}).parentPort;
const cache = new Map<string, {provider: string; batches: Map<string, Prediction[][]>}>();
const modules = Promise.all([import('./engine/workspace.js'), import('./engine/model.js')]);
let prediction: {id: number; resolve: (result: Prediction[][]) => void; reject: (error: Error) => void} | undefined;

async function dispatch(job: Job) {
  const {id, state, request, provider, rulesOnly} = job;
  const [{runWorkspace}, {scanCandidates}] = await modules;
  if (request.op !== 'scan' && request.op !== 'reviseMaterial') return runWorkspace(state, request);
  const send = (message: object) => port.postMessage({id, ...message});
  const phase = (text: string) => send({phase: text});
  const live = new Set(state.materials.map(doc => doc.id));
  for (const material of cache.keys()) if (!live.has(material)) cache.delete(material);
  const prior = cache.get(request.materialId);
  const current = new Map<string, Prediction[][]>();
  let evaluated = 0;
  let reused = 0;
  let modelMs = 0;
  const started = performance.now();

  async function predict(texts: string[], labels: string[]) {
    const key = JSON.stringify([labels, texts]);
    const previous = prior?.provider === provider ? prior.batches.get(key) : undefined;
    if (previous) {
      reused += texts.length;
      current.set(key, previous);
      return previous;
    }
    const before = performance.now();
    evaluated += texts.length;
    const result = await new Promise<Prediction[][]>((resolve, reject) => {
      prediction = {id, resolve, reject};
      send({inference: {texts, labels}});
    });
    modelMs += performance.now() - before;
    current.set(key, result);
    return result;
  }

  phase('正在分析');
  const result = await runWorkspace(state, request, rulesOnly ? undefined : async (text, free, known) => {
    const hits = await scanCandidates(text, free, known, predict, (done, total) => {
      phase(`已分析 ${done} / ${total} 段 · 首选 EP ${provider} · 复用 ${reused} 段 · 重算 ${evaluated} 段`);
    });
    phase('正在更新映射');
    return hits;
  });
  cache.set(request.materialId, {provider, batches: current});
  send({diagnostic: {stage: 'analysis', revision: request.revision, native: !rulesOnly, preferredEP: rulesOnly ? '' : provider,
    reused, evaluated, modelMs, totalMs: performance.now() - started}});
  return result;
}

port.on('message', ({data}: {data: Job | Reply}) => {
  if ('request' in data) {
    void dispatch(data).then(
      result => port.postMessage({id: data.id, result}),
      error => port.postMessage({id: data.id, error: error instanceof Error ? error.message : String(error)}),
    );
  } else if (prediction?.id === data.id) {
    const waiter = prediction;
    prediction = undefined;
    if (data.inferenceError) waiter.reject(new Error(data.inferenceError));
    else waiter.resolve(data.predictions!);
  }
});
