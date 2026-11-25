import { ADDRESS_BREAK, ADDRESS_DETAIL, NOTE } from './field-rules.js';
import { addressComponentEnd, deliveryEnd, hit, type Hit } from './fields.js';
import * as R from './location-rules.js';
import { bisect, indexOf, length, rule, slice, startsAny, trim } from './text.js';

const levelOf = (suffix: string) => R.ADMIN_LEVEL[suffix as keyof typeof R.ADMIN_LEVEL];
const noteItems = rule('[^，,、；;]+');
const separatesPlace = (text: string, end: number) => R.PLACE_SEPARATOR.match(slice(text, end, end + 4));
const locationStart = rule('(?:位于|居住(?:的|于)|住在|到达|从|在|到了?|去)(?:[本该](?:区|县|市|镇|村))?');
const locationEnd = rule('[，,。；;！？!?、\\r\\n\\f]|$');
const locatedSite = rule('(?:市场|停车场|车库|\\d号|\\d室|大厦)$');
const roomInProse = rule('(?<![0-9A-Za-z])\\d{1,6}(?:室|房)(?!间)');
const roomContext = rule('(?:楼|层|的|在|至|到|进|从|往|是)\\s*$');
const formalOffice = rule('(?:^|[，,。；;：:\\r\\n])([\\u3400-\\u9fff]{2,8}?(?:市|区|县)'
  + '(?:(?:人民)?法院|公安局(?:交通警察|刑事侦查)?支队(?:[\\u3400-\\u9fff]{2,5}大队)?))'
  + '(?=受理|审理|判决|裁定|作出|出具|认定|发出|[，,。；;：:\\r\\n]|$)');

function nearbySite(text: string, start: number, level = -1) {
  const cap = Math.min(length(text), start + 64);
  const limit = locationEnd.search(text, start, cap)?.start() ?? cap;
  const end = addressComponentEnd(text, start, limit, level);
  return end > start && locatedSite.search(slice(text, start, end)) ? end : start;
}

function addressEnd(text: string, place: Hit, positions: number[]) {
  const admin = R.ADMIN_END.search(slice(text, place.start, place.end));
  if (!admin) return place.end;
  let {end} = place;
  let level = levelOf(admin.value);
  while (!separatesPlace(text, end)) {
    const part = R.ADMIN_PART.match(text, end);
    if (!part || levelOf(part.group(2)!) <= level) break;
    const following = bisect(positions, end, true);
    const anchored = following > 0 && positions[following - 1] === end;
    if (!anchored && length(part.group(1)!) > 3) break;
    if (following < positions.length && positions[following] < part.end()) break;
    end = part.end();
    level = levelOf(part.group(2)!);
  }
  const site = separatesPlace(text, end) ? null : R.ADDRESS_SITE.match(text, end);
  const following = bisect(positions, end, true);
  if (site && (following === positions.length || positions[following] >= site.end())) return site.end();
  return R.ADDRESS_EDGE.match(text, end) ? end : place.end;
}

export function locationBoundaries(text: string, predicted: Hit[], language: Hit[], fields: Hit[]) {
  const places = new Map(predicted.filter(item => item.kind === 'address').map(item => [item.start, item]));
  const positions = [...places.keys()].sort((a, b) => a - b);
  const preceding = new Map([...places.values()].map(item => [item.end, item]));
  const organizations = predicted.filter(item => item.kind === 'organization');
  const result: Hit[] = [];
  for (const lead of locationStart.finditer(text)) {
    const start = lead.end();
    if (!R.ADMIN_PART.match(text, start)) continue;
    const end = nearbySite(text, start);
    if (end > start) result.push(hit(start, end, 'address', '定位语境中的完整地点', 87));
  }
  for (const room of roomInProse.finditer(text)) {
    if (roomContext.search(slice(text, Math.max(0, room.start() - 5), room.start()))) {
      result.push(hit(...room.span(), 'address', '叙述中的房室', 63));
    }
  }
  for (const office of formalOffice.finditer(text)) {
    result.push(hit(...office.span(1), 'organization', '行政地名与机关全称', 68));
  }
  for (const field of fields) {
    if (field.kind !== 'address' || field.value_limit === null) continue;
    for (const at of positions.slice(bisect(positions, field.start), bisect(positions, field.end, true))) {
      const place = places.get(at)!;
      if (field.end < place.end && place.end <= field.value_limit &&
          !ADDRESS_BREAK.search(text, field.end, place.end)) {
        result.push(hit(field.start, place.end, 'address', field.reason, field.priority));
      }
    }
  }
  for (const place of places.values()) {
    const value = slice(text, place.start, place.end);
    const admin = R.ADMIN_END.search(value);
    if (admin) {
      const end = nearbySite(text, place.end, levelOf(admin.value));
      if (end > place.end) result.push(hit(place.start, end, 'address', '地点后的具名场所或门牌', 87));
    }
    if (R.DELIVERY_SITE_END.search(value)) {
      const full = deliveryEnd(text, place.end, length(text));
      if (full > place.end) result.push(hit(place.start, full, 'address', '地点后的门牌楼室', 86));
    }
    const end = addressEnd(text, place, positions);
    if (end > place.end) result.push(hit(place.start, end, 'address', '连续行政区划或道路地点', 67));

    const office = R.PUBLIC_OFFICE.match(text, place.end);
    if (office) result.push(hit(place.start, office.end(), 'organization', '地名与机关全称', 68));
    const join = R.GEO_JOIN.match(text, place.end);
    const following = join && places.get(join.end());
    const court = following && R.PUBLIC_OFFICE.match(text, following.end);
    if (court) result.push(hit(place.start, court.end(), 'organization', '地名与法院全称', 69));
    const definition = separatesPlace(text, place.end) ? null : R.COMPANY_DEFINITION.match(text, place.end);
    if (definition && !organizations.some(item => place.end <= item.start && item.start < definition.end())) {
      result.push(hit(place.start, definition.end(), 'organization', '公司简称前的全称', 68));
    }
  }
  for (const match of R.JUDICIAL_COMMITTEE.finditer(text)) {
    result.push(hit(...match.span(), 'organization', '法定机关委员会', 68));
  }
  for (const match of R.NAMED_PLATFORM.finditer(text)) {
    const value = match.group(1)!;
    if (!R.GENERIC_PLATFORM.has(value) && !value.includes('的') &&
      !startsAny(value, ['某', '该', '本', '我', '其', '你'])) {
      result.push(hit(...match.span(1), 'organization', '具名平台', 66));
    }
  }

  for (const item of [...language, ...predicted]) {
    if (item.kind !== 'organization') continue;
    const value = slice(text, item.start, item.end);
    const formal = R.FORMAL_COMPANY.search(value);
    if (item.reason === 'org_suffix' && formal) {
      const left = slice(text, Math.max(0, item.start - 10), item.start);
      const conflicting = predicted.some(other => other.start < item.end && item.start < other.end &&
        (other.kind === 'person' || (other.kind === 'organization' && (other.start !== item.start || other.end > item.end))));
      if (R.PARTY_LEAD.search(left) && !conflicting) {
        result.push(hit(item.start, item.end, 'organization', '诉讼角色后的公司全称', 68));
      }
    }
    if (item.reason !== 'Otter') continue;
    if (R.BRANCH.search(value) && language.some(inner => inner.kind === 'organization' &&
      inner.start === item.start && inner.end < item.end && R.PARENT_ORG.search(slice(text, inner.start, inner.end)))) {
      result.push(hit(item.start, item.end, 'organization', '机构全称含分支', 68));
    }
    const branch = places.get(item.end);
    if (formal && branch && slice(text, branch.end, branch.end + 1) === '店') {
      const area = preceding.get(item.start);
      const start = area && R.ADMIN_END.search(slice(text, area.start, area.end)) ? area.start : item.start;
      result.push(hit(start, branch.end + 1, 'organization', '公司与门店全称', 69));
    }
  }
  for (const place of [...fields, ...places.values(), ...result]) {
    if (place.kind !== 'address') continue;
    const note = NOTE.match(text, place.end);
    if (!note) continue;
    if (ADDRESS_DETAIL.fullmatch(trim(note.group(1)!))) {
      result.push(hit(place.start, note.end(), 'address', place.reason, place.priority));
    } else {
      for (const item of noteItems.finditer(note.group(1)!)) {
        const value = trim(item.value);
        if (ADDRESS_DETAIL.fullmatch(value)) {
          const start = note.start(1) + item.start() + indexOf(item.value, value);
          result.push(hit(start, start + length(value), 'address', '括号内楼室', place.priority));
        }
      }
    }
  }
  return result;
}
