const { appendFileSync, readFileSync } = require('node:fs');

const { parentPort } = process;
const log = value => appendFileSync(process.env.DESKTOP_TEST_LOG, value + '\n');
const mode = () => readFileSync(process.env.DESKTOP_TEST_MODE, 'utf8');
const hold = (waiting, done) => {
  if (!waiting()) return done();
  const timer = setInterval(() => {
    if (!waiting()) { clearInterval(timer); done(); }
  }, 20);
};
log('start');
parentPort.on('message', ({data: {id, op, device, texts}}) => {
  const route = device?.backend;
  log(route ? op + ':' + route : op);
  const reply = message => parentPort.postMessage({id, ...message});
  if (op === 'discover') {
    reply({result: {backends: ['cpu', 'webgpu'], devices: [{id: 'webgpu', backend: 'webgpu', name: 'Fixture GPU'}]}});
  } else if (route === 'webgpu' && mode() === 'fail-' + op) {
    reply({error: 'Simulated inference failure'});
  } else if (op === 'prepare') {
    hold(() => route === 'webgpu' && mode() === 'hold-prepare', () => reply({result: {reusedSession: false, loadMs: 0}}));
  } else if (op === 'predict') {
    hold(() => mode() === 'hold' || (route === 'webgpu' && mode() === 'hold-predict'), () => {
      log('complete:' + route);
      reply({result: texts.map(() => [])});
    });
  }
});
