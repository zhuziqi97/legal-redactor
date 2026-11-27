import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ZipReader, ZipWriter, Uint8ArrayReader, Uint8ArrayWriter, TextReader } from '@zip.js/zip.js';
import { hit } from '../build/engine/fields.js';
import { runWorkspace } from '../build/engine/workspace.js';
import { encodeProject } from '../build/engine/project-state.js';
import { restoreText } from '../build/engine/restore.js';
import { projectProtection, readProject, writeProject } from '../build/project-file.cjs';
import fixture from './mapping-fixture.cjs';

function workspace() {
  let state = { materials: [], groups: {}, activeId: null, undo: null, revision: 0 };
  async function run(request) {
    const result = await runWorkspace(structuredClone(state), request);
    if (result.state) state = result.state;
    return result;
  }
  async function add(text, title, sourcePath) {
    const { view } = await run({ op: 'add', text, title, sourcePath });
    return run({ op: 'scan', materialId: view.current.id });
  }
  return { run, add, get state() { return state; } };
}

async function localProject(t) {
  const directory = await mkdtemp(join(tmpdir(), 'legal-redactor-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, '复核.lrproj');
}

test('项目保留跨材料改绑、派生代号、导出状态和待识别原文', async t => {
  const path = await localProject(t);
  const project = workspace();
  const originalPath = join(tmpdir(), 'already-moved.txt');
  await project.add('附注：😀\n被询问人：张甲\n问：你以前叫什么？\n答：我以前叫小宁。', '询问笔录', originalPath);
  const { view } = await project.add('姓名：赵敏\n备注：材料已核对。', '补充说明');
  const target = view.groups.find(group => group.primary === '张甲');
  const source = view.groups.find(group => group.primary === '赵敏');
  assert.ok(target.occurrences.some(row => row.original === '小宁' && row.replacement !== target.code));
  const change = { mode: 'bind', groupId: target.id, positions: source.occurrences };
  const { preview } = await project.run({ op: 'previewAdjustment', change });
  const bound = await project.run({ op: 'apply', change, expectedRevision: preview.revision });
  assert.equal(bound.view.groups.find(group => group.id === target.id).occurrences.length, 3);
  const { output } = await project.run({ op: 'output', materialId: '2' });
  await project.run({ op: 'markExported', materialId: '2', text: output });
  await project.run({ op: 'add', title: '未识别材料', text: '姓名：王甲' });
  const { view: before } = await project.run({ op: 'open', materialId: '2' });

  await writeProject(path, project.state);
  const zip = new ZipReader(new Uint8ArrayReader(await readFile(path)), { useWebWorkers: false });
  try {
    assert.deepEqual((await zip.getEntries()).map(entry => entry.filename), ['project.json']);
  } finally {
    await zip.close();
  }
  const {state: restored} = await readProject(path);
  const { view: after } = await runWorkspace(restored, { op: 'view' });
  assert.deepEqual(after, { ...before, revision: 0, canUndo: false });
  assert.equal(after.documents[1].exportState, 'current');
  assert.equal(after.documents[2].status, 'unrecognized');
  assert.deepEqual((await runWorkspace(restored, { op: 'output', materialId: '2' })).sourcePaths, [originalPath]);
  const added = await runWorkspace(restored, { op: 'add', title: '又一份材料', text: '姓名：王乙' });
  assert.equal(added.view.current.id, '4');
});

test('加密 v1 项目重开后仍使用跨类别订正的结果导出与恢复', async t => {
  const path = await localProject(t);
  const password = '合成项目口令';
  const initial = fixture.crossCategoryProject();
  const {output: previousOutput} = await runWorkspace(initial, {op:'output', materialId:'1'});
  const exported = await runWorkspace(initial, {op:'markExported', materialId:'1', text:previousOutput});
  await writeProject(path, exported.state, await projectProtection(password));
  const opened = await readProject(path, password);
  const change = {mode:'merge', groupId:'organization', targetId:'person'};
  const {preview} = await runWorkspace(opened.state, {op:'previewAdjustment', change});
  const applied = await runWorkspace(opened.state, {op:'apply', expectedRevision:preview.revision, change});
  assert.equal(applied.view.documents[0].exportState, 'changed');
  assert.equal(encodeProject(applied.state).schemaVersion, 1);
  await writeProject(path, applied.state, opened.protection);

  assert.deepEqual(await readProject(path), {locked:true});
  const {state} = await readProject(path, password);
  const {view} = await runWorkspace(state, {op:'view'});
  assert.deepEqual(view.groups.map(group => [group.id, group.type, group.occurrences.length]), [['person','person',102]]);
  assert.deepEqual(view.groups[0].occurrences.slice(-3), applied.view.groups[0].occurrences.slice(-3));
  assert.ok(state.materials[0].decisions.slice(-3).every(row => row.type === 'organization' && row.match === undefined));
  assert.equal(view.documents[0].exportState, 'changed');
  const {output} = await runWorkspace(state, {op:'output', materialId:'1'});
  assert.equal(output.match(/【柳某甲】/gu)?.length, 102);
  assert.doesNotMatch(output, /【L机构】/u);
  const restored = restoreText('【柳某甲】与【L机构】', view.groups);
  assert.equal(restored.output, `${fixture.original}与【L机构】`);
  assert.deepEqual(restored.occurrences.map(row => row.value), [fixture.original,null]);
});

test('快捷绑定补录沿用的派生代号随项目保存和重开', async t => {
  const path = await localProject(t);
  const project = workspace();
  const first = await project.add('被询问人：张甲\n问：你以前叫什么？\n答：我以前叫小宁。', '笔录');
  const group = first.view.groups.find(item => item.primary === '张甲');
  const alias = group.occurrences.find(row => row.original === '小宁');
  await project.add('备注：小宁提交回执。', '补充笔录');
  const positions = await project.run({op:'search', materialId:'2', text:'小宁'});
  const change = {mode:'bind', groupId:group.id, positions};
  const {preview} = await project.run({op:'previewAdjustment', change});
  await project.run({op:'apply', change, expectedRevision:preview.revision});
  await writeProject(path, project.state);
  const {state} = await readProject(path);
  const {output} = await runWorkspace(state, {op:'output', materialId:'2'});
  assert.equal(output, `备注：${alias.replacement}提交回执。`);
});

test('修改原文后、重新识别前保存的项目仍可接续人工订正', async t => {
  const path = await localProject(t);
  const project = workspace();
  const text = '姓名：张甲\n原文说明已核对。';
  const { view } = await project.add(text, '说明');
  const [position] = view.groups.find(item => item.primary === '张甲').occurrences;
  const change = { mode: 'keep', positions: [position] };
  const reviewed = await project.run({ op: 'apply', change });
  assert.equal(reviewed.view.current.items.find(row => row.original === '张甲').action, 'keep');
  const edited = await project.run({ op: 'editMaterial', materialId: '1', text: text + '\n补充一行。' });
  await writeProject(path, project.state);
  const {state: restored} = await readProject(path);
  const { view: reopened } = await runWorkspace(restored, { op: 'view' });
  assert.equal(reopened.current.status, 'unrecognized');
  assert.equal(reopened.current.previousOutput, edited.view.current.previousOutput);
  const scanned = await runWorkspace(restored, { op: 'scan', materialId: '1', revision: 1 });
  assert.equal(scanned.view.current.items.find(row => row.original === '张甲').action, 'keep');
  assert.match(scanned.view.current.output, /姓名：张甲/);
});

test('重开项目后局部编辑保留重复匿名分支，删除依据后更新剩余位置', async t => {
  const path = await localProject(t);
  const parent = '某某物业有限公司';
  const branch = '南京市分公司';
  const full = parent + branch;
  const unrelated = '某某建材有限公司' + branch;
  const text = `${full}负责移交。\n\n李某称${full}负责签收。\n\n${unrelated}另行报备。\n\n姓名：张甲`;
  const submitted = [];
  const scan = (source, free) => {
    submitted.push(...free.map(({start, end}) => source.slice(start, end)));
    const candidates = [...source.matchAll(new RegExp(full, 'gu'))].flatMap(({index: start}) =>
      source.startsWith('负责移交', start + full.length)
        ? [hit(start, start + parent.length, 'organization', 'Otter', 60)]
        : [hit(start + parent.length, start + full.length, 'organization', 'Otter', 60)]);
    return candidates.filter(row => free.some(passage => passage.start <= row.start && row.end <= passage.end));
  };
  const project = workspace();
  const added = await project.run({op:'add', text, title:'合成说明'});
  const inspected = await runWorkspace(added.state, {op:'scan', materialId:'1'}, scan);
  assert.ok(inspected.view.current.output.includes(`${full}负责签收。`));
  const name = inspected.view.groups.find(group => group.primary === '张甲');
  const renamed = await runWorkspace(inspected.state, {op:'apply', change:{mode:'rename', groupId:name.id, code:'人工甲'}});
  await writeProject(path, renamed.state);
  const {state} = await readProject(path);
  submitted.length = 0;
  const edited = text.replace('负责签收', '已完成签收');
  const revised = await runWorkspace(state, {op:'reviseMaterial', materialId:'1', revision:renamed.view.current.revision, text:edited}, scan);
  assert.ok(revised.view.current.output.includes(`${full}已完成签收。`));
  assert.ok(submitted.some(value => value.includes(`${full}负责移交`)));
  assert.ok(submitted.every(value => !value.includes(unrelated) && !value.includes('姓名')));
  assert.equal(revised.view.current.items.find(row => row.original === '张甲').replacement, '【人工甲】');

  const removed = edited.replace(`${full}负责移交。\n\n`, '');
  const noEvidence = await runWorkspace(revised.state, {op:'reviseMaterial', materialId:'1', revision:revised.view.current.revision, text:removed}, scan);
  assert.equal(noEvidence.view.current.items.find(row => row.original === branch && row.start === removed.indexOf(branch))?.action, 'replace');
  assert.equal(noEvidence.view.current.items.find(row => row.original === '张甲').replacement, '【人工甲】');
});

test('拒绝错误格式、较新版本和指向错误原文的复核记录', async t => {
  const path = await localProject(t);
  const project = workspace();
  await project.add('姓名：张甲', '说明');
  const file = encodeProject(project.state);
  async function writeMetadata(data) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
    await writer.add('project.json', new TextReader(JSON.stringify(data)));
    await writeFile(path, await writer.close());
  }
  await writeFile(path, '另一种格式');
  await assert.rejects(readProject(path), /无法读取项目文件/);
  await writeMetadata({ ...file, format: 'another-project' });
  await assert.rejects(readProject(path), /请选择 LegalRedactor 项目/);
  await writeMetadata({ ...file, schemaVersion: 2 });
  await assert.rejects(readProject(path), /格式版本与当前应用不兼容/);
  file.workspace.materials[0].decisions[0].original = '另一人';
  await writeMetadata(file);
  await assert.rejects(readProject(path), /复核项原文位置/);
});

test('替换失败保留目标及其内容，并清理临时目录', async t => {
  const path = await localProject(t);
  await mkdir(path);
  await writeFile(join(path, '原有内容.txt'), '原有内容');
  await assert.rejects(writeProject(path, workspace().state));
  assert.equal(await readFile(join(path, '原有内容.txt'), 'utf8'), '原有内容');
  assert.deepEqual(await readdir(join(path, '..')), ['复核.lrproj']);
});

test('加密项目可解锁、续存、另存、改密和移除保护', async t => {
  const path = await localProject(t);
  const copy = join(path, '..', '副本.lrproj');
  const project = workspace();
  await project.add('姓名：张甲\n内部复核原文。', '受保护材料', join(tmpdir(), 'source-case.txt'));
  const key = await projectProtection('合成密码 A');
  await writeProject(path, project.state, key);
  const first = await readFile(path);
  assert.equal(first.includes(Buffer.from('受保护材料')), false);
  assert.equal(first.includes(Buffer.from('project.json')), false);
  assert.deepEqual(await readProject(path), {locked:true});
  await assert.rejects(readProject(path, '错误密码'), /密码不正确或项目文件已损坏/);
  const opened = await readProject(path, '合成密码 A');
  assert.deepEqual(encodeProject(opened.state), encodeProject(project.state));
  await writeProject(path, opened.state, opened.protection);
  assert.notDeepEqual(await readFile(path), first, '同一密码续存也使用新的随机初始值');
  await writeProject(copy, opened.state, opened.protection);
  assert.deepEqual(await readProject(copy), {locked:true});

  const changed = await projectProtection('合成密码 B');
  await writeProject(path, opened.state, changed);
  await assert.rejects(readProject(path, '合成密码 A'), /密码不正确或项目文件已损坏/);
  const reopened = await readProject(path, '合成密码 B');
  assert.deepEqual(encodeProject(reopened.state), encodeProject(project.state));
  const damaged = await readFile(path);
  damaged[damaged.length - 1] ^= 1;
  await writeFile(path, damaged);
  await assert.rejects(readProject(path, '合成密码 B'), /密码不正确或项目文件已损坏/);

  await writeProject(path, reopened.state);
  const clear = await readProject(path);
  assert.equal(clear.protection, undefined);
  assert.deepEqual(encodeProject(clear.state), encodeProject(project.state));
});

test('重开后按项目地域继续编号，并跳过人工与零位置代号', async t => {
  const path = await localProject(t);
  const project = workspace();
  await project.add('姓名：张甲\n地址：唐山市', '首份材料');
  const {view} = await project.add('地址：泰安市\n姓名：欧阳宁', '第二份材料');
  const city = view.groups.find(group => group.primary === '泰安市');
  const manual = view.groups.find(group => group.primary === '张甲');
  const rename = {mode: 'rename', groupId: manual.id, code: '当事人甲'};
  const {preview} = await project.run({op: 'previewAdjustment', change: rename});
  await project.run({op: 'apply', change: rename, expectedRevision: preview.revision});
  await project.run({op: 'deleteMaterial', materialId: '2'});
  const {output} = await project.run({op: 'output', materialId: '1'});
  await writeProject(path, project.state);

  const {state: restored} = await readProject(path);
  assert.deepEqual(restored.groups[city.id].areas, {'泰安市': 'T1市'});
  const added = await runWorkspace(restored, {op: 'add', title: '追加材料',
    text: '姓名：张甲\n姓名：张乙\n姓名：张丙\n姓名：欧阳平\n字面标记【张某1】。\n'
      + '住所地：泰安市泰山区青松路28号。\n工作单位：唐山市人民政府。'});
  const next = await runWorkspace(added.state, {op: 'scan', materialId: added.view.current.id});
  assert.equal(next.view.current.output, '姓名：【当事人甲】\n姓名：【张某2】\n姓名：【张某3】\n姓名：【欧阳某2】\n字面标记【张某1】。\n'
    + '住所地：【T1市T区地址1】。\n工作单位：【T市人民政府】。');
  assert.equal((await runWorkspace(next.state, {op: 'output', materialId: '1'})).output, output);
  assert.equal(next.state.groups[city.id].code, '【T1市】');
});

test('v1 项目旧案号继续导出，只有重新识别该行才将附号纳入', async t => {
  const path = await localProject(t);
  const base = '（2025）豫0102民初123号';
  const original = `姓名：张甲\n\n案号：${base}之二\n\n材料已核对。`;
  const oldOutput = '姓名：【当事人甲】\n\n案号：【初审案号】之二\n\n材料已核对。';
  const previous = {
    materials: [{id: '1', title: '旧材料', text: original, sourcePath: null, relations: [], decisions: [
      {id: 1, start: 3, end: 5, original: '张甲', action: 'replace', replacement: '【当事人甲】', group: 'person',
        type: 'person', reason: '人工订正', object: null, name: '张甲'},
      {id: 2, start: original.indexOf(base), end: original.indexOf(base) + base.length, original: base,
        action: 'replace', replacement: '【初审案号】', group: 'case', type: 'case_number',
        reason: '案号', object: null, name: null},
    ], exported: oldOutput}],
    groups: {
      person: {id: 'person', type: 'person', code: '【当事人甲】', primary: '张甲'},
      case: {id: 'case', type: 'case_number', code: '【初审案号】', primary: base},
    },
    activeId: '1', revision: 0, nextMaterialId: 2, undo: null,
  };
  await writeProject(path, previous);
  const {state} = await readProject(path);
  assert.equal((await runWorkspace(state, {op: 'output', materialId: '1'})).output, oldOutput);

  const text = original.replace('已核对', '已复核');
  const local = await runWorkspace(state, {op: 'reviseMaterial', materialId: '1', revision: 1, text});
  assert.equal((await runWorkspace(local.state, {op: 'output', materialId: '1'})).output, oldOutput.replace('已核对', '已复核'));
  assert.equal(local.state.groups.case.code, '【初审案号】');
  await writeProject(path, local.state);
  const reopened = await readProject(path);
  assert.deepEqual(reopened.state.materials[0].sourceValues, local.state.materials[0].sourceValues);

  const edited = await runWorkspace(reopened.state, {op: 'reviseMaterial', materialId: '1', revision: 1,
    text: text.replace('之二', '之三')});
  const {output} = await runWorkspace(edited.state, {op: 'output', materialId: '1'});
  assert.match(output, /^姓名：【当事人甲】\n\n案号：【[^】]+】\n\n材料已复核。$/u);
  assert.equal(edited.view.current.items.find(row => row.type === 'case_number').original, base + '之三');
});
