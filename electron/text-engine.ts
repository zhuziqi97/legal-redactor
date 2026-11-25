type Source = { id: string; title: string; text: string };

function findOriginal(sources: Source[], word: string) {
  if (!word) return [];
  return sources.flatMap(source => {
    const matches = [];
    const chars = Array.from(source.text);
    const offsets = new Uint32Array(source.text.length + 1);
    const lines = new Uint32Array(chars.length + 1);
    let offset = 0;
    let line = 1;
    for (let index = 0; index < chars.length; index++) {
      offsets[offset] = index;
      lines[index] = line;
      offset += chars[index].length;
      if (chars[index] === '\n') line++;
    }
    offsets[offset] = chars.length;
    for (let at = source.text.indexOf(word); at >= 0; at = source.text.indexOf(word, at + word.length)) {
      const start = offsets[at];
      const end = offsets[at + word.length];
      matches.push({ materialId: source.id, title: source.title, itemId: null, start, end, line: lines[start], original: word,
        before: chars.slice(Math.max(0, start - 22), start).join('').split('\n').at(-1) ?? '',
        after: chars.slice(end, end + 25).join('').split('\n')[0], replacement: '', group: null, action: null });
    }
    return matches;
  });
}

module.exports = { findOriginal };
