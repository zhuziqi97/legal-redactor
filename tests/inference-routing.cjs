const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const requests = [];
const blocked = new Set(['auto', 'cuda']);
let receive;
let response;
let phases = [];
const parentPort = {
  on(_event, listener) { receive = listener; },
  postMessage(message) {
    if (message.phase) phases.push(message.phase);
    else response(message);
  },
};
const NativeOtter = {
  async load(directory, provider) {
    requests.push([directory, provider]);
    if (blocked.has(provider)) throw new Error(`${provider} 无法初始化`);
    return { release() {}, predict: async () => [[provider]] };
  },
};
runInNewContext(readFileSync(join(__dirname, '../build/inference-worker.cjs'), 'utf8'),
  { require: () => ({ NativeOtter }), Error, String,
    performance, process: {parentPort} });

let nextId = 0;
async function request(op, provider, directory = '本机模型') {
  phases = [];
  const message = await new Promise(resolve => {
    response = resolve;
    receive({data: {id: ++nextId, op, provider, directory, texts: [''], labels: []}});
  });
  assert.equal(message.id, nextId);
  return message;
}
(async () => {
  const fallback = (await request('prepare', 'auto')).result;
  assert.equal(fallback.provider, 'cpu');
  assert.equal(fallback.fallbackReason, 'auto 无法初始化');
  assert.equal(fallback.reusedSession, false);
  assert.ok(fallback.loadMs >= 0);
  assert.deepEqual(phases, ['正在加载模型', '正在加载模型 · 自动初始化失败，正在尝试 cpu']);
  assert.deepEqual((await request('predict', fallback.provider)).result, [['cpu']]);
  assert.equal((await request('prepare', 'auto')).result.reusedSession, true);
  assert.equal((await request('prepare', 'cpu')).result.fallbackReason, undefined);
  assert.deepEqual(requests, [['本机模型', 'auto'], ['本机模型', 'cpu']]);
  assert.equal((await request('prepare', 'cuda')).error, 'cuda 无法初始化');
  assert.deepEqual(requests.at(-1), ['本机模型', 'cuda']);
  blocked.add('cpu');
  assert.match((await request('prepare', 'auto')).error, /自动初始化失败.*尝试 cpu 失败/);
  blocked.delete('auto');
  assert.equal((await request('prepare', 'auto')).result.provider, 'auto');
  assert.equal((await request('prepare', 'auto')).result.reusedSession, true);
  blocked.add('auto');
  assert.equal((await request('predict', 'auto', '不同模型')).error, 'auto 无法初始化');
  assert.deepEqual(requests.at(-1), ['不同模型', 'auto']);
  console.log('模型加载、自动回退、预热复用、显式失败及预测路由均通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
