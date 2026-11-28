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

async function open(t, {provider = 'auto', model = true, mode = 'ok', profile, env: extra = {}} = {}) {
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
  const env = {...process.env, ...extra, REDACTOR_USER_DATA: directory, DESKTOP_TEST_LOG: log, DESKTOP_TEST_MODE: behavior};
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.REDACTOR_RULES_ONLY;
  if (model) env.REDACTOR_ONNX_DIR = join(temp, 'model');
  else delete env.REDACTOR_ONNX_DIR;
  const app = await _electron.launch({
    executablePath: process.env.ELECTRON_BIN || require('electron'), args: process.platform === 'linux' ? [fixture, '--no-sandbox'] : [fixture], env, timeout: 30000,
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
const count = async (project, op) => (await project.ops()).filter(value => value === op).length;

async function waitForCount(project, op, expected) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await count(project, op) >= expected) return;
    await new Promise(resolve => setTimeout(resolve, 35));
  }
  assert.fail(`Expected ${expected} worker events: ${op}`);
}

for (const phase of ['prepare', 'predict']) {
  test('取消 GPU ' + phase + ' 时结束推理进程，并可重新识别', async t => {
    const project = await open(t, {mode: 'hold-' + phase});
    const {page, behavior} = project;
    await add(page, '待取消材料');
    await waitForOp(project, phase + ':webgpu');
    await channel(page, '取消识别').click();
    await channel(page, '重新识别').waitFor();
    await writeFile(behavior, 'ok');
    await channel(page, '重新识别').click();
    await output(page).getByText(/【电话/u).first().waitFor();
    assert.equal(await count(project, 'start'), 2);
    assert.equal(await count(project, 'complete:webgpu'), 1);
  });
}

test('推理空闲后结束进程，下次识别重新启动', async t => {
  const project = await open(t, {env: {REDACTOR_INFERENCE_IDLE_MS: '300'}});
  await add(project.page, '首份材料');
  await waitForCount(project, 'complete:webgpu', 1);
  const started = await count(project, 'start');
  await new Promise(resolve => setTimeout(resolve, 900));
  await add(project.page, '空闲后的材料');
  await waitForCount(project, 'complete:webgpu', 2);
  assert.equal(await count(project, 'start'), started + 1);
});

test('切换推理设备后结束原进程，新设备重新加载', async t => {
  const project = await open(t);
  await add(project.page, '首份材料');
  await waitForCount(project, 'complete:webgpu', 1);
  assert.equal(await count(project, 'start'), 1);
  const settings = await settingsWindow(project, 'inference');
  await settings.getByRole('combobox', {name: '推理设备'}).selectOption('cpu');
  await channel(settings, '应用').click();
  await settings.getByText('设置已应用。').waitFor();
  await add(project.page, '改用 CPU 的材料');
  await waitForCount(project, 'complete:cpu', 1);
  assert.equal(await count(project, 'start'), 2);
});

for (const change of ['title', 'mapping']) {
  test(change === 'title' ? '识别期间重命名另一份材料只计算一轮' : '识别期间更改映射会基于新映射重新提交', async t => {
    const {crossCategoryProject} = require('./mapping-fixture.cjs');
    const {readProject, writeProject} = require('../build/project-file.cjs');
    const project = await open(t, {provider: 'cpu', mode: 'hold'});
    const {app, page, directory, behavior} = project;
    const path = join(directory, '同时复核.lrproj');
    await writeProject(path, crossCategoryProject());
    await app.evaluate(({dialog}, path) => {
      dialog.showOpenDialog = async () => ({canceled:false, filePaths:[path]});
    }, path);
    await channel(page.getByRole('tabpanel', {name:'脱敏'}), '打开项目').click();
    await page.locator('.material-row').filter({hasText:'合成笔录'}).waitFor();
    await add(page, '待识别笔录', '经确认，工作人员已经核对清单并按通知完成交接。\n联系电话：13800138000');
    await waitForOp(project, 'predict:cpu');

    const response = await page.evaluate(kind => window.redaction.engine(kind === 'title'
      ? {op:'renameMaterial', materialId:'1', title:'修正后的材料名'}
      : {op:'apply', change:{mode:'rename', groupId:'person', code:'【修改后的代号】'}}), change);
    assert.equal('issue' in response, false);
    await writeFile(behavior, 'ok');
    await output(page).getByText(/【电话/u).first().waitFor();
    const events = (await readFile(join(directory, 'diagnostics.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(row => row.stage === 'analysis').length, change === 'title' ? 1 : 2);
    assert.equal((await project.ops()).filter(op => op === 'predict:cpu').length, 1);
    await page.evaluate(() => window.redaction.saveProject());
    const {state} = await readProject(path);
    if (change === 'title') {
      assert.equal(state.materials[0].title, '修正后的材料名');
      const row = page.locator('.mapping-toggle').filter({hasText:'【柳某甲】'});
      await row.click();
      await page.locator('.position-list').getByText(/修正后的材料名/u).first().waitFor();
    } else {
      assert.equal(state.groups.person.code, '【修改后的代号】');
      await page.locator('.mapping-toggle').filter({hasText:'【修改后的代号】'}).waitFor();
    }
  });
}

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
  assert.deepEqual(await project.ops(), ['start', 'discover']);
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
  await channel(mapping, '修改代号').click();
  const adjustment = page.getByRole('region', {name: '调整清单'});
  await adjustment.getByLabel('代号').fill(next);
  await channel(adjustment, '确认改代号').click();
  await output(page).getByText(`【${next}】`, {exact: true}).waitFor();
}

test('加密项目重开保留共享代号，保存冲突保留当前修改与原文件', async t => {
  const project = await open(t, {provider: 'cpu'});
  const {app, page, directory} = project;
  await add(page, '首次笔录');
  await output(page).getByText('【张某1】', {exact: true}).waitFor();
  await add(page, '补充笔录', '姓名：张甲\n联系电话：13800138000\n补充说明已核对。');
  await output(page).getByText(/补充说明已核对。/u).last().waitFor();
  await renameMapping(page, '张某1', '当事人甲');

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

test('搜索派生代号找到跨类别目标，预览三处后合并并撤销', async t => {
  const {crossCategoryProject} = require('./mapping-fixture.cjs');
  const {writeProject} = require('../build/project-file.cjs');
  const {app, page, directory} = await open(t, {provider: 'cpu', model: false});
  const path = join(directory, '跨类别复核.lrproj');
  const state = crossCategoryProject();
  const original = state.materials[0];
  const first = original.decisions[0];
  first.aliasType = '曾用名';
  first.replacement = '【柳某甲-曾用名1】';
  const lastTwo = original.decisions.splice(-2);
  const offset = original.text.lastIndexOf('\n', lastTwo[0].start - 1) + 1;
  state.materials.push({...original, id:'2', title:'补充材料', text:original.text.slice(offset),
    decisions:lastTwo.map(row => ({...row, start:row.start - offset, end:row.end - offset}))});
  const extra = {...original, id:'3', title:'其他材料', text:'', decisions:[]};
  const names = [...Array.from({length:20}, (_, index) => `模拟单位${index + 1}`), '柳明传'];
  for (const [index, name] of names.entries()) {
    const id = `extra-${index + 1}`;
    const type = index === names.length - 1 ? 'person' : 'organization';
    const code = type === 'person' ? '【柳某乙】' : `【单位${index + 1}】`;
    const start = extra.text.length;
    extra.text += name + '\n';
    extra.decisions.push({...first, id:index + 1, original:name, start, end:start + name.length, group:id,
      replacement:code, aliasType:'', match:undefined, name:null, type});
    state.groups[id] = {id, type, primary:name, code};
  }
  state.materials.push(extra);
  state.nextMaterialId = 4;
  original.text = original.text.slice(0, offset);
  await writeProject(path, state);
  await app.evaluate(({dialog}, path) => {
    dialog.showOpenDialog = async () => ({canceled:false, filePaths:[path]});
  }, path);
  await channel(page.getByRole('tabpanel', {name:'脱敏'}), '打开项目').click();
  const mappings = page.getByRole('region', {name:'映射清单'});
  const filter = mappings.getByRole('searchbox', {name:'搜索映射'});
  const category = mappings.getByLabel('映射类别');
  await category.selectOption('organization');
  await filter.fill('L机构');
  const source = mappings.locator('.mapping').filter({has: channel(page, '柳明川 → 【L机构】')});
  await channel(source, '柳明川的映射操作').click();
  await channel(source, '合并到其他映射').click();
  const dialog = role(page, '合并映射');
  const search = dialog.getByRole('searchbox', {name:'搜索目标映射'});
  assert.equal(await search.evaluate(input => document.activeElement === input), true);
  const candidates = dialog.getByRole('group', {name:'目标映射'});
  assert.deepEqual(await candidates.getByRole('button').evaluateAll(items => items.slice(0, 2).map(item => item.getAttribute('aria-label'))),
    ['柳明川 → 【柳某甲】 99 处', '柳明传 → 【柳某乙】 1 处']);
  assert.equal(await candidates.getByText('文字相近', {exact:true}).count(), 0);
  await dialog.getByText('共 22 项', {exact:true}).waitFor();
  assert.equal(await candidates.evaluate(list => list.clientHeight < list.scrollHeight), true);
  await search.fill('柳明传');
  assert.deepEqual(await candidates.getByRole('button').evaluateAll(items => items.map(item => item.getAttribute('aria-label'))),
    ['柳明传 → 【柳某乙】 1 处', '柳明川 → 【柳某甲】 99 处']);
  await search.fill('L机构');
  await dialog.getByText('没有匹配的映射').waitFor();
  assert.equal(await channel(dialog, '查看合并').isDisabled(), true);
  await search.fill('柳某甲-曾用名1');
  const target = channel(dialog, '柳明川 → 【柳某甲】 99 处');
  await target.waitFor();
  await search.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await target.getAttribute('aria-pressed'), 'true');
  await channel(dialog, '查看合并').click();
  const preview = page.getByRole('region', {name:'调整清单'});
  await preview.getByLabel('柳明川的代号').selectOption('【柳某甲】');
  await preview.getByText('迁入 3 处 → 【柳某甲】', {exact:true}).waitFor();
  assert.equal(await preview.locator('.impact-entry').count(), 3);
  assert.equal(await output(page).getByText('【L机构】', {exact:true}).count(), 1);
  await channel(preview, '第 1 行 · 定位原文').click();
  await page.locator('#source-text mark[data-item="101"]').waitFor();
  assert.equal(await output(page).getByText('【L机构】', {exact:true}).count(), 2);
  await channel(preview, '更换目标').click();
  await channel(dialog, '查看合并').click();
  await preview.getByLabel('柳明川的代号').selectOption('【柳某甲】');
  await channel(preview, '确认合并').click();
  const merged = mappings.locator('.mapping').filter({has:channel(page, '柳明川 → 【柳某甲】')});
  await merged.getByText('102 处', {exact:true}).waitFor();
  assert.equal(await category.inputValue(), 'person');
  assert.equal(await filter.inputValue(), '');
  assert.equal(await channel(merged, '柳明川 → 【柳某甲】').getAttribute('aria-pressed'), 'true');
  assert.equal(await source.count(), 0);
  assert.equal(await output(page).getByText('【L机构】', {exact:true}).count(), 0);
  await channel(mappings, '撤销上次订正').click();
  await output(page).getByText('【L机构】', {exact:true}).first().waitFor();
  assert.equal(await category.inputValue(), 'person');
  assert.equal(await source.count(), 0);

  await page.locator('#source-text mark[data-item="101"]').click();
  await filter.fill('柳');
  await channel(mappings, '查看所属映射').click();
  await source.getByText('3 处', {exact:true}).waitFor();
  assert.equal(await category.inputValue(), 'organization');
  assert.equal(await filter.inputValue(), '柳');
  await page.locator('#source-text mark[data-item="101"]').click();
  await channel(page, '绑定到现有映射').click();
  const picker = preview.getByRole('searchbox', {name:'搜索目标映射'});
  await picker.fill('柳某甲-曾用名1');
  await channel(preview, '柳明川 → 【柳某甲】 99 处').click();
  await preview.getByLabel('柳明川的代号').selectOption('【柳某甲】');
  await channel(preview, '应用到所选 1 处').click();
  await merged.getByText('100 处', {exact:true}).waitFor();
  assert.equal(await category.inputValue(), 'person');
  assert.equal(await filter.inputValue(), '柳');
  await category.selectOption('organization');
  await source.getByText('2 处', {exact:true}).waitFor();
});

test('按类别和材料搜索映射，保留原文位置和脱敏输出', async t => {
  const {readProject, writeProject} = require('../build/project-file.cjs');
  const {runWorkspace} = await import('../build/engine/workspace.js');
  const {app, page, directory} = await open(t, {provider:'cpu'});
  let state = {materials:[], groups:{}, activeId:null, undo:null, revision:0};
  for (const [title, text] of [
    ['初次笔录', '姓名：张雷\n姓名：张雪\n单位：张氏商贸有限公司\n联系电话：13800138000'],
    ['补充说明', '被询问人：张雷\n问：你以前叫什么？\n答：我以前叫小雷。\n住址：北京市东城区和平路12号。'],
  ]) {
    state = (await runWorkspace(state, {op:'add', title, text})).state;
    state = (await runWorkspace(state, {op:'scan', materialId:state.activeId})).state;
  }
  state.activeId = '1';
  const {view} = await runWorkspace(state, {op:'view'});
  const alias = view.groups.find(group => group.primary === '张雷').occurrences.find(row => row.original === '小雷');
  const paths = [join(directory, '类别复核.lrproj'), join(directory, '另一个项目.lrproj')];
  for (const path of paths) await writeProject(path, state);
  await app.evaluate(({dialog, BrowserWindow}, paths) => {
    dialog.showOpenDialog = async () => ({canceled:false, filePaths:[paths.shift()]});
    BrowserWindow.getAllWindows()[0].setSize(1000, 700);
  }, paths);
  await channel(page.getByRole('tabpanel', {name:'脱敏'}), '打开项目').click();

  const mappings = page.getByRole('region', {name:'映射清单'});
  const category = mappings.getByLabel('映射类别');
  const scope = mappings.getByLabel('映射材料范围');
  const search = mappings.getByRole('searchbox', {name:'搜索映射'});
  const titles = () => mappings.locator('.mapping-title strong').allTextContents();
  await category.waitFor();
  assert.equal(await category.inputValue(), 'all');
  assert.deepEqual(await mappings.locator('.mapping-filters').evaluate(form => {
    const [query, materials, categories] = [...form.children].map(input => input.getBoundingClientRect());
    return [query.bottom < materials.top, materials.top === categories.top, materials.right < categories.left,
      materials.height === categories.height,
      Math.abs(query.right - categories.right) < 1];
  }), [true,true,true,true,true]);

  const readOutput = () => page.evaluate(() => window.redaction.engine({op:'output', materialId:'1'}));
  const saved = await readOutput();
  assert.match(saved.output, /【张某[^】]+】/u);
  await category.press('Space');
  await page.locator('select:open').waitFor();
  assert.equal(await category.evaluate(select => getComputedStyle(select, '::picker(select)').appearance), 'base-select');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await category.inputValue(), 'person');
  await search.fill('张');
  assert.deepEqual(await titles(), ['张雷','张雪']);
  const positions = mappings.getByRole('region', {name:'出现位置'});
  const lei = mappings.getByRole('button', {name:/^张雷 →/u});
  await lei.click();
  await positions.getByRole('button', {name:/补充说明.*被询问人/u}).click();
  await page.locator('#source-text mark.selected').filter({hasText:'张雷'}).waitFor();
  await channel(positions, '↑ 上一处').click();
  await page.locator('.material-row[aria-current="page"]').filter({hasText:'初次笔录'}).waitFor();
  await channel(positions, '↓ 下一处').click();
  await page.locator('.material-row[aria-current="page"]').filter({hasText:'补充说明'}).waitFor();
  await positions.getByRole('button', {name:/补充说明.*小雷/u}).click();
  await page.locator('#source-text mark.selected').filter({hasText:'小雷'}).waitFor();
  assert.equal(await category.inputValue(), 'person');
  const opened = await page.evaluate(() => window.redaction.engine({op:'open', materialId:'2'}));
  assert.deepEqual(Object.keys(opened), ['current']);
  assert.equal(opened.current.output, await output(page).textContent());
  await page.evaluate(() => window.redaction.saveProject());
  assert.equal((await readProject(paths[0])).state.activeId, '2');
  const firstMaterial = page.locator('.material-row').filter({hasText:'初次笔录'});
  await channel(page, '编辑原文').click();
  await page.getByRole('textbox', {name:'编辑材料原文'}).fill('尚未应用的修改');
  page.once('dialog', dialog => dialog.dismiss());
  await firstMaterial.click();
  assert.equal(await page.getByRole('textbox', {name:'编辑材料原文'}).inputValue(), '尚未应用的修改');
  page.once('dialog', dialog => dialog.accept());
  await firstMaterial.click();
  await firstMaterial.and(page.locator('[aria-current="page"]')).waitFor();

  await scope.selectOption('current');
  await search.fill('小雷');
  await mappings.getByText('没有匹配的映射', {exact:true}).waitFor();
  await search.fill(alias.replacement);
  assert.deepEqual(await titles(), []);
  await scope.selectOption('all');
  await lei.waitFor();
  assert.deepEqual(await titles(), ['张雷']);
  await search.fill('张');
  await category.selectOption('organization');
  assert.deepEqual(await titles(), ['张氏商贸有限公司']);
  assert.equal(await positions.count(), 0);
  await category.selectOption('all');
  assert.deepEqual(await titles(), ['张雷','张雪','张氏商贸有限公司']);
  assert.deepEqual(await readOutput(), saved);

  await search.fill('');
  await category.selectOption('contact');
  assert.deepEqual(await titles(), ['13800138000']);
  await add(page, '追加笔录', '姓名：李春');
  await output(page).getByText(/【李某/u).waitFor();
  assert.equal(await category.inputValue(), 'contact');
  const [other] = await Promise.all([app.waitForEvent('window'), viaMenu(app, '打开项目…')]);
  const otherCategory = other.getByLabel('映射类别');
  await otherCategory.waitFor({timeout:10000});
  assert.equal(await otherCategory.inputValue(), 'all');
  assert.equal(await category.inputValue(), 'contact');
});

test('长位置列表可滚动到末尾并跨材料定位，正文仍可联动与复制', async t => {
  const {crossCategoryProject} = require('./mapping-fixture.cjs');
  const {writeProject} = require('../build/project-file.cjs');
  const {app, page, directory} = await open(t, {model:false});
  const state = crossCategoryProject();
  state.materials.push({...state.materials[0], id:'2', title:'补充笔录'});
  state.nextMaterialId = 3;
  const path = join(directory, '长位置列表.lrproj');
  await writeProject(path, state);
  await app.evaluate(({dialog}, path) => {
    dialog.showOpenDialog = async () => ({canceled:false, filePaths:[path]});
  }, path);
  await channel(page.getByRole('tabpanel', {name:'脱敏'}), '打开项目').click();

  await channel(page, '搜索项目').click();
  await page.getByRole('searchbox', {name:'搜索项目'}).fill('柳明川');
  await channel(page, '查找').click();
  const results = page.locator('.project-results');
  await results.getByRole('heading', {name:'合成笔录 102 处'}).waitFor();
  assert.ok(await results.locator('.occurrence').count() < 60);
  await results.evaluate(list => { list.scrollTop = list.scrollHeight; });
  await results.getByRole('button', {name:/第 102 行/u}).click();
  await page.waitForFunction(() => CSS.highlights.has('adjustment-position'));
  await channel(page, '搜索项目').click();
  await page.locator('.material-row[aria-current="page"]').filter({hasText:'补充笔录'}).waitFor();

  await page.locator('#source-text mark[data-item="99"]').click();
  await page.locator('.position-list .occurrence.current').filter({hasText:/补充笔录.*第 99 行/u}).waitFor();
  assert.ok(await page.locator('.position-list .occurrence').count() < 60);
  await channel(page, '↑ 上一处').click();
  await page.locator('.position-list .occurrence.current').filter({hasText:/补充笔录.*第 98 行/u}).waitFor();

  await page.locator('#source-scroll').evaluate(pane => { pane.scrollTop = 250; });
  await page.waitForFunction(() => {
    const source = document.getElementById('source-scroll');
    const output = document.getElementById('output-scroll');
    const firstVisible = pane => [...pane.querySelectorAll('.text-line')].find(row =>
      row.getBoundingClientRect().bottom > pane.getBoundingClientRect().top + 12)?.dataset.lineNumber;
    return output.scrollTop > 0 && Math.abs(Number(firstVisible(source)) - Number(firstVisible(output))) <= 1;
  });
  const selected = await page.locator('#source-text').evaluate(root => {
    root.focus();
    const [first, second] = root.querySelectorAll('.text-line-body');
    const range = document.createRange();
    range.setStart(first.firstChild, 0);
    range.setEnd(second.firstChild, second.firstChild.textContent.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return range.toString();
  });
  assert.match(selected, /柳明川\n/u);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
  assert.equal(await app.evaluate(({clipboard}) => clipboard.readText()), selected);
});

test('通过映射菜单管理别称，跨材料补位置沿用实际代号', async t => {
  const {writeProject} = require('../build/project-file.cjs');
  const {runWorkspace} = await import('../build/engine/workspace.js');
  const {app, page, directory} = await open(t, {provider:'cpu', model:false});
  let state = {materials:[], groups:{}, activeId:null, undo:null, revision:0};
  for (const [title, text] of [
    ['合成补录', '备注：小宁已提交回执。\n姓名：赵敏'],
    ['合成笔录', '被询问人：张甲\n问：你以前叫什么？\n答：我以前叫小宁。'],
  ]) {
    state = (await runWorkspace(state, {op:'add', title, text})).state;
    state = (await runWorkspace(state, {op:'scan', materialId:state.activeId})).state;
  }
  const path = join(directory, '别称管理.lrproj');
  await writeProject(path, state);
  await app.evaluate(({dialog}, path) => {
    dialog.showOpenDialog = async () => ({canceled:false, filePaths:[path]});
  }, path);
  await channel(page.getByRole('tabpanel', {name:'脱敏'}), '打开项目').click();
  const mappings = page.getByRole('region', {name:'映射清单'});
  const mapping = mappings.locator('.mapping').filter({has:channel(page, '张甲 → 【张某1】')});
  await channel(mapping, '张甲 → 【张某1】').click();
  const positions = mappings.getByRole('region', {name:'出现位置'});
  await positions.getByLabel('按原词或别称筛选位置').selectOption('小宁');
  assert.equal(await positions.getByRole('button', {name:'小宁的别称操作'}).count(), 0);

  await channel(mapping, '张甲的映射操作').click();
  await channel(mapping, '管理原词与别称').click();
  const aliases = page.getByRole('region', {name:'管理原词与别称'});
  const entries = aliases.locator('.alias-entry');
  const term = entries.filter({has:channel(page, '小宁的位置操作')});
  const primary = entries.filter({has:channel(page, '张甲的位置操作')});
  await primary.getByText(/恢复原词/u).waitFor();
  await channel(primary, '张甲的位置操作').click();
  await channel(primary, '修正标注范围').click();
  const adjustment = page.getByRole('region', {name:'调整清单'});
  await adjustment.getByRole('heading', {name:'修正标注范围'}).waitFor();
  assert.equal(await adjustment.getByLabel('代号', {exact:true}).count(), 0);
  await channel(adjustment, '取消').click();
  const aliasButton = term.getByRole('button', {name:/小宁.*曾用名1.*1 处/});
  await aliasButton.click();
  await page.keyboard.press('Tab');
  await aliasButton.focus();
  assert.deepEqual(await aliasButton.evaluate(button => {
    const row = button.closest('.alias-entry');
    const list = row.parentElement;
    const outer = list.getBoundingClientRect();
    const inner = row.getBoundingClientRect();
    return {sameInset:Math.abs(inner.left - outer.left - (outer.right - inner.right)) < 1,
      rowFocus:getComputedStyle(row).boxShadow !== 'none', innerFocus:getComputedStyle(button).outlineStyle};
  }), {sameInset:true, rowFocus:true, innerFocus:'none'});
  await aliases.getByRole('region', {name:'原词位置'}).getByText(/合成笔录/u).waitFor();
  await channel(term, '小宁的位置操作').click();
  await channel(term, '添加位置').click();
  const adjust = page.getByRole('region', {name:'调整清单'});
  await adjust.getByRole('checkbox', {name:/选择合成补录.*小宁/u}).check();
  assert.equal(await adjust.getByRole('checkbox', {name:/选择合成笔录.*小宁/u}).count(), 0);
  const locate = channel(adjust, '第 1 行 · 定位原文');
  await locate.waitFor();
  assert.deepEqual(await adjust.locator('.impact-entry dd').allTextContents(), ['小宁', '【张某1-曾用名1】']);
  await locate.click();
  await page.locator('#source-text').getByText(/已提交回执/u).waitFor();
  assert.equal(await channel(page, '导出 TXT').isDisabled(), true);
  assert.equal(await channel(page, '复制文本').isDisabled(), true);
  await page.locator('.material-row').filter({hasText:'合成笔录'}).click();
  assert.equal(await channel(page, '导出 TXT').isEnabled(), true);
  await page.locator('.material-row').filter({hasText:'合成补录'}).click();
  assert.equal(await channel(page, '导出 TXT').isDisabled(), true);
  await channel(adjust, '应用到所选 1 处').click();
  await term.getByText('2 处', {exact:true}).waitFor();
  await output(page).getByText('【张某1-曾用名1】', {exact:true}).waitFor();
  assert.equal(await channel(page, '导出 TXT').isEnabled(), true);

  await channel(term, '小宁的位置操作').click();
  await channel(term, '改绑位置').click();
  await channel(adjust, '赵敏 → 【赵某1】 1 处').click();
  await adjust.getByRole('checkbox', {name:/选择合成补录.*小宁/u}).check();
  await channel(adjust, '改绑所选 1 处').click();
  await term.getByText('1 处', {exact:true}).waitFor();
  await output(page).getByText('【赵某1-曾用名1】', {exact:true}).waitFor();
  await channel(term, '小宁的位置操作').click();
  await channel(term, '移出位置').click();
  await adjust.getByRole('checkbox', {name:'全选本次结果'}).check();
  await channel(adjust, '移出所选 1 处').click();
  await primary.waitFor();
  assert.equal(await term.count(), 0);
});

test('移除最后一份材料后可以搜索、修改、保存、恢复和删除零位置映射', async t => {
  const project = await open(t, {provider:'cpu'});
  const {app, page, directory} = project;
  await add(page, '初次笔录', '被询问人：张甲\n问：你以前叫什么？\n答：我以前叫小宁。');
  await output(page).getByText('【张某1-曾用名1】', {exact:true}).waitFor();
  const review = page.getByRole('region', {name:'映射清单'});
  const scope = review.getByLabel('映射材料范围');
  await scope.selectOption('current');
  await channel(page, '初次笔录的材料操作').click();
  await channel(page, '移除材料').click();
  const removal = role(page, '移除材料');
  assert.deepEqual(await removal.locator('p').allTextContents(), ['从项目中移除「初次笔录」？']);
  assert.equal(await removal.getByRole('combobox').count(), 0);
  await channel(removal, '确认移除').click();
  const group = review.locator('.mapping').filter({has:channel(page, '张甲 → 【张某1】')});
  await group.getByText('0 处', {exact:true}).waitFor();
  assert.equal(await scope.inputValue(), 'all');
  assert.match(await (await app.browserWindow(page)).evaluate(window => window.getTitle()), /\*/u);
  await review.getByRole('searchbox', {name:'搜索映射'}).fill('张甲');
  await channel(group, '张甲的映射操作').click();
  await channel(group, '管理原词与别称').click();
  const aliases = page.getByRole('region', {name:'管理原词与别称'});
  await aliases.getByRole('button', {name:/张甲.*恢复原词.*0 处/u}).waitFor();
  assert.equal(await aliases.getByText('小宁', {exact:true}).count(), 0);
  await channel(aliases, '返回映射清单').click();
  await channel(group, '修改代号').click();
  const adjust = page.getByRole('region', {name:'调整清单'});
  await adjust.getByLabel('代号', {exact:true}).fill('当事人甲');
  await channel(adjust, '确认改代号').click();
  await channel(review, '张甲 → 【当事人甲】').waitFor();
  await app.evaluate(({dialog}, path) => {
    dialog.showOpenDialog = async () => ({canceled:false, filePaths:[path]});
  }, directory);
  await viaMenu(app, '保存项目');
  const save = role(page, '保存项目');
  await save.getByLabel('文件名').fill('合成恢复项目');
  await channel(save, '更改…').click();
  await save.getByText(directory, {exact:true}).waitFor();
  await channel(save, '保存').click();
  await page.locator('#redact-panel').getByText('项目已保存', {exact:true}).waitFor();
  await project.close();

  const reopen = await open(t, {provider:'cpu', model:false});
  const path = join(directory, '合成恢复项目.lrproj');
  const txt = join(directory, '恢复文本.txt');
  await reopen.app.evaluate(({dialog}, {path, txt}) => {
    dialog.showOpenDialog = async () => ({canceled:false, filePaths:[path]});
    dialog.showSaveDialog = async () => ({canceled:false, filePath:txt});
  }, {path, txt});
  await channel(reopen.page.getByRole('tabpanel', {name:'脱敏'}), '打开项目').click();
  const reopenedReview = reopen.page.getByRole('region', {name:'映射清单'});
  const savedMapping = channel(reopenedReview, '张甲 → 【当事人甲】');
  await savedMapping.waitFor();
  await reopen.page.getByRole('tab', {name:'恢复'}).click();
  const restore = reopen.page.getByRole('tabpanel', {name:'恢复'});
  const aliasCode = '【张某1-曾用名1】';
  await restore.getByRole('textbox', {name:'待恢复文本'}).fill(`【当事人甲】与${aliasCode}\n这里再见${aliasCode}`);
  await channel(restore, '完成').click();
  const mappings = restore.getByRole('region', {name:'恢复映射清单'});
  assert.equal(await mappings.locator('.restore-mapping').count(), 2);
  await channel(mappings, '未匹配 2').click();
  assert.equal(await mappings.locator('.restore-mapping').count(), 1);
  await mappings.locator('.restore-mapping').click();
  await channel(mappings, '第 2 行 · 第 2 处').click();
  assert.equal(await restore.locator('[data-restore-text="output"] mark.selected').textContent(), aliasCode);
  await channel(restore, '导出 TXT').click();
  await restore.getByText('已导出 TXT', {exact:true}).waitFor();
  assert.equal(await readFile(txt, 'utf8'), `张甲与${aliasCode}\n这里再见${aliasCode}`);

  await reopen.page.getByRole('tab', {name:'脱敏'}).click();
  await channel(reopenedReview, '张甲的映射操作').click();
  await channel(reopenedReview, '删除映射').click();
  await channel(role(reopen.page, '删除映射'), '确认删除').click();
  await savedMapping.waitFor({state:'detached'});
  await channel(reopenedReview, '撤销上次订正').click();
  await savedMapping.waitFor();
});
