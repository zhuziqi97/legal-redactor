const original = '柳明川';

function crossCategoryProject() {
  const person = {id: 'person', type: 'person', primary: original, code: '【柳某甲】'};
  const organization = {id: 'organization', type: 'organization', primary: original, code: '【L机构】'};
  let text = '';
  const decisions = Array.from({length: 102}, (_, index) => {
    const group = index < 99 ? person : organization;
    text += index < 99 ? '姓名：' : '记录对象：';
    const start = text.length;
    text += original + '\n';
    return {
      id: index + 1, start, end: start + original.length, original, type: group.type, reason: 'Otter',
      object: null, name: group.type === 'person' ? original : null, action: 'replace',
      replacement: group.code, group: group.id, match: [group.type, original],
    };
  });
  const doc = {id: '1', title: '合成笔录', text, sourcePath: null, decisions, relations: [], revision: 1};
  return {
    materials: [doc], groups: {person, organization}, activeId: doc.id,
    nextMaterialId: 2, revision: 0, undo: null,
  };
}

module.exports = {crossCategoryProject, original};
