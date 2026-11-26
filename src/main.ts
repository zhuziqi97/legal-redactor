import { createApp } from 'vue';
import App from './App.vue';
import SettingsWindow from './components/SettingsWindow.vue';
import './style.css';

const isSettings = new URLSearchParams(window.location.search).has('settings');
createApp(isSettings ? SettingsWindow : App).mount('#app');
