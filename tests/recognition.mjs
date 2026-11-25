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
  assert.match(render(text, rows).output, /现场。\r\n【王某】负责登记。/u);
});

test('独占一行的标题使用下一行完整值，保留相邻标点和字段', async () => {
  const text = '姓名：\n钱小平，联系电话：13900139000。\n单位名称：\n嘉林市晨星设备有限公司。';
  const [rows] = await buildPlan(text);
  assert.deepEqual(rows.map(row => row.original), ['钱小平', '13900139000', '嘉林市晨星设备有限公司']);
  assert.match(render(text, rows).output, /^姓名：\n【钱某】，联系电话：【电话1】。\n单位名称：\n【[^】]+】。$/u);
  assert.deepEqual(readFields('姓名：\n\n备注：待确认。').hits.filter(row => row.kind === 'person'), []);
});

test('别称更正保留引导语，对缺乏语境的模型昵称不建立候选', async () => {
  const text = '其实是小李。\n当时由小王负责。';
  const hits = await scanCandidates(text, [{start: 0, end: [...text].length, context: '张甲的昵称是什么？'}], [],
    async inputs => inputs.map(value => predictions(value, [['是小李', 'chat nickname'], ['小王', 'chat nickname']])));
  assert.deepEqual(hits.map(row => [...text].slice(row.start, row.end).join('')), ['小李']);
});
