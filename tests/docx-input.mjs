import assert from 'node:assert/strict';
import test from 'node:test';
import {readWordInput} from '../build/word-input.cjs';
import {makeDocx} from './docx-fixture.cjs';

const paragraph = text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const cell = text => `<w:tc>${paragraph(text)}</w:tc>`;

test('Word 正文与表格按出现顺序转为纯文本，保留空单元格和格内换行', async () => {
  const bytes = await makeDocx(
    '<w:p><w:r><w:t>材料</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>甲</w:t></w:r></w:p>'
    + `<w:tbl><w:tr>${cell('姓名')}${cell('金额')}${cell('备注')}</w:tr>`
    + `<w:tr>${cell('张甲')}${cell('6000')}${cell('')}</w:tr></w:tbl>`
    + paragraph('核对情况')
    + '<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>'
    + paragraph('当事人信息') + '</w:tc></w:tr>'
    + `<w:tr>${cell('对方信息')}<w:tc>${paragraph('张甲')}${paragraph('账户尾号 1234')}</w:tc></w:tr></w:tbl>`
    + paragraph('正文结束。'),
  );
  assert.equal(await readWordInput(bytes),
    '材料甲\n\n姓名\t金额\t备注\n张甲\t6000\t\n\n核对情况\n\n当事人信息\n对方信息\n张甲\n账户尾号 1234\n\n正文结束。');
});

test('损坏的 DOCX 与没有正文的 DOCX 给出不同读取提示', async () => {
  await assert.rejects(readWordInput(Buffer.from('not a Word document')), /无法读取 DOCX/u);
  await assert.rejects(readWordInput(await makeDocx('<w:p/>')), /没有可识别的正文/u);
});
