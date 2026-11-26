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
  assert.equal(await filter.inputValue(), '');
  assert.equal(await channel(merged, '柳明川 → 【柳某甲】').getAttribute('aria-pressed'), 'true');
  assert.equal(await source.count(), 0);
  assert.equal(await output(page).getByText('【L机构】', {exact:true}).count(), 0);
  await channel(mappings, '撤销上次订正').click();
  await source.getByText('3 处', {exact:true}).waitFor();

  await page.locator('#source-text mark[data-item="101"]').click();
  await channel(page, '绑定到现有映射').click();
  const picker = preview.getByRole('searchbox', {name:'搜索目标映射'});
  await picker.fill('柳某甲-曾用名1');
  await channel(preview, '柳明川 → 【柳某甲】 99 处').click();
  await preview.getByLabel('柳明川的代号').selectOption('【柳某甲】');
  await channel(preview, '应用到所选 1 处').click();
  await merged.getByText('100 处', {exact:true}).waitFor();
  await source.getByText('2 处', {exact:true}).waitFor();
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
  const mapping = mappings.locator('.mapping').filter({has:channel(page, '张甲 → 【张某】')});
  await channel(mapping, '张甲 → 【张某】').click();
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
  assert.deepEqual(await adjust.locator('.impact-entry dd').allTextContents(), ['小宁', '【张某-曾用名1】']);
  await locate.click();
  await page.locator('#source-text').getByText(/已提交回执/u).waitFor();
  assert.equal(await channel(page, '导出 TXT').isDisabled(), true);
  assert.equal(await channel(page, '复制文本').isDisabled(), true);
  await channel(adjust, '应用到所选 1 处').click();
  await term.getByText('2 处', {exact:true}).waitFor();
  await output(page).getByText('【张某-曾用名1】', {exact:true}).waitFor();
  assert.equal(await channel(page, '导出 TXT').isEnabled(), true);

  await channel(term, '小宁的位置操作').click();
  await channel(term, '改绑位置').click();
  await channel(adjust, '赵敏 → 【赵某】 1 处').click();
  await adjust.getByRole('checkbox', {name:/选择合成补录.*小宁/u}).check();
  await channel(adjust, '改绑所选 1 处').click();
  await term.getByText('1 处', {exact:true}).waitFor();
  await output(page).getByText('【赵某-曾用名1】', {exact:true}).waitFor();
  await channel(term, '小宁的位置操作').click();
  await channel(term, '移出位置').click();
  await adjust.getByRole('checkbox', {name:'全选本次结果'}).check();
  await channel(adjust, '移出所选 1 处').click();
  await primary.waitFor();
  assert.equal(await term.count(), 0);
});
