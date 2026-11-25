import * as R from './context-rules.js';
import { EMPTY, NAME, PERSON_VALUE, ROLE, TITLE, TURN } from './field-rules.js';
import { hit, type Hit, type Layout } from './fields.js';
import { idChecksum, translateWidth } from './numbers.js';
import { hasSurname } from './suspects.js';
import { bisect, char, endsAny, escape, indexOf, keyOf, length, rule, slice, startsAny, trim, type Span } from './text.js';

export type Relation = {
  type: string; name?: string; value?: string; start: number; end: number; subject_start: number; object_start: number;
  statement_start?: number; statement_end?: number; scope?: number; source?: string | null;
  question_start?: number; question_end?: number; roles?: string[]; valueKey?: string;
};

export function overlap(a: Pick<Hit, 'start' | 'end'>, b: Pick<Hit, 'start' | 'end'>) {
  return a.start < b.end && b.start < a.end;
}

export function choose(hits: Hit[]) {
  const positions: number[] = [];
  const chosen: Hit[] = [];
  for (const row of [...hits].sort((a, b) => b.priority - a.priority || a.start - b.start || b.end - a.end)) {
    const at = bisect(positions, row.start, true);
    if ((at && overlap(chosen[at - 1], row)) || (at < chosen.length && overlap(chosen[at], row))) continue;
    positions.splice(at, 0, row.start);
    chosen.splice(at, 0, row);
  }
  return chosen;
}

export function* allSpans(text: string, words: Iterable<string>): Generator<[raw: string, start: number, end: number]> {
  const values = [...new Set(words)].filter(Boolean).sort((a, b) => length(b) - length(a));
  if (!values.length) return;
  const expression = rule(values.map(escape).join('|'));
  for (const match of expression.finditer(text)) {
    const [start, end] = match.span();
    if (/^[\x00-\x7f]+$/.test(match.value) && (/^[A-Za-z0-9]$/.test(char(text, start - 1)) && start > 0
        || /^[A-Za-z0-9]$/.test(char(text, end)))) continue;
    yield [match.value, start, end];
  }
}

function qualified(text: string) { return R.STATEMENT_FOLLOWUP.match(text) || R.FOLLOWUP_CHOICE.match(text); }

export function affirmative(text: string) {
  return !(TURN.match(text)?.group(1)?.startsWith('问') || endsAny(trim(text, undefined, 'right'), ['？', '?']) || R.NON_ASSERTION.test(text));
}

const whoQuestion = rule('谁|姓名|名字|叫什么');
export function answerNames(text: string, layout: Layout) {
  const rows: Hit[] = [];
  for (const [question, answer] of layout.answers) {
    const query = slice(text, ...question);
    if (!whoQuestion.test(query) || R.FORMER_NAME.test(query)) continue;
    const reply = R.SHORT_REPLY.fullmatch(text, ...answer);
    const name = reply?.group(1);
    if (reply && name && PERSON_VALUE.fullmatch(name) && hasSurname(name) && !TITLE.fullmatch(name) && !ROLE.fullmatch(name)
        && !R.NON_ASSERTION.test(name) && !R.UNCERTAIN_ASSERTION.test(name)) rows.push(hit(...reply.span(1), 'person', '姓名短答', 65));
  }
  return rows;
}

const correction = rule('有误|需核实|待核实|说错');
const actually = rule('其实是|实际是');
const topicsOf = (text: string) => [...R.TOPIC.finditer(text)].map(match => match.value);

export function disputed(text: string, start: number, end: number, question: string, answerEnd: number) {
  const body = slice(text, start, end);
  if (R.REPORTED.test(body) || R.NON_ASSERTION.test(body) || R.UNCERTAIN_ASSERTION.test(body)) return true;
  let topics = topicsOf(body);
  if (R.FORMER_NAME.test(body) || R.PERSON_ALIAS.test(body)) topics.push('称呼');
  if (!topics.length) topics = topicsOf(question);
  for (const clause of R.CLAUSE.finditer(text, end, answerEnd)) {
    const rest = trim(clause.value);
    if (!rest) continue;
    const others = topicsOf(rest);
    if (others.length && !others.some(topic => topics.includes(topic)) && !R.PERSON_ALIAS.test(rest)) continue;
    if (qualified(rest) || R.DISPUTED.test(rest) || R.UNCERTAIN_ASSERTION.test(rest) || correction.test(rest)) return true;
    if (!others.length && R.SHORT_REPLY.fullmatch(trim(rest, '。', 'right')) && actually.match(rest)) return true;
  }
  return false;
}

const speakerPrefix = rule('(?:称|说|表示|陈述)[，,：:“]?');
const attributedPrefix = rule('(?:说|称|认为|表示)[，,：:“]+$');
const answerPrefix = rule('^\\s*(?:答话|答)\\s*[：:]\\s*');
const clauses = rule('[^，,]+');
const titleQuery = rule('(?:你们说的|你说的)?[^，。？！?]{1,8}(?:是谁|指谁|指的是谁)[？?]?');
const otherSubject = rule('他|她|对方|别人');

export function definitions(text: string, chosen: Hit[], layout: Layout) {
  const sections = [...new Set(layout.sections)].sort((a, b) => a - b);
  const scope = (at: number) => bisect(sections, at, true);
  const byStart = new Map(chosen.map(row => [row.start, row]));
  const people = new Set(chosen.filter(row => row.kind === 'person').map(row => slice(text, row.start, row.end)));
  const ends = new Map(chosen.filter(row => ['person', 'organization'].includes(row.kind)).map(row => [row.end, row]));
  const positions = chosen.map(row => row.start);
  const answerStarts = layout.answers.map(([, answer]) => answer[0]);
  const registrations = chosen.filter(row => row.kind === 'person' && ['被询问人', '被讯问人'].includes(row.reason));
  const registrationStarts = registrations.map(row => row.start);
  const speakerStarts = [...layout.speakers.keys()].sort((a, b) => a - b);
  const bindings = new Map<string, {section: number; raw: string; unit: string | null; names: Map<string, [number, string][]>}>();
  const objections = new Set<string>();
  const attributed = new Map<number, [end: number, who: string]>();
  const extra: Hit[] = [];
  let links: Relation[] = [];
  for (const row of chosen) {
    if (row.kind !== 'person' || !speakerPrefix.match(slice(text, row.end, row.end + 5))) continue;
    const sentence = R.SENTENCE.match(text, row.end);
    if (sentence) attributed.set(row.end, [sentence.end(), slice(text, row.start, row.end)]);
  }
  const attributedStarts = [...attributed.keys()].sort((a, b) => a - b);

  const chatSpeaker = (at: number) => {
    const start = speakerStarts[bisect(speakerStarts, at, true) - 1];
    if (start !== undefined && scope(start) === scope(at) && !slice(text, start, at).includes('\n')) return layout.speakers.get(start);
  };
  const source = (at: number) => {
    const speaker = chatSpeaker(at);
    if (speaker) return slice(text, ...speaker);
    const start = attributedStarts[bisect(attributedStarts, at, true) - 1];
    const entry = attributed.get(start);
    return entry && at < entry[0] ? entry[1] : null;
  };
  const interviewee = (at: number) => {
    const i = bisect(registrationStarts, at, true) - 1;
    if (i >= 0 && scope(registrationStarts[i]) === scope(at)) return registrations[i];
    const speaker = chatSpeaker(at);
    if (speaker && people.has(slice(text, ...speaker))) return hit(...speaker, 'person', '发言者', 100);
  };
  const titleOrganization = (at: number) => {
    const row = chosen[bisect(positions, at) - 1];
    if (row?.kind === 'organization' && ['', '的'].includes(slice(text, row.end, at))) return slice(text, row.start, row.end);
    const prefix = slice(text, Math.max(0, at - 36), at).split(/[，,。；;：:\r\n]/).at(-1)!;
    return R.TITLE_ORG.search(prefix)?.group('unit') ?? null;
  };
  const bind = (a: number, b: number, target: Hit, type: string, statement: Span, question?: Span) => {
    const raw = slice(text, a, b);
    const full = slice(text, target.start, target.end);
    if (raw === full || EMPTY.has(raw) || R.NON_ASSERTION.test(raw) || R.UNCERTAIN_ASSERTION.test(raw)) return;
    const unit = R.WEAK_TITLE.fullmatch(raw) ? titleOrganization(a) : null;
    const section = scope(a);
    const owner = source(a);
    const key = keyOf(section, raw, unit, owner);
    const binding = bindings.get(key) ?? {section, raw, unit, names: new Map<string, [number, string][]>()};
    const records = binding.names.get(full) ?? [];
    records.push([a, target.kind]);
    binding.names.set(full, records);
    bindings.set(key, binding);
    const kind = ['聊天昵称', '曾用名'].includes(type) ? 'nickname' : target.kind;
    extra.push(hit(a, b, kind, type, kind === 'nickname' ? 104 : 101));
    links.push({type, name: full, value: raw, start: a, end: b, subject_start: target.start, object_start: a,
      statement_start: statement[0], statement_end: statement[1], scope: section, source: owner,
      ...(question ? {question_start: question[0], question_end: question[1]} : {})});
  };

  for (const sentence of R.SENTENCE.finditer(text)) {
    const content = sentence.value;
    if (!(R.ALIAS_SUFFIX.test(content) || R.FORMER_NAME.test(content) || R.PERSON_ALIAS.test(content)) || endsAny(content, ['？', '?'])) continue;
    for (const label of R.PERSON_ALIAS.finditer(content)) {
      const prefix = slice(content, 0, label.start());
      if (R.NEGATED.test(prefix) && !affirmative(prefix)) {
        const a = sentence.start() + label.start(1);
        const target = byStart.get(sentence.start() + label.end());
        if (target) objections.add(keyOf(scope(a), label.group(1), titleOrganization(a), slice(text, target.start, target.end)));
      }
    }
    const i = bisect(answerStarts, sentence.end() - 1, true) - 1;
    const qa = i >= 0 && sentence.start() < layout.answers[i][1][1] ? layout.answers[i] : undefined;
    const after = R.SENTENCE.search(text, sentence.end());
    let limit = qa?.[1][1] ?? sentence.end();
    if (after && scope(after.start()) === scope(sentence.start()) && (R.DISPUTED.test(after.value) || qualified(after.value))) limit = Math.max(limit, after.end());
    for (const clause of clauses.finditer(content)) {
      const base = sentence.start() + clause.start();
      const lead = slice(text, sentence.start(), base);
      const unresolved = R.REPORTED.test(lead) || (source(base) === null && attributedPrefix.test(lead))
        || disputed(text, base, sentence.start() + clause.end(), qa ? slice(text, ...qa[0]) : '', limit);
      let body = answerPrefix.replace(clause.value, '');
      let start = base + length(clause.value) - length(body);
      const statement = qa?.[1] ?? sentence.span();
      const speaker = chatSpeaker(start + length(trim(body, ' 。！!', 'right')));
      if (speaker && start <= speaker[0] && speaker[1] < start + length(body)) {
        const cut = speaker[1] - start + 1;
        start += cut;
        body = slice(body, cut);
      }

      for (const alias of R.ALIAS_SUFFIX.finditer(body)) {
        const target = ends.get(start + length(trim(slice(body, 0, alias.start()), undefined, 'right')));
        const value = alias.group(1)!;
        const raw = trim(value, ' “”"「」');
        if (target && raw && !raw.includes('《') && !unresolved) {
          const a = start + alias.start(1) + indexOf(value, raw);
          bind(a, a + length(raw), target, target.kind === 'organization' ? '机构简称' : '人物简称', statement);
        }
      }
      for (const alias of R.PERSON_ALIAS.finditer(body)) {
        const target = byStart.get(start + alias.end());
        if (!unresolved && target?.kind === 'person' && !trim(slice(body, target.end - start), ' 。！!')) {
          bind(start + alias.start(1), start + alias.end(1), target, '人物简称', statement);
        }
      }
      for (const intro of R.FORMER_NAME.finditer(body)) {
        const cue = start + intro.start();
        let target: Hit | undefined = chosen[bisect(positions, cue) - 1];
        if (!(target?.kind === 'person' && target.start >= start && ['', '的'].includes(trim(slice(text, target.end, cue))))) target = undefined;
        const prefix = trim(slice(body, 0, intro.start()), ' 的');
        const i = bisect(answerStarts, cue, true) - 1;
        const question = i >= 0 && cue < layout.answers[i][1][1] ? layout.answers[i][0] : undefined;
        if (!target && prefix === '我') target = interviewee(cue);
        if (!target && ['', '他', '她'].includes(prefix) && question && R.FORMER_NAME.search(text, ...question)) {
          const subjects = chosen.slice(bisect(positions, question[0]), bisect(positions, question[1])).filter(row => row.kind === 'person');
          if (subjects.length === 1) target = subjects[0];
        }
        const value = R.ALIAS_VALUE.fullmatch(trim(trim(slice(body, intro.end())), '。！!', 'right'));
        const raw = value?.group(1) || value?.group(2);
        if (!value || !raw) continue;
        const a = start + indexOf(body, raw, intro.end());
        const b = a + length(raw);
        const identified = byStart.get(a);
        const hasBoundary = identified?.end === b && ['person', 'nickname'].includes(identified.kind);
        if (!(value.group(1) || hasBoundary || prefix === '我' || endsAny(intro.value, ['：', ':']))) continue;
        if (EMPTY.has(raw) || R.NON_ASSERTION.test(raw) || R.UNCERTAIN_ASSERTION.test(raw)) continue;
        if (!target || unresolved) { extra.push(hit(a, b, 'nickname', '别称值', 66)); continue; }
        const type = ['昵称', '显示名', '备注名'].some(label => intro.value.includes(label)) ? '聊天昵称'
          : startsAny(intro.value, ['曾用名', '原名', '以前叫']) ? '曾用名' : '人物别称';
        bind(a, b, target, type, statement, question);
      }
    }
  }

  for (const [question, answer] of layout.answers) {
    const query = slice(text, ...question);
    const reply = R.SHORT_REPLY.fullmatch(text, ...answer);
    if (!reply || R.FORMER_NAME.search(text, ...answer) || disputed(text, ...answer, query, answer[1])) continue;
    const title = R.WEAK_TITLE.search(text, ...question);
    const person = byStart.get(reply.start(1));
    if (title && person?.kind === 'person' && person.end === reply.end(1) && titleQuery.fullmatch(query)) {
      bind(...title.span(), person, '人物简称', answer, question);
    } else if (R.FORMER_NAME.test(query)) {
      const subjects = chosen.filter(row => question[0] <= row.start && row.start < question[1] && row.kind === 'person');
      const target = subjects.length === 1 ? subjects[0] : (!subjects.length && !otherSubject.test(query) ? interviewee(answer[0]) : undefined);
      const [a, b] = reply.span(1);
      const name = reply.group(1)!;
      if (EMPTY.has(name) || R.NEGATED.test(name) || R.UNCERTAIN_ASSERTION.test(name)) continue;
      const quoted = a > 0 && ['“', '"', '「'].includes(char(text, a - 1));
      if (!(byStart.get(a)?.end === b || quoted || hasSurname(name) || startsAny(name, ['小', '阿', '老']))) continue;
      const type = query.includes('昵称') ? '聊天昵称' : query.includes('以前') || query.includes('曾用名') ? '曾用名' : '人物别称';
      if (target) bind(a, b, target, type, answer, question);
      else extra.push(hit(a, b, 'nickname', '别称短答', 66));
    }
  }

  const rejected = new Set<number>();
  for (const {section, raw, unit, names} of bindings.values()) {
    for (const [name, evidence] of names) {
      if (names.size > 1 || objections.has(keyOf(section, raw, unit, name))) for (const [at] of evidence) rejected.add(at);
    }
  }
  links = links.filter(link => !rejected.has(link.start));
  const accepted = extra.filter(row => !rejected.has(row.start));
  const chatNames = new Map<string, Relation[]>();
  for (const link of links) if (link.type === '聊天昵称') {
    const key = keyOf(link.scope, link.value);
    const records = chatNames.get(key) ?? [];
    records.push(link);
    chatNames.set(key, records);
  }
  const targets = new Map<string, [name: string, evidence: number[]]>();
  for (const [raw, a, b] of allSpans(text, [...bindings.values()].map(binding => binding.raw))) {
    const containing = chosen[bisect(positions, a, true) - 1];
    if (containing && ['person', 'organization'].includes(containing.kind) && containing.start <= a && b <= containing.end
        && (a !== containing.start || b !== containing.end)) continue;
    const unit = R.WEAK_TITLE.fullmatch(raw) ? titleOrganization(a) : null;
    const same = byStart.get(a);
    const chatLinks = chatNames.get(keyOf(scope(a), raw)) ?? [];
    if (same?.kind === 'nickname' && ['发言者', '通话方'].includes(same.reason) && chatLinks.length) {
      const names = new Set(chatLinks.map(link => link.name!));
      if (names.size === 1) {
        accepted.push(hit(a, b, 'person', '全文称呼', 103));
        targets.set(keyOf(a, b), [names.values().next().value!, chatLinks.map(link => link.start)]);
      }
      continue;
    }
    const names = bindings.get(keyOf(scope(a), raw, unit, source(a)))?.names;
    if (names?.size !== 1 || chatLinks.length) continue;
    const [name, evidence] = names.entries().next().value!;
    if (evidence.some(([at]) => rejected.has(at))) continue;
    const kind = evidence[0][1];
    if (R.WEAK_TITLE.fullmatch(raw) || kind === 'organization' || (same?.end === b && ['person', 'nickname'].includes(same.kind))) {
      accepted.push(hit(a, b, kind, '全文称呼', 101));
      targets.set(keyOf(a, b), [name, evidence.map(([at]) => at)]);
    }
  }
  return {targets, scope, extra: accepted, links};
}

const shortest = NAME.replace('{2,6}', '{2,6}?');
const nameClaims = [rule(`(?:登记|注册|开户)在(${NAME})名下`),
  rule(`[，,；;。](${shortest})(?:声称|称|说|自述)(?:曾经|曾|一直)?(?:实际)?使用`),
  rule(`(?:实际由|交由|委托)(${NAME})(?:实际)?(?:使用|代收|经办)`)];
export function namesInStatements(text: string) {
  return nameClaims.flatMap(pattern => [...pattern.finditer(text)].filter(match => hasSurname(match.group(1)!))
    .map(match => hit(...match.span(1), 'person', '关系中的姓名', 74)));
}

const nonWord = rule('\\W');
const legacyId = rule('\\d{15}');
const modernId = rule('\\d{17}[\\dX]');
export function identityEvidence(text: string, hits: Hit[]) {
  const result = new Map<string, string>();
  for (let i = 1; i < hits.length; i++) {
    const identifier = hits[i];
    const who = hits[i - 1];
    if (identifier.kind !== 'id_card' || identifier.priority < 85 || who.kind !== 'person' || who.priority < 65) continue;
    if (identifier.start - who.end > 30 || !R.LABEL_BEFORE_ID.fullmatch(slice(text, who.end, identifier.start))) continue;
    const value = nonWord.replace(translateWidth(slice(text, identifier.start, identifier.end)), '').toUpperCase();
    if (legacyId.fullmatch(value) || (modernId.fullmatch(value) && idChecksum(value))) result.set(keyOf(who.start, who.end), value);
  }
  return result;
}
