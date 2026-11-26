import assert from 'node:assert/strict';
import test from 'node:test';
import {hit} from '../build/engine/fields.js';
import {runWorkspace} from '../build/engine/workspace.js';
import {restoreText} from '../build/engine/restore.js';
import fixture from './mapping-fixture.cjs';

function workspace(initial) {
  let state = initial ?? {materials: [], groups: {}, activeId: null, undo: null, revision: 0};
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

test('给已有别称补绑位置时，预览和确认都复用别称代号', async () => {
  const w = workspace();
  const first = await w.add('被询问人：张甲\n问：你以前叫什么？\n答：我以前叫小宁。');
  const group = first.groups.find(item => item.primary === '张甲');
  const alias = group.occurrences.find(row => row.original === '小宁');
  assert.notEqual(alias.replacement, group.code);
  await w.add('备注：小宁已提交回执。', '合成补录');
  const positions = (await w.search('小宁')).filter(row => row.materialId === '2');
  const change = {mode:'bind', groupId:group.id, alias:{original:alias.original, code:alias.replacement}, positions};
  const result = await w.preview(change);
  assert.deepEqual(await w.preview({...change, alias:undefined}), result);
  assert.equal(result.preview.code, alias.replacement);
  assert.deepEqual(result.preview.materials[0].changes[0].after, [{text:alias.replacement}]);
  const wrong = await w.preview({...change, positions:await w.search('回执')});
  assert.match(wrong.issue.message, /所选文字与别称不同/);
  const applied = await w.apply(change, result);
  assert.deepEqual(applied.view.groups[0].occurrences.filter(row => row.original === alias.original).map(row => row.replacement),
    [alias.replacement, alias.replacement]);
  assert.equal((await w.run({op:'undo'})).view.groups[0].occurrences.filter(row => row.original === alias.original).length, 1);
});

test('删材料预览提示恢复原词变化，确认后主代号与派生代号都沿用选择', async () => {
  const w = workspace();
  const first = await w.add('被询问人：张甲\n问：你以前叫什么？\n答：我以前叫小宁。', '初次笔录');
  const group = first.groups.find(item => item.primary === '张甲');
  const alias = group.occurrences.find(row => row.original === '小宁');
  await w.add('备注：小宁与小东到场。', '补充笔录');
  const positions = (await w.search('小宁')).filter(row => row.materialId === '2').concat(await w.search('小东'));
  await w.apply({mode:'bind', groupId:group.id, positions});
  const change = {mode:'deleteMaterial', materialId:'1'};
  const result = await w.preview(change);
  assert.deepEqual(result.preview.sources[0].terms, ['小宁', '小东']);
  assert.equal(result.preview.sources[0].primary, '张甲');
  assert.equal((await w.run({op:'view'})).view.documents.length, 2);
  const selected = {...change, primaries:{[group.id]:{original:'小东'}}};
  const updated = await w.preview(selected);
  assert.equal(updated.preview.sources[0].nextPrimary, '小东');
  const {view} = await w.apply(selected, updated);
  assert.equal(view.documents.length, 1);
  assert.equal(restoreText(`${group.code}/${alias.replacement}`, view.groups).output, '小东/小东');
  const promote = {mode:'primary', groupId:group.id, term:{original:'小宁'}};
  const choice = await w.preview(promote);
  assert.deepEqual(choice.preview.sources.map(source => [source.primary, source.nextPrimary]), [['小东','小宁']]);
  assert.deepEqual(choice.preview.materials, []);
  const applied = await w.apply(promote, choice);
  assert.equal(restoreText(`${group.code}/${alias.replacement}`, applied.view.groups).output, '小宁/小宁');
  assert.equal((await w.run({op:'undo'})).view.groups[0].primary, '小东');
});

test('单处范围修正保留实际代号，改代号单独预览主码和派生码', async () => {
  const w = workspace();
  const {groups} = await w.add('被询问人：张甲\n问：你以前叫什么？\n答：我以前叫小宁。');
  const group = groups.find(item => item.primary === '张甲');
  const alias = group.occurrences.find(row => row.original === '小宁');
  const edit = {mode:'editMapping', groupId:group.id, code:group.code, positions:[{...alias, end:alias.end + 1}]};
  const {view} = await w.apply(edit, await w.preview(edit));
  const current = view.groups.find(item => item.id === group.id);
  assert.equal(current.occurrences.find(row => row.original === '张甲').replacement, group.code);
  assert.equal(current.occurrences.find(row => row.original === '小宁。').replacement, alias.replacement);
  const rename = {mode:'rename', groupId:group.id, code:'笔录人员1'};
  const {preview} = await w.preview(rename);
  assert.deepEqual(preview.materials[0].changes.map(row => row.after.map(part => part.text).join('')),
    ['【笔录人员1】','【笔录人员1-曾用名1】']);
  const remove = {mode:'review', positions:current.occurrences.filter(row => row.original === '张甲')};
  assert.deepEqual((await w.preview(remove)).preview.sources[0].terms, ['小宁。']);
});

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
  assert.deepEqual((await w.preview(w.edit(address, company.code))).issue.merge.options,
    [{groupId:company.id, whole:true, selected:false}]);
  const numbers = view.groups.filter(group => group.type === 'mobile');
  assert.equal(numbers.length, 2);
  const numberMerge = (await w.preview(w.edit(numbers[0], numbers[1].code))).issue.merge;
  assert.deepEqual(numberMerge.options.map(({whole,selected}) => [whole,selected]), [[false,false]]);
  assert.equal(numberMerge.occupants[0].code, numbers[1].code);
});

test('明确选择目标后合并跨类别的同名映射，并能撤销', async () => {
  const w = workspace(fixture.crossCategoryProject());
  const change = {mode:'merge', groupId:'organization', targetId:'person'};
  const {preview} = await w.preview(change);
  assert.equal(preview.code, '【柳某甲】');
  assert.equal(preview.materials[0].changes.length, 3);
  assert.deepEqual(preview.sources.map(row => [row.id, row.moved, row.remaining]), [['organization',3,0]]);
  assert.equal((await w.run({op:'view'})).view.groups.length, 2);
  const {view} = await w.apply(change, {preview});
  assert.deepEqual(view.groups.map(row => [row.id,row.type,row.occurrences.length]), [['person','person',102]]);
  assert.ok(view.current.items.slice(-3).every(row => row.type === 'organization' && row.replacement === preview.code));
  assert.deepEqual((await w.run({op:'undo'})).view.groups.map(row => row.occurrences.length), [99,3]);
});

test('跨类别订正后新增材料按各自的识别结果匹配，局部修订保留已有订正', async () => {
  const w = workspace(fixture.crossCategoryProject());
  const change = {mode:'merge', groupId:'organization', targetId:'person'};
  const {state, view} = await w.apply(change, await w.preview(change));
  const decisions = state.materials[0].decisions;
  assert.deepEqual(decisions[0].match, ['person', fixture.original]);
  assert.ok(decisions.slice(-3).every(row => row.match === undefined && row.type === 'organization'));

  const extraPerson = await w.add(`姓名：${fixture.original}`, '人员补录');
  assert.equal(extraPerson.current.items[0].group, 'person');

  const prefix = '登记单位为';
  const {view: extra} = await w.run({op:'add', title:'单位补录', text:`${prefix}${fixture.original}。`});
  const latest = await w.run({op:'scan', materialId:extra.current.id}, () => [
    hit(prefix.length, prefix.length + fixture.original.length, 'organization', 'Otter', 85),
  ]);
  const organization = latest.view.current.items.find(item => item.original === fixture.original);
  assert.equal(organization.type, 'organization');
  assert.notEqual(organization.group, 'person');

  const {current} = view;
  const revised = await w.run({op:'reviseMaterial', materialId:current.id, revision:current.revision,
    text:`说明已核对。\n${current.text}`});
  const preserved = revised.view.groups.find(group => group.id === 'person').occurrences
    .filter(row => row.materialId === current.id).slice(-3);
  assert.deepEqual(preserved.map(row => [row.itemId, row.start, row.replacement]),
    view.groups[0].occurrences.slice(-3).map(row => [row.itemId, row.start + '说明已核对。\n'.length, row.replacement]));
});

test('迁入检查使用实际派生代号，并阻止绑定到原文里已有的代号', async () => {
  const state = fixture.crossCategoryProject();
  const doc = state.materials[0];
  const alias = doc.decisions.at(-1);
  alias.original = '柳小川';
  alias.aliasType = '曾用名';
  alias.replacement = '【L机构-曾用名1】';
  doc.text = doc.text.slice(0, alias.start) + alias.original + doc.text.slice(alias.end);
  doc.text += '曾记录【柳某甲-曾用名1】。';
  const w = workspace(state);
  const change = {mode:'merge', groupId:'organization', targetId:'person'};
  const result = await w.preview(change);
  assert.deepEqual(result.preview.materials[0].changes.at(-1).after, [{text:'【柳某甲-曾用名2】'}]);
  const {view} = await w.apply(change, result);
  assert.equal(view.current.items.at(-1).replacement, '【柳某甲-曾用名2】');

  const existing = await w.add('姓名：程明\n已存在【柳某甲】。');
  const row = existing.groups.find(group => group.primary === '程明').occurrences[0];
  const {issue} = await w.preview({mode:'bind', groupId:'person', positions:[row]});
  assert.equal(issue.positions[0].original, '【柳某甲】');
});

test('同一原词已有多个实际代号时，只给迁入位置明确选码', async () => {
  const state = fixture.crossCategoryProject();
  const first = state.materials[0].decisions[0];
  first.aliasType = '曾用名';
  first.replacement = '【柳某甲-曾用名1】';
  const w = workspace(state);
  const change = {mode:'merge', groupId:'organization', targetId:'person'};
  const {issue} = await w.preview(change);
  assert.deepEqual(issue.targetCodeChoices, [{original:fixture.original, codes:[
    {code:first.replacement, count:1}, {code:'【柳某甲】', count:98},
  ]}]);
  const confirmed = {...change, targetCodes:{[fixture.original]:'【柳某甲】'}};
  const {view} = await w.apply(confirmed, await w.preview(confirmed));
  assert.equal(view.groups[0].occurrences.length, 102);
  assert.equal(view.groups[0].occurrences[0].replacement, first.replacement);
  assert.ok(view.groups[0].occurrences.slice(-3).every(row => row.replacement === '【柳某甲】'));
});

test('新建撞码、修改撞码和从原文选中绑定使用同一跨类别规则', async () => {
  const w = workspace(fixture.crossCategoryProject());
  const {view} = await w.run({op:'view'});
  const source = view.groups.find(row => row.id === 'organization');
  const target = view.groups.find(row => row.id === 'person');
  const positions = source.occurrences.slice(0,1);
  const resolution = {mode:'selected', targetId:target.id};
  const edit = {...w.edit(source, target.code, resolution), rebindPositions:positions};
  const create = {mode:'create', type:'address', code:target.code, positions, resolution};
  const bind = {mode:'bind', groupId:target.id, positions};
  for (const change of [edit, create, bind]) {
    const previous = await w.preview(change);
    assert.equal(previous.preview.sources[0].remaining, 2);
    const {view} = await w.apply(change, previous);
    assert.equal(view.groups.find(row => row.id === source.id).occurrences.length, 2);
    assert.equal(view.groups.find(row => row.id === target.id).occurrences.length, 100);
    await w.run({op:'undo'});
  }
});

test('以实际完整值约束跨类别转移，允许同一号码的不同写法', async () => {
  const w = workspace();
  await w.add('姓名：赵敏\n联系电话：13800138000、13900139000');
  const {groups} = await w.add('联系电话：138-0013-8000');
  const name = groups.find(group => group.primary === '赵敏');
  const target = groups.find(group => group.primary === '13800138000');
  const other = groups.find(group => group.primary === '13900139000');
  assert.equal(target.occurrences.length, 2);
  for (const [from, to] of [[other,target], [other,name], [name,target]]) {
    const {issue} = await w.preview({mode:'merge', groupId:from.id, targetId:to.id});
    assert.match(issue.message, /实际相同的完整值/u);
  }
});

test('部分改绑预览显示源组的恢复原词，可以选择另一剩余别称', async () => {
  const w = workspace();
  const {groups} = await w.add('姓名：张甲\n姓名：赵敏\n姓名：周敏\n姓名：苏平');
  const [source, first, second, target] = ['张甲','赵敏','周敏','苏平'].map(name => groups.find(row => row.primary === name));
  await w.apply({mode:'merge', groupId:first.id, targetId:source.id});
  await w.apply({mode:'merge', groupId:second.id, targetId:source.id});
  const change = {...w.edit(source, target.code, {mode:'selected', targetId:target.id}), rebindPositions:source.occurrences};
  const {preview} = await w.preview(change);
  assert.deepEqual(preview.sources[0].terms, ['赵敏','周敏']);
  assert.equal(preview.sources[0].nextPrimary, '赵敏');
  change.primaries = {[source.id]:{original:'周敏'}};
  const {view} = await w.apply(change, await w.preview(change));
  assert.equal(view.groups.find(row => row.id === source.id).primary, '周敏');
  assert.equal((await w.run({op:'undo'})).view.groups.find(row => row.id === source.id).primary, '张甲');
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
