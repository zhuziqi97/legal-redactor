<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import type { WindowChrome } from '../../electron/contract';
import { defaultPreferences } from '../../engine/preferences';

const props = defineProps<{ isSettings: boolean }>();
const api = window.redaction;
const title = ref(props.isSettings ? '设置' : '未命名项目');
const mac = ref(false);
const menus = shallowRef<WindowChrome['menus']>([]);
const view = shallowRef(defaultPreferences().view);
const menuBar = ref<HTMLElement>();
const active = ref(0);
const opened = ref(-1);
let priorFocus: HTMLElement | null = null;

const triggers = () => menuBar.value?.querySelectorAll<HTMLButtonElement>('.title-menu-trigger');
const commands = () => Array.from(menuBar.value?.querySelectorAll<HTMLButtonElement>('.title-menu-command') ?? []);

function showMenu(index: number, last = false) {
  if (opened.value === -1) priorFocus = document.activeElement as HTMLElement | null;
  active.value = opened.value = index;
  void nextTick(() => commands().at(last ? -1 : 0)?.focus());
}

function closeMenu(restoreFocus = false) {
  if (opened.value === -1) return;
  opened.value = -1;
  if (restoreFocus) priorFocus?.focus({ preventScroll: true });
  priorFocus = null;
}

function runCommand(menu: number, item: number) {
  closeMenu(true);
  void api.runWindowMenu(menu, item);
}

function handleKeys(event: KeyboardEvent) {
  const { key } = event;
  if (key === 'Tab') {
    closeMenu(true);
    return;
  }
  if (key === 'Escape' && opened.value !== -1) {
    closeMenu(true);
  } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const count = menus.value.length;
    const delta = key === 'ArrowLeft' ? -1 : 1;
    active.value = (active.value + count + delta) % count;
    if (opened.value === -1) triggers()?.[active.value]?.focus();
    else showMenu(active.value);
  } else if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
    const items = commands();
    if (opened.value !== -1 && items.length) {
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const delta = key === 'ArrowUp' ? -1 : 1;
      const next = key === 'Home' ? 0 : key === 'End' ? items.length - 1 : (current + items.length + delta) % items.length;
      items[next]?.focus();
    } else if (key === 'ArrowDown' || key === 'ArrowUp') {
      showMenu(active.value, key === 'ArrowUp');
    } else {
      active.value = key === 'Home' ? 0 : menus.value.length - 1;
      triggers()?.[active.value]?.focus();
    }
  } else {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
}

function dismissOutside(event: PointerEvent) {
  if (!menuBar.value?.contains(event.target as Node)) closeMenu();
}
const dismissOnBlur = () => closeMenu();

onMounted(async () => {
  if (!props.isSettings) {
    api.onWindowTitle(value => { title.value = value; });
    api.onPreferencesChanged(({ settings }) => { view.value = settings.view; });
  }
  const chrome = await api.windowChrome();
  title.value = chrome.title;
  mac.value = chrome.mac;
  menus.value = chrome.menus;
  view.value = chrome.view;
});
document.addEventListener('pointerdown', dismissOutside);
window.addEventListener('blur', dismissOnBlur);
onUnmounted(() => {
  document.removeEventListener('pointerdown', dismissOutside);
  window.removeEventListener('blur', dismissOnBlur);
});
</script>

<template>
  <header class="title-bar">
    <div class="title-bar-start">
      <img v-if="!mac && !isSettings" class="title-bar-icon" src="/legal-redactor-icon.png" alt="">
      <nav v-if="menus.length" ref="menuBar" class="title-menu-bar" role="menubar" aria-label="应用菜单" @keydown="handleKeys">
        <div v-for="(menu, index) in menus" :key="menu.label" role="none" class="title-menu">
          <button type="button" class="title-menu-trigger" role="menuitem" aria-haspopup="menu"
            :aria-expanded="opened === index" :tabindex="active === index ? 0 : -1"
            @focus="active = index" @pointerdown.left.prevent
            @pointerenter="opened !== -1 && opened !== index && showMenu(index)"
            @click="opened === index ? closeMenu(true) : showMenu(index)">{{ menu.label }}</button>
          <div v-if="opened === index" class="title-menu-popup" role="menu" :aria-label="menu.label">
            <template v-for="(item, itemIndex) in menu.items" :key="itemIndex">
              <div v-if="item.type === 'separator'" class="title-menu-divider" role="separator"></div>
              <button v-else type="button" class="title-menu-command" tabindex="-1"
                :role="item.viewSwitch ? 'menuitemcheckbox' : 'menuitem'"
                :aria-checked="item.viewSwitch ? view[item.viewSwitch] : undefined"
                @click="runCommand(index, itemIndex)">
                <span class="title-menu-check" aria-hidden="true">{{ item.viewSwitch && view[item.viewSwitch] ? '✓' : '' }}</span>
                <span>{{ item.label }}</span>
                <kbd v-if="item.accelerator">{{ item.accelerator }}</kbd>
              </button>
            </template>
          </div>
        </div>
      </nav>
    </div>
    <span class="title-bar-caption">{{ title }}</span>
  </header>
</template>

<style scoped>
.title-bar {
  --caption-start: env(titlebar-area-x, 0px);
  --caption-width: calc(100vw - var(--caption-start) - env(titlebar-area-width, 100vw));
  flex: none;
  display: grid;
  grid-template-columns: minmax(max-content, 1fr) minmax(0, 1.25fr) minmax(var(--caption-width), 1fr);
  align-items: center;
  height: calc(env(titlebar-area-height, 36px) + 1px);
  background: var(--canvas);
  border-bottom: 1px solid var(--line);
  user-select: none;
  app-region: drag;
}
.title-bar-start { display: flex; align-items: center; gap: 8px; padding-inline: calc(11px + var(--caption-start)) 11px; }
.title-bar-icon { width: 21px; height: 21px; }
.title-bar-caption {
  padding-inline: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  text-align: center; font-size: 13px; font-weight: 550; color: var(--muted);
}
.title-menu-bar { display: flex; align-items: center; gap: 2px; app-region: no-drag; }
.title-menu { position: relative; }
.title-menu-trigger { min-height: 28px; padding-inline: 8px; border: 0; border-radius: 5px; font-size: 13px; }
.title-menu-trigger:is(:hover, [aria-expanded='true']) { background: var(--accent-soft); color: var(--accent); }
.title-menu-popup {
  position: absolute; z-index: 20; inset: calc(100% + 4px) auto auto 0;
  min-width: 172px; padding: 4px; border: 1px solid var(--edge); border-radius: 9px;
  background: var(--paper); box-shadow: 0 6px 18px #24355422;
}
.title-menu-command {
  width: 100%; min-height: 32px; display: flex; align-items: center; gap: 7px;
  padding: 4px 8px 4px 5px; border: 0; border-radius: 5px; text-align: start; white-space: nowrap; font-size: 13px;
}
.title-menu-command:is(:hover, :focus-visible) { background: var(--accent-soft); color: var(--accent); }
.title-menu-command:focus-visible { outline-offset: -2px; }
.title-menu-check { width: 13px; flex: none; text-align: center; color: var(--accent); }
.title-menu-command kbd { margin-inline-start: auto; padding-inline-start: 15px; color: var(--muted); font: inherit; font-size: 12px; }
.title-menu-divider { margin: 4px; border-top: 1px solid var(--line); }
</style>
