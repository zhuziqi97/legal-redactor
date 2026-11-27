<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import AdjustmentPanel from './components/AdjustmentPanel.vue';
import AliasPanel from './components/AliasPanel.vue';
import DocumentReader from './components/DocumentReader.vue';
import MaterialSidebar from './components/MaterialSidebar.vue';
import ReviewPanel from './components/ReviewPanel.vue';
import ProjectDialogs from './components/ProjectDialogs.vue';
import MappingTargetPicker from './components/MappingTargetPicker.vue';
import type { MappingCategory } from './mapping-search';
import { useAnalysisQueue } from './analysis-queue';
import RestoreWorkspace from './components/RestoreWorkspace.vue';
import type { MappingScope, Preferences, SettingsSection, UpdateStatus } from '../engine/preferences';
import { positionKey, prettyError, recoveryChoicesComplete, type Adjustment, type AdjustmentPreviewResult, type Evidence,
  type Group, type Issue, type Occurrence, type RangeSuggestion, type Span, type Term,
  type SourceFile, type ViewOptions, type Workspace } from './model';
import { indexText } from './positions';
import type { EngineRequest } from '../electron/contract';
import type { AliasTarget, Change as EngineChange, TargetCodeChoice } from '../engine/workspace-types';

const api = window.redaction;
const workspace = shallowRef<Workspace>({ documents: [], groups: [], current: null, pending: [], canUndo: false, revision: 0 });
const workspaceTabs = [{ id: 'redact', label: '脱敏' }, { id: 'restore', label: '恢复' }] as const;
type WorkspaceMode = (typeof workspaceTabs)[number]['id'];
const mode = ref<WorkspaceMode>('redact');
const viewOptions = shallowRef<ViewOptions>();
const updateVersion = ref('');
function applyUpdate(status: UpdateStatus) {
  if (status.kind === 'available') updateVersion.value = status.version;
  else if (status.kind === 'current' || status.kind === 'unavailable') updateVersion.value = '';
}
api.onUpdateStatus(applyUpdate);
void api.settingsInfo().then(({ update }) => applyUpdate(update)).catch(() => {});
const material = computed(() => workspace.value.current);
const showReview = computed(() => !!material.value || workspace.value.groups.length > 0 || workspace.value.canUndo);
const ready = computed(() => material.value?.status === 'ready');
const collapsed = ref(false);
const mappingScope = ref<MappingScope>('all');
const reviewCategory = ref<MappingCategory>('all');
function applyPreferences(settings: Preferences, reset: boolean) {
  if (reset || !viewOptions.value) {
    collapsed.value = settings.usage.sidebarCollapsed;
    mappingScope.value = settings.usage.mappingScope;
  }
  viewOptions.value = settings.view;
}
api.onPreferencesChanged(({ settings }, reset) => applyPreferences(settings, reset));
const busy = ref(true);
const openingMaterial = ref(false);
const sourceEdit = ref<{ id: string; revision: number; base: string; text: string } | null>(null);
const sourceDirty = computed(() => !!sourceEdit.value && sourceEdit.value.text !== sourceEdit.value.base);
const sourceError = ref('');
const revising = ref(false);
watch(sourceDirty, dirty => api.setDraftDirty(dirty), {flush: 'sync'});
const previewing = ref(false);
const suggesting = ref(false);
const { scanning, queued, scanPhases, scanErrors, identify, startNextAnalysis, cancelScan, removeFromQueue } =
  useAnalysisQueue(workspace, adopt, announce);
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
const previewReply = shallowRef<{ key: string; scope: string; result: AdjustmentPreviewResult }>();
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
function recoveryTerms(values: Record<string, string>): Record<string, Term> {
  return Object.fromEntries(Object.entries(values).filter(([, original]) => original).map(([id, original]) => [id, {original}]));
}
const draftChange = computed<Change | null>(() => {
  const active = draft.value;
  if (!active) return null;
  const targetCodes = active.targetCodes;
  const primaries = recoveryTerms(active.primaries);
  if (active.mode === 'merge') {
    return active.resolution?.targetId ? {mode: 'merge', groupId: active.groupId, targetId: active.resolution.targetId, targetCodes, primaries} : null;
  }
  if (active.mode === 'primary' && active.recoveryOriginal) {
    return {mode:'primary', groupId:active.groupId, term:{original:active.recoveryOriginal}};
  }
  if (active.mode === 'rename') {
    const code = active.code.trim();
    const saved = workspace.value.groups.find(item => item.id === active.groupId)?.code;
    return code && code !== saved && `【${code}】` !== saved ? {mode:'rename', groupId:active.groupId, code} : null;
  }
  if (active.mode === 'edit') {
    const item = workspace.value.groups.find(group => group.id === active.groupId);
    const positions = Object.values(active.edits);
    if (!item || !positions.length) return null;
    return { mode: 'editMapping', groupId: active.groupId, positions, code: item.code, primaries, targetCodes,
      ...(active.resolution ? { resolution: { ...active.resolution } } : {}) };
  }
  if (!picked.value.length || (active.mode === 'bind' && !active.groupId)) return null;
  const mode = active.mode === 'remove' ? active.keep ? 'keep' : 'review' : active.mode;
  return {
    mode, positions: picked.value, primaries, targetCodes,
    ...(mode === 'create' ? { type: active.type, code: active.code,
      ...(active.resolution ? { resolution: { ...active.resolution } } : {}) } : {}),
    ...(mode === 'bind' ? { groupId: active.groupId, ...(active.alias ? {alias: active.alias} : {}) } : {}),
  };
});
const previewKey = computed(() => draftChange.value
  ? JSON.stringify([draftKey.value, workspace.value.revision, changePayload(draftChange.value)]) : '');
const visibleImpact = computed(() => previewKey.value && previewKey.value === previewReply.value?.key
  ? previewReply.value.result : null);
const mergeKey = computed(() => {
  if (!draft.value || !['edit', 'create'].includes(draft.value.mode) || !draftChange.value) return '';
  const { resolution: _resolution, rebindPositions: _rebind, primaries: _primaries, targetCodes: _codes, ...selection } = changePayload(draftChange.value);
  return JSON.stringify([draftKey.value, workspace.value.revision, selection]);
});
const mergePrompt = computed(() => mergeKey.value === mergeReply.value?.key ? mergeReply.value.issue : null);
watch(mergeKey, () => { if (draft.value) draft.value.resolution = null; });
const transferScope = computed(() => {
  if (!draftChange.value) return '';
  const {primaries: _primaries, targetCodes: _codes, ...choice} = changePayload(draftChange.value);
  return JSON.stringify([draftKey.value, workspace.value.revision, choice]);
});
const previewSources = computed(() => {
  const reply = previewReply.value;
  return reply?.scope === transferScope.value && 'preview' in reply.result ? reply.result.preview.sources : [];
});
const codeChoiceReply = shallowRef<{ scope: string; choices: TargetCodeChoice[] }>();
const targetCodeChoices = computed(() => codeChoiceReply.value?.scope === transferScope.value ? codeChoiceReply.value.choices : []);
watch(() => [draftKey.value, draft.value?.groupId, draft.value?.resolution?.targetId], (next, previous) => {
  if (draft.value && next.some((value, index) => value !== previous[index])) draft.value.targetCodes = {};
});
const pendingOutput = computed(() => {
  const active = draft.value;
  const id = material.value?.id;
  if (id && rangeFor.value?.materialId === id && selection.value) return true;
  if (!active || !id) return false;
  const impact = visibleImpact.value;
  if (impact && 'preview' in impact) return impact.preview.materials.some(doc => doc.materialId === id && doc.affectsOutput);
  if (picked.value.some(row => row.materialId === id)) return true;
  const change = draftChange.value;
  if (!change) return false;
  if (active.mode === 'edit') return change.positions?.some(row => row.materialId === id) ?? false;
  if (active.mode !== 'rename' && active.mode !== 'merge') return false;
  return workspace.value.groups.find(item => item.id === active.groupId)?.occurrences.some(row => row.materialId === id) ?? false;
});
const canOutput = computed(() => !busy.value && ready.value && !sourceEdit.value && !pendingOutput.value);
const issues = ref<Issue[]>([]);
const notice = ref({ text: '', error: false });
const reader = ref<InstanceType<typeof DocumentReader>>();
const review = ref<InstanceType<typeof ReviewPanel>>();
const importDialog = ref<HTMLDialogElement>();
const projectDialogs = ref<InstanceType<typeof ProjectDialogs>>();
const projectBusy = computed(() => projectDialogs.value?.projectBusy ?? false);
const materialDialog = ref<HTMLDialogElement>();
const materialEdit = reactive({action:'rename' as 'rename' | 'delete', id:'', title:'', error:''});
const inputText = ref<HTMLTextAreaElement>();
const input = reactive({ title: '', text: '', path: null as string | null });
const importFilename = computed(() => input.path?.split(/[\\/]/).at(-1));
const openingImport = ref(false);
const extractingWord = ref(false);
const importEncodingTitle = ref('');
const importError = ref('');
let pasteDraft = { title: '', text: '' };
const groupDialog = ref<HTMLDialogElement>();
const groupDialogKey = ref(0);
const groupAction = ref<'merge' | 'delete'>('merge');
const groupDialogId = ref('');
const group = computed(() => workspace.value.groups.find(item => item.id === groupDialogId.value));
const groupRows = computed(() => group.value?.occurrences ?? []);
const aliasGroupId = ref('');
const aliasGroup = computed(() => workspace.value.groups.find(item => item.id === aliasGroupId.value));
const targetId = ref('');
const groupError = ref('');
const mergeReferences = computed(() => group.value ? [group.value.primary, ...new Set(group.value.occurrences.map(row => row.original))] : []);
const mergeTargets = computed(() => workspace.value.groups.filter(candidate => candidate.id !== group.value?.id));
const mergeTarget = computed(() => mergeTargets.value.find(candidate => candidate.id === targetId.value));
const groupImpact = computed(() => `影响 ${new Set(groupRows.value.map(row => row.materialId)).size} 份材料、${groupRows.value.length} 处`);
const evidence = computed(() => material.value?.evidence.find(link => {
  const row = quickItem.value;
  return row && (link.object_start === row.start || row.definitions?.includes(link.start) || row.sourceDefinitions?.includes(link.start));
}));
let timer: ReturnType<typeof setTimeout> | undefined;

function announce(text = '', error = false, brief = false) {
  clearTimeout(timer);
  notice.value = { text, error };
  if (brief) timer = setTimeout(() => { notice.value.text = ''; }, 2600);
}

async function run<R extends EngineRequest>(request: R) {
  busy.value = true;
  try {
    return await api.engine(request);
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
  if (reset && aliasGroupId.value) {
    aliasGroupId.value = '';
    draft.value = null;
  }
  if (reset || material.value?.id !== result.current?.id) {
    clearQuick();
    selected.value = null;
    issues.value = [];
  }
  workspace.value = result;
}

function adoptProject(result: Workspace) {
  reviewCategory.value = 'all';
  adopt(result, true);
}

onMounted(async () => {
  try {
    const [project, { settings }] = await Promise.all([api.initialProject(), api.preferences()]);
    if (!viewOptions.value) applyPreferences(settings, false);
    if (project && 'view' in project) adoptProject(project.view);
    else if (project && 'locked' in project) await projectDialogs.value?.unlock(project.title);
    else if (project) announce(project.warning, true);
  } catch (error) {
    announce(prettyError(error), true);
  } finally {
    busy.value = false;
  }
});

async function reveal(id: number | null) {
  selected.value = id;
  await nextTick();
  await reader.value?.reveal(id);
  await review.value?.reveal();
}

async function openMaterial(id: string) {
  if (busy.value) return false;
  if (id !== material.value?.id) {
    if (!confirmSourceSwitch()) return false;
    openingMaterial.value = true;
    try {
      const result = await run({ op: 'open', materialId: id });
      endSourceEdit();
      adopt({...workspace.value, current: result.current});
      rangeFor.value = null;
      announce();
    } catch (error) {
      announce(prettyError(error), true);
      return false;
    } finally {
      openingMaterial.value = false;
    }
  }
  return true;
}

async function selectMaterial(id: string) {
  if (await openMaterial(id)) mode.value = 'redact';
}

function moveWorkspaceTab(event: KeyboardEvent) {
  let next: WorkspaceMode;
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowRight': next = mode.value === 'redact' ? 'restore' : 'redact'; break;
    case 'Home': next = 'redact'; break;
    case 'End': next = 'restore'; break;
    default: return;
  }
  event.preventDefault();
  mode.value = next;
  document.getElementById(`${next}-tab`)?.focus();
}

async function jump(row: Pick<Occurrence, 'materialId' | 'itemId' | 'start' | 'end'>, focusSource = false) {
  if (sourceEdit.value?.id === row.materialId) {
    mode.value = 'redact';
    announce('请先应用或取消原文修改，再定位到原文。', true);
    return;
  }
  if (!await openMaterial(row.materialId)) return;
  mode.value = 'redact';
  rangeFor.value = null;
  clearQuick();
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
  Object.assign(input, { title: '', text: '', path: null });
  pasteDraft = { title: '', text: '' };
  importEncodingTitle.value = '';
  importError.value = '';
  importDialog.value?.showModal();
  inputText.value?.focus();
}
function adoptImport({ title, text, path }: SourceFile) {
  if (!input.path) pasteDraft = { title: input.title, text: input.text };
  Object.assign(input, { title, text, path });
  importEncodingTitle.value = '';
}

async function toggleSidebar() {
  try {
    const { settings } = await api.changePreferences({ sidebarCollapsed: !collapsed.value });
    collapsed.value = settings.usage.sidebarCollapsed;
  } catch (error) { announce(prettyError(error), true); }
}

async function changeMappingScope(scope: MappingScope, remember: boolean) {
  try {
    const saved = remember ? await api.changePreferences({ mappingScope: scope }) : null;
    mappingScope.value = saved?.settings.usage.mappingScope ?? scope;
  } catch (error) { announce(prettyError(error), true); }
}

function openSettings(section?: SettingsSection) {
  void api.openSettings(section).catch(error => announce(prettyError(error), true));
}

api.onWordExtracting(() => {
  if (!openingImport.value) return;
  importEncodingTitle.value = '';
  extractingWord.value = true;
});

async function pickFile() {
  if (busy.value) return;
  busy.value = true;
  openingImport.value = true;
  importError.value = '';
  try {
    const file = await api.open();
    if (file && 'requiresEncoding' in file) importEncodingTitle.value = file.title;
    else if (file) adoptImport(file);
  } catch (error) {
    importEncodingTitle.value = '';
    importError.value = prettyError(error);
  } finally {
    extractingWord.value = false;
    openingImport.value = false;
    busy.value = false;
  }
}
function cancelImport() {
  if (extractingWord.value) api.cancelWordImport();
  else if (!busy.value) importDialog.value?.close();
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
  if (input.path) Object.assign(input, pasteDraft, { path: null });
  importEncodingTitle.value = '';
  importError.value = '';
  void nextTick(() => inputText.value?.focus());
}

async function manageMaterial(action: typeof materialEdit.action, id: string) {
  const item = workspace.value.documents.find(doc => doc.id === id);
  if (!item || busy.value) return;
  Object.assign(materialEdit, {action, id, title:item.title, error:''});
  materialDialog.value?.showModal();
}

async function applyMaterial() {
  const { action, id, title } = materialEdit;
  if (busy.value || !id) return;
  materialEdit.error = '';
  try {
    const result = action === 'rename' ? await run({op:'renameMaterial', materialId:id, title})
      : await run({op:'deleteMaterial', materialId:id});
    adopt(result.view, action !== 'rename');
    if (action !== 'rename') { draft.value = null; rangeFor.value = null; }
    if (action === 'delete') {
      if (sourceEdit.value?.id === id) endSourceEdit();
      removeFromQueue(id);
    }
    materialDialog.value?.close();
  } catch (error) {
    materialEdit.error = prettyError(error);
  }
}

function findProject(text: string) {
  return api.engine({ op: 'findOriginal', text });
}
async function addMaterial() {
  if (busy.value || importEncodingTitle.value || !input.text.trim()) return;
  if (!confirmSourceSwitch()) return;
  try {
    const result = await run({ op: 'add', text: input.text, title: input.title, sourcePath: input.path ?? undefined });
    endSourceEdit();
    adopt(result.view, true);
    mode.value = 'redact';
    importDialog.value?.close();
    Object.assign(input, { title: '', text: '', path: null });
    pasteDraft = { title: '', text: '' };
  } catch (error) {
    importError.value = prettyError(error);
    return;
  }
  identify();
}

function confirmSourceSwitch() {
  return !sourceDirty.value || window.confirm('原文有未应用的修改。要放弃修改并切换材料吗？');
}

function beginSourceEdit() {
  const doc = material.value;
  if (!doc || busy.value || scanning.value === doc.id || queued.value.includes(doc.id) || draft.value || rangeFor.value) return;
  clearQuick();
  sourceError.value = '';
  sourceEdit.value = {id: doc.id, revision: doc.revision, base: doc.text, text: doc.text};
}

function endSourceEdit() {
  sourceEdit.value = null;
  sourceError.value = '';
}

async function applySourceEdit() {
  const edit = sourceEdit.value;
  if (!edit || !sourceDirty.value || !edit.text.trim() || busy.value || scanning.value) return;
  const {id, revision, text} = edit;
  revising.value = true;
  scanning.value = id;
  scanPhases[id] = '正在识别修改范围';
  sourceError.value = '';
  announce();
  try {
    const result = await run({op: 'reviseMaterial', materialId: id, revision, text});
    adopt(result.view, true);
    delete scanErrors[id];
    endSourceEdit();
    announce('已应用原文修改', false, true);
  } catch (error) {
    const message = prettyError(error);
    sourceError.value = message.includes('已取消') ? '已取消识别，可继续编辑或重新提交。' : message;
  } finally {
    delete scanPhases[id];
    scanning.value = null;
    revising.value = false;
    void startNextAnalysis();
  }
}

function fromDocument(id: number) {
  if (!ready.value || busy.value || sourceEdit.value) return;
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
    code: '', query: '', scope: 'all', rows: [], searchKeys: new Set(), chosen: new Set(), primaries: {}, targetCodes: {}, keep: false,
    edits: {}, resolution: null,
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
  return run({ op: 'candidate', materialId: material.value.id, start: span.start, end: span.end });
}
async function fromSelection(mode: 'create' | 'bind') {
  if (busy.value) return;
  const first = await getSelection().catch(error => { announce(prettyError(error), true); return null; });
  if (!first) return;
  const kind = material.value?.items.find(row => row.id === first.itemId)?.type || overlap.value[0]?.type;
  const active = makeDraft(mode, { title: mode === 'create' ? '新建映射' : '绑定到现有映射',
    type: kind || 'person', query: first.original, targetOriginal: first.original });
  register(active, [first], true);
  clearQuick();
}
async function addSelection() {
  const active = draft.value;
  if (!active || busy.value) return;
  try {
    const row = await getSelection();
    if (!row) return;
    if (active.alias && row.original !== active.alias.original) {
      active.error = '所选文字与别称不同。';
      return;
    }
    if (alreadyBoundToAlias(active, row)) {
      active.error = '这处已加入别称。';
      return;
    }
    register(active, [row], true);
    active.error = '';
    clearQuick();
  } catch (error) {
    active.error = prettyError(error);
  }
}
function alreadyBoundToAlias(active: Adjustment, row: Occurrence) {
  return active.alias && row.group === active.groupId && row.replacement === active.alias.code;
}
async function searchDraft() {
  const active = draft.value;
  if (!active || busy.value || !active.query.trim()) return;
  active.error = '';
  try {
    const found = await run({ op: 'search', text: active.query,
      materialId: active.scope === 'current' ? material.value?.id : null });
    const rows = active.alias ? found.filter(row => row.original === active.alias?.original && !alreadyBoundToAlias(active, row)) : found;
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
    await chooseRange(origin);
    return;
  }
  if (!selection.value) {
    rangeFor.value = { materialId: material.value.id, id };
    clicked.value = null;
    return;
  }
  await finishRange(id);
}
async function chooseRange(row: Occurrence) {
  if (row.itemId === null || !await openMaterial(row.materialId)) return;
  clearQuick();
  rangeFor.value = { materialId: row.materialId, id: row.itemId };
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

type Change = Omit<EngineChange, 'positions' | 'rebindPositions'> & { positions?: Occurrence[]; rebindPositions?: Occurrence[]; term?: Term };

function positionPayload({ materialId, itemId, start, end }: Occurrence) {
  return { materialId, itemId, start, end };
}

function changePayload(change: Change): EngineChange {
  const { positions, rebindPositions, term, alias, targetCodes, ...details } = change;
  return {
    ...details,
    ...(positions ? { positions: positions.map(positionPayload) } : {}),
    ...(rebindPositions ? { rebindPositions: rebindPositions.map(positionPayload) } : {}),
    ...(term ? { term: { original: term.original } } : {}),
    ...(alias ? { alias: { original: alias.original, code: alias.code } } : {}),
    ...(targetCodes ? {targetCodes: {...targetCodes}} : {}),
  };
}

watch([suggestionsKey, busy], ([key, locked], _, onCleanup) => {
  if (!key || locked || suggestionReply.value?.key === key) return;
  const timer = setTimeout(async () => {
    const active = draft.value;
    const edit = active?.originalEdit;
    if (!active?.groupId || !edit || busy.value || suggestionsKey.value !== key || suggestionReply.value?.key === key) return;
    suggesting.value = true;
    try {
      const rows = await run({ op: 'editSuggestions', groupId: active.groupId, text: edit.value,
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
    const scope = transferScope.value;
    previewing.value = true;
    busy.value = true;
    try {
      const result = await api.engine({ op: 'previewAdjustment', change: changePayload(change) });
      previewReply.value = { key, scope, result };
      if ('issue' in result && result.issue.merge) mergeReply.value = { key: conflictKey, issue: result.issue };
      if ('issue' in result && result.issue.targetCodeChoices) {
        const choices = new Map(targetCodeChoices.value.map(choice => [choice.original, choice]));
        for (const choice of result.issue.targetCodeChoices) choices.set(choice.original, choice);
        codeChoiceReply.value = {scope, choices: [...choices.values()]};
      }
    } catch (error) {
      previewReply.value = { key, scope, result: { error: prettyError(error) } };
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
    const result = await run({ op: 'apply', change: changePayload(change), expectedRevision });
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
  if (!active || !change || rangeFor.value || !shown || !('preview' in shown) ||
    !recoveryChoicesComplete(shown.preview.sources, active.primaries)) return;
  active.issue = null;
  active.error = '';
  const result = await commit(change, (message, issue) => { active.error = message; active.issue = issue || null; },
    shown && 'preview' in shown ? shown.preview.revision : undefined);
  if (result) {
    const destination = active.resolution?.targetId || active.groupId;
    draft.value = null;
    if (!aliasGroup.value && workspace.value.groups.some(item => item.id === destination)) await review.value?.showGroup(destination);
  }
  else if (draft.value?.issue?.stalePreview) {
    const current = await run({ op: 'view' }).catch(() => null);
    if (current) adopt(current.view);
  }
}
function addAlias(alias?: AliasTarget) {
  const item = aliasGroup.value;
  if (!item) return;
  makeDraft('bind', {title: alias ? '添加位置' : '添加别称', groupId: item.id, fixedTarget: true,
    alias, query: alias?.original || ''});
  if (alias) void searchDraft();
}

function editMapping(item: Group, origin?: Occurrence, rows = item.occurrences) {
  const value = origin?.original || rows[0]?.original || item.primary;
  return makeDraft('edit', { title: origin ? '修正这处标注' : '修正标注范围', groupId: item.id, rows,
    originalEdit: { base: value, value, origin, manual: {} } });
}

function openGroupAction(action: 'edit' | 'aliases' | 'merge' | 'delete', item: Group) {
  if (openingMaterial.value) return;
  clearQuick();
  if (action === 'edit') {
    makeDraft('rename', {title:'修改代号', groupId:item.id, rows:item.occurrences, code:item.code.slice(1,-1)});
    return;
  }
  if (action === 'aliases') {
    review.value?.selectGroup(item.id);
    aliasGroupId.value = item.id;
    return;
  }
  groupDialogId.value = item.id;
  groupAction.value = action;
  groupDialogKey.value++;
  targetId.value = '';
  groupError.value = '';
  void nextTick(() => groupDialog.value?.showModal());
}
function termAction(action: 'rebind' | 'removePositions' | 'edit' | 'primary', rows: Occurrence[]) {
  const item = aliasGroup.value;
  if (!item) return;
  const term = rows[0]!;
  if (action === 'primary') {
    makeDraft('primary', {title:'设置恢复原词', groupId:item.id, recoveryOriginal:term.original});
    return;
  }
  clearQuick();
  if (action === 'edit') { editMapping(item, undefined, rows); return; }
  const searchKeys = new Set(rows.map(positionKey));
  if (action === 'rebind') {
    makeDraft('bind', {title: '改绑位置', rows, searchKeys, rebindAlias: term.original, targetOriginal: term.original});
  } else {
    makeDraft('remove', {title: '移出位置', groupId: item.id, rows, searchKeys});
  }
}
async function applyGroup(keep = false) {
  if (!group.value) return;
  groupError.value = '';
  if (groupAction.value === 'merge') {
    const target = mergeTarget.value;
    if (!target) return;
    const source = workspace.value.groups.find(item => item.id === group.value?.id);
    if (!source) { groupError.value = '源映射已变更，请重新选择。'; return; }
    makeDraft('merge', {title: '合并映射', groupId: source.id, rows: source.occurrences,
      resolution: {mode: 'whole', targetId: target.id}});
    groupDialog.value?.close();
    return;
  }
  const change: Change = {mode:'delete', groupId:group.value.id, keep};
  if (await commit(change, message => { groupError.value = message; }, workspace.value.revision)) groupDialog.value?.close();
}

function chooseMergeTarget() {
  const active = draft.value;
  const source = workspace.value.groups.find(item => item.id === active?.groupId);
  if (!active || !source) return;
  draft.value = null;
  openGroupAction('merge', source);
  targetId.value = active.resolution?.targetId ?? '';
}

async function undo() {
  if (busy.value) return;
  try {
    const result = await run({ op: 'undo' });
    adopt(result.view, true);
    announce('已撤销上次订正', false, true);
  } catch (error) {
    announce(prettyError(error), true);
  }
}
async function output(kind: 'copy' | 'file') {
  if (!material.value || !canOutput.value) return;
  const id = material.value.id;
  busy.value = true;
  try {
    const result = await api.engine({ op: 'output', materialId: id });
    issues.value = 'issues' in result ? result.issues.map(issue => ({ ...issue, materialId: id })) : [];
    if ('issues' in result) {
      if (draft.value) announce('当前材料还有待处理的位置，请先完成调整。', true);
    } else if (kind === 'copy') {
      await api.copy(result.output);
      announce('已复制到剪贴板', false, true);
    } else {
      const path = await api.save(result.output, result.sourcePaths, result.filename);
      if (path) {
        const saved = await api.engine({ op: 'markExported', materialId: id, text: result.output });
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
  <div class="desktop-body">
    <MaterialSidebar :documents="workspace.documents" :current="material?.id" :collapsed="collapsed" :locked="busy" :scanning="scanning"
      :queued="queued" :phases="scanPhases" :errors="scanErrors" :revision="workspace.revision" :find-project="findProject"
      @toggle="toggleSidebar" @add="showImport" @open="selectMaterial" @locate="jump($event, true)"
      @manage="manageMaterial" @settings="openSettings" />
    <main class="workspace">
      <div class="workspace-header">
        <div class="workspace-tabs" role="tablist" aria-label="工作区" @keydown="moveWorkspaceTab">
          <button v-for="tab in workspaceTabs" :id="`${tab.id}-tab`" :key="tab.id" type="button" role="tab"
            :aria-selected="mode === tab.id" :aria-controls="`${tab.id}-panel`" :tabindex="mode === tab.id ? 0 : -1"
            @click="mode = tab.id">{{ tab.label }}</button>
        </div>
        <button v-if="updateVersion" class="button small quiet workspace-update" @click="openSettings('updates')">
          发现新版 {{ updateVersion }}
        </button>
      </div>
      <section v-show="mode === 'redact'" id="redact-panel" class="workspace-main" role="tabpanel" aria-labelledby="redact-tab">
        <div v-if="notice.text || (material && (!ready || scanning === material.id))" class="notice"
          :class="{ error: notice.error || !!scanErrors[material?.id || ''] }" role="status">
          <span>{{ material && (scanPhases[material.id] || scanErrors[material.id] || (queued.includes(material.id) ? '排队中' : '')) ||
            notice.text || '当前材料尚未识别' }}</span>
          <button v-if="scanning === material?.id" class="button small" @click="cancelScan">取消识别</button>
          <button v-else-if="material && !ready && !queued.includes(material.id) && !sourceEdit" class="button small" :disabled="busy" @click="identify()">重新识别</button>
        </div>
        <div v-if="rangeFor" class="notice">
          <span>请在原文中选出要替换的完整文字。</span>
          <div class="toolbar">
            <button class="button small" :disabled="!selection || busy" @mousedown.prevent @click="finishRange()">使用所选文字</button>
            <button class="button small quiet" @click="rangeFor = null; clearQuick()">取消</button>
          </div>
        </div>
        <div class="workbench" :class="{ 'workbench-empty': !showReview }">
          <div v-if="!material" class="empty-workspace">
            <img src="/legal-redactor-icon.png" width="58" height="58" alt="">
            <div class="empty-workspace-copy">
              <h2>法律文档脱敏</h2>
              <p>导入 Word（.docx）、TXT 文件，或粘贴文本。</p>
            </div>
            <div class="toolbar">
              <button class="button primary" :disabled="busy" @click="showImport">添加文本材料</button>
              <button class="button" :disabled="busy || projectBusy" @click="projectDialogs?.projectAction('open')">打开项目</button>
            </div>
          </div>
          <DocumentReader v-else ref="reader" :address="material.id" :material="material" :selected="selected"
            :view-options="viewOptions"
            :can-output="canOutput" :active="mode === 'redact'"
            :edit-text="sourceEdit?.text" :revising="revising" :edit-error="sourceError"
            :edit-disabled="busy || scanning === material.id || queued.includes(material.id) || !!draft || !!rangeFor"
            :apply-disabled="busy || !!scanning || !sourceDirty || !sourceEdit?.text.trim()"
            :show-quick="!!readySelection && !rangeFor && !busy && !sourceEdit && (!draft ||
              (draft.mode === 'create' || draft.mode === 'bind') && !draft.rebindAlias)"
            @select="fromDocument" @selection="trackSelection" @output="output" @dismiss="clearQuick"
            @edit="beginSourceEdit" @update:edit-text="sourceEdit && (sourceEdit.text = $event)"
            @cancel-edit="endSourceEdit" @apply-edit="applySourceEdit">
            <template #quick>
              <template v-if="draft && ['create','bind'].includes(draft.mode)">
                <button class="button small primary" @mousedown.prevent @click="addSelection">加入调整清单</button>
              </template>
              <template v-else>
                <button class="button small" @mousedown.prevent @click="fromSelection('bind')">绑定到现有映射</button>
                <button class="button small" @mousedown.prevent @click="fromSelection('create')">新建映射</button>
                <button v-if="selection ? overlap.length === 1 : quickItem" class="button small" @mousedown.prevent @click="startRange">
                  {{ (selection ? overlap[0]?.group : quickItem?.group) ? '修正这处标注' : '重选原文' }}
                </button>
                <button v-if="quickItem" class="button small quiet" @mousedown.prevent @click="keepSelection">保留原文</button>
                <button v-if="evidence" class="button small quiet" @mousedown.prevent @click="showEvidence(evidence)">查看关联依据</button>
              </template>
              <button class="button small quiet icon-button" aria-label="关闭快捷操作" @mousedown.prevent @click="clearQuick">×</button>
            </template>
          </DocumentReader>
          <AdjustmentPanel v-if="draft" :key="draftKey" :draft="draft" :groups="workspace.groups" :material-id="material?.id"
            :selected="selected" :locked="busy" :previewing="previewing || suggesting" :impact="visibleImpact"
            :preview-sources="previewSources" :target-code-choices="targetCodeChoices"
            :merge-prompt="mergePrompt" :range-for="rangeFor"
            :suggestions="visibleSuggestions" @original="setOriginal"
            @cancel="draft = null; rangeFor = null; clearQuick()" @search="searchDraft" @jump="jump($event, true)" @reselect="chooseRange"
            @issue="locate" @apply="applyDraft" @choose-target="chooseMergeTarget" />
          <AliasPanel v-if="aliasGroup" v-show="!draft" :key="aliasGroup.id" :group="aliasGroup" :material-id="material?.id" :can-add="!!material"
            :selected="selected" :locked="busy || !!sourceEdit" @back="aliasGroupId = ''" @jump="jump"
            @add="addAlias()" @add-positions="addAlias" @term="termAction" />
          <ReviewPanel v-if="showReview" v-show="!draft && !aliasGroup" ref="review" :material="material" :groups="workspace.groups" :pending="workspace.pending"
            :issues="issues" :selected="selected" :locked="(busy && !openingMaterial) || !!sourceEdit" :opening="openingMaterial" :can-undo="workspace.canUndo"
            v-model:category="reviewCategory" :scope="mappingScope" @scope="changeMappingScope" @jump="jump" @issue="locate"
            @create="makeDraft('create'); clearQuick()" @group="openGroupAction" @undo="undo" />
        </div>
      </section>
      <RestoreWorkspace v-show="mode === 'restore'" id="restore-panel" role="tabpanel" aria-labelledby="restore-tab"
        :groups="workspace.groups" :notice="notice" :view-options="viewOptions" :active="mode === 'restore'" @notice="announce" />
    </main>
  </div>

  <ProjectDialogs ref="projectDialogs" :busy="busy" :source-dirty="sourceDirty" :is-import-open="() => !!importDialog?.open"
    @busy="busy = $event" @redact="mode = 'redact'" @adopt="adoptProject" @notice="announce" />

  <dialog ref="importDialog" class="import-dialog" aria-labelledby="import-title" @cancel.prevent="cancelImport">
    <form class="dialog-form" @submit.prevent="addMaterial">
      <div class="dialog-heading">
        <h2 id="import-title">添加文本材料</h2>
        <button type="button" class="button quiet small close-dialog" aria-label="关闭" :disabled="busy" @click="importDialog?.close()">×</button>
      </div>
      <div class="import-content">
        <div class="import-source">
          <span v-if="importFilename" class="import-filename" :title="importFilename">{{ importFilename }}</span>
          <label v-else for="import-text">原文</label>
          <div class="toolbar">
            <button v-if="input.path" type="button" class="button small quiet" :disabled="busy" @click="pasteInstead">改用粘贴</button>
            <button type="button" class="button small" :disabled="busy" @click="pickFile">
              {{ openingImport && !extractingWord ? '正在打开…' : input.path ? '更换文件' : '打开文件' }}
            </button>
          </div>
        </div>
        <div v-if="importEncodingTitle" class="import-encoding" aria-live="polite">
          <span>「{{ importEncodingTitle }}」需要选择编码</span>
          <div class="toolbar">
            <button type="button" class="button small" :disabled="busy" @click="readSimplifiedChinese">简体中文（GB18030）</button>
            <button v-if="!input.path" type="button" class="button small quiet" :disabled="busy" @click="pasteInstead">改用粘贴</button>
          </div>
        </div>
        <div class="import-text-area">
          <textarea id="import-text" ref="inputText" v-model="input.text" :disabled="busy" :readonly="!!input.path"
            :aria-label="input.path ? '正文预览' : undefined" placeholder="粘贴或输入文本"></textarea>
          <div v-if="extractingWord" class="import-progress" role="status">
            <span aria-hidden="true"></span>正在提取正文…
          </div>
        </div>
        <p v-if="importError" class="form-error" role="alert">{{ importError }}</p>
      </div>
      <label class="import-name">材料名称<input v-model="input.title" :disabled="busy" placeholder="留空自动命名"></label>
      <div class="dialog-actions">
        <button type="button" class="button" :disabled="busy && !extractingWord" @click="cancelImport">
          {{ extractingWord ? '取消提取' : '取消' }}
        </button>
        <button class="button primary" :disabled="busy || !!importEncodingTitle || !input.text.trim()">添加并识别</button>
      </div>
    </form>
  </dialog>

  <dialog ref="materialDialog" aria-labelledby="material-title" @cancel.prevent="!busy && materialDialog?.close()">
    <form class="dialog-form" @submit.prevent="applyMaterial">
      <div class="dialog-heading"><h2 id="material-title">{{ materialEdit.action === 'rename' ? '重命名材料' : '移除材料' }}</h2></div>
      <label v-if="materialEdit.action === 'rename'">材料名称<input v-model="materialEdit.title" :disabled="busy" autofocus></label>
      <template v-else>
        <p v-if="sourceDirty && sourceEdit?.id === materialEdit.id">放弃未应用的修改并移除「{{ materialEdit.title }}」？</p>
        <p v-else>从项目中移除「{{ materialEdit.title }}」？</p>
      </template>
      <p v-if="materialEdit.error" class="form-error" role="alert">{{ materialEdit.error }}</p>
      <div class="dialog-actions">
        <button type="button" class="button" :disabled="busy" @click="materialDialog?.close()">取消</button>
        <button class="button primary" :disabled="busy || (materialEdit.action === 'rename' && !materialEdit.title.trim())">
          {{ materialEdit.action === 'rename' ? '保存名称' : '确认移除' }}
        </button>
      </div>
    </form>
  </dialog>

  <dialog ref="groupDialog" aria-labelledby="group-dialog-title" @cancel.prevent="!busy && groupDialog?.close()">
    <form v-if="group" class="dialog-form" @submit.prevent="applyGroup()">
      <div class="dialog-heading">
        <h2 id="group-dialog-title">{{ groupAction === 'merge' ? '合并映射' : '删除映射' }}</h2>
        <button type="button" class="button quiet small close-dialog" aria-label="关闭映射操作" :disabled="busy" @click="groupDialog?.close()">×</button>
      </div>
      <div class="group-preview"><strong>{{ group.primary }}</strong> → {{ group.code }}<span v-if="groupRows.length">{{ groupImpact }}</span></div>
      <MappingTargetPicker v-if="groupAction === 'merge'" :key="groupDialogKey" v-model="targetId" :groups="mergeTargets"
        :references="mergeReferences" :disabled="busy" autofocus />
      <p v-if="groupError" class="form-error" role="alert">{{ groupError }}</p>
      <div class="dialog-actions">
        <button type="button" class="button" :disabled="busy" @click="groupDialog?.close()">取消</button>
        <button v-if="groupAction === 'delete' && groupRows.length" type="button" class="button" :disabled="busy" @click="applyGroup(true)">{{ groupRows.length }} 处保留原文</button>
        <button class="button primary" :disabled="busy || (groupAction === 'merge' && !mergeTarget)">
          {{ groupAction === 'merge' ? '查看合并' : groupRows.length ? `${groupRows.length} 处转待核` : '确认删除' }}
        </button>
      </div>
    </form>
  </dialog>
</template>
