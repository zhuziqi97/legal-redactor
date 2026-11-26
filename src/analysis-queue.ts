import { reactive, ref, type Ref } from 'vue';
import { prettyError, type Workspace } from './model';

export function useAnalysisQueue(workspace: Readonly<Ref<Workspace>>, adopt: (view: Workspace) => void,
  announce: (message: string, error: boolean) => void) {
  const api = window.redaction;
  const scanning = ref<string | null>(null);
  const queued = ref<string[]>([]);
  const queuedAt = new Map<string, number>();
  const scanPhases = reactive<Record<string, string>>({});
  const scanErrors = reactive<Record<string, string>>({});

  function identify(id = workspace.value.current?.id) {
    const doc = workspace.value.documents.find(item => item.id === id);
    if (!doc || doc.status === 'ready' || queued.value.includes(doc.id)) return;
    if (scanning.value === id && !scanPhases[doc.id]?.startsWith('正在取消')) return;
    delete scanErrors[doc.id];
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
      const result = await api.engine({ op: 'scan', materialId: id, revision: doc.revision, queueMs });
      if (result.view.revision >= workspace.value.revision) {
        const renderStart = performance.now();
        adopt(result.view);
        if (workspace.value.current?.id === id) {
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

  function removeFromQueue(id: string) {
    queued.value = queued.value.filter(value => value !== id);
    queuedAt.delete(id);
    delete scanErrors[id];
    delete scanPhases[id];
  }

  return { scanning, queued, scanPhases, scanErrors, identify, startNextAnalysis, cancelScan, removeFromQueue };
}
