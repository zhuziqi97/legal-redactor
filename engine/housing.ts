import { char, digits, rule, slice, type Span } from './text.js';

const gap = '[ \\t　]*';
const buildingUnit = `(?:号${gap})?(?:楼|栋|幢|座|单元)`;
const addressUnit = String.raw`(?:[0-9A-Za-z]+[ \t]*(?:${buildingUnit}|层|室|房)|\d+(?:[-－]\d+)?号|\d+#楼)`;
export const addressComponent = `(?:${addressUnit}|[零〇一二两三四五六七八九十百]+(?:${buildingUnit}|层|室)|[东西南北中](?:区|楼|栋|座|单元))`;

export const roomIdentifier = `(?=[A-Za-z0-9东西南北-]{1,12}${gap}(?:室|房))(?=[A-Za-z东西南北-]*[0-9])`
  + `[A-Za-z0-9东西南北-]+${gap}(?:室|房(?!屋|间))`;
const housingIndex = '(?:[A-Za-z]?\\d+(?:[-－]\\d+)?|[A-Za-z]|[东西南北中甲乙丙丁]|[零〇一二两三四五六七八九十百壹贰叁肆伍陆柒捌玖拾佰]+)';
const levelIndex = `(?:第${gap})?${housingIndex}${gap}`;
const numberedLevel = `${levelIndex}(?:号${gap})?`;
const doorNumber = String.raw`\d+(?:[-－]\d+)?${gap}号(?!${gap}(?:楼|栋|幢|座|单元))(?:${gap}房(?!屋|间|产))?`;
const building = rule(`${numberedLevel}(?:栋|幢|座)|${levelIndex}号${gap}楼`);
const unit = rule(`${numberedLevel}单元`);
const floor = rule(`(?:地下)?${levelIndex}(?:楼|层)`);
const dwelling = rule(`${roomIdentifier}|${doorNumber}|[东西南北中]户`);
const housingParts = [building, unit, floor, dwelling];
const bareRoom = rule(String.raw`${gap}\d{1,6}(?:[-－]\d+)?(?:${gap}[东西南北](?=的|户|[，,。；;）)]|$))?`
  + '(?=$|[，,。；;（）()\\r\\n]|房屋|的)');
const housingStart = rule(`(?<![0-9A-Za-z])${levelIndex}(?:${buildingUnit}|层)`);
const maskedBuilding = rule('[×＊*Xx某]+(?:号楼|栋|幢|座)');
const maskedRoom = rule('[×＊*Xx某]+(?:室|号)');
const listRoom = rule('(?<![A-Za-z0-9])(?:[A-Za-z]?\\d{2,6}(?:[-－]\\d+)?)[ \\t　]*室');
const roomJoin = rule('[ \\t　]*(?:、|及|与|和|以及)[ \\t　]*');
const sharedRoomNumber = rule('[A-Za-z]?\\d{2,6}(?:[-－]\\d+)?');
const sharedRoomList = rule(`(?:${sharedRoomNumber.pattern}${roomJoin.pattern})+${listRoom.pattern}`);
const roomListStart = rule('(?:房号(?:分别)?[为是：:]?|住在|搬入|到达|进入|交付|单元|楼层)[ \\t　]*');
export const layoutCount = rule('[零一二两三四五六七八九十\\d]+厅');
const roomNumber = '(?:[0-9]{1,3}[-－]){0,2}[A-Za-z]?[0-9]{2,6}';
const labeledRoom = rule(`(?:房号|室号|房间号)${gap}(?:为|是|[：:])?${gap}`
  + String.raw`(?<value>${roomNumber}(?:${gap}室)?)(?=$|[，,。；;、）)\s]|的)`);
const numberedRoom = rule(`(?<![0-9A-Za-z－.-])(?:[东西南北中]户)?${roomNumber}${gap}室`);
const roomLead = rule('(?:单元|楼上|楼下|楼层|住在?|房间|入住|门牌)[ \\t　]*$');
const roomUse = rule('(?:的)?(?:业主|住户|房屋|住客)');
const roomCount = rule('(?:共有?|合计|总计|计有)[ \\t　]*$');
export const propertyCode = rule('\\d{1,3}[-－]\\d{1,3}[-－]\\d{2,5}');
const roomCodeEdge = rule('$|[\\s，,。；;、（）()]|房屋|的|室');
const dwellingEvidence = rule(String.raw`单元|\d+${gap}(?:号(?!楼)|室|房)|[东西南北中]户`);

export function housingEnd(text: string, start: number, anchored = true) {
  const code = anchored ? propertyCode.match(text, start) : undefined;
  if (code && roomCodeEdge.match(text, code.end())) {
    return code.end() + Number(char(text, code.end()) === '室');
  }
  let position = start;
  let end = start;
  let count = 0;
  let last = -1;
  for (const [index, part] of housingParts.entries()) {
    while (count && /[ \t　]/u.test(char(text, position))) position++;
    const match = part.match(text, position);
    if (!match) continue;
    end = position = match.end();
    last = index;
    count++;
  }
  if (last === 1 || last === 2) {
    const bare = bareRoom.match(text, end);
    if (bare) return bare.end();
    const list = sharedRoomList.match(text, position);
    if (list) return sharedRoomNumber.match(text, position)!.end();
  }
  return count >= 2 || anchored && last === 3 ? end : start;
}

export function* localRooms(text: string): Iterable<Span> {
  const roomsInUse = new Set<string>();
  for (const field of labeledRoom.finditer(text)) {
    yield field.span('value');
    roomsInUse.add(field.group('value')!);
  }
  const mentions = [...numberedRoom.finditer(text)].filter(room =>
    !layoutCount.match(text, room.end()) && !roomCount.search(slice(text, Math.max(0, room.start() - 6), room.start())));
  for (const room of mentions) {
    if (roomLead.search(slice(text, Math.max(0, room.start() - 12), room.start()))
        || roomUse.match(text, room.end()) || propertyCode.match(room.value) || char(room.value, 1) === '户') {
      roomsInUse.add(room.value);
    }
  }
  for (const room of mentions) if (roomsInUse.has(room.value)) yield room.span();
}

export function* proseRooms(text: string): Iterable<Span> {
  let end = 0;
  for (const start of housingStart.finditer(text)) {
    if (start.start() < end || /^[Xx]/u.test(start.value) && maskedBuilding.fullmatch(start.value)) continue;
    end = housingEnd(text, start.start(), false);
    const detail = slice(text, start.end(), end);
    if (end > start.start() && (dwellingEvidence.search(detail)
        || start.value.endsWith('单元') && [...detail].some(digits)) && !layoutCount.match(text, end)) {
      yield [start.start(), end];
    }
  }
  for (const masked of maskedBuilding.finditer(text)) {
    const visibleUnit = unit.match(text, masked.end());
    if (visibleUnit && maskedRoom.match(text, visibleUnit.end())) yield visibleUnit.span();
  }
  const rooms = [...listRoom.finditer(text)];
  for (const [index, room] of rooms.entries()) {
    const previous = rooms[index - 1];
    const next = rooms[index + 1];
    if (previous && roomJoin.fullmatch(text, previous.end(), room.start())
        || next && roomJoin.fullmatch(text, room.end(), next.start())) yield room.span();
  }
  for (const lead of roomListStart.finditer(text)) {
    const list = sharedRoomList.match(text, lead.end());
    if (!list) continue;
    for (const value of sharedRoomNumber.finditer(text, list.start(), list.end())) {
      yield [value.start(), slice(text, value.end(), list.end()).trim() === '室' ? list.end() : value.end()];
    }
  }
}
