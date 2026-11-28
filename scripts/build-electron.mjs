import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

const compilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  moduleDetection: ts.ModuleDetectionKind.Legacy,
  verbatimModuleSyntax: false,
};

mkdirSync(new URL('../build/', import.meta.url), { recursive: true });
for (const name of ['main', 'workspace-session', 'project-actions', 'analysis', 'preload', 'preferences', 'updates', 'project-file', 'text-input', 'word-input', 'word-worker', 'text-engine', 'otter', 'inference-environment', 'inference-worker', 'workspace-worker']) {
  const source = readFileSync(new URL(`../electron/${name}.ts`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { fileName: `${name}.ts`, compilerOptions });
  writeFileSync(new URL(`../build/${name}.cjs`, import.meta.url), outputText);
}

cpSync(new URL('../engine/lexicon/', import.meta.url), new URL('../build/engine/lexicon/', import.meta.url), { recursive: true });
