<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { prettyError, type Workspace } from '../model';

const api = window.redaction;
const props = defineProps<{ busy: boolean; sourceDirty: boolean; isImportOpen: () => boolean }>();
const emit = defineEmits<{
  busy: [value: boolean];
  adopt: [workspace: Workspace];
  redact: [];
  notice: [text: string, error?: boolean, brief?: boolean];
}>();

const closeDialog = ref<HTMLDialogElement>();
const projectBusy = ref(false);
const closeError = ref('');
const passwordDialog = ref<HTMLDialogElement>();
const passwordInput = ref<HTMLInputElement>();
const confirmationInput = ref<HTMLInputElement>();
const filenameInput = ref<HTMLInputElement>();
const directoryButton = ref<HTMLButtonElement>();
type PasswordPrompt = {kind: 'unlock'; title: string} | {kind: 'set'; protected: boolean} | {kind: 'remove'}
  | {kind: 'save'; saveAs: boolean; closeAfter: boolean; protected: boolean; name: string; directory: string};
const passwordPrompt = ref<PasswordPrompt | null>(null);
const saveDestination = reactive({name: '', directory: ''});
const saveProtection = ref<'none' | 'keep' | 'new'>('none');
const projectPassword = ref('');
const passwordConfirmation = ref('');
const passwordError = ref('');
const settingPassword = computed(() => passwordPrompt.value?.kind === 'set'
  || passwordPrompt.value?.kind === 'save' && saveProtection.value === 'new');
const passwordTitle = computed(() => {
  const prompt = passwordPrompt.value;
  if (prompt?.kind === 'unlock') return '解锁项目';
  if (prompt?.kind === 'remove') return '移除项目密码';
  if (prompt?.kind === 'save') return prompt.saveAs ? '项目另存为' : '保存项目';
  return prompt?.protected ? '修改项目密码' : '设置项目密码';
});

async function projectAction(command: 'open' | 'save' | 'saveAs', closeAfter = false) {
  if (projectBusy.value || (!closeAfter && props.isImportOpen()) || (command === 'open' && props.busy)) return;
  if (command !== 'open' && props.sourceDirty) {
    const message = '请先应用或取消原文修改，再保存项目。';
    if (closeAfter) closeError.value = message;
    else emit('notice', message, true);
    emit('redact');
    return;
  }
  projectBusy.value = true;
  if (command === 'open') emit('busy', true);
  closeError.value = '';
  try {
    if (command === 'open') {
      const result = await api.openProject();
      if (result && 'locked' in result) await showPasswordPrompt({kind:'unlock', title: result.title});
      else if (result) emit('adopt', result.view);
      return;
    }
    const status = await api.projectSaveStatus();
    const saveAs = command === 'saveAs';
    if (!status.hasFile || saveAs) {
      if (closeAfter) closeDialog.value?.close();
      await showPasswordPrompt({kind:'save', saveAs, closeAfter, ...status});
      return;
    }
    const saved = await api.saveProject();
    if (saved) await completeProjectSave(saved, closeAfter);
  } catch (error) {
    if (closeAfter) showCloseError(prettyError(error));
    else emit('notice', prettyError(error), true);
  } finally {
    if (command === 'open') emit('busy', false);
    projectBusy.value = false;
  }
}

function showCloseError(message: string) {
  closeError.value = message;
  if (!closeDialog.value?.open) closeDialog.value?.showModal();
}

async function completeProjectSave(saved: {dirty: boolean}, closeAfter: boolean) {
  if (!closeAfter) {
    emit('notice', saved.dirty ? '已保存本次快照，仍有新修改未保存。' : '项目已保存', false, true);
  } else if (saved.dirty) {
    showCloseError('保存期间有新修改。请再次保存后关闭。');
  } else {
    await api.closeWorkspace(false);
  }
}

watch(saveProtection, () => {
  if (passwordPrompt.value?.kind !== 'save') return;
  projectPassword.value = '';
  passwordConfirmation.value = '';
  passwordError.value = '';
});

async function showPasswordPrompt(prompt: PasswordPrompt, startWithPassword = false) {
  projectPassword.value = '';
  passwordConfirmation.value = '';
  passwordError.value = '';
  if (prompt.kind === 'save') {
    saveDestination.name = prompt.name;
    saveDestination.directory = prompt.directory;
    saveProtection.value = startWithPassword ? 'new' : prompt.protected ? 'keep' : 'none';
  }
  passwordPrompt.value = prompt;
  await nextTick();
  if (!passwordDialog.value?.open) passwordDialog.value?.showModal();
  if (prompt.kind === 'save' && !startWithPassword) filenameInput.value?.select();
  else passwordInput.value?.focus();
}

function closePasswordPrompt(cancel = false) {
  const prompt = passwordPrompt.value;
  if (cancel && prompt?.kind === 'unlock') void api.openProject(null).catch(() => {});
  passwordDialog.value?.close();
  passwordPrompt.value = null;
  projectPassword.value = '';
  passwordConfirmation.value = '';
  passwordError.value = '';
  if (cancel && prompt?.kind === 'save' && prompt.closeAfter) closeDialog.value?.showModal();
}

async function manageProjectPassword() {
  if (projectBusy.value || props.busy) return;
  if (props.sourceDirty) {
    emit('redact');
    emit('notice', '请先应用或取消原文修改，再设置项目密码。', true);
    return;
  }
  projectBusy.value = true;
  try {
    const status = await api.projectSaveStatus();
    if (status.hasFile) await showPasswordPrompt({kind:'set', protected: status.protected});
    else await showPasswordPrompt({kind:'save', saveAs: false, closeAfter: false, ...status}, true);
  } catch (error) {
    emit('notice', prettyError(error), true);
  } finally {
    projectBusy.value = false;
  }
}

async function chooseProjectDirectory() {
  if (projectBusy.value || passwordPrompt.value?.kind !== 'save') return;
  projectBusy.value = true;
  try {
    const directory = await api.pickProjectDirectory(saveDestination.directory);
    if (directory) {
      saveDestination.directory = directory;
      passwordError.value = '';
    }
  } catch (error) {
    passwordError.value = prettyError(error);
  } finally {
    projectBusy.value = false;
    await nextTick();
    directoryButton.value?.focus();
  }
}

function toggleSaveProtection(event: Event) {
  const prompt = passwordPrompt.value;
  if (prompt?.kind !== 'save') return;
  const enabled = (event.target as HTMLInputElement).checked;
  saveProtection.value = !enabled ? 'none' : prompt.protected ? 'keep' : 'new';
}

async function submitProjectPassword() {
  const prompt = passwordPrompt.value;
  if (!prompt || projectBusy.value) return;
  const entered = projectPassword.value;
  if (prompt.kind === 'save' && !saveDestination.name.trim()) {
    passwordError.value = '请输入项目文件名。';
    filenameInput.value?.focus();
    return;
  }
  if ((prompt.kind === 'unlock' || settingPassword.value) && !entered.trim()) {
    passwordError.value = '请输入项目密码。';
    void nextTick(() => passwordInput.value?.focus());
    return;
  }
  if (settingPassword.value && entered !== passwordConfirmation.value) {
    passwordError.value = '两次输入的密码不一致。';
    void nextTick(() => confirmationInput.value?.focus());
    return;
  }
  projectBusy.value = true;
  passwordError.value = '';
  try {
    if (prompt.kind === 'unlock') {
      projectPassword.value = '';
      const result = await api.openProject(entered);
      if (result && 'view' in result) emit('adopt', result.view);
      closePasswordPrompt();
    } else if (prompt.kind === 'save') {
      const password = saveProtection.value === 'new' ? entered
        : saveProtection.value === 'none' && prompt.protected ? null : undefined;
      const saved = await api.saveProject(password, {...saveDestination});
      if (saved) {
        closePasswordPrompt();
        await completeProjectSave(saved, prompt.closeAfter);
      }
    } else {
      const saved = await api.saveProject(prompt.kind === 'remove' ? null : entered);
      if (saved) {
        closePasswordPrompt();
        emit('notice', saved.dirty ? '项目密码已更新，仍有新修改未保存。'
          : prompt.kind === 'remove' ? '已移除项目密码' : '已保存加密项目', false, true);
      }
    }
  } catch (error) {
    if (!passwordDialog.value?.open && prompt.kind === 'save' && prompt.closeAfter) showCloseError(prettyError(error));
    else passwordError.value = prettyError(error);
  } finally {
    projectBusy.value = false;
    if (prompt.kind === 'unlock') passwordInput.value?.focus();
  }
}

api.onProjectCommand(command => {
  if (document.querySelector('dialog[open]')) return;
  if (command === 'password') void manageProjectPassword();
  else void projectAction(command);
});
api.onConfirmClose(() => {
  if (!closeDialog.value || closeDialog.value.open) return;
  if (passwordDialog.value?.open) closePasswordPrompt(true);
  if (closeDialog.value.open) return;
  closeError.value = '';
  closeDialog.value.showModal();
});

defineExpose({ projectBusy, projectAction, unlock: (title: string) => showPasswordPrompt({kind: 'unlock', title}) });
</script>

<template>
  <dialog ref="passwordDialog" class="project-password-dialog" aria-labelledby="project-password-title"
    :class="{'project-save-dialog': passwordPrompt?.kind === 'save'}"
    @cancel.prevent="!projectBusy && closePasswordPrompt(true)">
    <form v-if="passwordPrompt" class="dialog-form" @submit.prevent="submitProjectPassword">
      <div class="dialog-heading"><h2 id="project-password-title">{{ passwordTitle }}</h2></div>
      <template v-if="passwordPrompt.kind === 'unlock'">
        <p>请输入「{{ passwordPrompt.title }}」的密码。</p>
        <label>项目密码<input ref="passwordInput" v-model="projectPassword" type="password" :readonly="projectBusy" autocomplete="off"></label>
      </template>
      <p v-else-if="passwordPrompt.kind === 'remove'">移除密码后，项目文件将以明文保存。</p>
      <div v-if="passwordPrompt.kind === 'save'" class="project-save-fields">
        <label for="project-filename">文件名</label>
        <div class="project-filename">
          <input id="project-filename" ref="filenameInput" v-model="saveDestination.name" :readonly="projectBusy" type="text" spellcheck="false">
          <span aria-hidden="true">.lrproj</span>
        </div>
        <div class="project-field-label" id="project-location-label">保存位置</div>
        <div class="project-save-location" role="group" aria-labelledby="project-location-label">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>
          </svg>
          <span :title="saveDestination.directory">{{ saveDestination.directory }}</span>
          <button ref="directoryButton" type="button" class="button small quiet" :disabled="projectBusy" @click="chooseProjectDirectory">更改…</button>
        </div>
      </div>
      <div v-if="passwordPrompt.kind === 'set' || passwordPrompt.kind === 'save'" class="project-password-fields"
        :class="{'save-password-options': passwordPrompt.kind === 'save'}">
        <div v-if="passwordPrompt.kind === 'save'" class="save-password-row">
          <label class="save-password-toggle">
            <input type="checkbox" role="switch" :checked="saveProtection !== 'none'" :disabled="projectBusy"
              @change="toggleSaveProtection">
            <span>密码保护</span>
          </label>
          <div v-if="passwordPrompt.protected && saveProtection !== 'none'" class="save-password-inheritance">
            <span v-if="saveProtection === 'keep'" class="count">沿用当前密码</span>
            <button type="button" class="button small quiet" :disabled="projectBusy"
              @click="saveProtection = saveProtection === 'keep' ? 'new' : 'keep'">
              {{ saveProtection === 'keep' ? '更换密码' : '沿用当前密码' }}
            </button>
          </div>
        </div>
        <div v-if="settingPassword" class="project-password-inputs">
          <label>新密码<input ref="passwordInput" v-model="projectPassword" type="password" :readonly="projectBusy" autocomplete="new-password"></label>
          <label>确认密码<input ref="confirmationInput" v-model="passwordConfirmation" type="password" :readonly="projectBusy" autocomplete="new-password"></label>
        </div>
        <p v-if="settingPassword" class="count">忘记密码后将无法打开加密的项目文件。</p>
        <p v-else-if="passwordPrompt.kind === 'save' && passwordPrompt.protected && saveProtection === 'none'" class="count">副本将以明文保存。</p>
      </div>
      <p v-if="passwordError" class="form-error" role="alert">{{ passwordError }}</p>
      <div class="dialog-actions">
        <button v-if="passwordPrompt.kind === 'set' && passwordPrompt.protected" type="button" class="button quiet"
          :disabled="projectBusy" @click="showPasswordPrompt({kind:'remove'})">移除密码</button>
        <button type="button" class="button" :disabled="projectBusy" @click="closePasswordPrompt(true)">取消</button>
        <button type="submit" class="button primary" :disabled="projectBusy">
          {{ passwordPrompt.kind === 'unlock' ? '解锁' : passwordPrompt.kind === 'save' ? (passwordPrompt.saveAs ? '保存副本' : '保存')
            : passwordPrompt.kind === 'remove' ? '移除并保存' : '保存加密项目' }}
        </button>
      </div>
    </form>
  </dialog>

  <dialog ref="closeDialog" class="close-workspace-dialog" aria-labelledby="close-title" aria-describedby="close-description"
    @cancel.prevent="!projectBusy && closeDialog?.close()">
    <div class="dialog-form">
      <div class="dialog-heading"><h2 id="close-title">{{ sourceDirty ? '原文有未应用的修改' : '保存项目修改？' }}</h2></div>
      <p id="close-description">{{ sourceDirty ? '可先返回编辑并应用，或放弃未保存的修改并关闭。' : '当前项目有未保存的修改。' }}</p>
      <p v-if="closeError" class="form-error" role="alert">{{ closeError }}</p>
      <div class="dialog-actions">
        <button type="button" class="button" autofocus :disabled="projectBusy" @click="closeDialog?.close(); sourceDirty && emit('redact')">
          {{ sourceDirty ? '返回编辑' : '取消' }}
        </button>
        <button type="button" class="button" :disabled="projectBusy" @click="api.closeWorkspace(true)">放弃修改</button>
        <button v-if="!sourceDirty" type="button" class="button primary" :disabled="projectBusy" @click="projectAction('save', true)">
          {{ projectBusy ? '正在保存…' : '保存并关闭' }}
        </button>
      </div>
    </div>
  </dialog>
</template>
