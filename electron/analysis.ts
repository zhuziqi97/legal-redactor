import type { EngineReply, EngineRequest, WorkspaceJob, WorkspaceResult, WorkspaceWorkerMessage } from './contract.js';
import type { Session, WindowSession } from './session-types.js';
import type { InferenceDevice, InferenceStatus } from '../engine/inference-devices.js';
import type { Preferences } from '../engine/preferences.js';
import type { Request } from '../engine/workspace-types.js';
import type { Prediction } from '../engine/model.js';
const { dialog, utilityProcess } = require('electron') as typeof import('electron');
const { existsSync } = require('node:fs') as typeof import('node:fs');
const { join } = require('node:path') as typeof import('node:path');
const { inferenceBackends } = require('./engine/preferences.js') as typeof import('../engine/preferences.js');
const { cpuDevice, deviceOption, previousDeviceLabel, selectDevice } =
  require('./engine/inference-devices.js') as typeof import('../engine/inference-devices.js');
const { projectChanged, serialize } = require('./workspace-session.cjs') as typeof import('./workspace-session.js');

type AnalysisDependencies = {
  nativeModel?: string;
  rulesOnly: boolean;
  preference: () => Preferences['inference'];
  diagnose: (record: Record<string, unknown>) => void;
  statusChanged: (status: InferenceStatus) => void;
  chooseDevice: () => void;
};

function createAnalysis({nativeModel, rulesOnly, preference, diagnose, statusChanged, chooseDevice}: AnalysisDependencies) {
  const nativeEnabled = !!nativeModel && existsSync(join(nativeModel, 'otter.onnx'));

  type InferenceRoute = {reusedSession: boolean; loadMs: number};
  type InferencePending = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    progress?: (phase: string) => void;
  };

  class InferenceError extends Error {}

  let detectedDevices: InferenceDevice[] = [];
  let environmentReady = Promise.resolve();
  let environmentDetected = false;
  let autoUsesCpu = false;
  let activeDevice = '';

  function selectedDevice(choice = preference().provider) {
    return choice === 'auto' && autoUsesCpu ? cpuDevice : selectDevice(detectedDevices, choice);
  }

  function inferenceStatus(): InferenceStatus {
    const options = [{id: 'auto', label: '自动'}, deviceOption(cpuDevice), ...detectedDevices.map(deviceOption)];
    const {provider, label} = preference();
    const selected = selectedDevice();
    if (!selected) options.push({id: provider, label: previousDeviceLabel(provider, label) + (environmentDetected ? '（不可用）' : '')});
    return {options, selected: environmentDetected ? selected?.name ?? '' : '', active: activeDevice};
  }

  function publishInferenceStatus() {
    statusChanged(inferenceStatus());
  }

  async function probeEnvironment(window: Electron.BrowserWindow) {
    const started = performance.now();
    const allowed = new Set(inferenceBackends(process.platform, process.arch));
    try {
      const { devices, backends } = await infer('discover') as {devices: InferenceDevice[]; backends: string[]};
      detectedDevices = devices.filter(device => allowed.has(device.backend));
      diagnose({stage: 'inference-environment', backends, options: detectedDevices.map(device => device.backend),
        elapsedMs: performance.now() - started});
    } catch (error) {
      diagnose({stage: 'inference-environment', error: String(error), elapsedMs: performance.now() - started});
    }
    environmentDetected = true;
    publishInferenceStatus();
    if (!selectedDevice() && !window.isDestroyed()) {
      void dialog.showMessageBox(window, {
        type: 'warning', message: '所选推理设备不可用', buttons: ['重新选择', '稍后'], defaultId: 0, cancelId: 1,
      }).then(({ response }) => { if (response === 0) chooseDevice(); });
    }
  }

  const inferencePending = new Map<number, InferencePending>();
  let nativeWorker: ReturnType<typeof utilityProcess.fork> | undefined;
  let inferenceId = 0;
  function infer(op: 'discover' | 'prepare' | 'predict', device?: InferenceDevice, input?: { texts: string[]; labels: string[] },
    progress?: (phase: string) => void) {
    if (!nativeWorker) {
      const child = utilityProcess.fork(join(__dirname, 'inference-worker.cjs'), [], { serviceName: 'Otter ONNX Runtime' });
      child.on('message', (message: { id: number; result?: unknown; error?: string; phase?: string }) => {
        const waiter = inferencePending.get(message.id);
        if (!waiter) return;
        if (message.phase !== undefined) {
          waiter.progress?.(message.phase);
          return;
        }
        inferencePending.delete(message.id);
        if (message.error) waiter.reject(new InferenceError(message.error));
        else waiter.resolve(message.result);
      });
      child.on('exit', () => {
        if (nativeWorker !== child) return;
        nativeWorker = undefined;
        for (const waiter of inferencePending.values()) waiter.reject(new InferenceError('ONNX Runtime 进程已经退出。'));
        inferencePending.clear();
      });
      nativeWorker = child;
    }
    const id = ++inferenceId;
    const worker = nativeWorker;
    return new Promise((resolve, reject) => {
      inferencePending.set(id, { resolve, reject, progress });
      worker.postMessage(op === 'discover' ? { id, op } : { id, op, directory: nativeModel, device, ...input });
    });
  }

  function finishWorker(session: Session, child: ReturnType<typeof utilityProcess.fork>, message: string) {
    if (session.worker !== child) return;
    session.worker = undefined;
    const request = session.pending;
    session.pending = undefined;
    request?.reject(new Error(message));
  }

  function startWorker(session: Session) {
    const child = utilityProcess.fork(join(__dirname, 'workspace-worker.cjs'), [], { serviceName: '脱敏引擎' });
    session.worker = child;
    child.on('message', (message: WorkspaceWorkerMessage) => {
      const pending = session.pending;
      if (session.worker !== child || !pending || message.id !== pending.id) return;
      if ('inference' in message) {
        const reply = (value: object) => {
          if (session.worker === child && session.pending === pending) child.postMessage({id: pending.id, ...value});
        };
        infer('predict', pending.device, message.inference, pending.progress).then(result => {
          if (session.worker === child && session.pending === pending &&
              selectedDevice()?.id === pending.device.id && activeDevice !== pending.device.name) {
            activeDevice = pending.device.name;
            publishInferenceStatus();
          }
          reply({predictions: result as Prediction[][]});
        }, error => {
          pending.inferenceError = error;
          reply({inferenceError: error.message});
        });

        return;
      }
      if ('diagnostic' in message) {
        diagnose({...message.diagnostic, elapsedMs: performance.now() - pending.started});
        return;
      }
      if ('phase' in message) {
        pending.progress(message.phase);
        return;
      }
      session.pending = undefined;
      if ('error' in message) pending.reject(pending.inferenceError ?? new Error(message.error));
      else pending.resolve(message.result);
    });
    child.on('exit', () => finishWorker(session, child, '本地脱敏引擎已退出，请重试。'));
    return child;
  }

  function requestWorkspace(session: Session, job: WorkspaceJob, progress: (phase: string) => void, device = cpuDevice) {
    if (session.pending) throw new Error('请等待当前操作完成。');
    const id = ++session.nextId;
    const child = session.worker ?? startWorker(session);
    return new Promise<WorkspaceResult>((resolve, reject) => {
      session.pending = {id, resolve, reject, progress, device, started: performance.now()};
      child.postMessage({id, ...job});
    });
  }

  async function runEngine<R extends Exclude<EngineRequest, {op: 'findOriginal' | 'scan' | 'reviseMaterial'}>>(session: Session,
    request: R, progress: (phase: string) => void): Promise<EngineReply<R>> {
    let job: WorkspaceJob;
    if (request.op === 'open') {
      const material = session.state.materials.find(doc => doc.id === request.materialId);
      if (!material) throw new Error('找不到这份材料。');
      job = {material};
    } else {
      job = {state: session.state, request, provider: cpuDevice.id, rulesOnly};
    }
    const result = await requestWorkspace(session, job, progress);
    if (request.op === 'open') session.state = {...session.state, activeId: request.materialId};
    if (typeof result === 'object' && 'state' in result) {
      const {state, ...payload} = result;
      if (state) session.state = state;
      return payload as EngineReply<R>;
    }
    return result as EngineReply<R>;
  }

  function stopWorker(session: Session) {
    const child = session.worker;
    if (!child) return;
    finishWorker(session, child, '已取消识别。');
    child.kill();
  }

  function cancelAnalysis(session: Session) {
    if (!session.scan) return;
    session.scan.cancelled = true;
    if (session.analysis) stopWorker(session.analysis);
  }

  async function analyze(session: WindowSession, input: Extract<Request, {op: 'scan' | 'reviseMaterial'}> & {queueMs?: number},
    progress: (phase: string) => void) {
    if (session.scan) throw new Error('当前工作区已有分析任务。');
    if (!nativeEnabled && !rulesOnly) throw new Error('找不到本地 ONNX 模型，请检查发行包资源或开发环境的 REDACTOR_ONNX_DIR。');
    const job = { materialId: input.materialId, cancelled: false };
    const preferredEP = preference().provider;
    const started = performance.now();
    session.scan = job;
    const analysis = session.analysis ??= { state: session.state, nextId: 0 };
    const assertCurrent = () => {
      if (job.cancelled) throw new Error('已取消识别。');
      const doc = session.state.materials.find(row => row.id === input.materialId);
      if (!doc || (doc.revision ?? 1) !== input.revision) throw new Error('材料已更新，请分析最新修订。');
    };
    let firstFeedbackMs: number | undefined;
    const phase = (message: string) => {
      if (job.cancelled) return;
      firstFeedbackMs ??= performance.now() - started;
      progress(message);
    };
    async function recognize(device: InferenceDevice, usedFallback: boolean) {
      const route = rulesOnly ? undefined : await infer('prepare', device, undefined, phase) as InferenceRoute;
      assertCurrent();
      for (;;) {
        const {base, analysisRevision} = await serialize(session, () => {
          assertCurrent();
          return {base: session.state, analysisRevision: session.analysisRevision};
        });
        const prepared = await requestWorkspace(analysis, {state: base, request: input, provider: device.id, rulesOnly}, phase, device);
        if (typeof prepared !== 'object' || !('state' in prepared) || !prepared.state) throw new Error('未收到材料识别结果。');
        const next = prepared.state;
        const changed = next.revision !== base.revision;
        const result = await serialize(session, async () => {
          assertCurrent();
          if (session.analysisRevision !== analysisRevision) return null;
          const latest = new Map(session.state.materials.map(doc => [doc.id, doc]));
          for (const doc of next.materials) {
            const current = latest.get(doc.id)!;
            doc.title = current.title;
            if (current.exported === undefined) delete doc.exported;
            else doc.exported = current.exported;
          }
          next.activeId = session.state.activeId;
          next.revision = session.state.revision + Number(changed);
          analysis.state = next;
          const previewStart = performance.now();
          const view = await runEngine(analysis, { op: 'view' }, phase);
          assertCurrent();
          session.state = next;
          if (changed) {
            session.analysisRevision++;
            projectChanged(session);
          }
          diagnose({stage: 'analysis-view', preferredEP, provider: route && device.backend,
            device: route && device.name, deviceIndex: route && device.index, usedFallback,
            reusedSession: route?.reusedSession, modelLoadMs: route?.loadMs, queueMs: input.queueMs ?? 0, firstFeedbackMs,
            previewMs: performance.now() - previewStart, elapsedMs: performance.now() - started});
          return view;
        });
        if (result) return result;
        phase('工作区已有更新，正在重新整理映射');
      }
    }
    try {
      await environmentReady;
      assertCurrent();
      let device = rulesOnly ? cpuDevice : selectedDevice(preferredEP);
      if (!device) throw new Error('所选推理设备不可用。请在设置中重新选择。');
      let usedFallback = false;
      for (;;) {
        try { return await recognize(device, usedFallback); }
        catch (failure) {
          assertCurrent();
          if (!(failure instanceof InferenceError)) throw failure;
          diagnose({stage: 'inference-error', preferredEP, provider: device.backend, message: failure.message});
          if (preferredEP === 'auto' && device.backend !== 'cpu') {
            autoUsesCpu = true;
            if (preference().provider === 'auto') activeDevice = '';
            publishInferenceStatus();
            device = cpuDevice;
            usedFallback = true;
            continue;
          }
          if (selectedDevice()?.id === device.id) {
            activeDevice = '';
            publishInferenceStatus();
          }
          throw new Error(preferredEP === 'auto' ? '识别失败，请重试。' : '所选设备无法完成识别。请在设置中重新选择或重试。');
        }
      }
    } finally {
      session.scan = undefined;
      analysis.state = session.state;
    }
  }

  function detectEnvironment(window: Electron.BrowserWindow) {
    environmentReady = probeEnvironment(window);
    return environmentReady;
  }

  function resetDeviceStatus() {
    activeDevice = '';
    publishInferenceStatus();
  }

  return { analyze, cancelAnalysis, runEngine, stopWorker, inferenceStatus, selectedDevice, resetDeviceStatus, detectEnvironment };
}

export = { createAnalysis };
