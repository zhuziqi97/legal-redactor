const assert = require('node:assert/strict');
const {cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile, appendFile} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {before, after, test} = require('node:test');
const {_electron} = require('playwright');

const root = resolve(__dirname, '..');
const source = '姓名：张甲\n联系电话：13800138000\n业务流水号：2031021800004271\n统一社会信用代码：91000000MA0REDAC1X\n备注：材料已核对。';
const password = '仅用于回归的示例密码';
const channel = (page, name) => page.getByRole('button', {name, exact: true});
const role = (page, name) => page.getByRole('dialog', {name, exact: true});
let fixture, temp;

before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'lr-'));
  // Keep module lookup local and leave the real installed application untouched.
  fixture = await mkdtemp(join(root, 'node_modules', '.desktop-test-'));
  await mkdir(join(fixture, 'build'));
  for (const file of await readdir(join(root, 'build'))) {
    if (file.endsWith('.cjs') || file === 'engine') {
      await cp(join(root, 'build', file), join(fixture, 'build', file), {recursive: true});
    }
  }
  await cp(join(root, 'dist'), join(fixture, 'dist'), {recursive: true});
  await cp(join(__dirname, 'desktop-inference.cjs'), join(fixture, 'build', 'inference-worker.cjs'));
  const manifest = require('../package.json');
  await writeFile(join(fixture, 'package.json'), JSON.stringify({...manifest, main: 'fixture.cjs'}));
  await writeFile(join(fixture, 'fixture.cjs'), `
    const {net} = require('electron');
    net.fetch = async url => {
      if (!url.endsWith('/releases/latest')) throw new Error('Unexpected network request');
      const tag = 'v99.0.0';
      const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
      const ext = platform === 'linux' ? 'tar.gz' : 'zip';
      return new Response(JSON.stringify({tag_name: tag, assets: [
        {name: 'LegalRedactor-99.0.0-' + platform + '-' + process.arch + '.' + ext, size: 420000000, state: 'uploaded'}
      ]}));
    };
    require('./build/main.cjs');
  `);
  await mkdir(join(temp, 'model'));
  await writeFile(join(temp, 'model', 'otter.onnx'), '');
});

after(async () => {
  for (const path of [fixture, temp]) if (path) await rm(path, {recursive: true, force: true, maxRetries: 4});
});

async function open(t, {provider = 'auto', model = true, mode = 'ok', profile} = {}) {
  const directory = profile ?? await mkdtemp(join(temp, 'p-'));
  const settings = join(directory, 'preferences', 'settings.json');
  const log = join(directory, 'worker.log');
  const behavior = join(directory, 'mode.txt');
  if (!profile) {
    await mkdir(join(directory, 'preferences'));
    await writeFile(settings, JSON.stringify({inference: {provider}, updates: {automatic: true, lastAttempt: Date.now()}}));
  }
  await writeFile(log, '');
  await writeFile(behavior, mode);
  const env = {...process.env, REDACTOR_USER_DATA: directory, DESKTOP_TEST_LOG: log, DESKTOP_TEST_MODE: behavior};
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.REDACTOR_RULES_ONLY;
  if (model) env.REDACTOR_ONNX_DIR = join(temp, 'model');
  else delete env.REDACTOR_ONNX_DIR;
  const app = await _electron.launch({
    executablePath: process.env.ELECTRON_BIN || require('electron'), args: [fixture], env, timeout: 30000,
  });
  const close = () => app.evaluate(({app}) => app.exit(0)).catch(() => {});
  t.after(close);
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  return {app, page, close, directory, settings, behavior, ops: async () => (await readFile(log, 'utf8')).trim().split('\n')};
}

async function add(page, title, text = source) {
  await channel(page, '添加文本材料').first().click();
  const dialog = role(page, '添加文本材料');
  await dialog.getByLabel('材料名称').fill(title);
  await dialog.locator('textarea').fill(text);
  await channel(dialog, '添加并识别').click();
}

async function waitForOp(project, expected) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if ((await project.ops()).includes(expected)) return;
    await new Promise(resolve => setTimeout(resolve, 35));
  }
  assert.fail('Missing worker event: ' + expected);
}

function viaMenu(app, label) {
  return app.evaluate(({BrowserWindow, Menu}, label) => {
    const window = BrowserWindow.getAllWindows().find(item => !item.webContents.getURL().includes('settings=1'));
    const item = Menu.getApplicationMenu().items.find(item => item.label === '文件').submenu.items.find(item => item.label === label);
    item.click(item, window, {});
  }, label);
}

const output = page => page.locator('#output-text');
const settingsWindow = ({app, page}, section) => Promise.all([
  app.waitForEvent('window'), page.evaluate(section => window.redaction.openSettings(section), section),
]).then(([settings]) => settings);

test('作业取消后丢弃 GPU 的迟到结果，并可重新识别', async t => {
  const project = await open(t, {mode: 'hold'});
  const {page, behavior} = project;
  await add(page, '待取消材料');
  await waitForOp(project, 'predict:webgpu');
  await channel(page, '取消识别').click();
  await channel(page, '重新识别').waitFor();
  await writeFile(behavior, 'ok');
  await waitForOp(project, 'complete:webgpu');
  assert.equal(await output(page).getByText(/【电话/u).count(), 0);
  await channel(page, '重新识别').click();
  await output(page).getByText(/【电话/u).first().waitFor();
});

for (const phase of ['prepare', 'predict']) {
  test('自动模式的 GPU ' + phase + ' 失败后用 CPU 重试一次', async t => {
    const project = await open(t, {mode: 'fail-' + phase});
    await add(project.page, '自动回退');
    await output(project.page).getByText(/【电话/u).first().waitFor();
    const ops = await project.ops();
    assert.ok(ops.includes(phase + ':webgpu'));
    assert.equal(ops.filter(value => value === 'prepare:cpu').length, 1);
    assert.ok(ops.includes('complete:cpu'));
    assert.equal(JSON.parse(await readFile(project.settings, 'utf8')).inference.provider, 'auto');
  });
}

test('手动设备报错后保留材料及其偏好', async t => {
  const project = await open(t, {provider: 'webgpu', mode: 'fail-predict'});
  await add(project.page, '手动设备失败');
  await project.page.getByText('所选设备无法完成识别。请在设置中重新选择或重试。', {exact: true}).waitFor();
  assert.ok((await project.ops()).includes('predict:webgpu'));
  assert.ok(!(await project.ops()).some(value => value.endsWith(':cpu')));
  assert.match(await project.page.locator('#source-text').textContent(), /13800138000/u);
});

test('无模型时可应用偏好，重启可读，更新提醒可打开更新页', async t => {
  const project = await open(t, {model: false});
  const settings = await settingsWindow(project, 'inference');
  const device = settings.getByRole('combobox', {name: '推理设备'});
  await device.locator('option[value="webgpu"]').waitFor({state: 'attached'});
  await device.selectOption('webgpu');
  assert.equal(JSON.parse(await readFile(project.settings, 'utf8')).inference.provider, 'auto');
  await channel(settings, '应用').click();
  await settings.getByText('设置已应用。').waitFor();
  assert.deepEqual(await project.ops(), ['discover']);
  await project.close();

  const resumed = await open(t, {profile: project.directory, model: false});
  const updated = await settingsWindow(resumed, 'inference');
  const restored = updated.getByRole('combobox', {name: '推理设备'});
  await restored.locator('option[value="webgpu"]').waitFor({state: 'attached'});
  assert.equal(await restored.inputValue(), 'webgpu');
  await channel(updated, '软件更新').click();
  await channel(updated, '立即检查').click();
  await updated.getByText('发现新版 99.0.0 · 420 MB').waitFor();
  const badge = channel(resumed.page, '发现新版 99.0.0');
  await badge.waitFor();
  await channel(updated, '常规').click();
  await badge.click();
  await updated.getByRole('heading', {name: '软件更新'}).waitFor();
  await channel(updated, '下载').waitFor();
});

async function renameMapping(page, previous, next) {
  const mapping = page.locator('.mapping').filter({has: channel(page, `张甲 → 【${previous}】`)});
  await channel(mapping, '修改映射').click();
  const adjustment = page.getByRole('region', {name: '调整清单'});
  await adjustment.getByLabel('代号').fill(next);
  await channel(adjustment, '应用修改').click();
  await output(page).getByText(`【${next}】`, {exact: true}).waitFor();
}

test('加密项目重开保留共享代号，保存冲突保留当前修改与原文件', async t => {
  const project = await open(t, {provider: 'cpu'});
  const {app, page, directory} = project;
  await add(page, '首次笔录');
  await output(page).getByText('【张某】', {exact: true}).waitFor();
  await add(page, '补充笔录', '姓名：张甲\n联系电话：13800138000\n补充说明已核对。');
  await output(page).getByText(/补充说明已核对。/u).last().waitFor();
  await renameMapping(page, '张某', '当事人甲');

  await app.evaluate(({dialog}, path) => {
    dialog.showOpenDialog = async () => ({canceled: false, filePaths: [path]});
  }, directory);
  await viaMenu(app, '保存项目');
  const save = role(page, '保存项目');
  await save.getByLabel('文件名').fill('合成项目');
  await channel(save, '更改…').click();
  await save.getByText(directory, {exact: true}).waitFor();
  await save.getByRole('switch', {name: '密码保护'}).check();
  await save.getByLabel('新密码').fill(password);
  await save.getByLabel('确认密码').fill(password);
  await channel(save, '保存').click();
  await page.locator('#redact-panel').getByText('项目已保存', {exact: true}).waitFor();
  const path = join(directory, '合成项目.lrproj');
  const saved = await readFile(path);
  assert.equal(saved.subarray(0, 10).toString(), 'LRPROJ-ENC');

  await renameMapping(page, '当事人甲', '未保存代号');
  await appendFile(path, '模拟外部文件修改');
  const externallyChanged = await readFile(path);
  await viaMenu(app, '保存项目');
  await page.locator('#redact-panel').getByText(/项目文件已在外部移动或更改/u).waitFor();
  assert.deepEqual(await readFile(path), externallyChanged);
  await output(page).getByText('【未保存代号】', {exact: true}).waitFor();
  await project.close();
  await writeFile(path, saved);

  const reopen = await open(t, {provider: 'cpu'});
  await reopen.app.evaluate(({dialog}, path) => {
    dialog.showOpenDialog = async () => ({canceled: false, filePaths: [path]});
  }, path);
  await channel(reopen.page.getByRole('tabpanel', {name: '脱敏'}), '打开项目').click();
  const unlock = role(reopen.page, '解锁项目');
  await unlock.getByLabel('项目密码').fill(password);
  await channel(unlock, '解锁').click();
  await output(reopen.page).getByText('【当事人甲】', {exact: true}).waitFor();
  await reopen.page.getByText('首次笔录', {exact: true}).first().click();
  await output(reopen.page).getByText('【当事人甲】', {exact: true}).waitFor();
});
