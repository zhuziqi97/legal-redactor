import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFields} from '../build/engine/fields.js';
import {scanCandidates} from '../build/engine/model.js';
import {buildPlan, render} from '../build/engine/pipeline.js';

function predictions(text, values) {
  return values.flatMap(([value, label]) => {
    const at = text.indexOf(value);
    if (at < 0) return [];
    const start = [...text.slice(0, at)].length;
    return [{start, end: start + [...value].length, label}];
  });
}

test('同一答话和未结束句子保留换行作为上下文，跨行预测不替换', async () => {
  const answer = '答：😀 张甲赶到现场。\r\n王明负责登记。';
  const prose = '请通知证人周乙\n到一楼等候。';
  const text = '问：当时有谁在场？\r\n' + answer + '\r\n\r\n## 情况说明\n' + prose;
  const submitted = [];
  const [rows] = await buildPlan(text, {}, (source, free, known) =>
    scanCandidates(source, free, known, async inputs => {
      submitted.push(...inputs);
      return inputs.map(value => predictions(value, [
        ['张甲', 'person'], ['王明', 'person'], ['周乙', 'person'], ['现场。\r\n王明', 'organization'],
      ]));
    }));
  assert.ok(submitted.some(input => input.includes(answer)));
  assert.ok(submitted.includes(prose));
  assert.deepEqual(rows.map(row => row.original), ['张甲', '王明', '周乙']);
  for (const row of rows) assert.equal([...text].slice(row.start, row.end).join(''), row.original);
  assert.match(render(text, rows).output, /现场。\r\n【王某1】负责登记。/u);
});

test('独占一行的标题使用下一行完整值，保留相邻标点和字段', async () => {
  const text = '姓名：\n钱小平，联系电话：13900139000。\n单位名称：\n嘉林市晨星设备有限公司。';
  const [rows] = await buildPlan(text);
  assert.deepEqual(rows.map(row => row.original), ['钱小平', '13900139000', '嘉林市晨星设备有限公司']);
  assert.match(render(text, rows).output, /^姓名：\n【钱某1】，联系电话：【电话1】。\n单位名称：\n【[^】]+】。$/u);
  assert.deepEqual(readFields('姓名：\n\n备注：待确认。').hits.filter(row => row.kind === 'person'), []);
});

test('别称更正保留引导语，对缺乏语境的模型昵称不建立候选', async () => {
  const text = '其实是小李。\n当时由小王负责。';
  const hits = await scanCandidates(text, [{start: 0, end: [...text].length, context: '张甲的昵称是什么？'}], [],
    async inputs => inputs.map(value => predictions(value, [['是小李', 'chat nickname'], ['小王', 'chat nickname']])));
  assert.deepEqual(hits.map(row => [...text].slice(row.start, row.end).join('')), ['小李']);
});

test('字段明确时区分流水号、账号和信用代码，按列和完整逻辑记录识别', async () => {
  const text = '业务流水号：9901010000002022。\n银行账号：9901010000002022。\n统一社会信用代码：91000000MA0REDAC1X。\n\n'
    + '序号  债权人名称  金额（元）\n1  嘉林市晨星设备有限公司  16800\n合计  16800\n\n'
    + '姓名,联系电话,备注\n王明,13800138000,"已通知,\n等待回复"';
  const [rows] = await buildPlan(text);
  assert.deepEqual(rows.map(row => [row.original, row.type]), [
    ['9901010000002022', 'bank_account'], ['91000000MA0REDAC1X', 'uscc'],
    ['嘉林市晨星设备有限公司', 'organization'], ['王明', 'person'], ['13800138000', 'mobile'],
  ]);
  const output = render(text, rows).output;
  assert.match(output, /^业务流水号：9901010000002022。\n银行账号：【账号1】。\n统一社会信用代码：【信用代码1】。/u);
  assert.match(output, /  16800\n合计  16800[\s\S]+"已通知,\n等待回复"$/u);
  assert.ok(readFields(text).free.some(row => [...text].slice(row.start, row.end).join('') === '已通知,\n等待回复'));
});

test('确认完整地点时保留人物、动作、指代和引用标题', async () => {
  const text = '查看的是钱宁居住的嘉林市青松镇杏桥村安平路25号。\n'
    + '她把货送到了东原市宝林区万兴街19号。\n先去医院挂号，两天后在嘉林市康复医院复诊。\n'
    + '依据《中华人民共和国民法典》第三条。';
  const values = [['钱宁', 'person'], ['医院', 'location'], ['嘉林市康复医院', 'location'],
    ['中华人民共和国', 'location']];
  const [rows] = await buildPlan(text, {}, (source, free, known) => scanCandidates(source, free, known,
    async inputs => inputs.map(value => predictions(value, values))));
  assert.deepEqual(rows.map(row => [row.original, row.type]), [
    ['钱宁', 'person'], ['嘉林市青松镇杏桥村安平路25号', 'address'],
    ['东原市宝林区万兴街19号', 'address'], ['嘉林市康复医院', 'organization'],
  ]);
  const output = render(text, rows).output;
  assert.match(output, /查看的是【钱某1】居住的【[^】]+】。/u);
  assert.match(output, /她把货送到了【[^】]+】。[\s\S]*去医院挂号[\s\S]*《中华人民共和国民法典》第三条。/u);
});

test('问答更正撤回别称归属，重用问句动词时只替换姓名', async () => {
  const text = '问：钱宁的网名是什么？\n答：我记得他网名叫阿林。\n实际是阿杨。\n问：谁领了单据？\n答：吴刚领的。';
  const values = [['钱宁', 'person'], ['阿林', 'chat nickname'], ['是阿杨', 'chat nickname'], ['吴刚', 'person']];
  const [rows, , relations] = await buildPlan(text, {}, (source, free, known) => scanCandidates(source, free, known,
    async inputs => inputs.map(value => predictions(value, values))));
  assert.ok(!relations.some(link => ['阿林', '阿杨'].includes(link.value)));
  const output = render(text, rows).output;
  assert.doesNotMatch(output, /阿林|阿杨|吴刚/u);
  assert.match(output, /实际是【[^】]+】。\n问：谁领了单据？\n答：【吴某1】领的。/u);
});

test('按行政区和机关层级识别全称并保留独立公共机构', async () => {
  const text = '依据公安部发布的说明。材料移交郑州市公安局管城分局。';
  const [rows] = await buildPlan(text, {}, async () =>
    predictions(text, [['公安部', 'organization'], ['郑州市', 'location']])
      .map(({start, end, label}) => ({
        start, end, kind: label === 'location' ? 'address' : label, reason: 'Otter', priority: 60,
      })));
  assert.deepEqual(rows.map(({original, type}) => [original, type]), [['郑州市公安局管城分局', 'organization']]);
  assert.match(render(text, rows).output, /^依据公安部发布的说明。材料移交【[^】]+】。$/u);
});

test('编号列和案号附号按原文位置识别，保留庭号和序号', async () => {
  const text = '序号\t房屋信息\t楼栋号\t车位号\t法庭\n1\t2-3-504、601\tA栋\tB-209\t本院第八法庭\n'
    + '案号：（2025）豫0102民初123号之二\n统一社会信用代码91000000MA0REDAC1X';
  const [rows] = await buildPlan(text);
  assert.deepEqual(rows.map(({original, type}) => [original, type]), [
    ['2-3-504', 'address'], ['601', 'address'], ['A栋', 'address'], ['B-209', 'address'],
    ['（2025）豫0102民初123号之二', 'case_number'], ['91000000MA0REDAC1X', 'uscc'],
  ]);
  assert.match(render(text, rows).output, /\n1\t.*本院第八法庭\n/u);
});

test('确认的住所字段覆盖路名之后的连续具名楼座与房号', async () => {
  const address = '广东省广州市天河区石牌东街金桐中心A座22025号';
  const text = `住所：${address}。统一社会信用代码：91000000MA0REDAC1X。`;
  const [rows] = await buildPlan(text, {}, async () => [
    {start: 3, end: 19, kind: 'address', reason: 'Otter', priority: 60},
  ]);
  assert.deepEqual(rows.map(row => row.original), [address, '91000000MA0REDAC1X']);
});

test('即使段落中重复出现，诉讼角色本身也不形成姓名映射', async () => {
  const text = '被申请人提交材料。申请人称：收到回执。';
  const start = text.indexOf('申请人称');
  const [rows] = await buildPlan(text, {}, async () => [
    {start: 1, end: 4, kind: 'person', reason: 'Otter', priority: 60},
    {start, end: start + 3, kind: 'person', reason: 'Otter', priority: 60},
  ]);
  assert.equal(render(text, rows).output, text);
});

test('正文只续用同一段中有房屋依据的室号，保留户型和数量', async () => {
  const text = '附注😀：经核对，房号为7-306。该单元306室业主到场，306室等待验收。'
    + '库存为306，展馆共306室，户型为3室2厅。交付6栋2单元401、402室。\n\n306室另有备注。';
  const [rows] = await buildPlan(text);
  const rooms = rows.filter(row => row.type === 'address');
  assert.deepEqual(rooms.map(row => row.original), ['7-306', '306室', '306室', '6栋2单元401', '402室']);
  for (const row of rooms) assert.equal([...text].slice(row.start, row.end).join(''), row.original);
  assert.match(render(text, rows).output, /库存为306，展馆共306室，户型为3室2厅。交付【[^】]+】、【[^】]+】。\n\n306室另有备注。/u);
});

test('完整住所优先于独立室号，匿名处所只遮盖可见楼室', async () => {
  const address = '琼川花苑605室';
  const text = `查明${address}业主到场，605室已交接。钥匙来自某花园5号楼 2单元 702室。`;
  const [rows] = await buildPlan(text, {}, () => [{start: 2, end: 2 + address.length,
    kind: 'address', reason: 'Otter', priority: 60}]);
  assert.deepEqual(rows.filter(row => row.type === 'address').map(row => row.original), [address, '605室', '5号楼 2单元 702室']);
  assert.match(render(text, rows).output, /来自某花园【[^】]+】。$/u);
});

test('表格房屋编号覆盖有序楼室及带连接号的房号', async () => {
  const text = '序号\t房屋信息\t备注\n1\tA栋 2单元 305室\t已交\n2\t3－4－706室\t待核';
  const [rows] = await buildPlan(text);
  assert.deepEqual(rows.filter(row => row.type === 'address').map(row => row.original), ['A栋 2单元 305室', '3－4－706室']);
  assert.match(render(text, rows).output, /\n1\t【[^】]+】\t已交\n2\t【[^】]+】\t待核$/u);
});

test('连续识别银行辖区支行、上级机关和法庭全称', async () => {
  const bank = '东莞农村商业银行';
  const authority = '国家税务总局';
  const court = '杭州市西湖区人民法院';
  const text = `回执由${bank}长安支行送达。材料转交${authority}郑州市税务局第一稽查局。${court}民事审判第一庭归档。`;
  const [rows] = await buildPlan(text, {}, () =>
    predictions(text, [bank, authority, court].map(value => [value, 'organization']))
      .map(({start, end, label}) => ({start, end, kind: label, reason: 'Otter', priority: 60})));
  assert.deepEqual(rows.map(({original, type}) => [original, type]), [
    [bank + '长安支行', 'organization'], [authority + '郑州市税务局第一稽查局', 'organization'],
    [court + '民事审判第一庭', 'organization'],
  ]);
});

test('保留原文声明的机构代称和匿名分支，仍识别具名商号', async () => {
  const parent = '某某供应链有限公司';
  const branch = '杭州市分公司';
  const named = 'G云川设备有限公司';
  const published = 'B银行北京市分行（以下简称B银行）';
  const text = `${published}提交说明。B银行复函。CB银行参加。${parent}${branch}登记。${parent}${branch}签收。另通知${branch}和${named}。`;
  const values = ['B银行北京市分行', 'B银行', 'CB银行', parent, branch, named];
  const [rows] = await buildPlan(text, {}, () => values.flatMap(value =>
    [...text.matchAll(new RegExp(value, 'gu'))].map(({index: start}) =>
      ({start, end: start + value.length, kind: 'organization', reason: 'Otter', priority: 60}))));
  assert.deepEqual(rows.map(row => row.original), ['CB银行', branch, named]);
  const output = render(text, rows).output;
  assert.ok(output.startsWith(`${published}提交说明。B银行复函。`));
  assert.ok(output.includes(`${parent}${branch}登记。${parent}${branch}签收。`));
});

test('机构类型词单独出现时保留，连同具名辖区时识别全称', async () => {
  const statutoryRoles = '有限责任公司股东或者股份有限公司';
  const text = `有限公司应依法登记。分公司提交说明。支行负责接收。回执由南京市分公司签发。应登记${statutoryRoles}发起人的姓名。`;
  const [rows] = await buildPlan(text, {}, () => predictions(text, [
    ['有限公司', 'organization'], ['分公司', 'organization'], ['支行', 'organization'], ['南京市分公司', 'organization'],
    [statutoryRoles, 'organization'],
  ]).map(({start, end, label}) => ({start, end, kind: label, reason: 'Otter', priority: 60})));
  assert.deepEqual(rows.map(row => row.original), ['南京市分公司']);
  assert.match(render(text, rows).output, /^有限公司应依法登记。分公司提交说明。支行负责接收。/u);
  assert.ok(render(text, rows).output.includes(`应登记${statutoryRoles}发起人的姓名。`));
});

test('两次模型误带谓词时，后文的正确姓名边界仍沿用登记代号', async () => {
  const name = '林知远';
  const text = `姓名：${name}\n\n${name}是在周一到场的。${name}是在会后签收的。${name}是在此办理的。`;
  const occurrences = [...text.matchAll(/林知远/gu)].slice(1);
  const [rows] = await buildPlan(text, {}, () => occurrences.map(({index: start}, index) => ({
    start, end: start + name.length + Number(index < 2), kind: 'person', reason: 'Otter', priority: 60,
  })));
  assert.equal(rows.at(-1).original, name);
  assert.equal(rows.at(-1).replacement, rows[0].replacement);
  assert.ok(render(text, rows).output.endsWith(`${rows[0].replacement}是在此办理的。`));
});

test('已有重复姓名且有发言语境时，补齐模型未给出的位置', async () => {
  const text = '周宁提交笔录。记录中提到周宁已签收。核对完毕后，周宁说需补充材料。';
  const [rows] = await buildPlan(text, {}, () => [...text.matchAll(/周宁/gu)].slice(0, 2).map(({index: start}) => ({
    start, end: start + 2, kind: 'person', reason: 'Otter', priority: 60,
  })));
  assert.deepEqual(rows.map(row => row.original), ['周宁', '周宁', '周宁']);
  assert.equal(rows.at(-1).reason, '全文姓名');
  assert.equal(rows.at(-1).replacement, rows[0].replacement);
});

test('纯规则模式保留单位名称栏的提示文字，仍识别明确的单位名称', async () => {
  const text = '单位名称：请见附件。\n单位名称：青禾设备有限公司。';
  const [rows] = await buildPlan(text);
  assert.deepEqual(rows.map(row => row.original), ['青禾设备有限公司']);
  assert.match(render(text, rows).output, /^单位名称：请见附件。\n单位名称：【[^】]+】。$/u);
});
