export type RestoreOccurrence = {
  id: number;
  start: number;
  end: number;
  line: number;
  code: string;
  value: string | null;
};

type RestoreGroup = {
  code: string;
  primary: string;
  occurrences: readonly { replacement: string }[];
};

export function restoreText(text: string, groups: readonly RestoreGroup[]) {
  const values = new Map<string, string | null>();
  for (const group of groups) {
    const codes = [group.code, ...group.occurrences.map(occurrence => occurrence.replacement)];
    for (const code of codes) {
      const known = values.get(code);
      values.set(code, known === undefined || known === group.primary ? group.primary : null);
    }
  }

  const occurrences: RestoreOccurrence[] = [];
  const output: string[] = [];
  let cursor = 0;
  let line = 1;
  for (const match of text.matchAll(/【[^【】\r\n]+】/gu)) {
    const code = match[0];
    const start = match.index;
    const end = start + code.length;
    const unchanged = text.slice(cursor, start);
    const value = values.get(code) ?? null;
    line += unchanged.match(/\r\n|[\r\n]/gu)?.length ?? 0;
    occurrences.push({ id: occurrences.length, start, end, line, code, value });
    output.push(unchanged, value ?? code);
    cursor = end;
  }
  output.push(text.slice(cursor));
  return { output: output.join(''), occurrences };
}
