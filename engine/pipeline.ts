import { allSpans, answerNames, choose, definitions, identityEvidence, namesInStatements, type Relation } from './context.js';
import { PERSON_ALIAS } from './context-rules.js';
import { availableDisplay, displayBase, projectAreas } from './display.js';
import { NUMBER_KINDS, PERSON_VALUE, ROLE, TITLE } from './field-rules.js';
import { administrativeParts, genericOrganization, hit, languageRules, organizationValue, readFields, referenceLead,
  streetAddresses, typicalName, type Hit, type Layout, type Passage } from './fields.js';
import { localRooms, proseRooms } from './housing.js';
import { departmentEnd, locationBoundaries, parkingSites } from './locations.js';
import { GENERIC_OFFICE, independentForms, NUMBERED_TYPE, publicForms } from './organizations.js';
import { commonPlaces, completePhrases, namedUnitEnd, publishedOrganizationSpans, regionalBranchEnd } from './phrases.js';
import { idChecksum, translateWidth } from './numbers.js';
import { hasSurname } from './suspects.js';
import { bisect, char, keyOf, length, rule, slice, trim } from './text.js';

export const labels: Record<string, string> = {
  person: '人员', organization: '机构', address: '地址', id_card: '证件',
  mobile: '电话', bank_account: '账号', tail: '尾号', case_number: '案号',
  number: '号码', social: '社交账号', nickname: '昵称', email: '邮箱', uscc: '信用代码',
};

export type Action = 'replace' | 'keep' | 'review';
export type Decision = {
  start: number; end: number; original: string; type: string; reason: string; object: string | null;
  action: Action; replacement: string; name: string | null; definitions?: number[]; alias_display?: string;
};
export type Registered = {
  kind: string; value: string; identity?: string | null; replacement: string; scope?: string | null; areas?: Record<string, string>;
};
export type Registry = Record<string, Registered>;
type Allocation = {reserved?: Set<string>; areas?: Map<string, string>};
export type Scan = (text: string, free: Passage[], known: Hit[]) => Promise<Hit[]> | Hit[];
export type Plan = [rows: Decision[], objects: Registry, relations: Relation[]];

const personAction = rule('表示|同意|拒绝|承认|否认|签字|签署|随后|称|说');
const bodyPart = rule('(?:头|面|颈|肩|胸|背|腹|腿)部|手臂');
const personRole = rule('(?:被告人?|原告|上诉人|申请人|证人)[：:\\s]*$');
const villageLead = rule('(?:从|在|到|去|住|籍贯[：:]?|乡|镇|县)[ \\t]*$');
const villageTail = rule('村|人|其家|家(?:中|里)|出来|离开|出发|[，。；、！？\\s]|$');
const formalCompany = rule('(?:有限公司|有限责任公司|合伙企业(?:[（(][^）)]+[）)])?)$');
const facilityName = rule('(?:医院|大学|小学|中学|学院|法院|检察院|银行|支行|有限公司)$');
const genericPlace = rule('住处|家中|村里|小区|路口|店里|教室|大厅|停车场|停车库|车库');
const unnamedPerson = rule('[\\u3400-\\u9fff]{0,2}\\s*(?:某+|[Xx＊*×]{1,4})(?:\\s*[\\u3400-\\u9fff0-9]){0,2}');
const courtesyName = rule('[\\u3400-\\u9fff]{1,2}(?:先生|女士|小姐)');
const maskedTerm = rule('某{2,}|(?<=[\\u3400-\\u9fff])某(?=[甲乙丙丁\\u3400-\\u9fff]|$)|[＊*×]+|[Xx]{2,}'
  + '|(?<![A-Za-z])[Xx](?=[\\u3400-\\u9fff]|$)');
const maskedPlaceTail = rule('(?:某+|[Xx＊*×]+)(?:街道|镇|乡|村|路|街|巷|(?:精)?鉴字|(?:路)?口|号|楼|区|县)(?:[Xx＊*×]+)?');
const roleValue = rule('(?:[：:]|[ \\t]{2,})[ \\t]*$');
const identityDetail = rule('[，,]\\s*(?:男|女|[0-9]{2}岁|汉族|住址|住在|身份证|出生|系)');
const citationLead = '依照|根据|参照|依据|按照';
const citationIntro = rule('(?:' + citationLead + ')\\s*$');
const quotedTitle = rule('《[^》\\r\\n]+》');
const statuteTitle = rule('《(?:中华人民共和国)?[^》]{1,40}?(?:法|条例|规定|解释|办法|决定|意见|批复|公约)》');
const statuteArticle = rule('第[一二三四五六七八九十百千零〇0-9]+条');
const annualStandardTitle = '[\\u3400-\\u9fff]{2,12}?(?:省|自治区|市)[ \\t]*[12][0-9]{3}[ \\t]*年度?[ \\t]*[\\u3400-\\u9fff]{2,32}?标准';
const annualStandard = rule('(?:' + citationLead + '|适用|执行|以及|[和与及])[ \\t]*(' + annualStandardTitle + ')');
const annualTitle = rule('《' + annualStandardTitle + '》');
const workUnit = rule('(?:[\\u3400-\\u9fff]{2,16}?(?:管理局|监管局|知识产权局|人民法院|人民检察院|公安局|部|厅))'
  + '(?:[\\u3400-\\u9fff]{2,18}?(?:委员会|中心|部|司|局|处|科|室|所)){1,4}');
const identityStatement = rule('出生|民族|[一-鿿]{1,4}族|职务');
const identityFields = rule('[^，,。；;\\r\\n\\f]+');
const numberSeparators = rule('[\\s()（）－—-]');
const legacyId = rule('\\d{15}');
const completeMobile = rule('\\+\\d{8,15}|1[3-9]\\d{9}|0\\d{9,11}|[48]00\\d{7}');
const completeAccount = rule('\\d{8,22}');
export const validCode = rule('【[^【】\\r\\n]{1,40}】');
const namedKinds = new Set(['person', 'organization', 'address']);
const partyRoles = new Set(['申请人', '被申请人', '上诉人', '被上诉人', '被告人']);

const issuedTitle = rule("《(?<issuer>[^《》]{1,30}?(?:政府|委员会|法院|检察院|部|厅|局|办公室))关于[^《》]+的(?:通知|公告|通告)》");
const maskedBranch = rule("(?:某+|[×＊*Xx]+)(?:分行|支行|分公司|分院|分校)");
const plateLabel = rule("车牌(?:号码?)?[为是：: ]*$");
const maskedPlate = rule("[一-鿿][A-ZＡ-Ｚ][A-ZＡ-Ｚ0-9０-９×＊*]{4,7}");
const maskedOfficeTail = rule('(?:某+|[×＊*Xx]+)(?:局|委员会|人民政府|办公室|分局|' + NUMBERED_TYPE + '|高中|初中)');
const anonymousOrgStart = rule("(?:^|[，,。；;：:\\n]|申请人|原告|被告)[ \\t]*(?:某+|[×＊*]+)$");
const landUse = rule("(?:菜地|耕地|林地|宅基地)(?:上|里)?");
const motion = rule("(?:去到|前往|去|到|从|往|在)$");

function filterCandidates(text: string, predicted: Hit[], registeredOrgs: Set<string>) {
  const publicForm = independentForms(text);
  const modelSpans = new Set(predicted.map(item => keyOf(item.start, item.end, item.kind)));
  const organizations = predicted.filter(item => item.kind === 'organization');
  const maskedOrganizations = publishedOrganizationSpans(text);
  const anonymousBranches = new Set<string>();
  for (const {start, end} of organizations) {
    if (!maskedTerm.test(slice(text, start, end))) continue;
    maskedOrganizations.push([start, end]);
    const branchEnd = regionalBranchEnd(text, start, end);
    if (branchEnd > end) anonymousBranches.add(slice(text, start, branchEnd));
  }
  for (const [, start, end] of allSpans(text, anonymousBranches)) maskedOrganizations.push([start, end]);
  const titles = [...annualStandard.finditer(text)].map(match => match.span(1));
  for (const title of quotedTitle.finditer(text)) {
    const left = slice(text, Math.max(0, title.start() - 8), title.start());
    if (!statuteTitle.fullmatch(title.value) && !annualTitle.fullmatch(title.value)
        && !statuteArticle.match(trim(slice(text, title.end(), title.end() + 15), undefined, 'left'))) {
      const notice = issuedTitle.fullmatch(title.value);
      if (notice && citationIntro.search(left)) titles.push([title.start(), title.start() + notice.end('issuer')]);
      continue;
    }
    const prefix = organizations.find(item => item.end === title.start()
      && citationIntro.search(slice(text, Math.max(0, item.start - 8), item.start)));
    titles.push([prefix?.start ?? title.start(), title.end()]);
  }
  return (candidates: Hit[]) => candidates.flatMap(item => {
    const {start, end, kind, reason} = item;
    if (!namedKinds.has(kind) && kind !== 'nickname') return [item];
    const value = slice(text, start, end);
    if (/[\r\n\f]/u.test(value)) return [];
    if (!['全文称呼', '机构简称'].includes(reason) && !(kind === 'organization' && registeredOrgs.has(value))
        && (publicForm(start, end) || GENERIC_OFFICE.fullmatch(value))) return [];
    if ((kind === 'organization' || kind === 'address') && reason === 'Otter' && !registeredOrgs.has(value)
        && commonPlaces().has(value) && motion.search(slice(text, Math.max(0, start - 4), start))) return [];
    if (kind === 'person' && plateLabel.search(slice(text, Math.max(0, start - 10), start))
        && maskedPlate.fullmatch(value) && maskedTerm.test(value)) return [];
    if (kind === 'organization' && maskedBranch.match(text, end)
        && publicForms.has(value.replace(/股份有限公司$/u, ''))) return [];
    if ((kind === 'person' || kind === 'nickname')
        && (partyRoles.has(value) || ROLE.fullmatch(value) || unnamedPerson.fullmatch(value) || courtesyName.fullmatch(value))) return [];
    if (kind === 'organization' || kind === 'address') {
      if (genericOrganization.fullmatch(value) || referenceLead.match(value) || genericPlace.fullmatch(value)
          || titles.some(([a, b]) => a <= start && end <= b)
          || maskedOrganizations.some(([a, b]) => a <= start && end <= b)) return [];
      if (kind === 'organization' && (maskedTerm.test(value)
          || start && '某×＊*'.includes(char(text, start - 1))
          && anonymousOrgStart.search(slice(text, Math.max(0, start - 16), start)))) return [];
      if (kind === 'address' && (landUse.fullmatch(value) || maskedOfficeTail.match(text, end)
          || maskedPlaceTail.match(text, end) && !['住所中的已知地域', '遮名道路中的地域'].includes(reason)
          || maskedTerm.test(value) && !/\d+(?:号|室|栋)/u.test(value))) return [];
    }
    const modelAgreement = modelSpans.has(keyOf(start, end, kind));
    if (reason === 'org_suffix' && !modelAgreement && !(organizationValue(value) && formalCompany.search(value))) return [];
    if (reason === 'role_anchored' && !modelAgreement && !(typicalName(value)
        && (roleValue.search(slice(text, Math.max(0, start - 6), start)) || identityDetail.match(text, end)))) return [];
    if (kind === 'address' && reason === 'Otter' && facilityName.search(value) && organizationValue(value)) {
      return [{...item, kind: 'organization', reason: '具名机构用作地点'}];
    }
    return [item];
  });
}

function documentOccurrences(text: string, hits: Hit[], layout: Layout) {
  const sections = [...new Set(layout.sections)].sort((a, b) => a - b);
  const scope = (at: number) => bisect(sections, at, true);
  const names = new Set<string>();
  const knownPeople = new Set<string>();
  const organizations = new Map<string, Set<number>>();
  const villages = new Set<string>();
  for (const item of hits) {
    const raw = slice(text, item.start, item.end);
    if (item.kind === 'person') {
      names.add(raw);
      if (item.priority >= 65) knownPeople.add(raw);
    } else if (item.kind === 'organization' && (item.priority >= 65 || organizationValue(raw))) {
      if (!organizations.has(raw)) organizations.set(raw, new Set());
      organizations.get(raw)!.add(scope(item.start));
    } else if (item.kind === 'address') {
      for (const [stem, suffix] of administrativeParts(raw)) {
        if (suffix !== '村' || length(stem) < 2) continue;
        villages.add(stem);
        villages.add(stem + suffix);
      }
    }
  }
  const positions = hits.map(item => item.start);
  const extra: Hit[] = [];
  for (const [raw, start, end] of allSpans(text, [...names, ...organizations.keys(), ...villages])) {
    const prior = hits[bisect(positions, start, true) - 1];
    const current = prior && start < prior.end ? prior : undefined;
    const left = slice(text, Math.max(0, start - 24), start);
    if (knownPeople.has(raw) && current?.kind === 'organization' && current.start === start && current.end === end
        && current.priority < 65 && (personRole.search(left) || personAction.match(text, end))) {
      extra.push(hit(start, end, 'person', '全文登记姓名与人物陈述', 74));
    } else if (organizations.get(raw)?.has(scope(start))
        && !(current?.kind === 'organization' && end < current.end)) {
      const department = /(?:政府|局|委员会|法院)$/u.test(raw) ? departmentEnd(text, end) : end;
      const stop = Math.max(department, namedUnitEnd(text, start, end));
      extra.push(hit(start, stop, 'organization', stop > end ? '全称与直属部门' : '全文全称', stop > end ? 96 : 62));
    } else if (villages.has(raw) && villageTail.match(text, end)
        && !(current?.kind === 'address' && end <= current.end)
        && (villageLead.search(left) || ['人', '其家'].some(tail => slice(text, end, end + 2).startsWith(tail)))) {
      extra.push(hit(start, end, 'address', '全文村名', 66));
    } else if (names.has(raw)) {
      if (current?.kind === 'person' && current.start === start && current.end < end && hasSurname(raw)
          && (knownPeople.has(raw) || personRole.search(left))) {
        extra.push(hit(start, end, 'person', '全文姓名边界', 74));
      } else if (knownPeople.has(raw) &&
          ((start === 0 || '\r\n。！？；，：:'.includes(char(text, start - 1))) && personAction.match(text, end)
           || bodyPart.match(text, end)
           || [...PERSON_ALIAS.finditer(left)].some(item => item.end() === length(left)))) {
        extra.push(hit(start, end, 'person', '全文姓名', 64));
      } else if (current?.kind === 'person' && current.reason === 'Otter'
          && end <= current.end && (start !== current.start || end !== current.end)
          && ['', '的', '吗', '呢'].includes(slice(text, end, current.end))
          && ['', '由', '让', '将', '给'].includes(slice(text, current.start, start))) {
        extra.push(hit(start, end, 'person', '全文姓名边界', 61));
      }
    }
  }
  return extra;
}

export function normalized(kind: string, value: string) {
  if (kind === 'address') {
    return translateWidth(value)
      .replace(/(?<![零〇一二两三四五六七八九十百千万])([一二两三四五六七八九])(?=[ \t]*(?:楼|层))/gu,
        digit => digit === '两' ? '2' : String('一二三四五六七八九'.indexOf(digit) + 1))
      .replaceAll('（', '(').replaceAll('）', ')')
      .replace(/(?<=市|省|县|区)[，,](?=[\u3400-\u9fff])/g, '')
      .replace(/(?<=[\u3400-\u9fff])[ \t　]+|[ \t　]+(?=[\u3400-\u9fff])/g, '');
  }
  if (NUMBER_KINDS.has(kind)) {
    const digits = numberSeparators.replace(translateWidth(value), '').toUpperCase();
    return kind === 'mobile' && digits.startsWith('00') && length(digits) > 6 ? '+' + slice(digits, 2) : digits;
  }
  if (kind === 'case_number') {
    return translateWidth(value).replaceAll('（', '(').replaceAll('）', ')').replace(/[ \t]/gu, '');
  }
  if (kind === 'uscc') return value.replace(/\s/gu, '').toUpperCase();
  return value;
}

export function completeNumber(kind: string, raw: string, reason: string) {
  if (kind === 'tail' || kind === 'number' || reason === '分机') return false;
  const value = normalized(kind, raw);
  if (kind === 'id_card') return !!legacyId.fullmatch(value) || idChecksum(value);
  if (kind === 'mobile') return !!completeMobile.fullmatch(value);
  return !!completeAccount.fullmatch(value);
}

class Objects {
  readonly records: Registry;
  readonly names: Map<string, string>;
  private readonly used: Set<string>;
  private readonly areas: Map<string, string>;
  private readonly keys = new Map<string, string>();
  private nextId: number;

  constructor(registry: Registry, displays: Record<string, string>, private text: string, private document: string,
    allocation: Allocation) {
    this.records = Object.fromEntries(Object.entries(registry).map(([key, item]) => [key, {...item}]));
    this.names = new Map(Object.entries(displays));
    this.nextId = Math.max(0, ...Object.keys(this.records).map(Number)) + 1;
    for (const [key, item] of Object.entries(this.records)) {
      if (item.kind === 'person' && !this.names.has(item.value)) this.names.set(item.value, item.replacement);
      const lookup = keyOf(item.kind, normalized(item.kind, item.value), item.identity ?? null, item.scope ?? null);
      if (!this.keys.has(lookup)) this.keys.set(lookup, key);
    }
    this.areas = allocation.areas ? new Map(allocation.areas) : projectAreas(Object.values(this.records));
    this.used = new Set([...(allocation.reserved ?? []), ...Object.values(this.records).map(item => item.replacement), ...this.names.values()]);
  }

  allocate(kind: string, value: string, parts = new Map<string, string>()) {
    const [base, first] = displayBase(kind, value, labels[kind], this.areas, parts);
    const code = availableDisplay(base, first, this.used, this.text);
    this.used.add(code);
    return code;
  }

  name(value: string) {
    if (!this.names.has(value)) this.names.set(value, this.allocate('person', value));
    return this.names.get(value)!;
  }

  get(kind: string, raw: string, identity: string | null = null, section: number | string | null = null) {
    const value = normalized(kind, raw);
    const scope = section === null ? null : section === 0 ? this.document : `${this.document}/${section}`;
    const key = keyOf(kind, value, identity, scope);
    if (!this.keys.has(key)) {
      const id = String(this.nextId++);
      const parts = new Map<string, string>();
      const replacement = kind === 'person' ? this.name(value) : this.allocate(kind, value, parts);
      this.records[id] = {kind, value, identity, replacement, scope,
        ...(parts.size ? {areas: Object.fromEntries(parts)} : {})};
      this.keys.set(key, id);
    }
    return this.keys.get(key)!;
  }
}

export async function buildPlan(text: string, registry: Registry = {}, scan?: Scan, doc = '',
  displays: Record<string, string> = {}, layout = readFields(text), allocation: Allocation = {}): Promise<Plan> {
  const tentative = scan ? layout.hits.filter(item => item.needs_context) : [];
  const rules = layout.hits.filter(item => item.kind !== 'signature'
    && (!item.needs_context || !scan && item.kind !== 'organization'));
  rules.push(...streetAddresses(text), ...answerNames(text, layout));
  const narrative = [...text];
  for (const [message, [start]] of layout.speakers) narrative.fill(' ', start, message);
  let language = [...languageRules(narrative.join('')), ...namesInStatements(text)];
  const predicted = scan ? await scan(text, layout.free, rules) : [];
  const known = new Set(rules.filter(item => namedKinds.has(item.kind) && item.priority >= 95)
    .map(item => keyOf(item.kind, slice(text, item.start, item.end))));
  for (const item of Object.values(registry)) {
    if (namedKinds.has(item.kind)) known.add(keyOf(item.kind, item.value));
  }
  for (const name of Object.keys(displays)) known.add(keyOf('person', name));
  if (tentative.length) {
    const fieldSpans = new Set(tentative.map(item => keyOf(item.start, item.end)));
    language = language.filter(item => !fieldSpans.has(keyOf(item.start, item.end)) ||
      !['role_anchored', 'labeled_person'].includes(item.reason));
    const recognized = new Set(predicted.map(item => keyOf(item.start, item.end, item.kind)));
    const confirmed = tentative.filter(item => recognized.has(keyOf(item.start, item.end, item.kind)) ||
      known.has(keyOf(item.kind, slice(text, item.start, item.end))));
    rules.push(...confirmed);
    for (const item of confirmed) known.add(keyOf(item.kind, slice(text, item.start, item.end)));
  }

  const boundaries = locationBoundaries(text, predicted, language, rules);
  boundaries.push(...completePhrases(text, predicted, rules, boundaries, language), ...parkingSites(text, layout.free));
  for (const {start, end} of layout.free) {
    const passage = slice(text, start, end);
    for (const [a, b] of proseRooms(passage)) boundaries.push(hit(start + a, start + b, 'address', '正文楼室结构', 65));
    for (const [a, b] of localRooms(passage)) boundaries.push(hit(start + a, start + b, 'address', '正文独立室号', 59));
  }
  for (const reply of layout.courtReplies) {
    if (!identityStatement.search(text, reply.start, reply.end)) continue;
    for (const field of identityFields.finditer(text, reply.start, reply.end)) {
      const value = trim(field.value);
      if (!workUnit.fullmatch(value)) continue;
      const start = field.start() + length(field.value) - length(trim(field.value, undefined, 'left'));
      boundaries.push(hit(start, start + length(value), 'organization', '身份陈述中的工作单位', 92));
    }
  }
  const personEnds = new Map(predicted.filter(item => item.kind === 'person').map(item => [item.start, item.end]));
  for (const slot of layout.hits) {
    if (slot.kind !== 'signature') continue;
    const raw = slice(text, slot.start, slot.end);
    const stop = personEnds.get(slot.start) ?? 0;
    if (known.has(keyOf('person', raw))) rules.push(hit(slot.start, slot.end, 'person', '签名栏已登记姓名', 100));
    else if (slot.end < stop && stop <= (slot.value_limit || slot.end)) {
      rules.push(hit(slot.start, slot.end, 'person', '模型人名截至签署动作', 61));
    } else if (!scan && typicalName(raw)) {
      rules.push(hit(slot.start, slot.end, 'person', '纯规则签名', 58));
    }
  }
  language = language.map(item => {
    const stop = personEnds.get(item.start);
    return item.kind === 'person' && stop && stop < item.end && ['说', '称', '表示'].includes(slice(text, stop, item.end))
      ? hit(item.start, stop, item.kind, item.reason, item.priority) : item;
  });

  const registeredOrgs = new Set(Object.values(registry).filter(item => item.kind === 'organization').map(item => item.value));
  const eligible = filterCandidates(text, predicted, registeredOrgs);
  const candidates = eligible([...rules, ...language, ...predicted, ...boundaries]);
  let hits = choose(candidates);
  const completion = eligible(documentOccurrences(text, hits, layout));
  if (completion.length) {
    candidates.push(...completion);
    hits = choose(candidates);
  }
  const {targets, scope, extra, links} = definitions(text, hits, layout);
  const people = new Set(hits.filter(item => item.kind === 'person').map(item => slice(text, item.start, item.end)));
  const chosen = choose([...candidates, ...eligible(extra)]);
  const evidence = identityEvidence(text, chosen);
  const objects = new Objects(registry, displays, text, doc, allocation);
  const direct = new Map(links.map(link => [keyOf(link.start, link.end), link]));
  const resolved = chosen.flatMap(item => {
    if (item.kind === 'keep') return [];
    const {start, end, reason} = item;
    const raw = slice(text, start, end);
    const key = keyOf(start, end);
    let kind = item.kind;
    let target = reason === '裁判署名' ? raw.replace(/\s/gu, '') : raw;
    const link = direct.get(key);
    if (kind === 'person' || kind === 'organization') {
      if (link && link.type !== '聊天昵称') target = link.name!;
      else if (reason === '全文称呼') target = targets.get(key)![0];
    }
    if (kind === 'nickname' && ['发言者', '通话方'].includes(reason) && PERSON_VALUE.fullmatch(raw) &&
        (objects.names.has(raw) || people.has(raw))) kind = 'person';
    return [{item, kind, target, link}];
  });
  for (const {kind, target, link} of resolved) {
    if (kind === 'person') objects.name(target);
    else if (kind === 'nickname' && link && ['聊天昵称', '曾用名'].includes(link.type)) objects.name(link.name!);
  }
  const rows: Decision[] = [];
  for (const {item: {start, end, reason, priority}, kind, target, link} of resolved) {
    const key = keyOf(start, end);
    const raw = slice(text, start, end);
    let object: string | null;
    let replacement: string;
    if (kind === 'person') {
      replacement = objects.name(target);
      const identity = evidence.get(key);
      object = identity ? objects.get(kind, target, identity) : null;
    } else {
      let section: string | number | null = kind === 'nickname' ? scope(start) : null;
      if (kind === 'nickname' && link) section = `${scope(start)}/${link.type}/${link.name}`;
      if (NUMBER_KINDS.has(kind) && !completeNumber(kind, raw, reason)) section = `${scope(start)}@${start}`;
      object = objects.get(kind, target, null, section);
      replacement = objects.records[object].replacement;
      if (kind === 'nickname' && link && ['聊天昵称', '曾用名'].includes(link.type) && replacement.startsWith('【昵称')) {
        const person = objects.name(link.name!).slice(1, -1);
        const label = link.type === '聊天昵称' ? '微信昵称' : '曾用名';
        replacement = `【${person}-${label}${replacement.slice(3, -1)}】`;
        objects.records[object].replacement = replacement;
      }
    }
    const row: Decision = {start, end, original: raw, type: kind, reason, object,
      action: priority === 54 ? 'review' : 'replace', replacement, name: kind === 'person' ? target : null};
    if (reason === '全文称呼' || link) {
      row.definitions = targets.get(key)?.[1] ?? [start];
      row.alias_display = replacement;
    }
    rows.push(row);
  }
  const relations = [...links];
  for (let i = 1; i < chosen.length; i++) {
    const who = chosen[i - 1];
    const card = chosen[i];
    if (card.kind === 'id_card' && evidence.has(keyOf(who.start, who.end))) {
      relations.push({type: '证件', subject_start: who.start, object_start: card.start, start: who.start, end: card.end});
    }
  }

  const used = new Set(rows.map(row => row.object));
  return [rows, Object.fromEntries(Object.entries(objects.records).filter(([key]) => used.has(key))), relations];
}

export function render<Row extends Decision>(text: string, decisions: Row[], preview = false) {
  const chunks: string[] = [];
  const replacements: Array<Row & {output_start: number; output_end: number}> = [];
  let cursor = 0;
  let output = 0;
  const end = length(text);
  for (const row of [...decisions].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const {start, end: stop, action} = row;
    const original = slice(text, start, stop);
    if (cursor > start || start >= stop || stop > end || original !== row.original) {
      throw new Error(`复核区间重叠、越界或原值不符：${start}–${stop}`);
    }
    if (!['replace', 'keep', 'review'].includes(action)) throw new Error(`未知复核决定：${action}`);
    if (action === 'review' && !preview) throw new Error(`还有待核位置：${start}–${stop}。请在复核 JSON 或本地页面中处理。`);
    let value = row.replacement;
    if (action === 'replace') {
      if (!value || !validCode.fullmatch(value) || value === original) {
        throw new Error(`替换须使用有效的【代号】：${start}–${stop}`);
      }
    } else value = action === 'review' ? '【待核】' : original;
    chunks.push(slice(text, cursor, start), value);
    output += start - cursor;
    const outputEnd = output + length(value);
    if (action === 'replace') replacements.push({...row, output_start: output, output_end: outputEnd});
    cursor = stop;
    output = outputEnd;
  }
  chunks.push(slice(text, cursor));
  return {output: chunks.join(''), replacements};
}

export function reviewDecisions<Row extends Decision>(text: string, relations: Relation[], input: Row[]) {
  const rows = input.map(row => ({...row}));
  const at = new Map(rows.filter(row => row.action === 'replace').map(row => [row.start, row]));
  const links: Relation[] = [];
  const supported = new Set<number>();
  for (const link of relations) {
    const subject = at.get(link.subject_start);
    const alias = at.get(link.object_start);
    if (!subject || !alias) continue;
    if (link.type === '证件') {
      if (subject.object && alias.type === 'id_card') links.push(link);
      continue;
    }
    if (!link.name || subject.original !== link.name || alias.original !== link.value) continue;
    let consistent = subject.replacement === alias.replacement;
    if (link.type === '聊天昵称' || link.type === '曾用名') {
      const label = link.type === '聊天昵称' ? '微信昵称' : '曾用名';
      consistent = alias.replacement.startsWith(subject.replacement.slice(0, -1) + '-' + label);
    }
    if (consistent) {
      supported.add(link.start);
      links.push(link);
    }
  }
  const used = new Set(rows.map(row => row.replacement));
  const independent = new Map<string, string>();
  const independentPeople = new Map(rows.filter(row => row.type === 'person' && row.action === 'replace' && !row.definitions?.length)
    .map(row => [row.name || row.original, row.replacement]));
  for (const row of rows) {
    const evidence = row.definitions;
    if (!evidence?.length || evidence.some(value => supported.has(value))) continue;
    const proposed = row.alias_display;
    delete row.definitions;
    delete row.alias_display;
    row.object = null;
    row.name = row.type === 'person' ? row.original : null;
    if (row.action !== 'replace' || row.replacement !== proposed) continue;
    if (TITLE.fullmatch(row.original)) {
      row.action = 'keep';
      row.reason = '称呼归属未确认';
      continue;
    }
    const key = row.type === 'person' ? row.original : keyOf(evidence, row.original);
    const allocations = row.type === 'person' ? independentPeople : independent;
    if (!allocations.has(key)) {
      const [base, first] = displayBase(row.type, row.original, labels[row.type]);
      const code = availableDisplay(base, first, used, text);
      allocations.set(key, code);
      used.add(code);
    }
    row.replacement = allocations.get(key)!;
    row.reason = '按出现位置独立遮盖';
  }
  return {rows, links};
}

export type SourceValue = Pick<Hit, 'start' | 'end' | 'kind'>;

export function sourceValues(layout: Layout): SourceValue[] {
  return choose(layout.hits).filter(item => item.priority >= 86 &&
    (NUMBER_KINDS.has(item.kind) || ['case_number', 'social', 'email', 'uscc'].includes(item.kind)))
    .map(({start, end, kind}) => ({start, end, kind}));
}

export function checkSourceValues(text: string, rows: Decision[], numbers: SourceValue[]) {
  const ordered = [...rows].sort((a, b) => a.start - b.start);
  let index = 0;
  for (const value of numbers) {
    let cursor = value.start;
    while (index < ordered.length && ordered[index].end <= cursor) index++;
    let next = index;
    while (next < ordered.length && ordered[next].start < value.end) {
      if (trim(slice(text, cursor, ordered[next].start), ' \t　-－—()（）')) break;
      cursor = Math.max(cursor, ordered[next++].end);
    }
    if (cursor < value.end && trim(slice(text, cursor, value.end), ' \t　-－—()（）')) {
      throw new Error(`原文 ${value.start}–${value.end} 的${labels[value.kind]}仍有未处理部分。请补选范围或明确保留。`);
    }
  }
}
