<script setup lang="ts">
import { computed, nextTick, reactive, ref, shallowRef, watch } from 'vue';
import AdjustmentPanel from './components/AdjustmentPanel.vue';
import DocumentReader from './components/DocumentReader.vue';
import MaterialSidebar from './components/MaterialSidebar.vue';
import ReviewPanel from './components/ReviewPanel.vue';
import { positionKey, prettyError, samePersonKind, type Adjustment, type AdjustmentPreviewResult, type Evidence,
  type Group, type InferenceSettings, type Issue, type Occurrence, type OutputResult, type RangeSuggestion, type SourceChange, type Span, type Term,
  type SourceFile, type Workspace, type WorkspaceResult } from './model';
import { indexText } from './positions';

const api = window.redaction;
const workspace = shallowRef<Workspace>({ documents: [], groups: [], current: null, pending: [], canUndo: false, revision: 0 });
const material = computed(() => workspace.value.current);
const ready = computed(() => material.value?.status === 'ready');
const collapsed = ref(false);
const busy = ref(false);
const previewing = ref(false);
const suggesting = ref(false);
const scanning = ref<string | null>(null);
const queued = ref<string[]>([]);
const queuedAt = new Map<string, number>();
const scanPhases = reactive<Record<string, string>>({});
const scanErrors = reactive<Record<string, string>>({});
const scanNotices = reactive<Record<string, string>>({});
const selected = ref<number | null>(null);
const clicked = ref<number | null>(null);
const selection = ref<Span | null>(null);
const selectedItem = computed(() => material.value?.items.find(row => row.id === selected.value));
const quickItem = computed(() => material.value?.items.find(row => row.id === clicked.value));
const overlap = computed(() => {
  const span = selection.value;
  if (!span) return [];
  return material.value?.items.filter(row => span.start < row.end && row.start < span.end) || [];
});
const rangeTarget = computed(() => overlap.value[0]?.id ?? quickItem.value?.id);
const readySelection = computed(() => ready.value && (selection.value || quickItem.value));
const rangeFor = ref<{ materialId: string; id: number } | null>(null);
const draft = ref<Adjustment | null>(null);
const draftKey = ref(0);
const previewReply = shallowRef<{ key: string; result: AdjustmentPreviewResult }>();
const mergeReply = shallowRef<{ key: string; issue: Issue }>();
const suggestionReply = shallowRef<{ key: string; rows: RangeSuggestion[]; error?: string }>();
const suggestionsKey = computed(() => {
  const edit = draft.value?.originalEdit;
  return edit && edit.value.trim() && edit.value !== edit.base
    ? JSON.stringify([draftKey.value, workspace.value.revision, edit.value]) : '';
});
const visibleSuggestions = computed(() => suggestionsKey.value && suggestionsKey.value === suggestionReply.value?.key
  ? suggestionReply.value : null);
const picked = computed(() => draft.value?.rows.filter(row => draft.value!.chosen.has(positionKey(row))) || []);
const coverage = computed(() => draft.value && ['create', 'bind', 'edit'].includes(draft.value.mode));
const sourceChanges = computed<SourceChange[]>(() => {
  const active = draft.value;
  if (!active || active.mode === 'edit' || active.mode === 'alias' || (active.mode === 'bind' && !active.groupId)) return [];
  const byMaterial = new Map<string, Occurrence[]>();
  for (const row of picked.value) {
    const rows = byMaterial.get(row.materialId) || [];
    rows.push(row);
    byMaterial.set(row.materialId, rows);
  }
  return workspace.value.groups.flatMap(group => {
    if (active.mode === 'bind' && active.groupId === group.id) return [];
    const moved = group.occurrences.filter(row => coverage.value
      ? byMaterial.get(row.materialId)?.some(next => next.start < row.end && row.start < next.end)
      : active.chosen.has(positionKey(row)));
    if (!moved.length) return [];
    const removed = new Set(moved);
    const rest = group.occurrences.filter(row => !removed.has(row));
    const terms = rest.some(row => row.original === group.primary) ? [] : [...new Map(rest.map(row => [row.original, row])).values()];
    return [{ group, moved, rest, terms }];
  });
});
const draftChange = computed<Change | null>(() => {
  const active = draft.value;
  if (active?.mode === 'edit') {
    const item = workspace.value.groups.find(group => group.id === active.groupId);
    const positions = Object.values(active.edits);
    const wordChanged = active.originalEdit?.value !== active.originalEdit?.base;
    const inputCode = active.code.trim();
    const codeChanged = item?.code !== inputCode && item?.code !== `【${inputCode}】`;
    if (!item || !inputCode || (wordChanged && !positions.length) || (!positions.length && !active.primary && !codeChanged)) return null;
    const rebindPositions = !positions.length && codeChanged ? picked.value : [];
    return { mode: 'editMapping', groupId: active.groupId, positions, code: active.code, primary: active.primary,
      ...(rebindPositions.length ? { rebindPositions } : {}),
      ...(active.resolution ? { resolution: { ...active.resolution } } : {}) };
  }
  if (!active || !picked.value.length || (active.mode === 'bind' && !active.groupId)) return null;
  const mode = active.mode === 'remove' ? active.keep ? 'keep' : 'review' : active.mode;
  const primaries: Record<string, Term> = {};
  for (const { group, terms } of sourceChanges.value) {
    const choice = terms.find(row => row.original === active.primaries[group.id]);
    if (choice) primaries[group.id] = { original: choice.original };
  }
  return {
    mode, positions: picked.value, primaries,
    ...(mode === 'create' ? { type: active.type, code: active.code,
      ...(active.resolution ? { resolution: { ...active.resolution } } : {}) } : {}),
    ...(mode === 'bind' ? { groupId: active.groupId } : {}),
  };
});
const previewKey = computed(() => coverage.value && draftChange.value
  ? JSON.stringify([draftKey.value, workspace.value.revision, changePayload(draftChange.value)]) : '');
const visibleImpact = computed(() => previewKey.value && previewKey.value === previewReply.value?.key
  ? previewReply.value.result : null);
const mergeKey = computed(() => {
  if (!draft.value || !['edit', 'create'].includes(draft.value.mode) || !draftChange.value) return '';
  const { resolution: _resolution, rebindPositions: _rebind, ...selection } = changePayload(draftChange.value);
  return JSON.stringify([draftKey.value, workspace.value.revision, selection]);
});
const mergePrompt = computed(() => mergeKey.value === mergeReply.value?.key ? mergeReply.value.issue : null);
watch(mergeKey, () => { if (draft.value) draft.value.resolution = null; });
const issues = ref<Issue[]>([]);
const notice = ref({ text: '', error: false, brief: false });
const reader = ref<InstanceType<typeof DocumentReader>>();
const review = ref<InstanceType<typeof ReviewPanel>>();
const importDialog = ref<HTMLDialogElement>();
const closeDialog = ref<HTMLDialogElement>();
const settingsDialog = ref<HTMLDialogElement>();
const settings = shallowRef<InferenceSettings>();
const preferredEP = ref('auto');
const settingsBusy = ref(false);
const settingsError = ref('');
const materialDialog = ref<HTMLDialogElement>();
const materialEdit = reactive({ action: 'rename' as 'rename' | 'edit' | 'delete', id: '', title: '', text: '', error: '' });
const materialImpact = computed(() => {
  const affected = workspace.value.groups.filter(item => item.occurrences.some(row => row.materialId === materialEdit.id));
  return { groups: affected.length, removed: affected.filter(item => item.occurrences.every(row => row.materialId === materialEdit.id)).length };
});
const inputText = ref<HTMLTextAreaElement>();
const input = reactive({ title: '', text: '', path: null as string | null, encoding: '' });
const readingImport = ref(false);
const importEncodingTitle = ref('');
const importError = ref('');
const groupDialog = ref<HTMLDialogElement>();
const groupAction = ref<'merge' | 'delete' | 'remove'>('merge');
const group = shallowRef<Group | null>(null);
const groupRows = shallowRef<Occurrence[]>([]);
const targetId = ref('');
const mergeQuery = ref('');
const groupError = ref('');
const groupTerm = computed(() => groupRows.value[0]?.original || '');
const supportedTargets = computed(() => workspace.value.groups.filter(candidate =>
  candidate.id !== group.value?.id && group.value && samePersonKind(candidate.type, group.value.type)));
const mergeTargets = computed(() => supportedTargets.value.filter(candidate => candidate.id === targetId.value
  || [candidate.primary, candidate.code, ...candidate.occurrences.map(row => row.original)]
    .some(word => word.includes(mergeQuery.value.trim()))));
const mergeTarget = computed(() => supportedTargets.value.find(candidate => candidate.id === targetId.value));
const groupImpact = computed(() => `影响 ${new Set(groupRows.value.map(row => row.materialId)).size} 份材料、${groupRows.value.length} 处`);
const evidence = computed(() => material.value?.evidence.find(link => {
  const row = quickItem.value;
  return row && (link.object_start === row.start || row.definitions?.includes(link.start) || row.sourceDefinitions?.includes(link.start));
}));
let timer: ReturnType<typeof setTimeout> | undefined;

function announce(text = '', error = false, brief = false) {
  clearTimeout(timer);
  notice.value = { text, error, brief };
  if (brief) timer = setTimeout(() => { notice.value.text = ''; }, 2600);
}

async function run<T>(request: { op: string } & Record<string, unknown>) {
  busy.value = true;
  try {
    return await api.engine<T>(request);
  } finally {
    busy.value = false;
  }
}

function clearQuick() {
  clicked.value = null;
  selection.value = null;
  window.getSelection()?.removeAllRanges();
  reader.value?.clearHighlight();
}
function adopt(result: Workspace, reset = false) {
  if (reset || material.value?.id !== result.current?.id) {
    clearQuick();
    selected.value = null;
    issues.value = [];
  }
  workspace.value = result;
}
async function reveal(id: number | null) {
  selected.value = id;
  await nextTick();
  await reader.value?.reveal(id);
  await review.value?.reveal();
}

async function openMaterial(id: string) {
  if (busy.value) return false;
  if (id !== material.value?.id) {
    try {
      const result = await run<{ view: Workspace }>({ op: 'open', materialId: id });
      adopt(result.view);
      rangeFor.value = null;
      announce();
    } catch (error) {
      announce(prettyError(error), true);
      return false;
    }
  }
  return true;
}

async function jump(row: Pick<Occurrence, 'materialId' | 'itemId' | 'start' | 'end'>, focusSource = false) {
  if (!await openMaterial(row.materialId)) return;
  rangeFor.value = null;
  clearQuick();
  if (focusSource) await reader.value?.showSource();
  if (row.itemId !== null) await reveal(row.itemId);
  else {
    await reveal(null);
    if (focusSource) await reader.value?.highlightSpan(row);
    else await reader.value?.selectSpan(row);
  }
}

async function locate(issue: Issue) {
  const id = issue.materialId || material.value?.id;
  if (!id || !await openMaterial(id)) return;
  if (issue.itemId !== undefined) {
    clicked.value = issue.itemId;
    await reveal(issue.itemId);
    reader.value?.anchorItem(issue.itemId);
  } else if (issue.start !== undefined && issue.end !== undefined) {
    await reader.value?.selectSpan({ start: issue.start, end: issue.end });
  }
}

function showImport() {
  if (busy.value) return;
  clearQuick();
  Object.assign(input, { title: '', text: '', path: null, encoding: '' });
  importEncodingTitle.value = '';
  importError.value = '';
  importDialog.value?.showModal();
  inputText.value?.focus();
}
function adoptImport(file: SourceFile) {
  Object.assign(input, file);
  importEncodingTitle.value = '';
}

api.onImportReading(() => { readingImport.value = true; });

async function openSettings() {
  if (settingsBusy.value || settingsDialog.value?.open) return;
  settings.value = undefined;
  settingsError.value = '';
  settingsDialog.value?.showModal();
  settingsBusy.value = true;
  try {
    settings.value = await api.inferenceSettings();
    preferredEP.value = settings.value.provider;
  } catch (error) {
    settingsError.value = prettyError(error);
  } finally {
    settingsBusy.value = false;
  }
}

api.onOpenSettings(openSettings);

async function saveSettings() {
  if (!settings.value?.enabled || settingsBusy.value) return;
  settingsError.value = '';
  if (preferredEP.value === settings.value.provider) { settingsDialog.value?.close(); return; }
  settingsBusy.value = true;
  try {
    const message = await api.setProvider(preferredEP.value);
    settingsDialog.value?.close();
    if (message) announce(message);
  } catch (error) {
    settingsError.value = prettyError(error);
  } finally {
    settingsBusy.value = false;
  }
}

async function pickFile() {
  if (busy.value) return;
  busy.value = true;
  importError.value = '';
  try {
    const file = await api.open();
    if (file && 'requiresEncoding' in file) importEncodingTitle.value = file.title;
    else if (file) adoptImport(file);
  } catch (error) {
    importEncodingTitle.value = '';
    importError.value = prettyError(error);
  } finally {
    readingImport.value = false;
    busy.value = false;
  }
}
async function readSimplifiedChinese() {
  if (busy.value) return;
  busy.value = true;
  importError.value = '';
  try {
    adoptImport(await api.decodeImport());
  } catch (error) {
    importError.value = prettyError(error);
  } finally {
    busy.value = false;
  }
}
function pasteInstead() {
  importEncodingTitle.value = '';
  importError.value = '';
  input.path = null;
  input.encoding = '';
  void nextTick(() => inputText.value?.focus());
}

async function manageMaterial(action: typeof materialEdit.action, id: string) {
  const item = workspace.value.documents.find(doc => doc.id === id);
  if (!item || busy.value) return;
  if (action === 'edit' && !await openMaterial(id)) return;
  Object.assign(materialEdit, { action, id, title: item.title, text: action === 'edit' ? material.value?.text ?? '' : '', error: '' });
  materialDialog.value?.showModal();
}

async function applyMaterial() {
  const { action, id, title, text } = materialEdit;
  if (busy.value || !id) return;
  materialEdit.error = '';
  try {
    const op = { rename: 'renameMaterial', edit: 'editMaterial', delete: 'deleteMaterial' }[action];
    const result = await run<{ view: Workspace }>({ op, materialId: id, title, text });
    adopt(result.view, action !== 'rename');
    if (action !== 'rename') { draft.value = null; rangeFor.value = null; }
    if (action === 'delete') {
      queued.value = queued.value.filter(value => value !== id);
      queuedAt.delete(id);
      delete scanErrors[id];
      delete scanPhases[id];
      delete scanNotices[id];
    }
    materialDialog.value?.close();
    if (action === 'edit') identify(id, true);
  } catch (error) {
    materialEdit.error = prettyError(error);
  }
}

async function findCase(text: string) {
  return run<Occurrence[]>({ op: 'findOriginal', text });
}
async function addMaterial() {
  if (busy.value || !input.text.trim()) return;
  try {
    const result = await run<{ view: Workspace }>({ op: 'add', text: input.text, title: input.title, sourcePath: input.path });
    adopt(result.view, true);
    importDialog.value?.close();
    Object.assign(input, { title: '', text: '', path: null, encoding: '' });
  } catch (error) {
    importError.value = prettyError(error);
    return;
  }
  identify();
}
function identify(id = material.value?.id, rescan = false) {
  const doc = workspace.value.documents.find(item => item.id === id);
  if (!doc || doc.status === 'ready' || queued.value.includes(doc.id)) return;
  if (scanning.value === id && !rescan && !scanPhases[doc.id]?.startsWith('正在取消')) return;
  delete scanErrors[doc.id];
  delete scanNotices[doc.id];
  queuedAt.set(doc.id, performance.now());
  queued.value.push(doc.id);
  void startNextAnalysis();
}

async function startNextAnalysis() {
  if (scanning.value) return;
  const id = queued.value.shift();
  if (!id) return;
  const started = performance.now();
  const queueMs = started - (queuedAt.get(id) ?? started);
  queuedAt.delete(id);
  const doc = workspace.value.documents.find(item => item.id === id);
  if (!doc || doc.status === 'ready') { void startNextAnalysis(); return; }
  scanning.value = id;
  scanPhases[id] = '正在分析';
  try {
    const result = await api.engine<{ view: Workspace; inferenceNotice?: string }>({ op: 'scan', materialId: id, revision: doc.revision, queueMs });
    if (result.view.revision >= workspace.value.revision) {
      const renderStart = performance.now();
      adopt(result.view);
      if (result.inferenceNotice) scanNotices[id] = result.inferenceNotice;
      if (material.value?.id === id) {
        requestAnimationFrame(() => requestAnimationFrame(() => api.recordRender(performance.now() - renderStart)));
      }
    }
  } catch (error) {
    const now = workspace.value.documents.find(item => item.id === id);
    const message = prettyError(error);
    if (now?.revision === doc.revision && !message.includes('已取消')) scanErrors[id] = message;
  } finally {
    delete scanPhases[id];
    scanning.value = null;
    void startNextAnalysis();
  }
}
async function cancelScan() {
  if (!scanning.value) return;
  scanPhases[scanning.value] = '正在取消分析…';
  try {
    await api.cancel();
  } catch (error) {
    announce(prettyError(error), true);
  }
}
api.onProgress(phase => { if (scanning.value && !scanPhases[scanning.value]?.startsWith('正在取消')) scanPhases[scanning.value] = phase; });
api.onConfirmClose(() => {
  if (closeDialog.value && !closeDialog.value.open) closeDialog.value.showModal();
});

function fromDocument(id: number) {
  if (!ready.value || busy.value) return;
  clicked.value = id;
  const groupId = material.value?.items.find(row => row.id === id)?.group;
  if (groupId) review.value?.selectGroup(groupId);
  void reveal(id);
}
function trackSelection(span: Span | null) {
  selection.value = span;
  if (span) clicked.value = null;
}

function makeDraft(mode: Adjustment['mode'], options: Partial<Adjustment> = {}) {
  draftKey.value++;
  draft.value = {
    mode, title: '新建映射', groupId: '', fixedTarget: false, type: quickItem.value?.type || 'person',
    code: '', query: '', scope: 'all', rows: [], searchKeys: new Set(), chosen: new Set(), primaries: {}, keep: false,
    edits: {}, primary: '', resolution: null,
    error: '', issue: null, searched: false, ...options,
  };
  return draft.value;
}
function setOriginal(value: string) {
  const active = draft.value;
  const edit = active?.originalEdit;
  if (!active || !edit || value === edit.value) return;
  edit.value = value;
  rangeFor.value = null;
  edit.manual = {};
  active.edits = {};
  active.chosen.clear();
  active.primary = '';
  active.error = '';
  active.issue = null;
}
function register(active: Adjustment, rows: Occurrence[], choose = false) {
  const indexed = new Map(active.rows.map(row => [positionKey(row), row]));
  for (const row of rows) {
    const key = positionKey(row);
    indexed.set(key, row);
    if (choose) active.chosen.add(key);
  }
  active.rows = [...indexed.values()];
}

async function getSelection(): Promise<Occurrence | null> {
  if (!material.value) return null;
  const span = selection.value || quickItem.value || selectedItem.value;
  if (!span) return null;
  return run<Occurrence>({ op: 'candidate', materialId: material.value.id, start: span.start, end: span.end });
}
async function fromSelection(mode: 'create' | 'bind') {
  if (busy.value) return;
  const first = await getSelection().catch(error => { announce(prettyError(error), true); return null; });
  if (!first) return;
  const kind = material.value?.items.find(row => row.id === first.itemId)?.type || overlap.value[0]?.type;
  const active = makeDraft(mode, { title: mode === 'create' ? '新建映射' : '绑定到现有映射',
    type: kind || 'person', query: first.original });
  register(active, [first], true);
  clearQuick();
}
async function addSelection() {
  const active = draft.value;
  if (!active || busy.value) return;
  try {
    const row = await getSelection();
    if (!row) return;
    register(active, [row], true);
    active.error = '';
    clearQuick();
  } catch (error) {
    active.error = prettyError(error);
  }
}
async function searchDraft() {
  const active = draft.value;
  if (!active || busy.value || !active.query.trim()) return;
  active.error = '';
  try {
    const rows = await run<Occurrence[]>({ op: 'search', text: active.query,
      materialId: active.scope === 'current' ? material.value?.id : null });
    active.rows = active.rows.filter(row => active.chosen.has(positionKey(row)));
    active.searchKeys = new Set(rows.map(positionKey));
    active.searched = true;
    register(active, rows);
    if (!rows.length && active.rows.length) active.error = '当前搜索范围没有同文位置。';
  } catch (error) {
    active.error = prettyError(error);
  }
}
async function startRange() {
  if (!material.value || rangeTarget.value === undefined || overlap.value.length > 1) return;
  const id = rangeTarget.value;
  const item = material.value.items.find(row => row.id === id);
  const mapping = workspace.value.groups.find(group => group.id === item?.group);
  const origin = mapping?.occurrences.find(row => row.materialId === material.value?.id && row.itemId === id);
  if (!selection.value && mapping && origin) {
    clearQuick();
    editMapping(mapping, origin);
    return;
  }
  if (!selection.value) {
    rangeFor.value = { materialId: material.value.id, id };
    clicked.value = null;
    await reader.value?.showSource();
    return;
  }
  await finishRange(id);
}
async function chooseRange(row: Occurrence) {
  if (row.itemId === null || !await openMaterial(row.materialId)) return;
  clearQuick();
  rangeFor.value = { materialId: row.materialId, id: row.itemId };
  await reader.value?.showSource();
  await reveal(row.itemId);
}
async function finishRange(id = rangeFor.value?.id) {
  const doc = material.value;
  const span = selection.value;
  const row = doc?.items.find(item => item.id === id);
  if (!doc || !span || !row || busy.value || (rangeFor.value && rangeFor.value.materialId !== doc.id)) return;
  const mapping = workspace.value.groups.find(group => group.id === row.group);
  // Keep the original item identity so the engine replaces its range in place.
  const ix = indexText(doc.text);
  const original = ix.slice(span.start, span.end);
  if (!original.trim()) return;
  const entry: Occurrence = { ...span, materialId: doc.id, title: doc.title, line: ix.lines[span.start]!,
    itemId: row.id, original, before: '', after: '', replacement: row.replacement,
    group: row.group, action: row.action };
  if (mapping) {
    const old = mapping.occurrences.find(item => item.materialId === doc.id && item.itemId === row.id);
    if (!old) return;
    const active = draft.value?.mode === 'edit' && draft.value.groupId === mapping.id ? draft.value : editMapping(mapping, old);
    setOriginal(original);
    const key = positionKey(old);
    if (positionKey(entry) !== key) {
      active.originalEdit!.manual[key] = entry;
      active.edits[key] = entry;
    } else {
      delete active.originalEdit!.manual[key];
      delete active.edits[key];
    }
    active.primary = '';
  } else {
    const active = makeDraft('create', { title: '重选原文位置', type: row.type, query: original });
    register(active, [entry], true);
  }
  rangeFor.value = null;
  clearQuick();
  if (mapping) await reader.value?.highlightSpan(span);
}
async function keepSelection() {
  if (busy.value) return;
  const row = await getSelection().catch(error => { announce(prettyError(error), true); return null; });
  if (row) await commit({ mode: 'keep', positions: [row] });
}

type Change = Record<string, unknown> & { positions?: Occurrence[]; rebindPositions?: Occurrence[]; term?: Term };

function positionPayload({ materialId, itemId, start, end }: Occurrence) {
  return { materialId, itemId, start, end };
}

function changePayload(change: Change): Record<string, unknown> {
  const { positions, rebindPositions, term, ...details } = change;
  return {
    ...details,
    ...(positions ? { positions: positions.map(positionPayload) } : {}),
    ...(rebindPositions ? { rebindPositions: rebindPositions.map(positionPayload) } : {}),
    ...(term ? { term: { original: term.original } } : {}),
  };
}

watch([suggestionsKey, busy], ([key, locked], _, onCleanup) => {
  if (!key || locked || suggestionReply.value?.key === key) return;
  const timer = setTimeout(async () => {
    const active = draft.value;
    const edit = active?.originalEdit;
    if (!active || !edit || busy.value || suggestionsKey.value !== key || suggestionReply.value?.key === key) return;
    suggesting.value = true;
    try {
      const rows = await run<RangeSuggestion[]>({ op: 'editSuggestions', groupId: active.groupId, text: edit.value,
        original: edit.base, ...(edit.origin ? { origin: positionPayload(edit.origin) } : {}) });
      if (suggestionsKey.value !== key) return;
      suggestionReply.value = { key, rows };
      if (edit.origin && rows.length === 1) {
        const row = rows[0];
        const at = positionKey(row.original);
        if (row.candidates.length === 1 && row.candidates[0].clear && !edit.manual[at]) active.edits[at] = row.candidates[0].position;
      }
    } catch (error) {
      if (suggestionsKey.value === key) suggestionReply.value = { key, rows: [], error: prettyError(error) };
    } finally {
      suggesting.value = false;
    }
  }, 120);
  onCleanup(() => clearTimeout(timer));
});

watch([previewKey, busy], ([key, locked], _, onCleanup) => {
  if (!key || locked || previewReply.value?.key === key) return;
  const timer = setTimeout(async () => {
    const change = draftChange.value;
    if (!change || busy.value || previewKey.value !== key || previewReply.value?.key === key) return;
    const conflictKey = mergeKey.value;
    previewing.value = true;
    busy.value = true;
    try {
      const result = await api.engine<AdjustmentPreviewResult>({ op: 'previewAdjustment', change: changePayload(change) });
      previewReply.value = { key, result };
      if ('issue' in result && result.issue.merge) mergeReply.value = { key: conflictKey, issue: result.issue };
    } catch (error) {
      previewReply.value = { key, result: { error: prettyError(error) } };
    } finally {
      previewing.value = false;
      busy.value = false;
    }
  }, 120);
  onCleanup(() => clearTimeout(timer));
});

async function commit(change: Change, report = (message: string, _issue?: Issue) => announce(message, true), expectedRevision?: number) {
  if (busy.value) return false;
  try {
    const result = await run<WorkspaceResult>({ op: 'apply', change: changePayload(change), expectedRevision });
    if ('issue' in result) {
      report(result.issue.message, result.issue);
      return false;
    }
    adopt(result.view);
    issues.value = [];
    clearQuick();
    if (result.focus && result.focus.materialId === material.value?.id) await reveal(result.focus.itemId);
    announce('已应用订正', false, true);
    return true;
  } catch (error) {
    report(prettyError(error));
    return false;
  }
}
async function applyDraft() {
  const active = draft.value;
  const change = draftChange.value;
  const shown = visibleImpact.value;
  if (!active || !change || rangeFor.value || (coverage.value && (!shown || !('preview' in shown)))) return;
  active.issue = null;
  active.error = '';
  const result = await commit(change, (message, issue) => { active.error = message; active.issue = issue || null; },
    shown && 'preview' in shown ? shown.preview.revision : undefined);
  if (result) {
    const destination = active.resolution?.targetId || active.groupId;
    draft.value = null;
    if (active.mode === 'edit' || active.resolution?.targetId) review.value?.selectGroup(destination);
  }
  else if (draft.value?.issue?.stalePreview) {
    const current = await run<{ view: Workspace }>({ op: 'view' }).catch(() => null);
    if (current) adopt(current.view);
  }
}
function addToAlias() {
  const active = draft.value;
  if (!active) return;
  makeDraft('bind', { title: '为别称添加位置', groupId: active.groupId, fixedTarget: true, query: active.query });
  void searchDraft();
}
function removeFromAlias() {
  const active = draft.value;
  if (!active) return;
  active.mode = 'remove';
  active.title = '移出别称位置';
}

function editMapping(item: Group, origin?: Occurrence) {
  const value = origin?.original || item.primary;
  return makeDraft('edit', { title: '修改映射', groupId: item.id, rows: item.occurrences, code: item.code.slice(1, -1),
    originalEdit: { base: value, value, origin, manual: {} } });
}

function openGroupAction(action: 'edit' | 'add' | 'merge' | 'delete' | 'remove', item: Group, rows = item.occurrences) {
  clearQuick();
  if (action === 'edit') { editMapping(item); return; }
  if (action === 'add') {
    makeDraft('bind', { title: `为「${item.primary}」添加别称`, groupId: item.id, fixedTarget: true });
    return;
  }
  group.value = item;
  groupRows.value = rows;
  groupAction.value = action;
  targetId.value = '';
  mergeQuery.value = '';
  groupError.value = '';
  void nextTick(() => groupDialog.value?.showModal());
}
function termAction(action: 'edit' | 'remove' | 'primary', item: Group, rows: Occurrence[]) {
  const term = rows[0]!;
  if (action === 'remove') { openGroupAction(action, item, rows); return; }
  if (action === 'primary') {
    void commit({ mode: 'primary', groupId: item.id, term });
    return;
  }
  const active = makeDraft('alias', { title: `编辑别称「${term.original}」`, groupId: item.id,
    query: term.original });
  register(active, rows, true);
}
async function applyGroup(keep = false) {
  if (!group.value) return;
  groupError.value = '';
  if (groupAction.value === 'merge' && mergeTarget.value) {
    const target = mergeTarget.value;
    const active = editMapping(group.value);
    active.code = target.code.slice(1, -1);
    groupDialog.value?.close();
    await nextTick();
    active.resolution = { mode: 'whole', targetId: target.id };
    return;
  }
  const change = groupAction.value === 'remove'
    ? { mode: keep ? 'keep' : 'review', positions: groupRows.value }
    : { mode: groupAction.value, groupId: group.value.id, targetId: targetId.value, keep };
  if (await commit(change, message => { groupError.value = message; })) groupDialog.value?.close();
}

async function undo() {
  if (busy.value) return;
  try {
    const result = await run<{ view: Workspace }>({ op: 'undo' });
    adopt(result.view, true);
    announce('已撤销上次订正', false, true);
  } catch (error) {
    announce(prettyError(error), true);
  }
}
async function output(kind: 'copy' | 'file') {
  if (!material.value || !ready.value || busy.value) return;
  const id = material.value.id;
  busy.value = true;
  try {
    const result = await api.engine<OutputResult>({ op: 'output', materialId: id });
    issues.value = 'issues' in result ? result.issues.map(issue => ({ ...issue, materialId: id })) : [];
    if ('issues' in result) {
      if (draft.value) announce('当前材料还有待处理的位置，请先完成调整。', true);
    } else if (kind === 'copy') {
      await api.copy(result.output);
      announce('已复制到剪贴板', false, true);
    } else {
      const path = await api.save(result.output, result.sourcePaths, result.filename);
      if (path) {
        const saved = await api.engine<{ view: Workspace }>({ op: 'markExported', materialId: id, text: result.output });
        adopt(saved.view);
        announce('已导出 TXT', false, true);
      }
    }
  } catch (error) {
    announce(prettyError(error), true);
  } finally {
    busy.value = false;
  }
}
function showEvidence(link: Evidence) {
  clicked.value = null;
  return reader.value?.selectSpan({ start: link.statement_start ?? link.start, end: link.statement_end ?? link.end });
}
</script>

<template>
  <div class="desktop-body" :class="{ 'sidebar-collapsed': collapsed }">
    <MaterialSidebar :documents="workspace.documents" :current="material?.id" :collapsed="collapsed" :locked="busy" :scanning="scanning"
      :queued="queued" :phases="scanPhases" :errors="scanErrors"
      @toggle="collapsed = !collapsed" @add="showImport" @open="openMaterial" @manage="manageMaterial" @settings="openSettings" />
    <main class="workspace-main">
      <div v-if="notice.text || (material && (!ready || scanNotices[material.id]))" class="notice"
        :class="{ error: notice.error || !!scanErrors[material?.id || ''], brief: notice.brief && ready }" role="status">
        <span>{{ material && (scanPhases[material.id] || scanErrors[material.id] || (queued.includes(material.id) ? '排队中' : '')) ||
          notice.text || (material && scanNotices[material.id]) || '当前材料尚未识别' }}</span>
        <button v-if="scanning === material?.id" class="button small" @click="cancelScan">取消识别</button>
        <button v-else-if="material && !ready && !queued.includes(material.id)" class="button small" :disabled="busy" @click="identify()">重新识别</button>
      </div>
      <div v-if="rangeFor" class="notice">
        <span>请在原文中选出要替换的完整文字。</span>
        <div class="toolbar">
          <button class="button small" :disabled="!selection || busy" @mousedown.prevent @click="finishRange()">使用所选文字</button>
          <button class="button small quiet" @click="rangeFor = null; clearQuick()">取消</button>
        </div>
      </div>
      <div v-if="!material" class="empty-workspace">
        <div class="empty-icon" aria-hidden="true"><svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/></svg></div>
        <h2>添加案卷材料</h2>
        <button class="button primary" :disabled="busy" @click="showImport">打开 TXT 或粘贴文本</button>
      </div>
      <div v-else class="workbench">
        <DocumentReader ref="reader" :address="material.id" :material="material" :selected="selected"
          :can-output="!busy && ready" :find-case="findCase" :locked="busy" :revision="workspace.revision"
          :show-quick="!!readySelection && !rangeFor && !busy && draft?.mode !== 'edit'"
          @select="fromDocument" @selection="trackSelection" @output="output" @dismiss="clearQuick" @locate="jump($event, true)">
          <template #quick>
            <template v-if="draft && ['create','bind'].includes(draft.mode)">
              <button class="button small primary" @mousedown.prevent @click="addSelection">加入调整清单</button>
            </template>
            <template v-else>
              <button class="button small" @mousedown.prevent @click="fromSelection('bind')">绑定到现有映射</button>
              <button class="button small" @mousedown.prevent @click="fromSelection('create')">新建映射</button>
              <button v-if="selection ? overlap.length === 1 : quickItem" class="button small" @mousedown.prevent @click="startRange">
                {{ (selection ? overlap[0]?.group : quickItem?.group) ? '修改映射' : '重选原文' }}
              </button>
              <button v-if="quickItem" class="button small quiet" @mousedown.prevent @click="keepSelection">保留原文</button>
              <button v-if="evidence" class="button small quiet" @mousedown.prevent @click="showEvidence(evidence)">查看关联依据</button>
            </template>
            <button class="button small quiet icon-button" aria-label="关闭快捷操作" @mousedown.prevent @click="clearQuick">×</button>
          </template>
        </DocumentReader>
        <AdjustmentPanel v-if="draft" :key="draftKey" :draft="draft" :groups="workspace.groups" :material-id="material.id"
          :selected="selected" :locked="busy" :previewing="previewing || suggesting" :impact="visibleImpact" :source-changes="sourceChanges"
          :merge-prompt="mergePrompt" :range-for="rangeFor"
          :suggestions="visibleSuggestions" @original="setOriginal"
          @cancel="draft = null; rangeFor = null; clearQuick()" @search="searchDraft" @jump="jump($event, true)" @reselect="chooseRange"
          @issue="locate" @apply="applyDraft" @add="addToAlias" @remove="removeFromAlias" />
        <ReviewPanel v-show="!draft" ref="review" :material="material" :groups="workspace.groups" :pending="workspace.pending"
          :issues="issues" :selected="selected" :locked="busy" :can-undo="workspace.canUndo" @jump="jump" @issue="locate"
          @create="makeDraft('create'); clearQuick()" @group="openGroupAction" @term="termAction" @undo="undo" />
      </div>
    </main>
  </div>

  <dialog ref="closeDialog" class="close-workspace-dialog" aria-labelledby="close-title" aria-describedby="close-description">
    <div class="dialog-form">
      <div class="dialog-heading"><h2 id="close-title">关闭当前工作区？</h2></div>
      <p id="close-description">本次导入的材料和映射将在关闭时丢失。</p>
      <div class="dialog-actions">
        <button type="button" class="button" autofocus @click="closeDialog?.close()">继续处理</button>
        <button type="button" class="button primary" @click="api.closeWorkspace()">关闭工作区</button>
      </div>
    </div>
  </dialog>

  <dialog ref="importDialog" aria-labelledby="import-title" @cancel.prevent="!busy && importDialog?.close()">
    <form class="dialog-form" @submit.prevent="addMaterial">
      <div class="dialog-heading"><h2 id="import-title">添加材料</h2><button type="button" class="button quiet small close-dialog" aria-label="关闭添加材料" :disabled="busy" @click="importDialog?.close()">×</button></div>
      <label>材料名称<input v-model="input.title" :disabled="busy" placeholder="可选"></label>
      <div class="import-source">
        <span class="count">{{ readingImport ? '正在读取文件…' : input.path ? `已读取 ${input.encoding.toUpperCase()}` : '原文' }}</span>
        <button type="button" class="button small" :disabled="busy" @click="pickFile">打开 TXT</button>
      </div>
      <div v-if="importEncodingTitle" class="import-source">
        <span class="count">「{{ importEncodingTitle }}」需要选择编码</span>
        <button type="button" class="button small" :disabled="busy" @click="readSimplifiedChinese">简体中文（GB18030）</button>
        <button type="button" class="button small quiet" :disabled="busy" @click="pasteInstead">改用粘贴</button>
      </div>
      <textarea ref="inputText" v-model="input.text" :disabled="busy" :readonly="!!input.path" aria-label="材料原文" placeholder="在此粘贴原文"></textarea>
      <p v-if="importError" class="form-error" role="alert">{{ importError }}</p>
      <div class="dialog-actions">
        <button type="button" class="button" :disabled="busy" @click="importDialog?.close()">取消</button>
        <button class="button primary" :disabled="busy || !!importEncodingTitle || !input.text.trim()">添加并识别</button>
      </div>
    </form>
  </dialog>

  <dialog ref="materialDialog" aria-labelledby="material-title" @cancel.prevent="!busy && materialDialog?.close()">
    <form class="dialog-form" @submit.prevent="applyMaterial">
      <div class="dialog-heading"><h2 id="material-title">{{ { rename: '重命名材料', edit: '编辑原文', delete: '删除材料' }[materialEdit.action] }}</h2></div>
      <label v-if="materialEdit.action === 'rename'">材料名称<input v-model="materialEdit.title" :disabled="busy" autofocus></label>
      <template v-else-if="materialEdit.action === 'edit'">
        <p class="count">{{ materialEdit.title }}</p>
        <textarea v-model="materialEdit.text" aria-label="编辑材料原文" :disabled="busy" autofocus></textarea>
      </template>
      <p v-else>删除「{{ materialEdit.title }}」会影响 {{ materialImpact.groups }} 组映射，其中 {{ materialImpact.removed }} 组在本材料中有全部位置。</p>
      <p v-if="materialEdit.error" class="form-error" role="alert">{{ materialEdit.error }}</p>
      <div class="dialog-actions">
        <button type="button" class="button" :disabled="busy" @click="materialDialog?.close()">取消</button>
        <button class="button primary" :disabled="busy || (materialEdit.action === 'rename' && !materialEdit.title.trim()) || (materialEdit.action === 'edit' && !materialEdit.text.trim())">
          {{ { rename: '保存名称', edit: '保存并分析', delete: '确认删除' }[materialEdit.action] }}
        </button>
      </div>
    </form>
  </dialog>

  <dialog ref="settingsDialog" aria-labelledby="settings-title" @cancel.prevent="!settingsBusy && settingsDialog?.close()">
    <form class="dialog-form" @submit.prevent="saveSettings">
      <div class="dialog-heading"><h2 id="settings-title">推理设置</h2></div>
      <label v-if="settings?.enabled">ONNX Runtime 执行提供程序
        <select v-model="preferredEP" aria-label="ONNX Runtime 执行提供程序" :disabled="settingsBusy">
          <option value="auto">自动</option>
          <option v-for="ep in settings.providers" :key="ep.name" :value="ep.name">{{ ep.name }}</option>
        </select>
      </label>
      <p v-if="settings && !settings.enabled" class="count">当前找不到本地 ONNX 模型。</p>
      <p v-if="settingsBusy" role="status" class="count">正在检查本地推理环境…</p>
      <p v-if="settingsError" role="alert" class="form-error">{{ settingsError }}</p>
      <div class="dialog-actions">
        <button type="button" class="button" :disabled="settingsBusy" @click="settingsDialog?.close()">关闭</button>
        <button v-if="settings?.enabled" class="button primary" :disabled="settingsBusy">保存</button>
      </div>
    </form>
  </dialog>

  <dialog ref="groupDialog" aria-labelledby="group-dialog-title" @cancel.prevent="!busy && groupDialog?.close()">
    <form v-if="group" class="dialog-form" @submit.prevent="applyGroup()">
      <div class="dialog-heading">
        <h2 id="group-dialog-title">{{ {merge: '合并映射', delete: '删除映射', remove: '移除别称'}[groupAction] }}</h2>
        <button type="button" class="button quiet small close-dialog" aria-label="关闭映射操作" :disabled="busy" @click="groupDialog?.close()">×</button>
      </div>
      <div class="group-preview"><strong>{{ groupAction === 'remove' ? groupTerm : group.primary }}</strong> → {{ group.code }}<span>{{ groupImpact }}</span></div>
      <template v-if="groupAction === 'merge'">
        <label>搜索目标映射<input v-model="mergeQuery" type="search" placeholder="输入原词、别称或代号"></label>
        <label>合并到<select v-model="targetId" aria-label="合并到" :disabled="busy"><option value="">请选择目标映射</option>
          <option v-for="candidate in mergeTargets" :key="candidate.id" :value="candidate.id">{{ candidate.primary }} → {{ candidate.code }}</option></select>
        </label>
        <p v-if="!mergeTargets.length" class="count">没有匹配的同类映射</p>
        <div class="merge-summary">
          <strong>{{ mergeTarget ? `迁入「${mergeTarget.primary}」，使用 ${mergeTarget.code}` : '将一并迁入的原词' }}</strong>
          <p>{{ [...new Set(groupRows.map(row => row.original))].join('、') }}</p>
          <div v-if="mergeTarget" class="merge-positions">
            <p v-for="row in groupRows" :key="positionKey(row)">{{ row.title }} · 第 {{ row.line }} 行 · {{ row.original }}</p>
          </div>
        </div>
      </template>
      <div v-if="['delete','remove'].includes(groupAction)" class="disposition-preview">
        <p v-if="groupAction === 'delete'" class="count">涉及 {{ new Set(groupRows.filter(row => row.original !== group?.primary).map(row => row.original)).size }} 个别称</p>
        <p>转待核后，处理完这些位置即可输出相应材料。</p>
      </div>
      <p v-if="groupError" class="form-error" role="alert">{{ groupError }}</p>
      <div class="dialog-actions">
        <button type="button" class="button" :disabled="busy" @click="groupDialog?.close()">取消</button>
        <button v-if="['delete','remove'].includes(groupAction)" type="button" class="button" :disabled="busy" @click="applyGroup(true)">{{ groupRows.length }} 处保留原文</button>
        <button class="button primary" :disabled="busy || (groupAction === 'merge' && !targetId)">
          {{ groupAction === 'merge' ? '查看合并' : `${groupRows.length} 处转待核` }}
        </button>
      </div>
    </form>
  </dialog>
</template>
