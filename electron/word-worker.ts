const { parentPort, workerData } = require('node:worker_threads') as typeof import('node:worker_threads');
const { readWordInput } = require('./word-input.cjs') as { readWordInput(bytes: Buffer): Promise<string> };

const port = parentPort!;
void readWordInput(Buffer.from(workerData)).then(
  text => port.postMessage({ text }),
  (error: Error) => port.postMessage({ error: error.message }),
);
