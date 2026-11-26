<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { defaultPreferences, editableSettings, fontLabels, fontSizes, inferenceBackendLabels, isSettingsSection, sections,
  viewKeys, viewLabels, type InferenceBackend, type PreferenceSnapshot, type SettingsChanges, type SettingsSection,
  type UpdateStatus } from '../../engine/preferences';
import { prettyError } from '../model';

const api = window.redaction;
const target = new URLSearchParams(window.location.search).get('section');
const defaults = defaultPreferences();
const section = ref<SettingsSection>(isSettingsSection(target) ? target : defaults.usage.section);
const sectionKeys = Object.keys(sections) as SettingsSection[];
const saved = shallowRef(editableSettings(defaults));
const changes = shallowRef<SettingsChanges>({});
const resetting = ref(false);
const baseline = computed(() => resetting.value ? editableSettings(defaults) : saved.value);
const draft = computed(() => ({ ...baseline.value, ...changes.value }));
const dirty = computed(() => resetting.value || Object.keys(changes.value).length > 0);
const warning = ref('');
const ready = ref(false);
const saving = ref(false);
const error = ref('');
const message = ref('');
const backends = shallowRef<InferenceBackend[]>([]);
const previousBackend = computed(() => backends.value.some(backend => backend === baseline.value.provider)
  ? undefined : baseline.value.provider);
const version = ref('');
const update = shallowRef<UpdateStatus>({ kind: 'idle' });
const license = ref('');
const licenseDialog = ref<HTMLDialogElement>();

const updateText = computed(() => {
  switch (update.value.kind) {
    case 'idle': return '';
    case 'checking': return '正在检查更新…';
    case 'current': return '已是最新版。';
    case 'available': {
      const size = update.value.size ?? 0;
      const display = size >= 1e9 ? `${(size / 1e9).toFixed(2)} GB` : `${Math.ceil(size / 1e6)} MB`;
      return `发现新版 ${update.value.version} · ${display}`;
    }
    case 'unavailable': return `发现新版 ${update.value.version}，暂无适用于当前平台的发行包。`;
    case 'error': return update.value.message;
  }
});

function apply(snapshot: PreferenceSnapshot) {
  saved.value = editableSettings(snapshot.settings);
  warning.value = snapshot.warning;
}

api.onPreferencesChanged(apply);
api.onSettingsSection(next => { section.value = next; });
api.onUpdateStatus(status => { update.value = status; });
onMounted(async () => {
  window.addEventListener('beforeunload', confirmClose);
  try {
    const [snapshot, info] = await Promise.all([api.preferences(), api.settingsInfo()]);
    apply(snapshot);
    version.value = info.version;
    update.value = info.update;
    backends.value = info.backends;
    if (!target && section.value === defaults.usage.section) section.value = snapshot.settings.usage.section;
    ready.value = true;
  } catch (failure) { error.value = prettyError(failure); }
});
onUnmounted(() => window.removeEventListener('beforeunload', confirmClose));

function confirmClose(event: BeforeUnloadEvent) {
  if (!dirty.value || saving.value) return;
  event.preventDefault();
  event.returnValue = '';
}

async function saveSettings() {
  if (saving.value || !dirty.value) return;
  saving.value = true;
  error.value = '';
  message.value = '';
  try {
    apply(await api.applySettings(changes.value, resetting.value));
    changes.value = {};
    resetting.value = false;
    message.value = '设置已应用。';
  }
  catch (failure) { error.value = prettyError(failure); }
  finally { saving.value = false; }
}

function openSection(page: SettingsSection) {
  section.value = page;
  void api.changePreferences({ section: page }).catch(failure => { error.value = prettyError(failure); });
}

function edit(key: keyof SettingsChanges, event: Event) {
  const control = event.currentTarget as HTMLInputElement | HTMLSelectElement;
  const value = control instanceof HTMLInputElement ? control.checked
    : key === 'fontSize' ? Number(control.value) : control.value;
  const next = { ...changes.value, [key]: value };
  if (value === baseline.value[key]) delete next[key];
  changes.value = next;
  message.value = '';
}

function reset() {
  changes.value = {};
  resetting.value = true;
  message.value = '';
  error.value = '';
}

async function external(action: () => Promise<void>) {
  error.value = '';
  try { await action(); } catch (failure) { error.value = prettyError(failure); }
}

function showLicense() {
  void external(async () => {
    if (!license.value) license.value = await api.readProductLicense();
    licenseDialog.value?.showModal();
  });
}
</script>

<template>
  <main class="settings-window">
    <nav class="settings-navigation" aria-label="设置分区">
      <h1>设置</h1>
      <button v-for="key in sectionKeys" :key="key" class="settings-nav-button" :disabled="!ready || saving"
        :aria-current="key === section ? 'page' : undefined" @click="openSection(key)">{{ sections[key] }}</button>
    </nav>
    <div class="settings-main">
      <section class="settings-content" :aria-label="sections[section]">
        <h2>{{ sections[section] }}</h2>
        <fieldset v-if="section === 'reading'" :disabled="!ready || saving">
          <div class="settings-row reading-controls">
            <label>正文字体
              <select :value="draft.font" @change="edit('font', $event)">
                <option v-for="(name, key) in fontLabels" :key="key" :value="key">{{ name }}</option>
              </select>
            </label>
            <label>正文字号
              <select :value="draft.fontSize" @change="edit('fontSize', $event)">
                <option v-for="size in fontSizes" :key="size" :value="size">{{ size }} px</option>
              </select>
            </label>
          </div>
          <div class="reading-preview" :data-reading-font="draft.font" :style="{ '--reading-size': draft.fontSize + 'px' }">
            <p class="document-text">经核对，【当事人1】于 2026 年 3 月 12 日提交材料。</p>
          </div>
          <div class="settings-toggles">
            <label v-for="key in viewKeys" :key="key" class="settings-toggle">
              <span>{{ viewLabels[key] }}</span><input type="checkbox" :checked="draft[key]" @change="edit(key, $event)">
            </label>
          </div>
        </fieldset>
        <fieldset v-else-if="section === 'habits'" :disabled="!ready || saving">
          <label class="settings-select-row">启动时
            <select :value="draft.startupProject" @change="edit('startupProject', $event)">
              <option value="empty">打开空项目</option><option value="last">打开上次的项目</option>
            </select>
          </label>
          <div class="settings-toggles">
            <label class="settings-toggle">记忆窗口位置
              <input type="checkbox" :checked="draft.rememberWindowPosition" @change="edit('rememberWindowPosition', $event)">
            </label>
            <label class="settings-toggle">记忆上次打开的文件夹
              <input type="checkbox" :checked="draft.rememberFolders" @change="edit('rememberFolders', $event)">
            </label>
          </div>
        </fieldset>
        <fieldset v-else-if="section === 'inference'" :disabled="!ready || saving">
          <label class="settings-select-row">推理后端
            <select :value="draft.provider" @change="edit('provider', $event)">
              <option v-for="backend in backends" :key="backend" :value="backend">{{ inferenceBackendLabels[backend] }}</option>
              <option v-if="previousBackend" :value="previousBackend">{{ previousBackend }}（上次选择）</option>
            </select>
          </label>
        </fieldset>
        <fieldset v-else-if="section === 'updates'" :disabled="!ready || saving">
          <label class="settings-toggle">
            <span>自动检查更新</span><input type="checkbox" :checked="draft.automaticUpdates" @change="edit('automaticUpdates', $event)">
          </label>
          <div class="settings-update">
            <div class="settings-version-row">
              <span>当前版本 <strong>{{ version }}</strong></span>
              <button class="button" :disabled="update.kind === 'checking'" @click="external(api.checkUpdates)">立即检查</button>
            </div>
            <p v-if="updateText" class="settings-hint" role="status">{{ updateText }}</p>
            <div v-if="update.kind === 'available' || update.kind === 'unavailable'" class="toolbar">
              <button v-if="update.kind === 'available'" class="button primary" @click="external(() => api.openProductLink('download'))">下载</button>
              <button class="button" @click="external(() => api.openProductLink('release'))">查看更新说明</button>
            </div>
          </div>
        </fieldset>
        <div v-else class="settings-about">
          <img src="/legal-redactor-icon.png" width="58" height="58" alt="">
          <div>
            <h3>LegalRedactor</h3>
            <p>法律文档脱敏工具 · {{ version }}</p>
            <div class="toolbar">
              <button class="button" @click="external(() => api.openProductLink('homepage'))">项目主页</button>
              <button class="button" @click="showLicense">开源许可</button>
            </div>
          </div>
        </div>
      </section>
      <footer class="settings-footer">
        <p v-if="error || warning" class="form-error" role="alert">{{ error || warning }}</p>
        <p v-else-if="message" class="settings-hint" role="status">{{ message }}</p>
        <div class="toolbar settings-actions">
          <button class="button" :disabled="!ready || saving" @click="reset">恢复默认设置</button>
          <button class="button primary" :disabled="!ready || saving || !dirty" @click="saveSettings">{{ saving ? '正在应用…' : '应用' }}</button>
        </div>
      </footer>
    </div>
  </main>
  <dialog ref="licenseDialog" class="settings-license" aria-labelledby="license-title">
    <form method="dialog" class="dialog-form">
      <div class="dialog-heading"><h2 id="license-title">开源许可</h2></div>
      <pre>{{ license }}</pre>
      <div class="dialog-actions"><button class="button">关闭</button></div>
    </form>
  </dialog>
</template>
