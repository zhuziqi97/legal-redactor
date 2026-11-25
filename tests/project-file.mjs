import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ZipReader, ZipWriter, Uint8ArrayReader, Uint8ArrayWriter, TextReader } from '@zip.js/zip.js';
import { runWorkspace } from '../build/engine/workspace.js';
import { encodeProject } from '../build/engine/project-state.js';
import { readProject, writeProject } from '../build/project-file.cjs';

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
  const restored = await readProject(path);
  const { view: after } = await runWorkspace(restored, { op: 'view' });
  assert.deepEqual(after, { ...before, revision: 0, canUndo: false });
  assert.equal(after.documents[1].exportState, 'current');
  assert.equal(after.documents[2].status, 'unrecognized');
  assert.deepEqual((await runWorkspace(restored, { op: 'output', materialId: '2' })).sourcePaths, [originalPath]);
  const added = await runWorkspace(restored, { op: 'add', title: '又一份材料', text: '姓名：王乙' });
  assert.equal(added.view.current.id, '4');
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
  const restored = await readProject(path);
  const { view: reopened } = await runWorkspace(restored, { op: 'view' });
  assert.equal(reopened.current.status, 'unrecognized');
  assert.equal(reopened.current.previousOutput, edited.view.current.previousOutput);
  const scanned = await runWorkspace(restored, { op: 'scan', materialId: '1', revision: 1 });
  assert.equal(scanned.view.current.items.find(row => row.original === '张甲').action, 'keep');
  assert.match(scanned.view.current.output, /姓名：张甲/);
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
