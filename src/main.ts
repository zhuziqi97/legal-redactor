import { createApp, h } from 'vue';
import App from './App.vue';
import SettingsWindow from './components/SettingsWindow.vue';
import WindowTitleBar from './components/WindowTitleBar.vue';
import './style.css';

const isSettings = new URLSearchParams(window.location.search).has('settings');
createApp({ render: () => [h(WindowTitleBar, { isSettings }), h(isSettings ? SettingsWindow : App)] }).mount('#app');
