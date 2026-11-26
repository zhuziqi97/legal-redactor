import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const application = new URL('../', import.meta.url);
if (!existsSync(new URL('dist/index.html', application)) || !existsSync(new URL('build/main.cjs', application))) {
  console.error('请先运行 npm run build。');
  process.exit(1);
}
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const executable = process.env.ELECTRON_BIN || createRequire(import.meta.url)('electron');
const electron = spawn(executable, [fileURLToPath(application)], {
  stdio: 'inherit', env: environment,
});
electron.on('error', () => {
  console.error('找不到 Electron，请将 ELECTRON_BIN 设为本机的 Electron 可执行文件。');
  process.exitCode = 1;
});
electron.on('exit', (code) => { process.exitCode = code ?? 1; });
