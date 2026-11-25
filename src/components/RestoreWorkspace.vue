<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { restoreText, type RestoreOccurrence } from '../../engine/restore';
import { prettyError, type Group, type SourceFile } from '../model';

const props = defineProps<{ groups: Group[]; notice: { text: string; error: boolean } }>();
const emit = defineEmits<{ notice: [text: string, error?: boolean, brief?: boolean] }>();
const api = window.redaction;
const text = ref('');
const source = ref<Pick<SourceFile, 'title' | 'path'> | null>(null);
const encodingTitle = ref('');
const busy = ref(false);
const editing = ref(true);
const editor = ref<HTMLTextAreaElement>();
const workbench = ref<HTMLElement>();
const sides = ['input', 'output'] as const;
const selected = ref<number | null>(null);
const result = computed(() => restoreText(text.value, props.groups));
const unmatched = computed(() => result.value.occurrences.filter(row => row.value === null).length);
const selectedCode = computed(() => selected.value === null ? null : result.value.occurrences[selected.value]?.code);

const pieces = computed(() => {
  const parts: { text: string; occurrence?: RestoreOccurrence }[] = [];
  let cursor = 0;
  for (const occurrence of result.value.occurrences) {
    if (cursor < occurrence.start) parts.push({ text: text.value.slice(cursor, occurrence.start) });
    parts.push({ text: occurrence.code, occurrence });
    cursor = occurrence.end;
  }
  if (cursor < text.value.length) parts.push({ text: text.value.slice(cursor) });
  return parts;
});
const mappings = computed(() => {
  const rows = new Map<string, RestoreOccurrence[]>();
  for (const occurrence of result.value.occurrences) {
    const entries = rows.get(occurrence.code);
    if (entries) entries.push(occurrence);
    else rows.set(occurrence.code, [occurrence]);
  }
  return [...rows.values()];
});
watch(result, () => { selected.value = null; });

async function select(occurrence: RestoreOccurrence) {
  editing.value = false;
  selected.value = occurrence.id;
  await nextTick();
  const first = mappings.value.find(rows => rows[0].code === occurrence.code)?.[0];
  workbench.value?.querySelector(`[data-restore-group="${first?.id}"]`)?.scrollIntoView({ block: 'nearest' });
  for (const mark of workbench.value?.querySelectorAll(`mark[data-restore-item="${occurrence.id}"]`) ?? []) {
    mark.scrollIntoView({ block: 'nearest' });
  }
}

function edit() {
  editing.value = true;
  void nextTick(() => editor.value?.focus());
}

function setEditor(element: unknown) {
  editor.value = element instanceof HTMLTextAreaElement ? element : undefined;
}

function paste(event: ClipboardEvent) {
  const area = editor.value;
  const pasted = event.clipboardData?.getData('text/plain');
  if (!area || !pasted || area.selectionStart !== 0 || area.selectionEnd !== area.value.length) return;
  event.preventDefault();
  source.value = null;
  encodingTitle.value = '';
  text.value = pasted;
  editing.value = false;
}

function useFile(file: SourceFile) {
  source.value = { title: file.title, path: file.path };
  text.value = file.text;
  encodingTitle.value = '';
  editing.value = false;
}

async function openFile(retry = false) {
  if (busy.value) return;
  busy.value = true;
  emit('notice', '');
  try {
    const file = retry ? await api.decodeImport('restore') : await api.open('restore');
    if (!file) return;
    if ('requiresEncoding' in file) encodingTitle.value = file.title;
    else useFile(file);
  } catch (error) {
    if (!retry) encodingTitle.value = '';
    emit('notice', prettyError(error), true);
  } finally {
    busy.value = false;
  }
}

async function output(kind: 'copy' | 'file') {
  if (busy.value || !text.value.trim()) return;
  busy.value = true;
  try {
    const output = result.value.output;
    if (kind === 'copy') {
      await api.copy(output);
      emit('notice', '已复制到剪贴板', false, true);
    } else {
      const file = source.value;
      const path = await api.save(output, file ? [file.path] : [], file ? `${file.title}_恢复.txt` : '恢复文本.txt', 'restore');
      if (path) emit('notice', '已导出 TXT', false, true);
    }
  } catch (error) {
    emit('notice', prettyError(error), true);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="workspace-main restore-workspace">
    <div v-if="notice.text" class="notice" :class="{ error: notice.error }" role="status">{{ notice.text }}</div>
    <div v-if="encodingTitle" class="notice" role="status">
      <span>「{{ encodingTitle }}」需要选择编码</span>
      <div class="toolbar">
        <button class="button small" :disabled="busy" @click="openFile(true)">简体中文（GB18030）</button>
        <button class="button small quiet" :disabled="busy" @click="encodingTitle = ''">取消</button>
      </div>
    </div>
    <div ref="workbench" class="workbench">
      <section class="reader" aria-label="恢复对照">
        <div class="panes">
          <article v-for="side in sides" :key="side" class="pane" :aria-label="side === 'input' ? '待恢复文本' : '恢复预览'">
            <div class="pane-title output-heading">
              <span v-if="side === 'input'">待恢复文本</span>
              <span v-else>恢复预览 <small class="restore-source-note">按当前项目映射恢复</small></span>
              <div v-if="side === 'input'" class="toolbar pane-output-actions">
                <button class="button small" :disabled="busy" @click="openFile()">打开 TXT</button>
                <button v-if="!editing" class="button small" :disabled="busy" @click="edit">编辑</button>
                <button v-else-if="text" class="button small" :disabled="busy" @click="editing = false">完成</button>
              </div>
              <div v-else class="toolbar pane-output-actions">
                <button class="button small" :disabled="busy || !text.trim()" @click="output('copy')">复制文本</button>
                <button class="button small primary" :disabled="busy || !text.trim()" @click="output('file')">导出 TXT</button>
              </div>
            </div>
            <textarea v-if="side === 'input' && editing" :ref="setEditor" v-model="text"
              class="restore-editor document-text" aria-label="待恢复文本" placeholder="粘贴待恢复文本" @paste="paste"></textarea>
            <div v-else class="pane-scroll">
              <div class="document-text" :data-restore-text="side"><template v-for="(piece, index) in pieces" :key="index"><mark
                v-if="piece.occurrence" :data-restore-item="piece.occurrence.id"
                :class="['color-person', { 'review-state': piece.occurrence.value === null, selected: selected === piece.occurrence.id }]"
                role="button" tabindex="0"
                :aria-label="piece.occurrence.value === null ? `未匹配 ${piece.text}` : `${piece.text} → ${piece.occurrence.value}`"
                @click="select(piece.occurrence)" @keydown.enter.prevent="select(piece.occurrence)"
                @keydown.space.prevent="select(piece.occurrence)"
              >{{ side === 'output' ? piece.occurrence.value ?? piece.text : piece.text }}</mark><template v-else>{{ piece.text }}</template></template></div>
            </div>
          </article>
        </div>
      </section>
      <section class="card review" aria-label="恢复映射清单">
        <header class="review-heading">
          <h2>映射清单</h2>
          <span v-if="result.occurrences.length" class="count">恢复 {{ result.occurrences.length - unmatched }} 处</span>
        </header>
        <div class="review-list">
          <p v-if="text.trim() && !mappings.length" class="muted-empty">没有可匹配的代号</p>
          <div v-for="rows in mappings" :key="rows[0].code" class="mapping"
            :class="{ 'mapping-selected': selectedCode === rows[0].code }">
            <button class="mapping-toggle restore-mapping" :data-restore-group="rows[0].id"
              :aria-expanded="selectedCode === rows[0].code" @click="select(rows[0])">
              <span class="mapping-title">
                <strong>{{ rows[0].code }}</strong>
                <template v-if="rows[0].value !== null">
                  <span class="mapping-arrow"> → </span><span>{{ rows[0].value }}</span>
                </template>
                <span v-else class="chip group-review">未匹配</span>
              </span>
              <span class="count">{{ rows.length }} 处</span>
            </button>
            <template v-if="selectedCode === rows[0].code">
              <button v-for="(row, index) in rows" :key="row.id" class="occurrence" :class="{ current: selected === row.id }"
                @click="select(row)">第 {{ row.line }} 行 · 第 {{ index + 1 }} 处</button>
            </template>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.restore-editor { flex: 1; min-height: 0; width: 100%; border: 0; border-radius: 0; resize: none; padding: 13px 17px; }
.restore-editor:focus-visible { outline-offset: -2px; }
.restore-source-note { margin-inline-start: 6px; color: var(--muted); font-size: 11px; font-weight: 400; }
.restore-mapping { width: 100%; justify-content: space-between; }
.restore-mapping .count { flex: none; }
.restore-mapping .group-review { margin-inline-start: 6px; }
</style>
