import { PERSON_VALUE, ROLE, TITLE } from './field-rules.js';
import { hit, type Hit, type Passage } from './fields.js';
import { COMPOUND_SURNAMES } from './suspect-rules.js';
import { hasSurname } from './suspects.js';
import { char, length, rule, slice, startsAny, trim } from './text.js';

export type Prediction = {start: number; end: number; label: string};
export type Predict = (texts: string[], labels: string[]) => Promise<Prediction[][]>;
type Window = {start: number; end: number; lower: number; upper: number; prefix: string};

const labels = ['person', 'organization', 'location'];
const socialLabels = [...labels, 'chat nickname', 'social media account'];
const types: Record<string, string> = {
  person: 'person', organization: 'organization', location: 'address',
  'chat nickname': 'nickname', 'social media account': 'social',
};
const punctuation = rule('[。！？；，]');
const socialContext = rule('微信|昵称|网名|绰号|联系人备注');
const weakTitle = rule('[\\u3400-\\u9fff](?:总|经理|主任|老师|师傅|老板|律师)(?:是|说|称|的|吗|呢)?');
const party = rule('(?:原告|被告人?|上诉人|申请人|第三人|证人)[：:\\s]*$');

export function modelWindows(text: string, free: Passage[], known: Hit[]) {
  const definite = known.filter(item => item.priority >= 95);
  const groups = new Map<string[], Window[]>();
  for (const {start, end, context} of free) {
    if (!trim(slice(text, start, end)) || definite.some(item => item.start <= start && end <= item.end)) continue;
    const kinds = socialContext.search(context) || socialContext.search(text, start, end) ? socialLabels : labels;
    if (!groups.has(kinds)) groups.set(kinds, []);
    const windows = groups.get(kinds)!;
    let cursor = start;
    while (cursor < end) {
      let stop = Math.min(end, cursor + 192);
      if (stop < end) {
        const split = [...punctuation.finditer(text, cursor + 96, stop)].at(-1);
        if (split) stop = split.end();
      }
      const from = Math.max(start, cursor - 24);
      windows.push({start: from, end: Math.min(end, stop + 24), lower: cursor, upper: stop,
        prefix: context && from === start ? context + '\n' : ''});
      cursor = stop;
    }
  }
  return groups;
}

export async function scanCandidates(text: string, free: Passage[], known: Hit[], predict: Predict,
  progress?: (done: number, total: number) => void) {
  const groups = modelWindows(text, free, known);
  const total = [...groups.values()].reduce((sum, windows) => sum + windows.length, 0);
  let completed = 0;
  const candidates: Hit[] = [];
  for (const [kinds, windows] of groups) {
    for (let i = 0; i < windows.length; i += 8) {
      const batch = windows.slice(i, i + 8);
      const results = await predict(batch.map(window => window.prefix + slice(text, window.start, window.end)), kinds);
      if (results.length !== batch.length) throw new Error('模型返回的推理段数与提交段数不同。');
      completed += batch.length;
      progress?.(completed, total);
      for (const [index, {start, end, lower, upper, prefix}] of batch.entries()) {
        const offset = start - length(prefix);
        for (const item of results[index]) {
          const a = offset + item.start;
          let b = offset + item.end;
          const center = Math.floor((a + b) / 2);
          if (!(start <= a && a < b && b <= end && lower <= center && center < upper)) continue;
          let kind = types[item.label];
          if ((kind === 'person' || kind === 'organization') && char(text, b - 1) === '系') {
            const name = slice(text, a, b - 1);
            if (PERSON_VALUE.fullmatch(name) && hasSurname(name) &&
                (length(name) <= 3 || startsAny(name, COMPOUND_SURNAMES)) &&
                party.search(slice(text, Math.max(0, a - 10), a)) && b < end &&
                !'，。；、！？,.;!?）)'.includes(char(text, b))) {
              b--;
              kind = 'person';
            }
          }
          if (kind === 'person' && b - a > 2 && '的吗呢'.includes(char(text, b - 1))) b--;
          if (kind === 'organization' && char(text, b - 1) === '的') b--;
          const value = slice(text, a, b);
          if (ROLE.fullmatch(value) || TITLE.fullmatch(value) || length(value) < 2 ||
              (kind === 'person' && weakTitle.fullmatch(value))) continue;
          candidates.push(hit(a, b, kind, 'Otter', 60));
        }
      }
    }
  }
  return candidates;
}
