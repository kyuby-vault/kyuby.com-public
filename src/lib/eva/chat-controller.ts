import evaSystemPrompt from '../../agents/eva.md?raw';
import { requireWebGpu, WebGpuAdmissionError } from './webgpu-admission';
import {
  createElement as createLucideElement,
  createIcons,
  Cpu,
  DatabaseZap,
  Download,
  Menu,
  PanelRightOpen,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Save,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide';
import {
  appendMessage,
  clearEvaData,
  createSession,
  deleteMemory,
  deleteSession,
  exportEvaLocalData,
  importEvaLocalData,
  previewEvaDataImport,
  contextKey,
  validateEvaContextScope,
  listEvaContextScopes,
  loadEvaRecovery,
  saveEvaRecovery,
  clearEvaRecovery,
  MAX_EVA_IMPORT_BYTES,
  getProfile,
  listMemory,
  searchMemory,
  rebuildMemoryIndex,
  prepareMemoryIndex,
  closeMemoryIndex,
  setMemoryIndexBusyProbe,
  setMemoryIndexActivitySink,
  storeMemory,
  storeChapterSynopsis,
  listMessages,
  listSessions,
  renameSession,
  retagEmptySession,
  updateProfile,
  type EvaMessage,
  type EvaProfile,
  type EvaSession,
  type EvaContextScope,
  type EvaDataExport,
} from '../memory/db';
import { RecoveryCheckpoint } from './recovery-checkpoint';
import { deriveEvaBudgets, heapHeadroom, isEvaKvAllowance, MAX_CONTINUATIONS, type EvaBudgets, type EvaKvAllowance } from './generation-budget';
import { continuationMessages, continuationRemainder, ContinuationNoProgressError, tokenTail, MAX_UNFINISHED_CHARACTERS, UnfinishedGeneration, type EvaTextWindow } from './continuation';
import { ContextManager, createRecallBlock, estimateContextTokens, EXTRACTIVE_SUMMARY_TAG, SUMMARY_TOKEN_LIMIT } from './context-manager';
import { GenerationActivity } from './generation-activity';
import { generateChapterSynopsis } from './story-bible';
import { AUTO_RESUME_STORAGE_KEY, autoResumeFromDisk, canAutoResumeFromDisk } from './auto-resume';
import {
  runBoundedToolLoop,
  EVA_TOOL_DEFINITIONS,
} from '../tools/registry';
import {
  correlationTokenFromSessionId,
  createClientCorrelationToken,
  createDebugSessionId,
} from './debug-session-id';
import {
  getEvaMessageDisplayContent,
} from './model-context';
import {
  EvaModelCacheClient,
  ModelCacheRpcError,
  inspectBrowserStorage,
  requestBrowserStoragePersistence,
  type BrowserStorageStatus,
  type ModelCacheWorkerMessage,
} from './model-cache/client';
import type {
  ModelCacheBackend,
  ModelCacheIntegrityState,
  ModelCacheInventory,
  ModelCacheLoadSource,
  ModelCacheStatus,
  ModelCacheUiState,
  ModelCacheWarning,
} from './model-cache/types';
import { createModelCacheRootPath } from './model-cache/routing';
import { ModelCacheProgress } from './model-cache/progress';
import { acquisitionDiagnosticError, acquisitionDiagnosticsJson, copyAcquisitionDiagnostics } from './model-cache/diagnostics';
import { AcquisitionWakeLock } from './model-cache/wake-lock';
import { ACQUISITION_NOTICES, acquisitionCapacity, acquisitionDevicePolicy, acquisitionFailureCode, terminateFailedLoad,
  type AcquisitionCapacity, type AcquisitionNoticeCode } from './model-cache/resilience';
import { evaluateMemoryAdvisory, probeStorageAdmission } from './model-cache/storage-admission';
import {
  INITIAL_MODEL_CACHE_UI_STATE,
  MODEL_CACHE_CORRUPTION_WARNING,
  deriveModelCacheUi,
  reduceModelCacheUiState,
  type ModelCacheUiEvent,
} from './model-cache/state';
import {
  fetchEvaModelConfig,
  getEvaRuntimeSettings,
  normalizeEvaRuntimeSettings,
} from './runtime';
import {
  type EvaFunctionToolDefinition,
  type EvaGenerationOptions,
  type EvaModelConfig,
  type EvaModelMessage,
  type EvaWorkerState,
} from './worker-protocol';
import {
  EvaWorkerClient,
  type EvaGenerationResult,
  type EvaLoadProgress,
} from './worker-client';

const ACTIVE_SESSION_KEY = 'kyuby-eva-active-session';
const EXPERIMENTAL_UI_KEY = 'kyuby-eva-experimental-ui';
const EXPERIMENTAL_COLLAPSE_CHARACTERS = 600;
const PERSISTENCE_DENIED_MESSAGE = 'Local storage is limited. Model cache may be cleared by browser.';
const CACHE_LEASE_HEARTBEAT_MS = 60_000;

type FixtureMode = 'ready' | 'endpoint-error' | 'webgpu-unavailable' | 'model-cache';
type StatusTone = 'checking' | 'ready' | 'warning' | 'error' | 'busy';

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return 'unknown size';
  }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex >= 3 ? 2 : unitIndex >= 1 ? 1 : 0;
  return `${amount.toFixed(digits)} ${units[unitIndex]}`;
}

function formatShortVersion(value: string | null): string {
  if (!value) {
    return '—';
  }
  const normalized = value.replace(/^sha256:/, 'sha256:');
  return normalized.length > 24 ? `${normalized.slice(0, 21)}…` : normalized;
}

function backendLabel(backend: ModelCacheBackend): string {
  if (backend === 'opfs') {
    return 'OPFS';
  }
  return 'Unavailable';
}

function integrityLabel(integrity: ModelCacheIntegrityState, warning: ModelCacheWarning | null): string {
  if (integrity === 'verified') {
    return 'Verified when saved · rechecks on load';
  }
  if (integrity === 'verifying') {
    return 'Verifying…';
  }
  if (integrity === 'failed') {
    return warning?.message ?? 'Integrity check failed';
  }
  return 'Not verified';
}

function debugModelSha(config: EvaModelConfig | null): string | null {
  const graph = config?.manifest.cacheInventory?.files.find(
    (file) => file.present && file.role === 'onnx-graph',
  );
  return graph?.sha256 ?? config?.manifestRawSha256 ?? null;
}

function isLimitedStorageWarning(warning: ModelCacheWarning | null): boolean {
  return warning?.code === 'persistence-denied';
}

function readyNotice(warning: ModelCacheWarning | null): string {
  const ready = 'Eva is loaded in this tab. Conversations and chosen memories stay in this browser.';
  if (!warning) {
    return ready;
  }
  if (warning.code === 'cache-corrupt') {
    return `Cached model data was invalid and was removed. Eva finished loading from the network. ${ready}`;
  }
  if (warning.code === 'quota-insufficient') {
    return `There was not enough available storage to keep this load on disk. Eva finished loading from the network. ${ready}`;
  }
  if (warning.code === 'storage-unavailable') {
    return `Durable model storage was unavailable, so Eva finished loading from the network. ${ready}`;
  }
  if (warning.code === 'persistence-denied') {
    return `Local storage is limited. Model cache may be cleared by browser. ${ready}`;
  }
  return `${warning.message} ${ready}`;
}

interface InferenceRuntime {
  readonly state: EvaWorkerState;
  readonly budgets: EvaBudgets;
  measure(messages: EvaModelMessage[], tools?: EvaFunctionToolDefinition[]): Promise<number>;
  tail(text: string): Promise<EvaTextWindow>;
  setBudget(allowance: EvaKvAllowance): Promise<EvaBudgets>;
  load(config: EvaModelConfig, onProgress?: (progress: EvaLoadProgress) => void): Promise<void>;
  generate(
    messages: EvaModelMessage[],
    options: EvaGenerationOptions,
    tools: EvaFunctionToolDefinition[],
    onToken?: (text: string) => void,
  ): Promise<EvaGenerationResult>;
  cancel(): void;
  dispose(): Promise<void>;
  terminate(): void;
}

class FixtureRuntime implements InferenceRuntime {
  state: EvaWorkerState = 'idle';
  budgets = deriveEvaBudgets();
  #cancelled = false;

  async measure(messages: EvaModelMessage[], tools: EvaFunctionToolDefinition[] = []): Promise<number> {
    // The legacy fixture keeps its conservative byte arithmetic; real workers use their tokenizer.
    return estimateContextTokens(messages) + (tools.length ? new TextEncoder().encode(JSON.stringify(tools)).length : 0);
  }
  async tail(text: string): Promise<EvaTextWindow> {
    return tokenTail(text, (value) => Array.from(value).map((char) => char.codePointAt(0)!), (tokens) => String.fromCodePoint(...tokens));
  }
  async setBudget(allowance: EvaKvAllowance): Promise<EvaBudgets> {
    this.budgets = import.meta.env.DEV && new URL(location.href).searchParams.get('evaBudget') === 'device'
      ? deriveEvaBudgets({ max_position_embeddings: 262144, num_hidden_layers: 36, num_key_value_heads: 8, head_dim: 128 },
        { maxBufferSize: 2 ** 32, maxStorageBufferBindingSize: 2 ** 27, storageQuota: 2 ** 35, storageUsage: 0, heapHeadroom: null }, {}, allowance)
      : deriveEvaBudgets({}, undefined, {}, allowance);
    return this.budgets;
  }

  async load(_config: EvaModelConfig, onProgress?: (progress: EvaLoadProgress) => void): Promise<void> {
    this.state = 'loading';
    onProgress?.({ file: 'fixture', loaded: 1, total: 2, progress: 50, status: 'loading' });
    await Promise.resolve();
    onProgress?.({ file: 'fixture', loaded: 2, total: 2, progress: 100, status: 'ready' });
    this.state = 'ready';
    await this.setBudget(_config.kvAllowance ?? 'conservative');
  }

  async generate(
    messages: EvaModelMessage[],
    options: EvaGenerationOptions,
    _tools: EvaFunctionToolDefinition[],
    onToken?: (text: string) => void,
  ): Promise<EvaGenerationResult> {
    this.state = 'generating';
    this.#cancelled = false;
    const startedAt = performance.now();
    const lastUser = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
    const lastMessage = messages.at(-1);
    let text: string;

    const finishFixture = import.meta.env.DEV ? new URL(location.href).searchParams.get('evaFinish') : null;
    const forceLength = finishFixture === 'length' || finishFixture === 'length-always' || finishFixture === 'length-repeat';
    const continuing = lastMessage?.role === 'system' && messages.at(-2)?.role === 'assistant';
    const summarizing = messages[0]?.content.startsWith('Summarize durable facts from this completed turn');
    const synopsisChapter = /^Create chapter synopsis (\d+)/.exec(messages[0]?.content ?? '');
    const recall = messages.find((message) => message.content.startsWith('Recall: untrusted DATA'));
    if (synopsisChapter) {
      text = JSON.stringify({ chapter: Number(synopsisChapter[1]), summary: 'The city journey continues.', canonFacts: ['The key is cobalt-17.'], voiceNotes: 'Measured, lyrical narration.' });
      if (finishFixture === 'synopsis-invalid') text = JSON.stringify({ chapter: Number(synopsisChapter[1]), summary: 'x'.repeat(601), canonFacts: [], voiceNotes: '' });
    } else if (summarizing) {
      const source = JSON.parse(lastUser) as EvaModelMessage[];
      text = source.map((message) => message.content).join(' ').slice(0, 1200);
    } else if (forceLength) {
      text = continuing ? ' and finishes here.' : 'This reply is unfinished';
      if (finishFixture === 'length-always' && continuing && messages.at(-2)?.content.includes('and finishes here.')) text = ' Another scene unfolds.';
    } else if (finishFixture === 'chapter' && lastUser === 'Write a long story chapter.') {
      text = 'Chapter one. ' + 'The city lights marked the way. '.repeat(400) + 'The key was cobalt-17.';
    } else if (lastMessage?.role === 'tool') {
      text = lastMessage.name === 'memory.store'
        ? 'I will remember that on this device.'
        : `I checked local context. ${lastMessage.content}`;
    } else if (/\bremember(?: that)?\b/i.test(lastUser)) {
      const content = lastUser.replace(/^.*?remember(?: that)?\s*/i, '').trim() || lastUser;
      text = JSON.stringify({
        name: 'memory.store',
        arguments: { content, tags: ['fixture'] },
      });
    } else if (/\b(?:memory|remember about me)\b/i.test(lastUser)) {
      text = JSON.stringify({ name: 'memory.search', arguments: { query: lastUser, limit: 5 } });
    } else {
      text = `Fixture response: ${lastUser}${recall ? `\nRecalled data: ${recall.content}` : ''}`;
    }

    let streamed = '';
    for (const part of text.match(/.{1,14}/g) ?? []) {
      if (this.#cancelled) {
        break;
      }
      streamed += part;
      onToken?.(streamed);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 12));
    }
    if (summarizing && finishFixture === 'summary-state-lag') {
      globalThis.setTimeout(() => { this.state = 'ready'; }, 0);
    } else {
      this.state = 'ready';
    }
    return {
      text: streamed,
      inputTokens: Math.ceil(messages.reduce((total, message) => total + message.content.length, 0) / 4),
      generatedTokens: Math.ceil(streamed.length / 4),
      elapsedMs: Math.round(performance.now() - startedAt),
      finishReason: !synopsisChapter && !summarizing && forceLength && (!continuing || finishFixture === 'length-always' || finishFixture === 'length-repeat') && !this.#cancelled ? 'length' : 'stop',
      cancelled: this.#cancelled,
      tokenLimit: forceLength ? Math.ceil(streamed.length / 4) : options.maxNewTokens,
    };
  }

  cancel(): void {
    this.#cancelled = true;
  }

  async dispose(): Promise<void> {
    this.state = 'disposed';
  }

  terminate(): void {
    this.state = 'disposed';
  }
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Eva UI is missing #${id}.`);
  }
  return element as T;
}

function getFixtureMode(): FixtureMode | null {
  if (!import.meta.env.DEV) {
    return null;
  }
  const value = new URL(window.location.href).searchParams.get('evaFixture');
  return value === 'ready'
    || value === 'endpoint-error'
    || value === 'webgpu-unavailable'
    || value === 'model-cache'
    ? value
    : null;
}

function fixtureModelConfig(): EvaModelConfig {
  return {
    modelHost: 'fixture://eva',
    modelId: 'eva-browser-test-fixture',
    manifestUrl: 'fixture://eva/eva-browser-test-fixture/artifact-manifest.json',
    manifestVersion: 'fixture:eva-browser-test-fixture',
    manifestEtag: null,
    manifestRawSha256: '0'.repeat(64),
    manifestFetchedAt: 0,
    cacheLeaseNonce: null,
    manifest: {
      schemaVersion: 1,
      prepareMode: 'browser-test-fixture',
      cacheInventory: null,
      onnx: {
        entryFile: 'onnx/model_q4f16.onnx',
        runtimeDtype: 'q4f16',
        quantizationBackend: 'fixture',
        dataFiles: ['model_q4f16.onnx_data_0'],
      },
    },
  };
}

function formatSessionTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(value);
}

function formatMessageTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(value);
}

function downloadJson(filename: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: 'application/json',
  }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function mountEvaChat(): Promise<void> {
  if (import.meta.env.DEV && new URL(window.location.href).searchParams.get('evaFixture') === 'sandbox') { (await import('../sandbox/sandbox-client')).installSandboxFixture(); return; }
  const app = requiredElement<HTMLElement>('eva-app');
  createIcons({
    root: app,
    icons: {
      Cpu,
      DatabaseZap,
      Download,
      Menu,
      PanelRightOpen,
      Plus,
      Power,
      PowerOff,
      RefreshCw,
      Save,
      Send,
      Sparkles,
      Square,
      Trash2,
      X,
    },
  });

  const sessionList = requiredElement<HTMLUListElement>('session-list');
  const newSessionButton = requiredElement<HTMLButtonElement>('new-session');
  const deleteSessionButton = requiredElement<HTMLButtonElement>('delete-session');
  const messageList = requiredElement<HTMLElement>('message-list');
  const emptyConversation = requiredElement<HTMLElement>('empty-conversation');
  const form = requiredElement<HTMLFormElement>('chat-form');
  const input = requiredElement<HTMLTextAreaElement>('message-input');
  const sendButton = requiredElement<HTMLButtonElement>('send-message');
  const stopButton = requiredElement<HTMLButtonElement>('stop-generation');
  const loadButton = requiredElement<HTMLButtonElement>('load-model');
  const loadButtonLabel = requiredElement<HTMLElement>('load-model-label');
  const unloadButton = requiredElement<HTMLButtonElement>('unload-model');
  const statusBadge = requiredElement<HTMLElement>('runtime-status');
  const modelLabel = requiredElement<HTMLElement>('model-label');
  const runtimeNotice = requiredElement<HTMLElement>('runtime-notice');
  const runtimeNoticeText = requiredElement<HTMLElement>('runtime-notice-text');
  const retryRuntimeButton = requiredElement<HTMLButtonElement>('retry-runtime');
  const composerState = requiredElement<HTMLElement>('composer-state');
  const liveStatus = requiredElement<HTMLElement>('live-status');
  const loadProgress = requiredElement<HTMLElement>('load-progress');
  const loadProgressLabel = requiredElement<HTMLElement>('load-progress-label');
  const loadProgressValue = requiredElement<HTMLElement>('load-progress-value');
  const loadProgressBar = requiredElement<HTMLProgressElement>('load-progress-bar');
  const memoryList = requiredElement<HTMLUListElement>('memory-list');
  const emptyMemory = requiredElement<HTMLElement>('empty-memory');
  const exportButton = requiredElement<HTMLButtonElement>('export-data');
  const exportScope = requiredElement<HTMLSelectElement>('export-scope');
  const contextPartition = requiredElement<HTMLSelectElement>('context-partition');
  const importButton = requiredElement<HTMLButtonElement>('import-data');
  const importFile = requiredElement<HTMLInputElement>('import-file');
  const importDialog = requiredElement<HTMLDialogElement>('import-dialog');
  const importPreview = requiredElement<HTMLElement>('import-preview');
  const importTargets = requiredElement<HTMLUListElement>('import-targets');
  const importError = requiredElement<HTMLElement>('import-error');
  const importMode = requiredElement<HTMLSelectElement>('import-mode');
  const confirmImport = requiredElement<HTMLButtonElement>('confirm-import');
  const contextSaveStatus = requiredElement<HTMLElement>('context-save-status');
  const recoveryPreview = requiredElement<HTMLElement>('recovery-preview');
  const recoveryPartial = requiredElement<HTMLElement>('recovery-partial');
  const discardRecovery = requiredElement<HTMLButtonElement>('discard-recovery');
  const recoveryLabel = requiredElement<HTMLElement>('recovery-label');
  const continueButton = requiredElement<HTMLButtonElement>('continue-response');
  const stopContinuationButton = requiredElement<HTMLButtonElement>('stop-continuation');
  const tokenOverride = requiredElement<HTMLInputElement>('generation-token-limit');
  const autoContinue = requiredElement<HTMLSelectElement>('auto-continue');
  const kvAllowance = requiredElement<HTMLSelectElement>('kv-allowance');
  const downloadConcurrency = requiredElement<HTMLSelectElement>('download-concurrency');
  downloadConcurrency.value = localStorage.getItem('kyuby-eva-download-concurrency') === '4' ? '4' : '2';
  const pauseDownload = requiredElement<HTMLButtonElement>('pause-download');
  const resumeDownload = requiredElement<HTMLButtonElement>('resume-download');
  const downloadStatus = requiredElement<HTMLElement>('download-status');
  let downloadPaused = false;
  let pauseWork: Promise<void> | null = null;
  let downloadStartedAt = 0;
  const downloadMetrics = new Map<string, { durableBytes: number; networkBytes: number; resumedBytes: number }>();
  const synopsisButton = requiredElement<HTMLButtonElement>('create-synopsis');
  const synopsisChapter = requiredElement<HTMLInputElement>('synopsis-chapter');
  const synopsisStatus = requiredElement<HTMLElement>('synopsis-status');
  const compressionOffer = requiredElement<HTMLElement>('compression-offer');
  const compressionButton = requiredElement<HTMLButtonElement>('offer-compression');
  const retryResponse = requiredElement<HTMLButtonElement>('retry-response');
  const wallArithmetic = requiredElement<HTMLElement>('runtime-wall-arithmetic');
  const continuationArithmetic = requiredElement<HTMLElement>('runtime-continuation-arithmetic');
  const savedKvAllowance = localStorage.getItem('kyuby-eva-kv-allowance');
  kvAllowance.value = isEvaKvAllowance(savedKvAllowance) ? savedKvAllowance : 'conservative';
  const runtimeContextBudget = requiredElement<HTMLElement>('runtime-context-budget');
  const runtimeOutputBudget = requiredElement<HTMLElement>('runtime-output-budget');
  const runtimeBudgetProvenance = requiredElement<HTMLElement>('runtime-budget-provenance');
  const runtimeFinishReason = requiredElement<HTMLElement>('runtime-finish-reason');
  const profileForm = requiredElement<HTMLFormElement>('profile-form');
  const profileName = requiredElement<HTMLInputElement>('profile-name');
  const profileNotes = requiredElement<HTMLTextAreaElement>('profile-notes');
  const runtimeProvider = requiredElement<HTMLElement>('runtime-provider');
  const runtimeState = requiredElement<HTMLElement>('runtime-state');
  const runtimeModel = requiredElement<HTMLElement>('runtime-model');
  const runtimeInputTokens = requiredElement<HTMLElement>('runtime-input-tokens');
  const runtimeOutputTokens = requiredElement<HTMLElement>('runtime-output-tokens');
  const runtimeElapsed = requiredElement<HTMLElement>('runtime-elapsed');
  const runtimeModelFiles = requiredElement<HTMLElement>('runtime-model-files');
  const runtimeIntegrity = requiredElement<HTMLElement>('runtime-integrity');
  const reverifyButton = requiredElement<HTMLButtonElement>('reverify-model');
  const reverifySummary = requiredElement<HTMLElement>('reverify-summary');
  const reverifyResults = requiredElement<HTMLUListElement>('reverify-results');
  const cacheProgressSummary = requiredElement<HTMLElement>('cache-progress-summary');
  requiredElement<HTMLDetailsElement>('cache-progress-details').open = !matchMedia('(pointer: coarse), (max-width: 640px)').matches;
  const pagingStatus = requiredElement<HTMLElement>('context-paging-status');
  const contextManager = new ContextManager();
  const generationActivity = new GenerationActivity();
  setMemoryIndexBusyProbe(() => !disposed && (generationActivity.active || uiState.session === 'loading' || uiState.session === 'unloading'));
  setMemoryIndexActivitySink((message) => { if (!disposed) liveStatus.textContent = message; });
  const cacheFileProgress = requiredElement<HTMLUListElement>('cache-file-progress');
  const runtimeLoadSource = requiredElement<HTMLElement>('runtime-load-source');
  const runtimeCacheBackend = requiredElement<HTMLElement>('runtime-cache-backend');
  const runtimeStoragePolicy = requiredElement<HTMLElement>('runtime-storage-policy');
  const runtimeSiteStorage = requiredElement<HTMLElement>('runtime-site-storage');
  const runtimeCacheVersion = requiredElement<HTMLElement>('runtime-cache-version');
  const runtimeManifest = requiredElement<HTMLElement>('runtime-manifest');
  const runtimeSessionId = requiredElement<HTMLElement>('runtime-session-id');
  const runtimeContextModel = requiredElement<HTMLElement>('runtime-context-model');
  const runtimeContextPartition = requiredElement<HTMLElement>('runtime-context-partition');
  const persistenceBanner = requiredElement<HTMLElement>('persistence-banner');
  const requestPersistenceButton = requiredElement<HTMLButtonElement>('request-persistence');
  const requestPersistenceLabel = requiredElement<HTMLElement>('request-persistence-label');
  const experimentalUiToggle = requiredElement<HTMLInputElement>('experimental-ui-toggle');
  const autoResumeToggle = requiredElement<HTMLInputElement>('auto-resume-disk');
  autoResumeToggle.checked = localStorage.getItem(AUTO_RESUME_STORAGE_KEY) !== 'off';
  const removeModelButton = requiredElement<HTMLButtonElement>('remove-local-model');
  const removeModelDialog = requiredElement<HTMLDialogElement>('remove-model-dialog');
  const removeModelCopy = requiredElement<HTMLElement>('remove-model-copy');
  const confirmRemoveModelButton = requiredElement<HTMLButtonElement>('confirm-remove-model');
  const clearDataButton = requiredElement<HTMLButtonElement>('clear-local-data');
  const clearDialog = requiredElement<HTMLDialogElement>('clear-dialog');
  const confirmClearButton = requiredElement<HTMLButtonElement>('confirm-clear');
  const mobileMemoryDialog = requiredElement<HTMLDialogElement>('mobile-memory-dialog');
  const mobileMemoryTitle = mobileMemoryDialog.querySelector<HTMLElement>('#mobile-memory-title, h2');
  const mobileMemoryCopy = requiredElement<HTMLElement>('mobile-memory-copy');
  const confirmMobileMemoryButton = requiredElement<HTMLButtonElement>('confirm-mobile-memory');
  let mobileMemoryWarningAccepted = false;
  const sessionsPanel = requiredElement<HTMLElement>('sessions-panel');
  const inspector = requiredElement<HTMLElement>('inspector');
  const drawerScrim = requiredElement<HTMLElement>('drawer-scrim');
  const openSessionsButton = requiredElement<HTMLButtonElement>('open-sessions');
  const closeSessionsButton = requiredElement<HTMLButtonElement>('close-sessions');
  const toggleInspectorButton = requiredElement<HTMLButtonElement>('toggle-inspector');
  const closeInspectorButton = requiredElement<HTMLButtonElement>('close-inspector');
  const fixtureMode = getFixtureMode();

  const contextModelId = fixtureMode && fixtureMode !== 'model-cache'
    ? fixtureModelConfig().modelId : getEvaRuntimeSettings().modelId;
  const activePartitionStorageKey = `${ACTIVE_SESSION_KEY}:partition:${contextModelId}`;
  let contextScope: EvaContextScope = { model_id: contextModelId, context_partition_id: 'default' };
  const savedPartition = localStorage.getItem(activePartitionStorageKey);
  if (savedPartition) {
    try { contextScope = validateEvaContextScope({ model_id: contextModelId, context_partition_id: savedPartition }); }
    catch { localStorage.removeItem(activePartitionStorageKey); }
  }
  let contextBusy = false;
  let disposed = false;
  let pendingImport: EvaDataExport | null = null;
  let partialRecovery = '';

  let sessions: EvaSession[] = [];
  let profile: EvaProfile = { ...contextScope, id: 'local', displayName: 'You', notes: '', updatedAt: 0 };
  let activeSessionId = '';
  let modelConfig: EvaModelConfig | null = null;
  let runtime: InferenceRuntime | null = null;
  let uiState: ModelCacheUiState = { ...INITIAL_MODEL_CACHE_UI_STATE };
  let cacheStatus: ModelCacheStatus | null = null;
  let browserStorage: BrowserStorageStatus = {
    persistence: 'browser-managed',
    estimate: { usage: null, quota: null },
  };
  let persistenceDenied = false;
  let experimentalUi = globalThis.localStorage.getItem(EXPERIMENTAL_UI_KEY) === 'on';
  const cacheClient = new EvaModelCacheClient();
  const copyDiagnosticsButton = requiredElement<HTMLButtonElement>('copy-acquisition-diagnostics');
  const diagnosticsStatus = requiredElement<HTMLElement>('acquisition-diagnostics-status');
  let cacheConfigured = false;
  let cacheLoadNonce: string | null = null;
  let cacheLeaseHeartbeatNonce: string | null = null;
  let cacheLeaseHeartbeat: ReturnType<typeof globalThis.setTimeout> | null = null;
  let generating = false;
  let cancelRequested = false;
  let unfinishedReason: 'length' | 'stop' | 'error' = 'stop';
  let autoContinuations = 0;
  let reverifying = false;
  let autoResuming = false;
  let cacheProgress = new ModelCacheProgress(null);
  let sharedAcquisition = false;
  let capacity: AcquisitionCapacity = 'ok';
  let acquisitionFailure: AcquisitionNoticeCode | null = null;
  let runtimeRetryNeeded = false;
  const capacityLabel = requiredElement<HTMLElement>('acquisition-capacity');
  const visibilityHint = requiredElement<HTMLElement>('download-visibility-hint');
  const devicePolicy = () => acquisitionDevicePolicy(navigator as Navigator & {
    userAgentData?: { mobile?: boolean }; deviceMemory?: number;
  }, downloadConcurrency.value === '4' ? 4 : 2);
  const acquisitionWakeLock = new AcquisitionWakeLock(() => {
    if (devicePolicy().mobile) {
      visibilityHint.hidden = false;
      visibilityHint.textContent = 'Screen wake lock is unavailable. Keep this tab visible while downloading; you can resume after an interruption.';
    }
  }, navigator, document, code => cacheClient.diagnostics.record({ kind: 'wake-lock', code }));

  function acquisitionNotice(code: AcquisitionNoticeCode, customMessage?: string): void {
    runtimeNotice.dataset.acquisition = code;
    runtimeNoticeText.textContent = customMessage ?? ACQUISITION_NOTICES[code];
  }

  function acquisitionDiagnostic(error: unknown): void {
    cacheClient.diagnostics.record({ kind: 'error', code: acquisitionDiagnosticError(error) });
    const text = error instanceof Error ? error.message : String(error);
    liveStatus.textContent = text.slice(0, 2048);
    console.warn('Eva acquisition diagnostic:', text.slice(0, 2048));
  }

  function activeSessionStorageKey(): string {
    return `${ACTIVE_SESSION_KEY}:${JSON.stringify(contextScope)}`;
  }

  function reportContextError(error: unknown): void {
    contextSaveStatus.textContent = `Local save failed: ${error instanceof Error ? error.message : String(error)}. Please retry or export your data.`;
  }

  const recovery = new RecoveryCheckpoint(
    () => ({ sessionId: activeSessionId, scope: { ...contextScope }, draft: input.value, partialResponse: partialRecovery }),
    async ({ sessionId, scope, draft, partialResponse }) => {
      if (!sessionId) return;
      if (draft || partialResponse) await saveEvaRecovery(sessionId, { draft, partialResponse }, scope);
      else await clearEvaRecovery(sessionId, scope);
      contextSaveStatus.textContent = `Recovery saved on this device at ${new Date().toLocaleTimeString()}. This is not an external backup.`;
    },
    reportContextError,
  );

  function flushHiddenRecovery(): void {
    if (document.hidden && !contextBusy && !disposed) void recovery.flush().catch(reportContextError);
  }

  async function restoreRecovery(): Promise<void> {
    const saved = await loadEvaRecovery(activeSessionId, contextScope);
    input.value = saved?.draft ?? '';
    partialRecovery = saved?.partialResponse ?? '';
    unfinishedReason = 'stop'; // Recovery never silently resumes on reload or partition switch.
    autoContinuations = 0;
    recoveryLabel.textContent = 'Recovered unfinished response — not sent to the model';
    recoveryPartial.textContent = getEvaMessageDisplayContent({ role: 'assistant', content: partialRecovery });
    recoveryPreview.hidden = !partialRecovery;
    if (input.value.length > input.maxLength) {
      liveStatus.textContent = `The recovered draft exceeds the ${input.maxLength.toLocaleString()}-character message limit.`;
    }
    updateControls();
  }

  async function refreshContextPartitions(): Promise<void> {
    const scopes = await listEvaContextScopes(contextModelId);
    if (!scopes.some((scope) => scope.context_partition_id === contextScope.context_partition_id)) scopes.push(contextScope);
    contextPartition.replaceChildren(...scopes.map((scope) => {
      const option = document.createElement('option');
      option.value = scope.context_partition_id;
      option.textContent = scope.context_partition_id;
      option.selected = scope.context_partition_id === contextScope.context_partition_id;
      return option;
    }));
    runtimeContextModel.textContent = contextScope.model_id;
    runtimeContextPartition.textContent = contextScope.context_partition_id;
  }

  function patchUiState(patch: Partial<ModelCacheUiState>): void {
    uiState = { ...uiState, ...patch };
    renderUi();
  }

  function dispatchUi(event: ModelCacheUiEvent): void {
    uiState = reduceModelCacheUiState(uiState, event);
    renderUi();
  }

  async function createLocalSession(title = 'New conversation'): Promise<EvaSession> {
    const createdAt = Date.now();
    const id = createDebugSessionId({
      correlationToken: createClientCorrelationToken(),
      createdAt,
      modelSha256: debugModelSha(modelConfig),
    });
    return createSession(title, { id, createdAt }, contextScope);
  }

  async function retagActiveEmptySessionForModel(): Promise<void> {
    const modelSha256 = debugModelSha(modelConfig);
    if (!modelSha256) {
      return;
    }
    const session = sessions.find(({ id }) => id === activeSessionId);
    if (!session) {
      return;
    }
    const correlationToken = correlationTokenFromSessionId(session.id)
      ?? createClientCorrelationToken();
    const replacementId = createDebugSessionId({
      correlationToken,
      createdAt: session.createdAt,
      modelSha256,
    });
    if (replacementId === session.id) {
      return;
    }
    const retagged = await retagEmptySession(session.id, replacementId, contextScope);
    if (!retagged) {
      return;
    }
    activeSessionId = retagged.id;
    localStorage.setItem(activeSessionStorageKey(), activeSessionId);
    sessions = await listSessions(contextScope);
    renderSessions();
    renderUi();
  }

  function displayedDebugSessionId(): string {
    const session = sessions.find(({ id }) => id === activeSessionId);
    return session?.id ?? '—';
  }

  function stopCacheLeaseHeartbeat(): void {
    cacheLeaseHeartbeatNonce = null;
    if (cacheLeaseHeartbeat !== null) {
      globalThis.clearTimeout(cacheLeaseHeartbeat);
      cacheLeaseHeartbeat = null;
    }
  }

  function startCacheLeaseHeartbeat(nonce: string): void {
    stopCacheLeaseHeartbeat();
    cacheLeaseHeartbeatNonce = nonce;
    const schedule = (): void => {
      cacheLeaseHeartbeat = globalThis.setTimeout(() => {
        cacheLeaseHeartbeat = null;
        if (cacheLeaseHeartbeatNonce !== nonce || cacheLoadNonce !== nonce) {
          return;
        }
        void cacheClient.renewLoad(nonce).catch((error) => {
          if (cacheLeaseHeartbeatNonce !== nonce) {
            return;
          }
          acquisitionDiagnostic(error);
          const warning: ModelCacheWarning = {
            code: 'connection-lost',
            message: ACQUISITION_NOTICES['connection-lost'],
            recoverable: true,
          };
          runtimeNoticeText.textContent = warning.message;
          dispatchUi({ type: 'WARNING_SET', warning });
        }).finally(() => {
          if (cacheLeaseHeartbeatNonce === nonce && cacheLoadNonce === nonce) {
            schedule();
          }
        });
      }, CACHE_LEASE_HEARTBEAT_MS);
    };
    schedule();
  }

  function renderRuntimeDetails(): void {
    const inventory = modelConfig?.manifest.cacheInventory ?? null;
    const totalBytes = cacheStatus?.totalBytes ?? inventory?.totalBytes ?? null;

    runtimeModelFiles.textContent = uiState.cacheAction === 'verifying' && uiState.residency !== 'on-disk'
      ? 'Finalizing…'
      : uiState.residency === 'on-disk'
        ? `Stored · verified · ${formatBytes(totalBytes)}`
        : 'Not stored';
    runtimeIntegrity.textContent = integrityLabel(
      uiState.cacheAction === 'verifying' ? 'verifying' : cacheStatus?.integrity ?? 'unverified',
      uiState.warning,
    );
    runtimeLoadSource.textContent = uiState.loadSource === 'disk'
      ? 'Disk'
      : uiState.loadSource === 'network' ? 'Network' : '—';
    runtimeCacheBackend.textContent = backendLabel(cacheStatus?.backend ?? 'unavailable');
    runtimeStoragePolicy.textContent = browserStorage.persistence === 'persistent'
      ? 'Persistent'
      : browserStorage.persistence === 'best-effort' ? 'Best effort' : 'Browser managed';
    runtimeSiteStorage.textContent = browserStorage.estimate.usage !== null
      && browserStorage.estimate.quota !== null
      ? `${formatBytes(browserStorage.estimate.usage)} used of ${formatBytes(browserStorage.estimate.quota)}`
      : 'Estimate unavailable';
    runtimeCacheVersion.textContent = formatShortVersion(
      cacheStatus?.manifestVersion ?? modelConfig?.manifestVersion ?? null,
    );
    runtimeSessionId.textContent = displayedDebugSessionId();

    if (!modelConfig) {
      runtimeManifest.textContent = uiState.preflight === 'checking' ? 'Checking…' : 'Unavailable';
    } else if (fixtureMode) {
      runtimeManifest.textContent = uiState.manifestUpdateAvailable
        ? 'Development fixture · update available for next load'
        : 'Development fixture';
    } else {
      const timestamp = new Date(modelConfig.manifestFetchedAt).toLocaleString();
      runtimeManifest.textContent = uiState.manifestUpdateAvailable
        ? `Validated ${timestamp} · update available for next load`
        : uiState.warning?.code === 'manifest-revalidation'
          ? `Validated ${timestamp} · revalidation failed`
          : `Validated ${timestamp}`;
    }
  }

  function renderPersistence(): void {
    const persistence = browserStorage.persistence;
    persistenceBanner.hidden = false;
    requestPersistenceButton.hidden = persistence !== 'best-effort';
    if (persistence === 'persistent') {
      persistenceDenied = false;
      persistenceBanner.dataset.tone = 'ok';
      persistenceBanner.textContent = 'Persistent storage granted. The browser will not automatically erase Eva\'s local model files.';
      return;
    }
    if (persistence === 'best-effort') {
      persistenceBanner.dataset.tone = persistenceDenied ? 'warn' : 'info';
      persistenceBanner.textContent = persistenceDenied
        ? 'The browser denied persistent storage. Eva keeps the model files, but the browser may erase them under storage pressure.'
        : 'Model files are stored best-effort. Request persistent storage to protect them from automatic browser cleanup.';
      requestPersistenceLabel.textContent = persistenceDenied
        ? 'Retry persistent storage request'
        : 'Protect model files from browser cleanup';
      return;
    }
    persistenceDenied = false;
    persistenceBanner.dataset.tone = 'info';
    persistenceBanner.textContent = 'This browser manages site storage automatically; a persistence request is not available.';
  }

  function applyExperimentalUi(): void {
    app.classList.toggle('experimental-ui', experimentalUi);
    experimentalUiToggle.checked = experimentalUi;
  }

  function renderUi(): void {
    const derived = deriveModelCacheUi(uiState, {
      isGenerating: generating,
      hasStoredFiles: uiState.residency === 'on-disk' || (cacheStatus?.cachedBytes ?? 0) > 0,
    });
    const limitedStorage = isLimitedStorageWarning(uiState.warning);
    const tone: StatusTone = derived.bubble.kind === 'loading' || derived.bubble.kind === 'unloading'
      ? 'busy'
      : derived.bubble.kind === 'unavailable' ? 'error'
        : derived.bubble.kind === 'checking' ? 'checking'
          : limitedStorage ? 'warning' : 'ready';
    statusBadge.textContent = derived.bubble.label;
    statusBadge.dataset.tone = tone;
    runtimeNotice.dataset.tone = limitedStorage ? 'limited-storage' : 'default';
    runtimeState.textContent = derived.bubble.label;
    loadButtonLabel.textContent = derived.load.label;
    loadButton.title = derived.load.title;
    loadButton.setAttribute('aria-label', derived.load.accessibleName);
    unloadButton.title = derived.unload.title;
    unloadButton.setAttribute('aria-label', derived.unload.accessibleName);
    renderRuntimeDetails();
    renderPersistence();
    updateControls();
  }

  function setPanelAccessibility(panel: HTMLElement, visible: boolean): void {
    panel.inert = !visible;
    panel.setAttribute('aria-hidden', String(!visible));
  }

  function syncDrawerAccessibility(): void {
    setPanelAccessibility(
      sessionsPanel,
      window.innerWidth > 760 || sessionsPanel.classList.contains('is-open'),
    );
    setPanelAccessibility(
      inspector,
      window.innerWidth > 1120
        ? !app.classList.contains('inspector-closed')
        : inspector.classList.contains('is-open'),
    );
  }

  function updateControls(): void {
    const derived = deriveModelCacheUi(uiState, {
      isGenerating: generating,
      hasStoredFiles: uiState.residency === 'on-disk' || (cacheStatus?.cachedBytes ?? 0) > 0,
    });
    const sessionBusy = uiState.session === 'loading' || uiState.session === 'unloading';
    const cacheBusy = uiState.cacheAction !== 'idle';
    const busy = sessionBusy || cacheBusy || generating || contextBusy || reverifying || autoResuming;
    const ready = uiState.session === 'ready';
    loadButton.disabled = !modelConfig || derived.load.disabled || contextBusy || reverifying || autoResuming || capacity === 'insufficient';
    retryRuntimeButton.hidden = !(derived.retryRuntime || runtimeRetryNeeded || capacity === 'insufficient');
    retryRuntimeButton.disabled = busy;
    unloadButton.disabled = derived.unload.disabled || contextBusy || reverifying || autoResuming;
    autoResumeToggle.disabled = busy;
    input.disabled = !ready || busy;
    sendButton.disabled = !ready || busy || (!!partialRecovery && unfinishedReason !== 'error') || input.value.trim().length === 0 || input.value.length > input.maxLength;
    continueButton.disabled = !ready || busy || !partialRecovery || partialRecovery.length >= MAX_UNFINISHED_CHARACTERS;
    stopContinuationButton.disabled = busy;
    tokenOverride.disabled = busy;
    autoContinue.disabled = busy;
    kvAllowance.disabled = busy;
    downloadConcurrency.disabled = busy;
    pauseDownload.disabled = uiState.session !== 'loading' || !cacheLoadNonce || downloadPaused || autoResuming;
    resumeDownload.hidden = !downloadPaused;
    resumeDownload.disabled = uiState.session !== 'unloaded' || cacheLoadNonce !== null;
    synopsisButton.disabled = compressionButton.disabled = !ready || busy;
    synopsisChapter.disabled = busy;
    retryResponse.disabled = !ready || busy;
    input.setCustomValidity(input.value.length > input.maxLength ? 'Shorten the recovered draft before sending.' : '');
    stopButton.hidden = !generating;
    removeModelButton.disabled = !cacheConfigured || !derived.canRemove || contextBusy || reverifying || autoResuming;
    reverifyButton.disabled = busy || !cacheConfigured || !modelConfig?.manifest.cacheInventory || !(cacheStatus?.cachedBytes);
    newSessionButton.disabled = busy;
    deleteSessionButton.disabled = busy;
    contextPartition.disabled = busy;
    importButton.disabled = busy;
    exportButton.disabled = busy;
    exportScope.disabled = busy;
    confirmImport.disabled = busy || pendingImport === null;
    importMode.disabled = busy;
    importDialog.querySelector<HTMLButtonElement>('button[value="cancel"]')!.disabled = busy;
    discardRecovery.disabled = busy;
    clearDataButton.disabled = busy;
    profileForm.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>('button, input, textarea')
      .forEach((element) => { element.disabled = busy; });
    sessionList.querySelectorAll('button').forEach((button) => {
      (button as HTMLButtonElement).disabled = busy;
    });
    input.placeholder = ready ? 'Message Eva' : 'Load Eva to begin';
    composerState.textContent = generating
      ? cancelRequested ? 'Stopping...' : 'Eva is responding'
      : uiState.session === 'loading' ? `Loading from ${uiState.loadSource ?? 'network'}`
        : uiState.session === 'unloading' ? 'Unloading Eva'
          : ready ? 'Runs locally after model load' : 'Eva is not loaded';
  }

  function closeDrawers(): void {
    sessionsPanel.classList.remove('is-open');
    inspector.classList.remove('is-open');
    drawerScrim.hidden = true;
    syncDrawerAccessibility();
  }

  function openSessions(): void {
    inspector.classList.remove('is-open');
    sessionsPanel.classList.add('is-open');
    drawerScrim.hidden = false;
    syncDrawerAccessibility();
  }

  function openInspector(): void {
    app.classList.remove('inspector-closed');
    sessionsPanel.classList.remove('is-open');
    if (window.innerWidth <= 1120) {
      inspector.classList.add('is-open');
      drawerScrim.hidden = false;
    }
    syncDrawerAccessibility();
  }

  function closeInspector(): void {
    if (window.innerWidth > 1120) {
      app.classList.add('inspector-closed');
    }
    inspector.classList.remove('is-open');
    drawerScrim.hidden = true;
    syncDrawerAccessibility();
  }

  function createMessageView(message: EvaMessage, pending = false): {
    article: HTMLElement;
    content: HTMLElement;
  } {
    const article = document.createElement('article');
    article.className = `message message--${message.role}${pending ? ' message--pending' : ''}`;
    article.dataset.messageId = message.id;

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = message.role === 'assistant' ? 'E' : message.role === 'tool' ? 'T' : 'Y';
    avatar.setAttribute('aria-hidden', 'true');

    const body = document.createElement('div');
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const author = document.createElement('strong');
    author.textContent = message.role === 'assistant'
      ? 'Eva'
      : message.role === 'tool' ? message.name ?? 'Local tool' : profile.displayName;
    const time = document.createElement('time');
    time.dateTime = new Date(message.createdAt).toISOString();
    time.textContent = formatMessageTime(message.createdAt);
    meta.append(author, time);

    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = getEvaMessageDisplayContent(message);
    body.append(meta, content);
    if (experimentalUi && !pending && (content.textContent ?? '').length > EXPERIMENTAL_COLLAPSE_CHARACTERS) {
      article.classList.add('message--collapsible', 'message--collapsed');
      const hint = document.createElement('button');
      hint.type = 'button';
      hint.className = 'message-collapse-hint';
      hint.textContent = 'Show more';
      hint.addEventListener('click', () => {
        const collapsed = article.classList.toggle('message--collapsed');
        hint.textContent = collapsed ? 'Show more' : 'Show less';
      });
      content.addEventListener('click', () => hint.click());
      body.append(hint);
    }
    article.append(avatar, body);
    return { article, content };
  }

  async function renderMessages(): Promise<void> {
    await renderMemory();
    const messages = activeSessionId ? await listMessages(activeSessionId, contextScope) : [];
    messageList.replaceChildren();
    emptyConversation.hidden = messages.length > 0;
    if (messages.length === 0) {
      messageList.append(emptyConversation);
      return;
    }
    for (const message of messages) {
      messageList.append(createMessageView(message).article);
    }
    messageList.scrollTop = messageList.scrollHeight;
  }

  function renderSessions(): void {
    sessionList.replaceChildren();
    for (const session of sessions) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.className = `session-button${session.id === activeSessionId ? ' is-active' : ''}`;
      button.type = 'button';
      button.dataset.sessionId = session.id;
      button.disabled = uiState.session === 'loading'
        || uiState.session === 'unloading'
        || uiState.cacheAction !== 'idle'
        || generating;
      const title = document.createElement('strong');
      title.textContent = session.title;
      const updated = document.createElement('span');
      updated.textContent = formatSessionTime(session.updatedAt);
      button.append(title, updated);
      button.addEventListener('click', () => {
        void runContextAction(async () => {
          await recovery.flush();
          activeSessionId = session.id;
          localStorage.setItem(activeSessionStorageKey(), activeSessionId);
          renderSessions();
          renderUi();
          await renderMessages();
          await restoreRecovery();
          closeDrawers();
        });
      });
      item.append(button);
      sessionList.append(item);
    }
  }

  async function refreshSessions(): Promise<void> {
    sessions = await listSessions(contextScope);
    renderSessions();
    renderUi();
  }

  async function renderMemory(): Promise<void> {
    const records = await listMemory(contextScope);
    const paged = records.filter((record) => record.provenance === 'auto' && record.sessionId === activeSessionId).length;
    const extractive = records.filter((record) => record.provenance === 'auto' && record.sessionId === activeSessionId
      && record.tags.includes(EXTRACTIVE_SUMMARY_TAG)).length;
    pagingStatus.hidden = paged === 0;
    pagingStatus.textContent = paged ? `Paged to memory: ${paged} completed turn${paged === 1 ? '' : 's'}${extractive ? ` (${extractive} extractive)` : ''}` : '';
    memoryList.replaceChildren();
    emptyMemory.hidden = records.length > 0;
    for (const record of records) {
      const item = document.createElement('li');
      item.className = 'memory-item';
      item.dataset.provenance = record.provenance ?? 'legacy';
      const content = document.createElement('p');
      content.textContent = record.content;
      const footer = document.createElement('footer');
      if (record.provenance === 'auto') {
        const badge = document.createElement('span');
        badge.className = 'status-badge';
        badge.textContent = record.tags.includes(EXTRACTIVE_SUMMARY_TAG) ? 'Auto / Extractive' : 'Auto';
        badge.setAttribute('aria-label', 'Automatic summary');
        footer.append(badge);
      }
      if (record.provenance === 'synopsis') {
        const badge = document.createElement('span');
        badge.className = 'status-badge';
        badge.textContent = `Synopsis · chapter ${record.synopsis!.chapter} · raw retained`;
        footer.append(badge);
      }
      const tags = document.createElement('span');
      tags.textContent = record.tags.length > 0 ? record.tags.join(' · ') : 'untagged';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.title = 'Delete memory';
      remove.setAttribute('aria-label', `Delete memory: ${record.content.slice(0, 80)}`);
      remove.append(createLucideElement(Trash2, { 'aria-hidden': 'true' }));
      remove.addEventListener('click', () => { void runContextAction(async () => {
        await deleteMemory(record.id, contextScope);
        await renderMemory();
      }); });
      footer.append(tags, remove);
      item.append(content, footer);
      memoryList.append(item);
    }
  }

  function renderProfile(): void {
    profileName.value = profile.displayName;
    profileNotes.value = profile.notes;
  }

  async function refreshStorageStatus(): Promise<void> {
    const total = cacheStatus?.totalBytes ?? modelConfig?.manifest.cacheInventory?.totalBytes ?? 0;
    const cached = cacheStatus?.cachedBytes ?? 0;
    const admission = await probeStorageAdmission(total, cached);
    browserStorage = {
      persistence: admission.persisted ? 'persistent' : 'best-effort',
      estimate: { usage: admission.usage, quota: admission.quota },
    };
    capacity = admission.state === 'insufficient-storage' ? 'insufficient' : acquisitionCapacity(total, cached, browserStorage.estimate);
    cacheClient.diagnostics.record({ kind: 'preflight', code: admission.state,
      total,
      ...(browserStorage.estimate.usage === null ? {} : { usage: browserStorage.estimate.usage }),
      ...(browserStorage.estimate.quota === null ? {} : { quota: browserStorage.estimate.quota }) });
    capacityLabel.dataset.state = capacity;
    capacityLabel.textContent = capacity === 'ok' ? 'OK · space available'
      : capacity === 'tight' ? 'Tight · may need cleanup; the browser estimate is limited'
        : 'Insufficient · free browser storage or remove an old cached model, then Retry';
    if (admission.state === 'insufficient-storage' && uiState.session === 'unloaded') {
      acquisitionNotice('insufficient-storage', admission.message);
    } else if (admission.state === 'cache-unavailable' && uiState.session === 'unloaded') {
      acquisitionNotice('cache-unavailable', admission.message);
    }
    renderUi();
  }

  async function requestPersistence(): Promise<void> {
    if (browserStorage.persistence !== 'best-effort') {
      return;
    }
    const granted = await requestBrowserStoragePersistence();
    persistenceDenied = granted === false;
    if (granted) {
      if (uiState.warning?.code === 'persistence-denied') {
        dispatchUi({ type: 'WARNING_CLEARED' });
      }
      liveStatus.textContent = 'Persistent storage granted. Model files are protected from automatic browser cleanup.';
    } else {
      dispatchUi({
        type: 'WARNING_SET',
        warning: {
          code: 'persistence-denied',
          message: PERSISTENCE_DENIED_MESSAGE,
          recoverable: true,
        },
      });
    }
    await refreshStorageStatus();
  }

  function updateOverallLoadSource(source: ModelCacheLoadSource): void {
    if (uiState.session !== 'loading') {
      return;
    }
    if (uiState.loadSource === 'network' && source === 'disk') {
      return;
    }
    if (uiState.loadSource !== source) {
      dispatchUi({ type: 'LOAD_SOURCE_CHANGED', source });
    }
  }

  function handleCacheMessage(message: ModelCacheWorkerMessage): void {
    if (message.type === 'LEASE_STATE') {
      sharedAcquisition = message.kind === 'attached';
      if (sharedAcquisition) runtimeNoticeText.textContent = 'Joining download · Network (shared). Each tab still uses its own GPU memory.';
      return;
    }
    if (message.type === 'PACKAGE_COMPLETE') {
      // Disk readiness is not inference readiness. LOAD_READY is emitted only
      // after this tab's ORT session has actually loaded, never on a cache event.
      if (message.manifestVersion === modelConfig?.manifestVersion) {
        patchUiState({ residency: 'on-disk', cacheAction: 'idle' });
      }
      return;
    }
    if (autoResuming && (message.type === 'CACHE_WARNING' && message.warning.code !== 'cache-service-restarted' || message.type === 'ERROR')) return;
    if (message.type === 'STATUS') {
      cacheStatus = message.status;
      browserStorage = {
        persistence: message.status.persistence,
        estimate: message.status.estimate,
      };
      patchUiState({
        residency: message.status.residency,
        cacheAction: message.status.cacheAction,
        warning: message.status.warning ?? uiState.warning,
      });
      return;
    }

    if (message.type === 'FILE_PROGRESS') {
      if (message.manifestVersion !== modelConfig?.manifestVersion) return;
      if (reverifying) {
        reverifySummary.textContent = `Re-hashing ${message.file}: ${formatBytes(message.loadedBytes)} / ${formatBytes(message.totalBytes)}. No downloads.`;
        return;
      }
      updateOverallLoadSource(message.source);
      if (uiState.session !== 'loading') {
        return;
      }
      if (!cacheProgress.update(message)) return;
      if (message.phase === 'retrying') {
        acquisitionNotice('connection-lost');
        runtimeNoticeText.textContent = `Connection dropped — retrying (${message.attempt}/4). Resuming from the durable checkpoint.`;
      } else if (message.phase === 'resuming' || message.phase === 'verifying-resumed-prefix') {
        acquisitionNotice('resuming');
        runtimeNoticeText.textContent = 'Resuming: checking the saved prefix before the next Range request. The full file must still pass SHA-256.';
      } else if (message.phase === 'verifying') acquisitionNotice('verifying');
      else if (message.transfer && message.transfer.resumedBytes > 0) acquisitionNotice('resuming');
      if (message.transfer) {
        downloadMetrics.set(message.file, message.transfer);
        const metrics = [...downloadMetrics.values()];
        const bytes = metrics.reduce((sum, entry) => sum + entry.networkBytes, 0);
        const resumed = metrics.reduce((sum, entry) => sum + entry.resumedBytes, 0);
        const durable = metrics.reduce((sum, entry) => sum + entry.durableBytes, 0);
        const speed = bytes / Math.max(1, (performance.now() - downloadStartedAt) / 1000);
        const remaining = [...cacheProgress.files.values()].reduce((sum, entry) => sum + Math.max(0, entry.total - Math.max(entry.received, entry.verified)), 0);
        downloadStatus.textContent = `Download transfers: ${formatBytes(bytes)} newly received · ${formatBytes(resumed)} resumed · ${formatBytes(durable)} durable prefix (unverified) · ${formatBytes(speed)}/s average · download ETA ${speed ? `~${Math.ceil(remaining / speed)}s` : 'measuring'}. Final SHA-256 and inference setup are additional.`;
        downloadStatus.dataset.resumedBytes = String(resumed);
        downloadStatus.dataset.durableBytes = String(durable);
      }
      const percent = cacheProgress.percent;
      cacheProgressSummary.textContent = `${percent}% aggregate · Downloaded ${formatBytes(cacheProgress.received)} of ${formatBytes(cacheProgress.total)} · Verified ${formatBytes(cacheProgress.verified)} of ${formatBytes(cacheProgress.total)} · ${cacheProgress.completeFiles} of ${cacheProgress.files.size} files complete.`;
      cacheFileProgress.replaceChildren(...[...cacheProgress.files.values()].map((file) => {
        const item = document.createElement('li');
        item.dataset.file = file.file;
        item.dataset.percent = String(file.percent);
        item.dataset.phase = file.phase;
        item.textContent = `${file.file} · ${Math.floor(file.percent)}% · ${file.source} · ${file.phase} · received ${formatBytes(file.received)}, verified ${formatBytes(file.verified)} / ${formatBytes(file.total)}`;
        return item;
      }));
      const phase = message.phase === 'retrying' ? `Retrying (${message.attempt}/4)` : message.phase === 'downloading'
        ? 'Downloading'
        : message.phase === 'verifying' ? 'Verifying'
          : message.phase === 'committing' ? 'Finalizing'
            : message.phase === 'resuming' || message.phase === 'verifying-resumed-prefix' ? 'Resuming: checking saved prefix'
              : message.phase === 'serving' || message.phase === 'done' ? 'Loading' : 'Preparing';
      loadProgress.hidden = false;
      loadProgressBar.value = percent;
      loadProgressBar.textContent = `${percent}%`;
      loadProgressValue.textContent = `${percent}%`;
      loadProgressLabel.textContent = `${phase} ${message.file.split('/').at(-1)} · ${message.source === 'disk' ? 'Disk' : sharedAcquisition ? 'Network (shared)' : 'Network'}`;
      return;
    }

    if (message.type === 'SOURCE_CHANGED') {
      updateOverallLoadSource(message.source);
      if (message.source === 'network' && message.reason !== 'cache-miss') {
        const warning: ModelCacheWarning = message.reason === 'corruption'
          ? MODEL_CACHE_CORRUPTION_WARNING
          : message.reason === 'quota'
            ? {
                code: 'quota-insufficient',
                message: 'There is not enough available storage to keep Eva on disk. Eva is loading from the network.',
                recoverable: true,
              }
            : {
                code: 'storage-unavailable',
                message: 'Durable model storage is unavailable. Eva is loading from the network.',
                recoverable: true,
              };
        runtimeNoticeText.textContent = warning.message;
        dispatchUi({ type: 'WARNING_SET', warning });
        void refreshStorageStatus();
      }
      return;
    }

    if (message.type === 'CACHE_WARNING') {
      if (message.warning.code === 'connection-lost') acquisitionFailure = 'connection-lost';
      if (message.warning.code === 'integrity-failed') acquisitionFailure = 'load-failed';
      if (message.warning.code === 'cache-corrupt') {
        runtimeNoticeText.textContent = 'Cached model data was invalid and was removed. Eva is loading from the network.';
      } else if (message.warning.code === 'browser-evicted') {
        acquisitionNotice('resuming');
        runtimeNoticeText.textContent = 'Browser cleared partial download; resuming what survived.';
      } else {
        const code: AcquisitionNoticeCode = message.warning.code === 'cache-service-restarted' ? 'cache-service-restarted'
          : message.warning.code === 'host-contract' ? 'host-contract'
          : message.warning.code === 'connection-lost' ? 'connection-lost'
          : message.warning.code === 'integrity-failed' ? 'load-failed'
          : message.warning.code === 'quota-insufficient' ? 'insufficient-storage' : 'cache-unavailable';
        acquisitionNotice(code);
      }
      dispatchUi({ type: 'WARNING_SET', warning: { ...message.warning, message: runtimeNoticeText.textContent ?? '' } });
      if (message.warning.code === 'cache-corrupt'
        || message.warning.code === 'quota-insufficient'
        || message.warning.code === 'storage-unavailable') {
        void refreshStorageStatus();
      }
      return;
    }

    if (message.type === 'MANIFEST_UPDATED') {
      runtimeNoticeText.textContent = uiState.session === 'ready'
        ? 'Eva remains ready with the current model. An update is available for the next load.'
        : 'An updated Eva model is available for the next explicit load.';
      dispatchUi({ type: 'MANIFEST_UPDATED' });
      return;
    }

    if (message.type === 'REMOVE_RESULT') {
      cacheStatus = message.status;
      patchUiState({
        residency: message.status.residency,
        cacheAction: message.status.cacheAction,
        warning: message.status.warning,
      });
      return;
    }

    if (message.type === 'ERROR') {
      acquisitionDiagnostic(message.message);
      const warning: ModelCacheWarning = {
        code: 'protocol',
        message: ACQUISITION_NOTICES['cache-unavailable'],
        recoverable: message.recoverable,
      };
      dispatchUi({ type: 'WARNING_SET', warning });
    }
  }

  async function createNewSession(): Promise<void> {
    await recovery.flush();
    const session = await createLocalSession();
    activeSessionId = session.id;
    localStorage.setItem(activeSessionStorageKey(), activeSessionId);
    await refreshSessions();
    await renderMessages();
    await restoreRecovery();
    closeDrawers();
    input.focus();
  }

  async function initializeData(): Promise<void> {
    profile = await getProfile(contextScope);
    sessions = await listSessions(contextScope);
    const savedSessionId = localStorage.getItem(activeSessionStorageKey())
      ?? localStorage.getItem(ACTIVE_SESSION_KEY);
    activeSessionId = sessions.some((session) => session.id === savedSessionId)
      ? savedSessionId as string
      : sessions[0]?.id ?? '';
    if (!activeSessionId) {
      activeSessionId = (await createLocalSession()).id;
      sessions = await listSessions(contextScope);
    }
    localStorage.setItem(activeSessionStorageKey(), activeSessionId);
    renderSessions();
    renderProfile();
    await Promise.all([renderMessages(), renderMemory(), refreshStorageStatus()]);
    await refreshContextPartitions();
    await restoreRecovery();
  }

  async function runContextAction(action: () => Promise<void>): Promise<void> {
    if (disposed || contextBusy || generating || uiState.session === 'loading' || uiState.session === 'unloading') return;
    contextBusy = true;
    updateControls();
    try { await action(); }
    catch (error) {
      reportContextError(error);
      if (importDialog.open) {
        importError.textContent = error instanceof Error ? error.message : String(error);
        importError.hidden = false;
      }
    }
    finally { contextBusy = false; updateControls(); flushHiddenRecovery(); }
  }

  async function checkRuntime(): Promise<void> {
    runtimeRetryNeeded = false;
    modelConfig = null;
    cacheConfigured = false;
    cacheStatus = null;
    retryRuntimeButton.hidden = true;
    dispatchUi({ type: 'PREFLIGHT_STARTED' });
    dispatchUi({ type: 'RESIDENCY_CHANGED', residency: 'unknown' });
    dispatchUi({ type: 'MANIFEST_UPDATE_CLEARED' });
    runtimeNotice.hidden = false;
    runtimeNoticeText.textContent = 'Checking WebGPU and the Eva artifact...';

    if (fixtureMode === 'webgpu-unavailable') {
      runtimeProvider.textContent = 'Unavailable';
      modelLabel.textContent = 'WebGPU is not available';
      runtimeNoticeText.textContent = 'WebGPU is unavailable in this browser. Eva was not loaded.';
      dispatchUi({ type: 'RESIDENCY_CHANGED', residency: 'network-only' });
      dispatchUi({ type: 'PREFLIGHT_FAILED', error: 'WebGPU is unavailable.' });
      return;
    }
    if (fixtureMode === 'endpoint-error') {
      runtimeProvider.textContent = 'Test fixture';
      modelLabel.textContent = 'Eva artifact endpoint unavailable';
      runtimeNoticeText.textContent = 'Eva artifact preflight failed: the model endpoint is unavailable. No model was loaded.';
      retryRuntimeButton.hidden = false;
      dispatchUi({ type: 'RESIDENCY_CHANGED', residency: 'network-only' });
      dispatchUi({ type: 'PREFLIGHT_FAILED', error: 'The model endpoint is unavailable.' });
      return;
    }
    if (!fixtureMode) {
      try { await requireWebGpu(); }
      catch (error) {
        const message = error instanceof WebGpuAdmissionError ? error.message : 'The GPU check failed. Retry without downloading the model.';
        runtimeProvider.textContent = 'Unavailable';
        modelLabel.textContent = 'WebGPU is not ready';
        runtimeNoticeText.textContent = message;
        retryRuntimeButton.hidden = false;
        // A GPU failure says nothing about OPFS residency.
        dispatchUi({ type: 'PREFLIGHT_FAILED', error: message });
        return;
      }
    }

    try {
      const settings = normalizeEvaRuntimeSettings(getEvaRuntimeSettings());
      let cacheWarning: ModelCacheWarning | null = null;

      if (!fixtureMode || fixtureMode === 'model-cache') {
        const availability = await cacheClient.initialize();
        if (availability.warning) acquisitionDiagnostic(availability.warning.message);
        cacheWarning = availability.warning ? { ...availability.warning, message: ACQUISITION_NOTICES['cache-unavailable'] } : null;
        if (availability.available) {
          try {
            cacheStatus = await cacheClient.configureRoot({
              modelOrigin: new URL(settings.modelHost).origin,
              modelRootPath: createModelCacheRootPath(settings.modelId),
            });
          } catch (error) {
            acquisitionDiagnostic(error);
            cacheWarning = {
              code: 'network-only',
              message: ACQUISITION_NOTICES['cache-unavailable'],
              recoverable: true,
            };
          }
        }
      }

      modelConfig = fixtureMode === 'ready'
        ? fixtureModelConfig()
        : await fetchEvaModelConfig(settings);
      if (fixtureMode === 'model-cache') {
        modelConfig = { ...modelConfig, testFixture: 'model-cache' };
      }

      const manifestInventory = modelConfig.manifest.cacheInventory;
      const inventory: ModelCacheInventory | null = manifestInventory
        ? {
            ...manifestInventory,
            modelOrigin: modelConfig.modelHost,
            modelRootPath: createModelCacheRootPath(modelConfig.modelId),
            manifestIdentity: {
              manifestVersion: modelConfig.manifestVersion,
              strongEtag: modelConfig.manifestEtag,
              rawSha256: modelConfig.manifestRawSha256,
            },
          }
        : null;
      let residency = cacheStatus?.residency ?? 'network-only';
      if (inventory && cacheClient.availability.available) {
        try {
          cacheStatus = await cacheClient.configureInventory(inventory);
          cacheConfigured = true;
          residency = cacheStatus.residency;
          cacheWarning = cacheStatus.warning ?? cacheWarning;
        } catch (error) {
          acquisitionDiagnostic(error);
          residency = 'network-only';
          cacheWarning = {
            code: 'network-only',
            message: ACQUISITION_NOTICES['cache-unavailable'],
            recoverable: true,
          };
        }
      } else {
        residency = 'network-only';
      }

      runtimeProvider.textContent = fixtureMode ? 'Fixture (test only)' : 'WebGPU';
      runtimeModel.textContent = modelConfig.modelId;
      modelLabel.textContent = fixtureMode === 'ready'
        ? 'Deterministic browser test fixture · not a model substitute'
        : fixtureMode === 'model-cache'
          ? 'Model-cache transport fixture · not a model substitute'
        : `${modelConfig.modelId} · q4f16 · ${modelConfig.manifest.onnx.dataFiles.length} shards`;
      runtimeNoticeText.textContent = uiState.manifestUpdateAvailable
        ? 'An updated Eva model is available for the next explicit load.'
        : fixtureMode === 'ready'
        ? 'Development fixture ready. Production still requires the exact Eva artifact.'
        : residency === 'on-disk'
          ? 'Verified Eva model files are on this device. Loading remains explicit.'
          : cacheWarning
            ? `${cacheWarning.message} Loading remains explicit.`
            : 'Eva passed artifact preflight. Loading is explicit and may download several gigabytes.';
      if (cacheWarning) {
        dispatchUi({ type: 'WARNING_SET', warning: cacheWarning });
      } else {
        dispatchUi({ type: 'WARNING_CLEARED' });
      }
      try {
        await retagActiveEmptySessionForModel();
      } catch (error) {
        liveStatus.textContent = `The debug session ID could not be updated: ${error instanceof Error ? error.message : String(error)}`;
      }
      dispatchUi({ type: 'PREFLIGHT_SUCCEEDED', residency });
      if (!uiState.manifestUpdateAvailable && (cacheWarning?.code === 'network-only' || cacheStatus?.backend === 'unavailable')) acquisitionNotice('cache-unavailable');
      await refreshStorageStatus();
      if (capacity === 'tight' && residency !== 'on-disk') runtimeNoticeText.textContent += ' Storage is tight or its estimate unavailable; cleanup may be needed.';
    } catch (error) {
      modelLabel.textContent = 'Eva artifact preflight failed';
      acquisitionDiagnostic(error);
      acquisitionNotice('load-failed');
      retryRuntimeButton.hidden = false;
      dispatchUi({ type: 'RESIDENCY_CHANGED', residency: 'network-only' });
      dispatchUi({
        type: 'PREFLIGHT_FAILED',
        error: ACQUISITION_NOTICES['load-failed'],
      });
    }
  }

  async function resumeModelOnPageLoad(): Promise<void> {
    if (!cacheConfigured || !modelConfig || disposed || !canAutoResumeFromDisk(autoResumeToggle.checked, cacheStatus)) return;
    autoResuming = true;
    updateControls();
    try {
      const result = await autoResumeFromDisk({ enabled: autoResumeToggle.checked, status: cacheStatus,
        verify: async () => {
          cacheProgress = new ModelCacheProgress(modelConfig?.manifest.cacheInventory ?? null);
          dispatchUi({ type: 'LOAD_STARTED', source: 'disk' });
          runtimeNoticeText.textContent = 'Verifying the saved model before automatic disk-only loading.';
          const verified = await cacheClient.reverify();
          cacheStatus = verified.status;
          patchUiState({ session: 'unloaded', cacheAction: 'idle' });
          return !disposed && verified.files.every((file) => file.status === 'passed') && canAutoResumeFromDisk(true, verified.status);
        },
        loadDisk: async () => {
          if (disposed) return false;
          await loadModel(true);
          return uiState.session === 'ready';
        },
      });
      if (result === 'unavailable' && !disposed) {
        loadProgress.hidden = true;
        cacheStatus = await cacheClient.getStatus().catch(() => null);
        patchUiState({ session: 'unloaded', residency: cacheStatus?.residency ?? 'network-only', cacheAction: 'idle',
          error: null, warning: null, loadSource: null });
        runtimeNoticeText.textContent = cacheStatus?.residency === 'on-disk'
          ? 'Model files remain on this device. Load Eva when ready.'
          : 'Eva is available. Load Eva explicitly to download missing model files.';
        liveStatus.textContent = '';
      }
    } finally { autoResuming = false; updateControls(); }
  }

  autoResumeToggle.addEventListener('change', () => {
    try { localStorage.setItem(AUTO_RESUME_STORAGE_KEY, autoResumeToggle.checked ? 'on' : 'off'); }
    catch {
      autoResumeToggle.checked = localStorage.getItem(AUTO_RESUME_STORAGE_KEY) !== 'off';
      liveStatus.textContent = 'The auto-resume preference could not be saved.';
    }
  });

  async function loadModel(diskOnly = false): Promise<void> {
    if (!modelConfig || uiState.session !== 'unloaded' || uiState.preflight !== 'usable') {
      return;
    }

    if (!diskOnly && uiState.manifestUpdateAvailable) {
      await checkRuntime();
      if (!modelConfig || uiState.session !== 'unloaded' || uiState.preflight !== 'usable') {
        return;
      }
    }
    const initialSource: ModelCacheLoadSource = uiState.residency === 'on-disk' ? 'disk' : 'network';
    downloadPaused = false;
    acquisitionFailure = null;
    runtimeRetryNeeded = false;
    visibilityHint.hidden = true;
    downloadStartedAt = performance.now();
    downloadMetrics.clear();
    downloadStatus.textContent = 'Preparing explicit load; speed and download ETA will appear for Range transfers.';
    cacheLoadNonce = null;
    liveStatus.textContent = '';
    cacheProgress = new ModelCacheProgress(modelConfig.manifest.cacheInventory);
    cacheFileProgress.replaceChildren();
    cacheProgressSummary.textContent = '';
    loadProgress.hidden = false;
    loadProgressBar.value = 0;
    loadProgressBar.textContent = '0%';
    loadProgressValue.textContent = '0%';
    loadProgressLabel.textContent = `Preparing Eva · ${initialSource === 'disk' ? 'Disk' : 'Network'}`;
    runtimeNoticeText.textContent = initialSource === 'disk'
      ? 'Eva is loading from verified files on this device.'
      : 'Eva is downloading and loading after your explicit request.';
    dispatchUi({ type: 'LOAD_STARTED', source: initialSource });

    try {
      if (!fixtureMode) await requireWebGpu(); // Revalidate immediately before acquiring a lease.
      if ((!fixtureMode || fixtureMode === 'model-cache') && 'serviceWorker' in navigator && !cacheClient.availability.available) {
        acquisitionFailure = 'cache-unavailable';
        throw new Error('The cache service has not attached. Retry instead of starting an uncached download.');
      }
      if (cacheClient.availability.available && modelConfig.manifest.cacheInventory) {
        // Residency is a fresh SW answer, not this tab's previous-load guess.
        // GET_STATUS also exercises the one-replay recovery when globals died.
        cacheStatus = cacheConfigured ? await cacheClient.getStatus() : await cacheClient.ensureConfigured();
        cacheConfigured = true;
      }
      await refreshStorageStatus();
      const admission = await probeStorageAdmission(
        cacheStatus?.totalBytes ?? modelConfig?.manifest.cacheInventory?.totalBytes ?? 0,
        cacheStatus?.cachedBytes ?? 0,
      );
      if (admission.state === 'cache-unavailable') {
        acquisitionFailure = 'cache-unavailable';
        acquisitionNotice('cache-unavailable', admission.message);
        throw new Error(admission.message);
      }
      if (!diskOnly && (capacity === 'insufficient' || admission.state === 'insufficient-storage')) {
        acquisitionFailure = 'insufficient-storage';
        acquisitionNotice('insufficient-storage', admission.message);
        throw new DOMException(admission.message, 'QuotaExceededError');
      }
      if (diskOnly && !cacheConfigured) throw new Error('Disk-only loading requires the verified local cache.');
      if (cacheConfigured) {
        try {
          const policy = devicePolicy();
          try { cacheLoadNonce = await cacheClient.beginLoad(diskOnly, policy.concurrency, policy.chunkBytes); }
          catch (error) {
            // RPC-coded failures already consumed their one self-heal replay.
            // Transport/timeouts get one explicit configure + begin attempt here.
            if (error instanceof ModelCacheRpcError && error.code !== 'RPC_TIMEOUT') throw error;
            await cacheClient.ensureConfigured();
            cacheLoadNonce = await cacheClient.beginLoad(diskOnly, policy.concurrency, policy.chunkBytes);
          }
          startCacheLeaseHeartbeat(cacheLoadNonce);
          updateControls();
        } catch (error) {
          acquisitionDiagnostic(error);
          acquisitionFailure = 'cache-unavailable';
          // A rejected lease must NEVER turn into an uncontrolled multi-GB fetch.
          // Retry/Load re-drives the same recovery, including disk-only loads.
          throw error;
        }
      }
      if (devicePolicy().mobile && (!cacheLoadNonce || cacheStatus?.backend === 'unavailable')) {
        acquisitionFailure = 'cache-unavailable';
        throw new Error('Mobile acquisition needs a working local cache. Enable browser storage, then Retry.');
      }
      if (!cacheConfigured && !diskOnly) {
        const warning: ModelCacheWarning = {
          code: 'network-only',
          message: ACQUISITION_NOTICES['cache-unavailable'],
          recoverable: true,
        };
        runtimeNoticeText.textContent = `${warning.message} Eva is loading from the network.`;
        dispatchUi({ type: 'LOAD_SOURCE_CHANGED', source: 'network', warning });
      }
      if (cacheLoadNonce && initialSource === 'network') await acquisitionWakeLock.start();

      // The explicit page lease must exist before the dedicated worker script is
      // requested, allowing the Service Worker to bind its resulting Client id.
      const loadConfig: EvaModelConfig = {
        ...modelConfig,
        cacheLeaseNonce: cacheLoadNonce,
        pageHeapHeadroom: heapHeadroom(),
        kvAllowance: kvAllowance.value as EvaKvAllowance,
      };
      const performLoad = async () => {
        if (downloadPaused || disposed) throw new DOMException('Acquisition ended.', 'AbortError');
        runtime ??= fixtureMode === 'ready' ? new FixtureRuntime() : new EvaWorkerClient();
        await runtime.load(loadConfig, (progress) => {
          if (cacheConfigured && modelConfig?.manifest.cacheInventory) return; // SW owns aggregate progress.
          const percent = progress.progress ?? (
            progress.loaded !== null && progress.total ? progress.loaded / progress.total * 100 : 0
          );
          const boundedPercent = Math.max(loadProgressBar.value, Math.min(100, Math.round(percent)));
          loadProgressBar.value = boundedPercent;
          loadProgressBar.textContent = `${boundedPercent}%`;
          loadProgressValue.textContent = `${boundedPercent}%`;
          const source = uiState.loadSource === 'disk' ? 'Disk' : 'Network';
          loadProgressLabel.textContent = progress.file
            ? `Loading ${progress.file.split('/').at(-1)} · ${source}`
            : `${progress.status} · ${source}`;
        });
      };
      const beforeLoadRestarts = cacheClient.restarts;
      try { await performLoad(); }
      catch (error) {
        runtime = terminateFailedLoad(runtime);
        if (!cacheLoadNonce || downloadPaused || disposed || acquisitionFailure === 'load-failed') throw error;
        // A killed SW also breaks the in-flight Fetch, not just the next RPC.
        // Reconcile the existing explicit lease; retry inference setup ONCE only
        // if a lost global was actually recovered, never for integrity failures.
        await cacheClient.renewLoad(cacheLoadNonce);
        if (cacheClient.restarts === beforeLoadRestarts) throw error;
        await performLoad();
      }
      renderBudgets();
      loadProgress.hidden = true;
      acquisitionWakeLock.stop();
      dispatchUi({ type: 'LOAD_READY' });
      runtimeNoticeText.textContent = readyNotice(uiState.warning);
      if (!diskOnly) input.focus();

      if (cacheLoadNonce) {
        stopCacheLeaseHeartbeat();
        try {
          cacheStatus = await cacheClient.endLoad(cacheLoadNonce);
          const recoveredStorageWrite = cacheStatus.residency === 'on-disk'
            && (uiState.warning?.code === 'quota-insufficient'
              || uiState.warning?.code === 'storage-unavailable');
          patchUiState({
            residency: cacheStatus.residency,
            cacheAction: cacheStatus.cacheAction,
            warning: recoveredStorageWrite ? null : cacheStatus.warning ?? uiState.warning,
          });
          if (recoveredStorageWrite) {
            runtimeNoticeText.textContent = 'Eva recovered from a temporary storage write failure. Eva is loaded in this tab and verified model files are on disk.';
          }
        } catch (error) {
          acquisitionDiagnostic(error);
          patchUiState({
            warning: {
              code: 'write-failed',
              message: 'Eva is ready, but the local cache could not finish. Retry the cache check before the next load.',
              recoverable: true,
            },
          });
        }
      }
    } catch (error) {
      stopCacheLeaseHeartbeat();
      runtimeRetryNeeded = !downloadPaused;
      runtime = terminateFailedLoad(runtime);
      acquisitionWakeLock.stop();
      if (downloadPaused) await pauseWork;
      if (cacheLoadNonce && !downloadPaused) {
        try {
          cacheStatus = await cacheClient.cancelLoad(cacheLoadNonce);
        } catch {
          // The load error remains primary; an expired lease needs no extra failure.
        }
      }
      loadProgress.hidden = true;
      if (downloadPaused) {
        patchUiState({ session: 'unloaded', error: null, cacheAction: 'idle', loadSource: null });
        runtimeNoticeText.textContent = 'Download paused. Completed OPFS chunks are retained, unverified and never served. Resume is explicit.';
        downloadStatus.textContent = 'Paused — network lease ended. Resume continues durable Range prefixes; an incomplete chunk is downloaded again. No background download.';
        return;
      }
      if (diskOnly) {
        patchUiState({ session: 'unloaded', error: null, cacheAction: 'idle', warning: null, loadSource: null });
        return;
      }
      acquisitionDiagnostic(error);
      const failureCode = acquisitionFailure ?? acquisitionFailureCode(error);
      const isCustomError = error instanceof Error && error.message && (
        error.message.includes('Safari storage limit reached') || error.message.includes('Private Browsing')
      );
      const noticeMessage = isCustomError ? error.message : ACQUISITION_NOTICES[failureCode];
      acquisitionNotice(failureCode, noticeMessage);
      if (!isCustomError && devicePolicy().mobile && acquisitionFailure === 'cache-unavailable') {
        runtimeNoticeText.textContent = 'Local cache unavailable. This download is paused; no uncached model download was started. Enable site storage or try another browser, then Retry.';
      }
      dispatchUi({
        type: 'LOAD_FAILED',
        error: noticeMessage,
      });
      patchUiState({
        residency: cacheStatus?.residency ?? uiState.residency,
        cacheAction: cacheStatus?.cacheAction ?? 'idle',
      });
    } finally {
      acquisitionWakeLock.stop();
      stopCacheLeaseHeartbeat();
      cacheLoadNonce = null;
      await refreshStorageStatus();
    }
  }

  async function unloadModel(): Promise<void> {
    acquisitionWakeLock.stop();
    if (!runtime || uiState.session !== 'ready') {
      return;
    }
    dispatchUi({ type: 'UNLOAD_STARTED' });
    try {
      await runtime.dispose();
      dispatchUi({ type: 'UNLOAD_FINISHED' });
      runtimeNoticeText.textContent = uiState.residency === 'on-disk'
        ? isLimitedStorageWarning(uiState.warning)
          ? 'Local storage is limited. Model cache may be cleared by browser.'
          : 'Eva was unloaded. Verified model files remain on this device.'
        : 'Eva was unloaded. The local conversation remains available.';
    } catch (error) {
      liveStatus.textContent = error instanceof Error ? error.message : String(error);
      patchUiState({ session: 'ready' });
      dispatchUi({
        type: 'CACHE_ACTION_FAILED',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function showRemoveModelDialog(): void {
    const totalBytes = cacheStatus?.totalBytes
      ?? modelConfig?.manifest.cacheInventory?.totalBytes
      ?? null;
    const size = totalBytes === null ? '' : ` (about ${formatBytes(totalBytes)})`;
    removeModelCopy.textContent = `This removes the verified local Eva model files${size}. Conversations, memories, and profile stay on this device.${uiState.session === 'ready'
      ? ' Eva will remain loaded in this tab until you unload it or leave the page.'
      : ''}`;
    removeModelDialog.showModal();
  }

  async function removeModelFromDevice(): Promise<void> {
    if (!cacheConfigured
      || uiState.cacheAction !== 'idle'
      || uiState.session === 'loading'
      || uiState.session === 'unloading'
      || generating) {
      return;
    }

    dispatchUi({ type: 'REMOVE_STARTED' });
    runtimeNoticeText.textContent = 'Removing Eva model files from this device…';
    try {
      const result = await cacheClient.removeModel();
      cacheStatus = result.status;
      dispatchUi({ type: 'REMOVE_FINISHED' });
      if (result.status.warning) {
        dispatchUi({ type: 'WARNING_SET', warning: result.status.warning });
      }
      if (uiState.session === 'ready') {
        runtimeNoticeText.textContent = 'Eva remains loaded in this tab. The next load will use the network.';
      } else {
        runtimeNoticeText.textContent = 'Eva model files were removed. The next load will use the network.';
      }
      liveStatus.textContent = result.removed
        ? `Removed ${formatBytes(result.removedBytes)} of Eva model files. Conversations, memories, and profile were kept.`
        : 'No stored Eva model files were found. Conversations, memories, and profile were kept.';
    } catch (error) {
      acquisitionDiagnostic(error);
      const warning: ModelCacheWarning = {
        code: 'remove-failed',
        message: 'Eva model files could not be removed: close other tabs using the cache, then retry.',
        recoverable: true,
      };
      if (cacheStatus) {
        cacheStatus = { ...cacheStatus, residency: 'unknown', integrity: 'unverified' };
      }
      runtimeNoticeText.textContent = warning.message;
      dispatchUi({ type: 'CACHE_ACTION_FAILED', error: warning.message, warning });
    } finally {
      await refreshStorageStatus();
    }
  }

  reverifyButton.addEventListener('click', () => { void reverifyModel(); });
  async function reverifyModel(): Promise<void> {
    if (reverifyButton.disabled || reverifying) return;
    reverifying = true;
    reverifyResults.replaceChildren();
    reverifySummary.textContent = 'Re-hashing local files. No downloads.';
    updateControls();
    try {
      const result = await cacheClient.reverify();
      cacheStatus = result.status;
      const failed = result.files.filter((file) => file.status === 'failed');
      reverifyResults.replaceChildren(...result.files.map((file) => {
        const item = document.createElement('li');
        item.dataset.result = file.status;
        item.textContent = `${file.status === 'passed' ? 'PASS' : 'FAIL (invalid or missing; removed if present)'} · ${file.file}`;
        return item;
      }));
      reverifySummary.textContent = failed.length
        ? `${failed.length} file(s) failed. Invalid entries removed. Unload if needed, then Load explicitly to repair. No download was started.`
        : `PASS · ${result.files.length} files re-verified against manifest SHA-256. No downloads.`;
      patchUiState({ residency: result.status.residency, warning: result.status.warning });
      runtimeIntegrity.textContent = failed.length ? 'Failed · repair on next explicit load' : 'SHA-256 re-verification passed';
    } catch (error) {
      acquisitionDiagnostic(error);
      reverifySummary.textContent = 'Verification failed. The local cache could not be checked. Retry; no download was started.';
    } finally { reverifying = false; updateControls(); }
  }

  async function prepareContext(history: EvaMessage[], scope: EvaContextScope, sessionId: string, extra: EvaModelMessage[] = []): Promise<EvaModelMessage[]> {
    const budget = { ...(runtime?.budgets ?? deriveEvaBudgets()), maxNewTokens: Math.min(generationOptions().maxNewTokens, runtime?.budgets.maxNewTokens ?? 640) };
    const query = [...history].reverse().find((message) => message.role === 'user')?.content ?? '';
    const recallForSession = async () => createRecallBlock([
      ...(await listMemory(scope)).filter((record) => record.provenance === 'synopsis' && record.sessionId === sessionId),
      ...(await searchMemory(query, 5, scope, sessionId)).filter((record) => record.provenance !== 'synopsis'),
    ], sessionId);
    const recall = await recallForSession();
    const overheadTokens = extra.length ? 0 : new TextEncoder().encode(JSON.stringify(EVA_TOOL_DEFINITIONS)).length;
    const memories = await listMemory(scope);
    const input = { history, system: evaSystemPrompt, recall, budgets: budget, memories, extra, overheadTokens,
      recallRequired: memories.some((record) => record.provenance === 'synopsis' && record.sessionId === sessionId) };
    const measure = (messages: EvaModelMessage[]) => runtime!.measure(messages, extra.length ? [] : EVA_TOOL_DEFINITIONS);
    const before = await measure([{ role: 'system', content: evaSystemPrompt }, ...history.map(({ role, content, name }) => ({ role, content, ...(name ? { name } : {}) })), ...extra]);
    for (let pass = 0; pass <= history.length; pass += 1) {
      const saved = await contextManager.pageAtBoundary(input, {
        measure,
        isBusy: () => generationActivity.active,
        isCancelled: () => disposed || cancelRequested || !runtime,
        pendingSend: generating,
        generate: (messages) => generationActivity.run(() => runtime!.generate(messages, { maxNewTokens: Math.min(SUMMARY_TOKEN_LIMIT, budget.maxNewTokens),
          contextLimit: budget.contextLength, temperature: 0.1 }, [])),
        persist: async ({ content, tags, ...metadata }) => {
          await storeMemory(content, tags, scope, metadata);
          await renderMemory();
        },
      }).catch((error) => { compressionOffer.hidden = false; throw error; });
      if (cancelRequested || disposed) throw new Error('Context paging stopped. Original history remains on this device.');
      input.recall = await recallForSession();
      input.memories = await listMemory(scope);
      const plan = await contextManager.measuredPlan(input, measure);
      wallArithmetic.textContent = `${fixtureMode ? 'Fixture estimate' : 'Tokenizer'}: ${before} before paging → ${plan.estimatedTokens} after; + ${budget.maxNewTokens} output reserve / ${budget.contextLength} context.`;
      if (plan.fits && !plan.evictions.length) { compressionOffer.hidden = true; return plan.messages; }
      if (!saved && !plan.evictions.length) break;
    }
    throw new Error('Context archives could not be retained on this device. Retry or export the conversation.');
  }

  async function sendMessage(retry = false): Promise<void> {
    const text = retry ? (await listMessages(activeSessionId, contextScope)).at(-1)?.content ?? '' : input.value.trim();
    if (!text || (partialRecovery && unfinishedReason !== 'error') || (!retry && input.value.length > input.maxLength) || uiState.session !== 'ready' || !runtime || generating || contextBusy) {
      return;
    }

    generating = true;
    cancelRequested = false;
    autoContinuations = 0;
    liveStatus.textContent = '';
    input.value = '';
    updateControls();
    const turnScope = { ...contextScope };
    const turnSessionId = activeSessionId;
    let userSaved = false;
    let assistantSaved = false;
    let pendingView: ReturnType<typeof createMessageView> | null = null;
    let streamedText = '';
    let generationPass = 0;
    try {
      const existingMessages = await listMessages(turnSessionId, turnScope);
      if (retry && existingMessages.at(-1)?.role !== 'user') throw new Error('No pending user turn to retry. Use Continue for unfinished text, or send a new message.');
      const userMessage = retry ? existingMessages.at(-1)! : await appendMessage(turnSessionId, 'user', text, undefined, turnScope);
      userSaved = true;
      emptyConversation.hidden = true;
      emptyConversation.remove();
      if (!retry) messageList.append(createMessageView(userMessage).article);
      if (!existingMessages.some((message) => message.role === 'user')) {
        await renameSession(turnSessionId, text, turnScope);
      }
      partialRecovery = '';
      recoveryPreview.hidden = true;
      recovery.markDirty();
      await recovery.flush();
      pendingView = createMessageView({
        ...turnScope,
        id: `pending_${crypto.randomUUID()}`,
        sessionId: turnSessionId,
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
      }, true);
      messageList.append(pendingView.article);
      messageList.scrollTop = messageList.scrollHeight;

      const persistedMessages = await listMessages(turnSessionId, turnScope);
      const initialMessages = await prepareContext(persistedMessages, turnScope, turnSessionId);
      const result = await runBoundedToolLoop(initialMessages, async (messages, tools) => {
        const budget = runtime!.budgets;
        const measured = await runtime!.measure(messages, tools);
        if (measured > budget.contextLength - Math.min(generationOptions().maxNewTokens, budget.maxNewTokens)) {
          throw new Error(`Tool prompt needs ${measured} tokens plus output reserve, beyond ${budget.contextLength} context. Lower the output ceiling or increase the admitted KV allowance. No history was removed.`);
        }
        generationPass += 1;
        streamedText = '';
        pendingView!.content.textContent = generationPass > 1 ? 'Using local context...' : '';
        partialRecovery = '';
        recovery.markDirty();
        const response = await generationActivity.run(() => runtime!.generate(messages, generationOptions(), tools, (streamed) => {
          streamedText = streamed;
          partialRecovery = streamed.slice(0, MAX_UNFINISHED_CHARACTERS);
          if (streamed.length >= MAX_UNFINISHED_CHARACTERS) { cancelRequested = true; runtime!.cancel(); }
          recovery.markDirty();
          pendingView!.content.textContent = getEvaMessageDisplayContent({
            role: 'assistant',
            content: streamed,
          });
          messageList.scrollTop = messageList.scrollHeight;
        }));
        renderGenerationResult(response);
        streamedText = response.text;
        partialRecovery = response.text.slice(0, MAX_UNFINISHED_CHARACTERS);
        if (response.finishReason === 'length' || response.cancelled || cancelRequested) {
          throw new UnfinishedGeneration(response.finishReason, response.generatedTokens);
        }
        return response.text;
      }, turnScope, turnSessionId);

      const finalText = result.text.trim() || streamedText.trim();
      if (finalText) {
        const assistantMessage = await appendMessage(turnSessionId, 'assistant', finalText, undefined, turnScope);
        assistantSaved = true;
        pendingView.article.replaceWith(createMessageView(assistantMessage).article);
      } else {
        pendingView.article.remove();
      }
      partialRecovery = '';
      recovery.markDirty();
      await recovery.flush();
      if (cancelRequested) {
        liveStatus.textContent = 'Generation stopped. The partial response was kept.';
      }
      await Promise.all([refreshSessions(), renderMemory()]);
    } catch (error) {
      pendingView?.article.remove();
      if (userSaved && !assistantSaved) partialRecovery = streamedText.slice(0, MAX_UNFINISHED_CHARACTERS);
      unfinishedReason = error instanceof UnfinishedGeneration ? error.reason : 'error';
      runtimeFinishReason.textContent = unfinishedReason;
      recoveryLabel.textContent = error instanceof UnfinishedGeneration ? error.message : 'Unfinished response after an error — not a completed answer';
      recoveryPartial.textContent = getEvaMessageDisplayContent({ role: 'assistant', content: partialRecovery });
      recoveryPreview.hidden = !partialRecovery;
      if (!userSaved) input.value = text;
      recovery.markDirty();
      await recovery.flush().catch(reportContextError);
      await Promise.all([refreshSessions(), renderMessages(), renderMemory()]).catch(reportContextError);
      liveStatus.textContent = error instanceof UnfinishedGeneration && error.reason === 'stop'
        ? 'Generation stopped. The partial response was kept.' : error instanceof Error ? error.message : String(error);
      patchUiState({ session: 'ready' });
    } finally {
      generating = false;
      cancelRequested = false;
      updateControls();
      messageList.scrollTop = messageList.scrollHeight;
    }
    maybeAutoContinue();
  }

  async function createSynopsis(): Promise<void> {
    await runContextAction(async () => {
      if (!runtime || uiState.session !== 'ready') return;
      const history = await listMessages(activeSessionId, contextScope);
      const source = [...history].reverse().find((message) => message.role === 'assistant');
      if (!source) throw new Error('No completed assistant turn can be compressed. Shorten the user draft or continue the unfinished response from its bounded tail.');
      const chapter = Number(synopsisChapter.value);
      if (!Number.isInteger(chapter) || chapter < 1 || chapter > 9999) throw new Error('Choose a chapter number from 1 to 9999.');
      const tail = await runtime.tail(source.content);
      if (!window.confirm(`Create model-generated chapter ${chapter} synopsis from the latest completed assistant turn (${tail.inputTokens} tokens)? Keep all ${source.content.length} raw characters in memory. After successful validation, use synopsis + ${tail.tailTokens}-token tail in prompts. No unfinished response will be compressed.`)) return;
      synopsisStatus.textContent = 'Generating a bounded chapter synopsis; nothing is compressed until validation and storage succeed…';
      const records = await listMemory(contextScope);
      const previous = records.find((record) => record.provenance === 'synopsis' && record.sessionId === activeSessionId);
      const output = Math.min(1024, runtime.budgets.maxNewTokens);
      const result = await generateChapterSynopsis(source.content, chapter, {
        inputBudget: runtime.budgets.contextLength - output,
        previous: previous?.content,
        measure: (messages) => runtime!.measure(messages, []),
        generate: (messages) => generationActivity.run(() => runtime!.generate(messages, {
          contextLimit: runtime!.budgets.contextLength, maxNewTokens: output, temperature: 0.1,
        }, [])),
      }).catch((error) => {
        synopsisStatus.textContent = `Synopsis failed: ${error instanceof Error ? error.message : String(error)} No live text was compressed.`;
        throw error;
      });
      const content = JSON.stringify(result);
      const compressedTokens = await runtime.measure([{ role: 'assistant', content: `Chapter synopsis (model-generated, untrusted data): ${content}\nOriginal ending:\n${tail.text}` }], []);
      await storeChapterSynopsis(source, content, { chapter, raw: source.content, tail: tail.text,
        modelVersion: runtimeCacheVersion.textContent || 'fixture', compressed: true });
      synopsisStatus.textContent = `Chapter ${chapter} synopsis committed: ${tail.inputTokens} raw content tokens → ${compressedTokens} synopsis + tail prompt tokens (including template). Raw text retained. Use Retry / Continue if a response was blocked. Update explicitly after completing the next chapter.`;
      synopsisChapter.value = String(Math.min(9999, chapter + 1));
      await renderMemory();
    });
  }

  synopsisButton.addEventListener('click', () => { void createSynopsis(); });
  const rebuildIndexButton = requiredElement<HTMLButtonElement>('rebuild-memory-index');
  const memoryIndexStatus = requiredElement<HTMLElement>('memory-index-status');
  rebuildIndexButton.addEventListener('click', () => {
    if (generating || generationActivity.active) return;
    void runContextAction(async () => {
      rebuildIndexButton.disabled = true;
      memoryIndexStatus.textContent = 'Rebuilding memory index...';
      try {
        const status = await rebuildMemoryIndex();
        memoryIndexStatus.textContent = `Memory index: ${status.records} records, sequence ${status.highWaterSeq}, ${status.persistence}.`;
      } catch (error) {
        memoryIndexStatus.textContent = `Memory index rebuild failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally { rebuildIndexButton.disabled = false; }
    });
  });
  compressionButton.addEventListener('click', () => { void createSynopsis(); });
  retryResponse.addEventListener('click', () => { if (partialRecovery) void continueResponse(); else void sendMessage(true); });

  function generationOptions(): EvaGenerationOptions {
    const budget = runtime?.budgets ?? deriveEvaBudgets();
    if (!tokenOverride.checkValidity()) throw new Error('Output token ceiling must be an integer from 1 to 4096.');
    return { maxNewTokens: tokenOverride.value ? Number(tokenOverride.value) : budget.maxNewTokens,
      contextLimit: budget.contextLength, temperature: 0.35 };
  }

  function renderBudgets(): void {
    const budget = runtime?.budgets ?? deriveEvaBudgets();
    runtimeContextBudget.textContent = budget.source === 'model-device'
      ? `${budget.configMax} (config) → ${budget.contextLength} (device cap${budget.slidingWindow ? ', sliding window considered' : ''})`
      : `${budget.contextLength} · conservative defaults`;
    runtimeOutputBudget.textContent = `${budget.maxNewTokens} maximum · reduced to remaining tokenized context room and user ceiling`;
    runtimeBudgetProvenance.textContent = `${budget.explanation} KV: ${formatBytes(budget.kvBytesPerToken)}/token; KV allowance: ${formatBytes(budget.kvBudgetBytes)}; max buffer: ${formatBytes(budget.probe.maxBufferSize)}; binding: ${formatBytes(budget.probe.maxStorageBufferBindingSize)}; heap headroom: ${formatBytes(budget.probe.heapHeadroom)}; disk: ${formatBytes(budget.probe.storageUsage)} / ${formatBytes(budget.probe.storageQuota)}.`;
  }

  function renderGenerationResult(response: EvaGenerationResult): void {
    runtimeInputTokens.textContent = response.inputTokens?.toLocaleString() ?? '-';
    runtimeOutputTokens.textContent = response.generatedTokens?.toLocaleString() ?? '-';
    runtimeElapsed.textContent = `${(response.elapsedMs / 1000).toFixed(1)} s`;
    runtimeFinishReason.textContent = response.cancelled ? 'stop (cancelled, unfinished)' : response.finishReason;
    runtimeOutputBudget.textContent = `${response.tokenLimit} tokens admitted for this pass`;
  }

  function maybeAutoContinue(): void {
    const maximum = Number(autoContinue.value);
    if (!disposed && unfinishedReason === 'length' && partialRecovery && maximum > 0
      && maximum <= MAX_CONTINUATIONS && autoContinuations < maximum && !continueButton.disabled) {
      autoContinuations += 1;
      void continueResponse();
    }
  }

  async function continueResponse(): Promise<void> {
    if (!runtime || generating || contextBusy || disposed || uiState.session !== 'ready' || !partialRecovery) return;
    const prefix = partialRecovery;
    generating = true;
    cancelRequested = false;
    updateControls();
    try {
      const tail = await runtime.tail(prefix);
      continuationArithmetic.textContent = `${tail.inputTokens} unfinished tokens → ${tail.tailTokens} tail tokens + continuation marker; full ${prefix.length} characters retained locally.`;
      const messages = await prepareContext(await listMessages(activeSessionId, contextScope), contextScope, activeSessionId,
        continuationMessages([], tail.text));
      recoveryLabel.textContent = 'Continuing — UNFINISHED until a stop token';
      // No tool execution on recovered text, including imported recovery records.
      const response = await generationActivity.run(() => runtime!.generate(messages, generationOptions(), [], (text) => {
        partialRecovery = (prefix + text).slice(0, MAX_UNFINISHED_CHARACTERS);
        if (prefix.length + text.length >= MAX_UNFINISHED_CHARACTERS) { cancelRequested = true; runtime!.cancel(); }
        recovery.markDirty();
        recoveryPartial.textContent = getEvaMessageDisplayContent({ role: 'assistant', content: partialRecovery });
      }));
      renderGenerationResult(response);
      const remainder = response.cancelled ? response.text : continuationRemainder(prefix, response.text);
      partialRecovery = (prefix + remainder).slice(0, MAX_UNFINISHED_CHARACTERS);
      recoveryPartial.textContent = getEvaMessageDisplayContent({ role: 'assistant', content: partialRecovery });
      if (response.finishReason === 'length' || response.cancelled || cancelRequested) {
        throw new UnfinishedGeneration(response.finishReason, response.generatedTokens);
      }
      const combined = prefix + remainder;
      if (combined.length >= MAX_UNFINISHED_CHARACTERS) throw new UnfinishedGeneration('length', response.generatedTokens);
      await appendMessage(activeSessionId, 'assistant', combined, undefined, contextScope);
      partialRecovery = '';
      unfinishedReason = 'stop';
      recoveryPreview.hidden = true;
      liveStatus.textContent = 'Continuation completed.';
      await Promise.all([renderMessages(), refreshSessions()]);
    } catch (error) {
      unfinishedReason = error instanceof UnfinishedGeneration ? error.reason : 'error';
      runtimeFinishReason.textContent = unfinishedReason;
      if (error instanceof ContinuationNoProgressError) partialRecovery = prefix;
      recoveryPartial.textContent = getEvaMessageDisplayContent({ role: 'assistant', content: partialRecovery });
      recoveryLabel.textContent = error instanceof UnfinishedGeneration ? error.message
        : `Continue could not progress: ${error instanceof Error ? error.message : String(error)} Unfinished text is retained.`;
      liveStatus.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      recovery.markDirty();
      await recovery.flush().catch(reportContextError);
      generating = false;
      cancelRequested = false;
      updateControls();
    }
    maybeAutoContinue();
  }

  continueButton.addEventListener('click', () => { void continueResponse(); });
  kvAllowance.addEventListener('change', () => { void (async () => {
    if (!isEvaKvAllowance(kvAllowance.value)) return;
    const previous = localStorage.getItem('kyuby-eva-kv-allowance') ?? 'conservative';
    try {
      if (runtime?.state === 'ready') await runtime.setBudget(kvAllowance.value);
      localStorage.setItem('kyuby-eva-kv-allowance', kvAllowance.value);
      renderBudgets();
    } catch (error) {
      kvAllowance.value = previous;
      liveStatus.textContent = `KV setting rejected: ${error instanceof Error ? error.message : String(error)}`;
    }
  })(); });
  stopContinuationButton.addEventListener('click', () => {
    unfinishedReason = 'stop';
    autoContinue.value = '0';
    recoveryLabel.textContent = 'Stopped — kept as UNFINISHED recovery. Continue or dismiss before a new turn.';
    updateControls();
  });

  input.addEventListener('input', () => {
    recovery.markDirty();
    updateControls();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendMessage();
  });
  stopButton.addEventListener('click', () => {
    if (runtime && generating) {
      cancelRequested = true;
      runtime.cancel();
      updateControls();
    }
  });
  function triggerLoadWithMemoryCheck(): void {
    const totalBytes = cacheStatus?.totalBytes ?? modelConfig?.manifest.cacheInventory?.totalBytes ?? 0;
    const advisory = evaluateMemoryAdvisory(totalBytes);
    if (!mobileMemoryWarningAccepted && advisory.kind !== 'none') {
      if (mobileMemoryTitle) mobileMemoryTitle.textContent = advisory.title;
      mobileMemoryCopy.textContent = advisory.copy;
      mobileMemoryDialog.showModal();
      return;
    }
    void loadModel();
  }

  loadButton.addEventListener('click', triggerLoadWithMemoryCheck);
  confirmMobileMemoryButton.addEventListener('click', () => {
    mobileMemoryWarningAccepted = true;
    mobileMemoryDialog.close('confirm');
    void loadModel();
  });
  downloadConcurrency.addEventListener('change', () => {
    localStorage.setItem('kyuby-eva-download-concurrency', downloadConcurrency.value === '4' ? '4' : '2');
  });
  pauseDownload.addEventListener('click', () => {
    acquisitionWakeLock.stop();
    if (!cacheLoadNonce || uiState.session !== 'loading' || autoResuming) return;
    downloadPaused = true;
    pauseDownload.disabled = true;
    stopCacheLeaseHeartbeat();
    // Cancellation waits for OPFS checkpoint writes to settle before a new lease.
    const pausedRuntime = runtime;
    pauseWork = cacheClient.cancelLoad(cacheLoadNonce).then((status) => { cacheStatus = status; }).catch(reportContextError).finally(() => {
      pausedRuntime?.terminate();
      if (runtime === pausedRuntime) runtime = null;
    });
  });
  resumeDownload.addEventListener('click', triggerLoadWithMemoryCheck);
  requestPersistenceButton.addEventListener('click', () => void requestPersistence());
  experimentalUiToggle.addEventListener('change', () => {
    experimentalUi = experimentalUiToggle.checked;
    globalThis.localStorage.setItem(EXPERIMENTAL_UI_KEY, experimentalUi ? 'on' : 'off');
    applyExperimentalUi();
    void renderMessages();
  });
  unloadButton.addEventListener('click', () => void unloadModel());
  retryRuntimeButton.addEventListener('click', () => void checkRuntime());
  newSessionButton.addEventListener('click', () => void runContextAction(createNewSession));
  deleteSessionButton.addEventListener('click', () => {
    if (!activeSessionId || !window.confirm('Delete this local conversation?')) {
      return;
    }
    void runContextAction(async () => {
      await recovery.flush();
      await deleteSession(activeSessionId, contextScope);
      localStorage.removeItem(activeSessionStorageKey());
      await initializeData();
    });
  });
  profileForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void runContextAction(async () => {
      profile = await updateProfile(profileName.value, profileNotes.value, contextScope);
      renderProfile();
      await renderMessages();
      liveStatus.textContent = 'Profile saved on this device.';
    });
  });
  contextPartition.addEventListener('change', () => {
    const nextPartition = contextPartition.value;
    contextPartition.value = contextScope.context_partition_id;
    void runContextAction(async () => {
      await recovery.flush();
      contextScope = { model_id: contextModelId, context_partition_id: nextPartition };
      localStorage.setItem(activePartitionStorageKey, nextPartition);
      await initializeData();
    });
  });
  exportButton.addEventListener('click', () => {
    void runContextAction(async () => {
      await recovery.flush();
      downloadJson(
        `eva-local-data-${new Date().toISOString().slice(0, 10)}.json`,
        await exportEvaLocalData(exportScope.value === 'all' ? {} : { model_id: contextModelId }),
      );
      contextSaveStatus.textContent = `External export requested at ${new Date().toLocaleTimeString()}. Keep the downloaded file outside browser storage.`;
    });
  });
  importButton.addEventListener('click', () => {
    importFile.value = '';
    importFile.click();
  });
  importFile.addEventListener('change', () => {
    const file = importFile.files?.[0];
    if (!file) return;
    pendingImport = null;
    void runContextAction(async () => {
      if (file.size > MAX_EVA_IMPORT_BYTES) throw new Error('The import file exceeds 16 MiB.');
      const { data, counts } = previewEvaDataImport(await file.text());
      pendingImport = data;
      importError.hidden = true;
      importError.textContent = '';
      importTargets.replaceChildren(...Object.values(data.contexts).map((scope) => {
        const item = document.createElement('li');
        item.textContent = `${scope.model_id} / ${scope.context_partition_id}`;
        return item;
      }));
      importPreview.textContent = `${counts.models} models, ${counts.contexts} context partitions, ${counts.sessions} sessions, ${counts.messages} messages, ${counts.memory} memories, ${counts.profiles} profiles, ${counts.recovery} unfinished recovery records.`;
      importMode.value = 'merge';
      importDialog.showModal();
    });
  });
  importDialog.addEventListener('close', () => { pendingImport = null; });
  importDialog.addEventListener('cancel', (event) => { if (contextBusy) event.preventDefault(); });
  confirmImport.addEventListener('click', (event) => {
    event.preventDefault();
    const data = pendingImport;
    if (!data) return;
    void runContextAction(async () => {
      importError.hidden = true;
      await recovery.flush();
      const result = await importEvaLocalData(data, importMode.value === 'replace' ? 'replace' : 'merge');
      const imported = data.contexts[contextKey(contextScope)];
      const latestSession = imported?.sessions.toSorted((left, right) => right.updatedAt - left.updatedAt)[0];
      if (latestSession) localStorage.setItem(activeSessionStorageKey(), latestSession.id);
      await initializeData();
      importDialog.close();
      contextSaveStatus.textContent = `Import committed: ${result.accepted} records accepted, ${result.kept} existing matching records retained.`;
      liveStatus.textContent = 'Local contexts imported. Model files were not changed.';
    });
  });
  discardRecovery.addEventListener('click', () => {
    void runContextAction(async () => {
      const previous = partialRecovery;
      partialRecovery = '';
      recovery.markDirty();
      try { await recovery.flush(); }
      catch (error) { partialRecovery = previous; recovery.markDirty(); throw error; }
      recoveryPartial.textContent = '';
      recoveryPreview.hidden = true;
      contextSaveStatus.textContent = 'Unfinished response dismissed. The draft was kept on this device.';
    });
  });
  removeModelButton.addEventListener('click', showRemoveModelDialog);
  copyDiagnosticsButton.addEventListener('click', () => {
    copyDiagnosticsButton.disabled = true;
    diagnosticsStatus.textContent = 'Preparing local diagnostics…';
    void copyAcquisitionDiagnostics(async () => {
      let worker = null as Awaited<ReturnType<typeof cacheClient.getDiagnostics>>;
      let workerError: string | null = null;
      try { worker = await cacheClient.getDiagnostics(); }
      catch (error) { workerError = acquisitionDiagnosticError(error); }
      return acquisitionDiagnosticsJson(worker?.snapshot ?? null, cacheClient.diagnostics.snapshot(), {
        workerAvailable: worker !== null, workerError,
        activeLeases: worker?.activeLeases ?? null, activeTransfers: worker?.activeTransfers ?? null,
        session: uiState.session, residency: uiState.residency, source: uiState.loadSource,
        manifestVersion: modelConfig?.manifestVersion ?? null,
        capacity, cacheBackend: cacheStatus?.backend ?? null, integrity: cacheStatus?.integrity ?? null,
        warning: uiState.warning?.code ?? null, storage: browserStorage,
        sharedAcquisition, explicitLeaseActive: cacheLoadNonce !== null,
        cacheServiceRestarts: cacheClient.restarts, wakeLock: acquisitionWakeLock.state,
        acquisitionPolicy: devicePolicy(),
        progress: { percent: cacheProgress.percent, files: [...cacheProgress.files.values()] },
      });
    }).then(() => { diagnosticsStatus.textContent = 'Acquisition diagnostics copied. Nothing uploaded.'; })
      .catch(() => { diagnosticsStatus.textContent = 'Could not copy diagnostics. Allow clipboard access on this HTTPS page and try again. Nothing uploaded.'; })
      .finally(() => { copyDiagnosticsButton.disabled = false; });
  });
  confirmRemoveModelButton.addEventListener('click', () => void removeModelFromDevice());
  clearDataButton.addEventListener('click', () => clearDialog.showModal());
  confirmClearButton.addEventListener('click', () => {
    void runContextAction(async () => {
      await recovery.reset();
      try {
        await clearEvaData();
        for (const key of Object.keys(localStorage)) {
          if (key === ACTIVE_SESSION_KEY || key.startsWith(`${ACTIVE_SESSION_KEY}:`)) localStorage.removeItem(key);
        }
        contextScope = { model_id: contextModelId, context_partition_id: 'default' };
        await initializeData();
        contextSaveStatus.textContent = 'Local context data cleared. External export files were not changed.';
        liveStatus.textContent = 'Conversations, memory, and profile were cleared. Model files were not removed.';
      } catch (error) {
        recovery.markDirty();
        throw error;
      } finally {
        if (!disposed) recovery.start();
      }
    });
  });
  document.querySelectorAll<HTMLButtonElement>('.tab-button').forEach((button) => {
    button.addEventListener('click', () => {
      const selected = button.dataset.tab;
      document.querySelectorAll<HTMLButtonElement>('.tab-button').forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle('is-active', active);
        candidate.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll<HTMLElement>('.inspector-view').forEach((view) => {
        view.hidden = view.dataset.view !== selected;
      });
    });
  });
  openSessionsButton.addEventListener('click', openSessions);
  closeSessionsButton.addEventListener('click', closeDrawers);
  toggleInspectorButton.addEventListener('click', openInspector);
  closeInspectorButton.addEventListener('click', closeInspector);
  drawerScrim.addEventListener('click', closeDrawers);
  window.addEventListener('resize', syncDrawerAccessibility);
  const unsubscribeCache = cacheClient.subscribe(handleCacheMessage);
  window.addEventListener('pagehide', () => {
    acquisitionWakeLock.stop();
    disposed = true;
    void closeMemoryIndex().catch(() => undefined);
    recovery.stop();
    document.removeEventListener('visibilitychange', flushHiddenRecovery);
    stopCacheLeaseHeartbeat();
    if (cacheLoadNonce) {
      void cacheClient.cancelLoad(cacheLoadNonce).catch(() => undefined);
    }
    unsubscribeCache();
    cacheClient.dispose();
    runtime?.terminate();
  }, { once: true });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) window.location.reload();
  });

  syncDrawerAccessibility();
  applyExperimentalUi();
  try {
    await initializeData();
  } catch (error) {
    patchUiState({
      preflight: 'unavailable',
      error: error instanceof Error ? error.message : String(error),
    });
    runtimeNoticeText.textContent = `Eva could not open local storage: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  if (disposed) return;
  recovery.start();
  document.addEventListener('visibilitychange', flushHiddenRecovery);
  await checkRuntime();
  await resumeModelOnPageLoad();
  updateControls();
  void prepareMemoryIndex().then((status) => {
    if (status && !disposed) memoryIndexStatus.textContent = `Memory index: ${status.records} records, sequence ${status.highWaterSeq}, ${status.persistence}.`;
  }).catch(() => {
    if (!disposed) memoryIndexStatus.textContent = 'Memory index unavailable. Rebuild to retry.';
  });
}
