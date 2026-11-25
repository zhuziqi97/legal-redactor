import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreText } from '../build/engine/restore.js';
import { decodeInput } from '../build/text-input.cjs';

test('主代号和有效别称代号均还原为当前映射的原文，保留其余字符', () => {
  const input = '😀【张某】已签收。\r\n\r\n\t【张某-微信昵称1】复核了【附件】。张某 [张某]\n【张某】';
  const groups = [{ code: '【张某】', primary: '张甲', occurrences: [{ replacement: '【张某-微信昵称1】' }] }];
  const { output, occurrences } = restoreText(input, groups);
  assert.equal(output, '😀张甲已签收。\r\n\r\n\t张甲复核了【附件】。张某 [张某]\n张甲');
  assert.deepEqual(occurrences.map(({ line, code, value }) => [line, code, value]), [
    [1, '【张某】', '张甲'], [3, '【张某-微信昵称1】', '张甲'], [3, '【附件】', null], [4, '【张某】', '张甲'],
  ]);
  for (const { start, end, code } of occurrences) assert.equal(input.slice(start, end), code);
  const changed = restoreText('【张某】', [{ ...groups[0], primary: '张乙' }]);
  assert.equal(changed.output, '张乙');
});

test('保留无法唯一匹配的代号，且插入的原文不参与第二轮替换', () => {
  const groups = [
    { code: '【共用】', primary: '张甲', occurrences: [] },
    { code: '【共用】', primary: '李乙', occurrences: [] },
    { code: '【甲】', primary: '取值【乙】', occurrences: [] },
    { code: '【乙】', primary: '其他原文', occurrences: [] },
  ];
  const { output, occurrences } = restoreText('【共用】、【甲】、【甲 】、【缺失', groups);
  assert.equal(output, '【共用】、取值【乙】、【甲 】、【缺失');
  assert.deepEqual(occurrences.map(row => row.value), [null, '取值【乙】', null]);
});

test('恢复 TXT 保留源文件换行，脱敏导入继续使用 LF', () => {
  const input = Buffer.from('甲\r\n\r\n乙\r丙', 'utf8');
  assert.equal(decodeInput(input, undefined, true).text, '甲\r\n\r\n乙\r丙');
  assert.equal(decodeInput(input).text, '甲\n\n乙\n丙');
});
