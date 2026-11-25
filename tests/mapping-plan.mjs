import assert from 'node:assert/strict';
import test from 'node:test';
import {runWorkspace} from '../build/engine/workspace.js';

function workspace() {
  let state = {materials: [], groups: {}, activeId: null, undo: null, revision: 0};
  const run = async request => {
    const response = await runWorkspace(structuredClone(state), request);
    if (response.state) state = response.state;
    return response;
  };
  const add = async (text, title = '笔录') => {
    const {view: {current}} = await run({op: 'add', text, title});
    return (await run({op:'scan', materialId: current.id})).view;
  };
  const preview = change => run({op:'previewAdjustment', change});
  const apply = (change, result) => run({op:'apply', change, expectedRevision: result?.preview.revision});
  const search = text => run({op:'search', text});
  const edit = (source, code, resolution) => ({mode:'editMapping', groupId:source.id, code, resolution});
  return {run, add, preview, apply, search, edit};
}

test('同址不同写法可确认合并、保留目标代号并整批撤销', async () => {
  const w = workspace();
  await w.add('住址：北京市东城区和平路12号。', '询问笔录');
  const second = await w.add('住址：东城区和平路12号。', '情况说明');
  assert.equal(second.groups.filter(group => group.type === 'address').length, 2);
  const [target, source] = second.groups.filter(group => group.type === 'address');
  const conflict = (await w.preview(w.edit(source, target.code))).issue;
  assert.deepEqual(conflict.merge.occupants, [{groupId: target.id, code:target.code, kind:'primary'}]);
  assert.ok(conflict.merge.options[0].whole);
  const change = w.edit(source, target.code, {mode:'whole', targetId:target.id});
  const impact = await w.preview(change);
  assert.equal(impact.preview.code, target.code);
  assert.ok(impact.preview.materials.some(doc => doc.title === '情况说明'));
  const {view} = await w.apply(change, impact);
  assert.equal(view.groups.find(group => group.id === target.id).occurrences.length, 2);
  assert.equal(view.groups.some(group => group.id === source.id), false);
  assert.equal((await w.run({op:'undo'})).view.groups.length, second.groups.length);

  const bound = {mode:'bind', groupId:target.id, positions:source.occurrences};
  const bindPreview = await w.preview(bound);
  assert.equal((await w.apply(bound, bindPreview)).view.groups.find(group => group.id === target.id).occurrences.length, 2);
});

test('地名与机构、不同完整号码、派生代号和字面标记各自有明确的冲突来源', async () => {
  const w = workspace();
  await w.add('被询问人：张甲\n问：你以前叫什么？\n答：我以前叫小宁。');
  const view = await w.add('姓名：赵敏\n住址：北京市东城区和平路12号\n甲方：远山贸易有限公司\n' +
    '联系电话：13800138000、13900139000\n原稿：【已有标记】');
  const zhao = view.groups.find(group => group.primary === '赵敏');
  const zhang = view.groups.find(group => group.primary === '张甲');
  assert.ok(zhao && zhang);
  const alias = zhang.occurrences.find(row => row.original === '小宁').replacement;
  const derived = (await w.preview(w.edit(zhao, alias))).issue.merge;
  assert.deepEqual(derived.occupants, [{groupId:zhang.id, code:alias, kind:'alias'}]);
  assert.deepEqual(derived.options, []);
  const create = {mode:'create', type:'person', positions:await w.search('赵敏'), code:alias};
  assert.deepEqual((await w.preview(create)).issue.merge.options, []);
  const literal = (await w.preview(w.edit(zhao, '已有标记'))).issue;
  assert.match(literal.message, /原文已有相同标记/);
  assert.equal(literal.positions[0].original, '【已有标记】');
  const address = view.groups.find(group => group.type === 'address');
  const company = view.groups.find(group => group.type === 'organization');
  assert.deepEqual((await w.preview(w.edit(address, company.code))).issue.merge.options, []);
  const numbers = view.groups.filter(group => group.type === 'mobile');
  assert.equal(numbers.length, 2);
  const numberMerge = (await w.preview(w.edit(numbers[0], numbers[1].code))).issue.merge;
  assert.deepEqual(numberMerge.options.map(({whole,selected}) => [whole,selected]), [[false,false]]);
  assert.equal(numberMerge.occupants[0].code, numbers[1].code);
});

test('新建映射遇占用只改派勾选位置，已失效的预览保留正文', async () => {
  const w = workspace();
  const first = await w.add('姓名：张甲\n交接人：赵敏\n赵敏随后到场。');
  await w.add('姓名：赵敏\n工作已交接。', '补充材料');
  const to = first.groups.find(group => group.primary === '张甲');
  const matches = await w.search('赵敏');
  const request = {mode:'create', type:'person', code:to.code, positions:[matches[0]]};
  const issue = (await w.preview(request)).issue.merge;
  assert.deepEqual(issue.options, [{groupId:to.id, whole:false, selected:true}]);
  const change = {...request, resolution:{mode:'selected', targetId:to.id}};
  const old = await w.preview(change);
  await w.run({op:'renameMaterial', materialId:matches[1].materialId, title:'已改名称'});
  assert.equal((await w.apply(change, old)).issue.stalePreview, true);
  const {view} = await w.apply(change, await w.preview(change));
  const scoped = (await w.search('赵敏')).map(row => row.group);
  assert.equal(scoped[0], to.id);
  assert.ok(scoped.slice(1).every(id => id !== to.id));
  assert.equal(view.groups.find(group => group.id === to.id).occurrences.length, 2);
});
