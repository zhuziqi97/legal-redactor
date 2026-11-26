import type { Group, Occurrence } from './model';

const searchText = (value: string) => value.trim().toLowerCase();
const withoutBrackets = (value: string) => value.replace(/^【(.*)】$/u, '$1');

export function matchMapping(group: Group, query: string, rows: readonly Occurrence[] = group.occurrences) {
  const needle = searchText(query);
  const includes = (value: string) => searchText(value).includes(needle);
  const direct = [group.primary, group.code].some(includes);
  const matched = rows.filter(row => includes(row.original) || includes(row.replacement));
  return {found: direct || matched.length > 0, terms: direct ? [] : [...new Set(matched.map(row => row.original))]};
}

export function mappingTerms(group: Group) {
  const terms = new Map<string, Occurrence[]>();
  for (const row of group.occurrences) {
    const rows = terms.get(row.original);
    if (rows) rows.push(row);
    else terms.set(row.original, [row]);
  }
  return terms;
}

export function mappingTarget(group: Group) {
  const terms = mappingTerms(group);
  const codes = (rows: Occurrence[]) => [...new Set(rows.map(row => withoutBrackets(searchText(row.replacement))))];
  const primaryCodes = [withoutBrackets(searchText(group.code)), ...codes(terms.get(group.primary) ?? [])];
  terms.delete(group.primary);
  const aliases = [...terms].map(([original, rows]) => ({key: searchText(original), codes: codes(rows)}));
  return {group, primaryCodes, aliases};
}

function nameCharacters(value: string) {
  return [...searchText(value).replace(/(?:股份有限公司|有限责任公司|有限公司)$/u, '')];
}

function oneEdit(left: string, right: string) {
  if (/[^\p{L}\s·・]/u.test(left) || /[^\p{L}\s·・]/u.test(right)) return false;
  const [a, b] = [nameCharacters(left), nameCharacters(right)].sort((x, y) => x.length - y.length);
  if (a.length < 3 || b.length - a.length > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const rest = a.length === b.length ? a.slice(i + 1) : a.slice(i);
  return rest.every((character, index) => character === b[i + 1 + index]);
}

export function rankMappingTargets(targets: ReturnType<typeof mappingTarget>[], query: string, references: string[]) {
  const needle = searchText(query);
  const anchors = [...new Set(references.map(searchText))];
  const ranked = targets.map(({group, primaryCodes, aliases}) => {
    const primary = searchText(group.primary);
    const aliasMatch = (predicate: (value: string) => boolean, includeCodes = false) => aliases.some(alias =>
      predicate(alias.key) || includeCodes && alias.codes.some(predicate));
    const hit = (rank: number) => ({group, rank});
    if (needle) {
      const codeNeedle = withoutBrackets(needle) || needle;
      const equal = (value: string) => value === codeNeedle;
      const contains = (value: string) => value.includes(codeNeedle);
      if (primary === needle || primaryCodes.some(equal) || aliasMatch(equal, true)) return hit(3);
      if (primary.includes(needle) || primaryCodes.some(contains) || aliasMatch(contains, true)) return hit(2);
    } else {
      if (anchors.includes(primary)) return hit(3);
      if (aliasMatch(value => anchors.includes(value))) return hit(2);
    }
    const similar = (value: string) => needle ? oneEdit(value, needle) : anchors.some(anchor => oneEdit(value, anchor));
    return hit(similar(primary) || aliasMatch(similar) ? 1 : 0);
  });
  return ranked.filter(entry => !needle || entry.rank > 0).sort((left, right) => right.rank - left.rank);
}
