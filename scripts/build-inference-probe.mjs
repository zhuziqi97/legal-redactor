import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = join(root, 'build');

if (process.platform === 'linux') {
  mkdirSync(build, {recursive: true});
  execFileSync(process.env.CC || 'cc', [
    '-O2', '-std=c11', 'native/inference-probe-linux.c', '-ldl', '-o', 'build/inference-probe',
  ], {cwd: root, stdio: 'inherit'});
} else if (process.platform === 'win32') {
  mkdirSync(build, {recursive: true});
  const compile = 'cl /nologo /std:c++17 /EHsc /O2 /MT /Fobuild\\inference-probe.obj /Febuild\\inference-probe.exe native\\inference-probe-windows.cpp dxgi.lib d3d12.lib user32.lib';
  if (process.env.VCINSTALLDIR) {
    execFileSync('cmd.exe', ['/d', '/c', compile], {cwd: root, stdio: 'inherit'});
  } else {
    const vswhere = join(process.env['ProgramFiles(x86)'] ?? process.env.ProgramFiles,
      'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    const installation = execFileSync(vswhere, [
      '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath',
    ], {encoding: 'utf8'}).trim();
    if (!installation) throw new Error('Install the Visual Studio C++ x64 build tools.');
    const vcvars = join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
    execFileSync('cmd.exe', ['/d', '/s', '/c', `"call "${vcvars}" && ${compile}"`],
      {cwd: root, windowsVerbatimArguments: true, stdio: 'inherit'});
  }
  rmSync(join(build, 'inference-probe.obj'), {force: true});
}
