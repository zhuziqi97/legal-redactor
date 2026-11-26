const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const requests = [];
const blocked = new Set(['cuda:unavailable']);
const gpu = { id: 'cuda:first', backend: 'cuda', name: '测试 GPU', index: 0 };
const secondGpu = { id: 'cuda:second', backend: 'cuda', name: '另一张 GPU', index: 1 };
const cpu = { id: 'cpu', backend: 'cpu', name: 'CPU' };
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
  async load(directory, device) {
    requests.push([directory, device.id]);
    if (blocked.has(device.id)) throw new Error(`${device.id} 无法初始化`);
    return { release() {}, predict: async () => [[device.id]] };
  },
};
runInNewContext(readFileSync(join(__dirname, '../build/inference-worker.cjs'), 'utf8'),
  { require: file => file === './otter.cjs' ? { NativeOtter }
    : { discoverInferenceEnvironment: async () => ({ devices: [gpu], backends: ['cuda', 'cpu'] }) }, Error, String,
    performance, process: {parentPort} });

let nextId = 0;
async function request(op, device, directory = '本机模型') {
  phases = [];
  const message = await new Promise(resolve => {
    response = resolve;
    receive({data: {id: ++nextId, op, device, directory, texts: [''], labels: []}});
  });
  assert.equal(message.id, nextId);
  return message;
}
(async () => {
  assert.deepEqual((await request('discover')).result.devices, [gpu]);
  assert.deepEqual(requests, []);
  assert.deepEqual(phases, []);
  assert.equal((await request('prepare', gpu)).result.reusedSession, false);
  assert.deepEqual(phases, ['正在加载模型']);
  assert.deepEqual((await request('predict', gpu)).result, [[gpu.id]]);
  assert.equal((await request('prepare', gpu)).result.reusedSession, true);
  assert.equal((await request('prepare', secondGpu)).result.reusedSession, false);
  assert.deepEqual((await request('predict', secondGpu)).result, [[secondGpu.id]]);
  assert.equal((await request('prepare', { ...gpu, id: 'cuda:unavailable' })).error, 'cuda:unavailable 无法初始化');
  assert.deepEqual(requests, [['本机模型', gpu.id], ['本机模型', secondGpu.id], ['本机模型', 'cuda:unavailable']]);
  assert.deepEqual((await request('predict', cpu)).result, [['cpu']]);
  console.log('无模型环境探测、按设备复用会话、显式失败及预测路由均通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
