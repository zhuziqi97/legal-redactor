import type { Group, Occurrence } from './model';

const searchText = (value: string) => value.trim().toLowerCase();
const withoutBrackets = (value: string) => value.replace(/^【(.*)】$/u, '$1');

export function matchMapping(group: Group, query: string, rows: readonly Occurrence[] = group.occurrences) {
  const needle = searchText(query);
  const exactNeedle = withoutBrackets(needle);
  const includes = (value: string) => searchText(value).includes(needle);
  const equals = (value: string) => withoutBrackets(searchText(value)) === exactNeedle;
  const direct = [group.primary, group.code].some(includes);
  const matched = rows.filter(row => includes(row.original) || includes(row.replacement));
  const exact = [group.primary, group.code].some(equals) ||
    matched.some(row => equals(row.original) || equals(row.replacement));
  return {found: direct || matched.length > 0, exact, terms: direct ? [] : [...new Set(matched.map(row => row.original))]};
}
