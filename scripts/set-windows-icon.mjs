import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { resedit } from '@electron/packager/resedit';

const [executable, iconPath, rawVersion] = process.argv.slice(2);
const version = (rawVersion || JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  .replace(/-.*$/u, '');
const productName = '法律文档脱敏工具';
const filename = basename(executable);

await resedit(executable, {
  iconPath,
  productName,
  productVersion: version,
  fileVersion: version,
  legalCopyright: 'Copyright 2026 zhuziqi97',
  win32Metadata: {
    CompanyName: 'zhuziqi97',
    FileDescription: productName,
    InternalName: 'LegalRedactor',
    OriginalFilename: filename,
    ProductName: productName,
  },
});
