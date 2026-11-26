import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

mkdirSync(new URL('../build/', import.meta.url), { recursive: true });
for (const name of ['main', 'workspace-session', 'project-actions', 'analysis', 'preload', 'preferences', 'updates', 'project-file', 'text-input', 'word-input', 'word-worker', 'text-engine', 'otter', 'inference-environment', 'inference-worker', 'workspace-worker']) {
  const source = readFileSync(new URL(`../electron/${name}.ts`, import.meta.url), 'utf8');
  writeFileSync(new URL(`../build/${name}.cjs`, import.meta.url), stripTypeScriptTypes(source, { mode: 'transform' }));
}
