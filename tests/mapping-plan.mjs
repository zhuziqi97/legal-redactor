import assert from 'node:assert/strict';
import test from 'node:test';
import {runWorkspace} from '../build/engine/workspace.js';

function workspace() {
  let state = {materials: [], groups: {}, activeId: null, undo: null, revision: 0};
  const run = async (request, scan) => {
    const response = await runWorkspace(structuredClone(state), request, scan);
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

test('原文修订只推理受影响的记录，保留外部位置、人工订正和共享代号', async () => {
  const w = workspace();
  await w.add('姓名：张甲\n另一份正文。', '补充材料');
  const text = '姓名：张甲\n内容：尚待录入。\n姓名：王强\n末段说明一切正常。';
  const before = await w.add(text, '书面材料');
  const group = before.groups.find(row => row.primary === '张甲');
  const keep = before.groups.find(row => row.primary === '王强').occurrences[0];
  await w.apply({mode:'keep', positions:[keep]});

  const modified = '😀 开头补充。\n' + text.replace('尚待录入', '联系电话：13900139000');
  const windows = [];
  const request = {op:'reviseMaterial', materialId:before.current.id, revision:before.current.revision, text:modified};
  const {view} = await w.run(request, (source, free) => {
    windows.push(...free.map(row => Array.from(source).slice(row.start, row.end).join('')));
    return [];
  });
  assert.ok(windows.some(line => line.includes('开头补充')));
  assert.ok(windows.every(line => !line.includes('张甲') && !line.includes('王强') && !line.includes('末段说明')), windows.join('\n'));
  assert.equal(view.current.revision, before.current.revision + 1);
  assert.equal(view.groups.find(row => row.id === group.id).occurrences.length, 2);
  const kept = view.current.items.find(row => row.original === '王强');
  assert.equal(kept.id, keep.itemId);
  assert.equal(kept.action, 'keep');
  assert.equal(kept.start, Array.from(modified.slice(0, modified.indexOf('王强'))).length);
  const {output} = await w.run({op:'output', materialId:view.current.id});
  assert.doesNotMatch(output, /13900139000/, '号码应从导出中移除');
});

test('改动已有人工订正的值需复核，失败或过时的识别保留原稿', async () => {
  const w = workspace();
  const {current, groups} = await w.add('姓名：张甲\n独立内容。');
  const [row] = groups.find(group => group.primary === '张甲').occurrences;
  await w.apply({mode:'keep', positions:[row]});
  const request = {op:'reviseMaterial', materialId:current.id, revision:current.revision, text:'姓名：张乙\n独立内容。'};
  await assert.rejects(w.run(request, () => {throw new Error('推理失败');}), /推理失败/);
  assert.equal((await w.run({op:'view'})).view.current.text, current.text);
  const {view} = await w.run(request);
  assert.equal(view.current.items.find(item => item.original === '张乙').action, 'review');
  assert.equal((await w.run({op:'output', materialId:current.id})).issues.length, 1);
  await assert.rejects(w.run({...request, text:'已过时的修订'}), /材料已更新/);
  assert.equal((await w.run({op:'view'})).view.current.text, request.text);
});

test('裁判署名保留职务和原文区间，并沿用另一份材料的人员代号', async () => {
  const w = workspace();
  const first = await w.add('姓名：王明');
  const [group] = first.groups;
  const next = await w.add('本案审理终结。\n审 判 员    王 明\n书 记 员    李 华');
  const row = next.current.items.find(item => item.original === '王 明');
  assert.equal(row.group, group.id);
  assert.equal([...next.current.text].slice(row.start, row.end).join(''), '王 明');
  assert.match(next.current.output, /审 判 员    【王某】\n书 记 员    【李某】/u);
});

test('修改文首完整住址会更新文末简称，局部编辑只提交受影响的模型文本', async () => {
  const w = workspace();
  const before = await w.add('地址待补。\n交接事项另办。\n他从槐安村出来。');
  assert.ok(!before.current.items.some(item => item.original === '槐安村'));
  const text = before.current.text.replace('地址待补。', '住址：平川市柳桥镇槐安村新民路8号。');
  const windows = [];
  const {view} = await w.run({op: 'reviseMaterial', materialId: before.current.id, revision: before.current.revision, text},
    (source, free) => {
      windows.push(...free.map(row => [...source].slice(row.start, row.end).join('')));
      return [];
    });
  assert.ok(windows.every(value => !value.includes('他从')));
  assert.equal(view.current.items.find(item => item.original === '槐安村')?.reason, '全文村名');
  const full = await workspace().add(text);
  assert.deepEqual(view.current.items.map(row => [row.original, row.type, row.action]),
    full.current.items.map(row => [row.original, row.type, row.action]));
  const reverted = await w.run({op: 'reviseMaterial', materialId: view.current.id, revision: view.current.revision,
    text: before.current.text}, () => []);
  assert.equal(reverted.view.current.items.find(item => item.original === '槐安村')?.action, 'review');
});

test('编辑原文引入的字面代号与既有映射冲突时定位待核', async () => {
  const w = workspace();
  const {current, groups} = await w.add('姓名：张甲\n另一段材料。');
  const {code} = groups.find(row => row.primary === '张甲');
  const {view} = await w.run({op:'reviseMaterial', materialId:current.id, revision:current.revision,
    text:`姓名：张甲\n原稿中写作${code}，待核对。`});
  assert.equal(view.current.items.find(row => row.original === '张甲').action, 'review');
  assert.equal((await w.run({op:'output', materialId:current.id})).issues.length, 1);
});

test('移除别称依据后，后文已有别称回到待核，机构全称仍沿用原代号', async () => {
  const w = workspace();
  const text = '甲方：远山贸易有限公司（以下简称远山公司）。\n交接过程记录。\n远山公司随后提交材料。';
  const {current} = await w.add(text);
  const alias = current.items.find(row => row.reason === '全文称呼');
  const full = current.items.find(row => row.original === '远山贸易有限公司');
  assert.ok(alias && alias.definitions.length && alias.group === full.group);
  const {view} = await w.run({op:'reviseMaterial', materialId:current.id, revision:current.revision, text:text.replace('（以下简称远山公司）','')});
  assert.equal(view.current.items.find(row => row.id === full.id).group, full.group);
  assert.equal(view.current.items.find(row => row.id === full.id).replacement, full.replacement);
  assert.equal(view.pending[0].itemId, alias.id);
  assert.equal(view.pending[0].original, '远山公司');
});
