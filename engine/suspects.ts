import * as R from './suspect-rules.js';
import { char, digits, endsAny, length, rule, slice, startsAny, trim, type Rule } from './text.js';

type Suspect = { text: string; category: 'person' | 'organization'; reason: string; start: number; end: number };
const dots = ['·', '•'];
const speakerStop = rule(R._NARRATIVE_ANCHORS);
const clause = rule('[的向与及或]|协议|签署|任一|均可|根据|可以|应当');
const spaces = rule('\\s+');

export function hasSurname(name: string) {
  if (dots.some(dot => name.includes(dot)) && length(name) >= 3) return !startsAny(name, dots) && !endsAny(name, dots);
  return startsAny(name, R.COMPOUND_SURNAMES) || R.SURNAMES.has(char(name, 0));
}

function personLike(value: string) {
  return !!value && !R._PERSON_BLOCKLIST.has(value) && !startsAny(value, [...R._PERSON_STOPWORDS])
    && !value.includes('某') && !endsAny(value, ['公司', '法院', '银行', '事务所']);
}

export function languageSuspects(text: string) {
  const rows: Suspect[] = [];
  for (const match of R._ORG_SUFFIX_RE.finditer(text)) {
    const stop = match.start();
    const floor = Math.max(0, stop - R._ORG_MAX_HEAD);
    let start = stop;
    while (start > floor && R._ORG_NAME_CHAR.match(char(text, start - 1))) start--;
    let anchored = start === 0 || !R._ORG_NAME_CHAR.match(char(text, start - 1));
    let head = slice(text, start, stop);
    const boundary = [...R._ORG_LEFT_CUT.finditer(head)].at(-1);
    if (boundary?.end()) {
      head = slice(head, boundary.end());
      anchored = true;
    }
    for (let lead = R._ORG_LEAD.match(head); lead?.end(); lead = R._ORG_LEAD.match(head)) head = slice(head, lead.end());
    if (length(head) < 2 || R._GENERIC_HEAD_ONLY.has(head)) continue;
    const suffix = match.value;
    if (endsAny(suffix, R._INSTITUTIONAL_SUFFIX) && R._CLAUSE_IN_HEAD.test(head)) continue;
    if (['工作室', '经营部', '商行', '服务部'].includes(suffix) && (length(head) < 3 || clause.test(head))) continue;
    const name = head + suffix;
    if (length(name) < 4 || R._ORG_BLOCKLIST.has(name) || (name.endsWith('人民法院') && length(name) <= 8)) continue;
    if (name.endsWith('银行') && !['分行', '支行', '股份', '有限', '集团'].some(part => name.includes(part))) continue;
    rows.push({text: name, category: 'organization', reason: anchored ? 'org_suffix' : 'org_suffix_unanchored',
      start: stop - length(head), end: match.end()});
  }

  for (const match of R._PERSON.finditer(text)) {
    const name = trim(match.group('name')!);
    const delimiter = trim(match.group('delim') ?? '');
    if (!personLike(name)) continue;
    if (!delimiter && (!hasSurname(name) || digits(char(text, match.end('name')))
        || (length(name) === 4 && !startsAny(name, R.COMPOUND_SURNAMES)))) continue;
    rows.push({text: name, category: 'person', reason: 'role_anchored', start: match.start('name'), end: match.end('name')});
  }
  const labeled: [pattern: Rule, reason: string][] = [
    [R._PERSON_NARRATIVE, 'relation_anchored'], [R._ENTRUSTED, 'entrusted_by'], [R._LABELED_PERSON, 'labeled_person'],
  ];
  for (const [pattern, reason] of labeled) {
    for (const match of pattern.finditer(text)) {
      const name = trim(match.group('name')!);
      if (!personLike(name) || !hasSurname(name)) continue;
      if (reason === 'relation_anchored' && speakerStop.test(name)) continue;
      if (reason === 'entrusted_by' && ['本人', '当事人'].includes(name)) continue;
      rows.push({text: name, category: 'person', reason, start: match.start('name'), end: match.end('name')});
    }
  }
  for (const match of R._LABELED_LATIN.finditer(text)) {
    const name = spaces.replace(trim(match.group('name')!), ' ');
    if (length(name) >= 2) rows.push({text: name, category: 'person', reason: 'latin_labeled', start: match.start('name'), end: match.end('name')});
  }
  return rows;
}
