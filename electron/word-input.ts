const mammoth = require('mammoth') as typeof import('mammoth');
const { parseFragment } = require('parse5') as typeof import('parse5');

type HtmlNode = import('parse5').DefaultTreeAdapterTypes.Node;
type HtmlElement = import('parse5').DefaultTreeAdapterTypes.Element;
type Block = { text: string; table?: true };

const paragraphTags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const listTags = new Set(['ol', 'ul', 'li']);
const tableGroups = new Set(['thead', 'tbody', 'tfoot']);

function children(node: HtmlNode) {
  return 'childNodes' in node ? node.childNodes : [];
}

function tag(node: HtmlNode) {
  return 'tagName' in node ? node.tagName : '';
}

function inlineText(node: HtmlNode): string {
  if ('value' in node) return node.value;
  if (tag(node) === 'br') return '\n';
  return children(node).map(inlineText).join('');
}

function separate(blocks: Block[]) {
  return blocks.map((block, index) => {
    const previous = blocks[index - 1];
    const spacer = previous ? (block.table || previous.table ? '\n\n' : '\n') : '';
    return spacer + block.text;
  }).join('');
}

function readTable(table: HtmlNode) {
  const rowNodes = children(table).flatMap(node => tableGroups.has(tag(node)) ? children(node) : [node]);
  const rows = rowNodes.filter(node => tag(node) === 'tr').map(row =>
    children(row).filter((node): node is HtmlElement => tag(node) === 'td' || tag(node) === 'th').map(cell => ({
      text: separate(readBlocks(cell)),
      merged: cell.attrs.some(({ name, value }) => (name === 'rowspan' || name === 'colspan') && value !== '1'),
    })),
  );
  const width = rows[0]?.length;
  const rectangular = rows.every(row => row.length === width &&
    row.every(cell => !cell.merged && !/[\n\t]/u.test(cell.text)));
  return rows.map(row => row.map(cell => cell.text).join(rectangular ? '\t' : '\n')).join('\n');
}

function readBlocks(container: HtmlNode): Block[] {
  const blocks: Block[] = [];
  let inline = '';
  function flushInline() {
    if (inline.trim()) blocks.push({ text: inline });
    inline = '';
  }
  for (const node of children(container)) {
    const name = tag(node);
    if (name === 'table') {
      flushInline();
      blocks.push({ text: readTable(node), table: true });
    } else if (paragraphTags.has(name)) {
      flushInline();
      blocks.push({ text: inlineText(node) });
    } else if (listTags.has(name)) {
      flushInline();
      blocks.push(...readBlocks(node));
    } else {
      inline += inlineText(node);
    }
  }
  flushInline();
  return blocks;
}

async function readWordInput(bytes: Buffer) {
  let html: string;
  try {
    ({ value: html } = await mammoth.convertToHtml({ buffer: bytes }, {
      includeEmbeddedStyleMap: false,
      ignoreEmptyParagraphs: false,
      convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
    }));
  } catch {
    throw new Error('无法读取 DOCX。请在 Word 或 WPS 中打开文件并重新另存为 DOCX。');
  }
  const text = separate(readBlocks(parseFragment(html)));
  if (!text.trim()) throw new Error('DOCX 文件没有可识别的正文。');
  return text;
}

export = { readWordInput };
