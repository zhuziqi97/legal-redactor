type ImportEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';

function decodeInput(bytes: Uint8Array, requested?: 'gb18030') {
  const bom = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
  const utf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const encoding: ImportEncoding = requested ?? bom ?? 'utf-8';
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    if (!requested && !bom && !utf8Bom) return { requiresEncoding: true as const };
    throw new Error(`TXT 解码失败（${encoding.toUpperCase()}）。请换用正确编码的文件。`);
  }
  const normalized = text.replace(/\r\n?/g, '\n');
  if (!normalized.trim()) throw new Error('TXT 文件没有可识别的正文。');
  return { text: normalized, encoding };
}

module.exports = { decodeInput };
