import type {
  ModelCacheLoadSource,
  ModelCacheResidency,
  ModelCacheUiState,
  ModelCacheWarning,
} from './types';

export const INITIAL_MODEL_CACHE_UI_STATE: Readonly<ModelCacheUiState> = Object.freeze({
  preflight: 'checking',
  residency: 'unknown',
  session: 'unloaded',
  loadSource: null,
  cacheAction: 'idle',
  warning: null,
  error: null,
  manifestUpdateAvailable: false,
});

export type ModelCacheUiEvent =
  | { type: 'PREFLIGHT_STARTED' }
  | { type: 'PREFLIGHT_SUCCEEDED'; residency: ModelCacheResidency }
  | { type: 'PREFLIGHT_FAILED'; error: string; warning?: ModelCacheWarning }
  | { type: 'RESIDENCY_CHANGED'; residency: ModelCacheResidency }
  | { type: 'LOAD_STARTED'; source: ModelCacheLoadSource }
  | { type: 'LOAD_SOURCE_CHANGED'; source: ModelCacheLoadSource; warning?: ModelCacheWarning }
  | { type: 'LOAD_READY' }
  | { type: 'LOAD_FAILED'; error: string }
  | { type: 'UNLOAD_STARTED' }
  | { type: 'UNLOAD_FINISHED' }
  | { type: 'VERIFY_STARTED' }
  | { type: 'VERIFY_FINISHED'; residency: ModelCacheResidency; warning?: ModelCacheWarning }
  | { type: 'REMOVE_STARTED' }
  | { type: 'REMOVE_FINISHED' }
  | { type: 'CACHE_ACTION_FAILED'; error: string; warning?: ModelCacheWarning }
  | { type: 'WARNING_SET'; warning: ModelCacheWarning }
  | { type: 'WARNING_CLEARED' }
  | { type: 'MANIFEST_UPDATED' }
  | { type: 'MANIFEST_UPDATE_CLEARED' };

export type ModelCacheBubbleKind =
  | 'loading'
  | 'ready'
  | 'unloading'
  | 'checking'
  | 'unavailable'
  | 'on-disk'
  | 'available';

export interface ModelCacheControlView {
  label: string;
  accessibleName: string;
  title: string;
  disabled: boolean;
}

export interface ModelCacheUiView {
  retryRuntime: boolean;
  bubble: {
    kind: ModelCacheBubbleKind;
    label: string;
  };
  load: ModelCacheControlView;
  unload: ModelCacheControlView;
  loadSourceLabel: 'Disk' | 'Network' | '—';
  canRemove: boolean;
}

export interface DeriveModelCacheUiOptions {
  isGenerating?: boolean;
  hasStoredFiles?: boolean;
}

function optionalWarning(
  event: { warning?: ModelCacheWarning },
  current: ModelCacheWarning | null,
): ModelCacheWarning | null {
  return Object.prototype.hasOwnProperty.call(event, 'warning')
    ? event.warning ?? null
    : current;
}

export function reduceModelCacheUiState(
  state: Readonly<ModelCacheUiState>,
  event: ModelCacheUiEvent,
): ModelCacheUiState {
  switch (event.type) {
    case 'PREFLIGHT_STARTED':
      return { ...state, preflight: 'checking', error: null };
    case 'PREFLIGHT_SUCCEEDED':
      return {
        ...state,
        preflight: 'usable',
        residency: event.residency,
        error: null,
      };
    case 'PREFLIGHT_FAILED':
      return {
        ...state,
        preflight: 'unavailable',
        error: event.error,
        warning: optionalWarning(event, state.warning),
      };
    case 'RESIDENCY_CHANGED':
      return { ...state, residency: event.residency };
    case 'LOAD_STARTED':
      return {
        ...state,
        session: 'loading',
        loadSource: event.source,
        error: null,
      };
    case 'LOAD_SOURCE_CHANGED':
      return state.session !== 'loading'
        ? state as ModelCacheUiState
        : {
            ...state,
            loadSource: state.loadSource === 'network' ? 'network' : event.source,
            warning: optionalWarning(event, state.warning),
          };
    case 'LOAD_READY':
      return state.session !== 'loading'
        ? state as ModelCacheUiState
        : { ...state, session: 'ready', error: null };
    case 'LOAD_FAILED':
      return {
        ...state,
        session: 'unloaded',
        loadSource: null,
        error: event.error,
      };
    case 'UNLOAD_STARTED':
      return state.session !== 'ready'
        ? state as ModelCacheUiState
        : { ...state, session: 'unloading', error: null };
    case 'UNLOAD_FINISHED':
      return {
        ...state,
        session: 'unloaded',
        loadSource: null,
      };
    case 'VERIFY_STARTED':
      return { ...state, cacheAction: 'verifying', error: null };
    case 'VERIFY_FINISHED':
      return {
        ...state,
        cacheAction: 'idle',
        residency: event.residency,
        warning: optionalWarning(event, state.warning),
      };
    case 'REMOVE_STARTED':
      return { ...state, cacheAction: 'removing', error: null };
    case 'REMOVE_FINISHED':
      return {
        ...state,
        cacheAction: 'idle',
        residency: 'network-only',
        error: null,
        warning: state.warning?.code === 'remove-failed' ? null : state.warning,
      };
    case 'CACHE_ACTION_FAILED':
      return {
        ...state,
        cacheAction: 'idle',
        residency: state.cacheAction === 'removing' ? 'unknown' : state.residency,
        error: event.error,
        warning: optionalWarning(event, state.warning),
      };
    case 'WARNING_SET':
      return { ...state, warning: event.warning };
    case 'WARNING_CLEARED':
      return { ...state, warning: null };
    case 'MANIFEST_UPDATED':
      return { ...state, manifestUpdateAvailable: true };
    case 'MANIFEST_UPDATE_CLEARED':
      return { ...state, manifestUpdateAvailable: false };
  }
}

function bubbleForState(state: Readonly<ModelCacheUiState>): ModelCacheUiView['bubble'] {
  if (state.session === 'loading') {
    return {
      kind: 'loading',
      label: state.loadSource === 'disk' ? 'Loading · disk' : 'Loading · network',
    };
  }
  if (state.session === 'ready') {
    return { kind: 'ready', label: 'Ready' };
  }
  if (state.session === 'unloading') {
    return { kind: 'unloading', label: 'Unloading' };
  }
  if (state.preflight === 'checking') {
    return { kind: 'checking', label: 'Checking' };
  }
  if (state.preflight === 'unavailable') {
    return { kind: 'unavailable', label: 'Unavailable' };
  }
  if (state.residency === 'on-disk') {
    return { kind: 'on-disk', label: 'On disk' };
  }
  return { kind: 'available', label: 'Available' };
}

function loadControlForState(
  state: Readonly<ModelCacheUiState>,
  unavailableForMutation: boolean,
): ModelCacheControlView {
  if (state.session === 'loading') {
    const label = state.loadSource === 'disk'
      ? 'Loading Eva from disk…'
      : 'Downloading and loading Eva…';
    return { label, accessibleName: label, title: label, disabled: true };
  }
  if (state.session === 'ready') {
    const label = 'Eva is ready';
    return { label, accessibleName: label, title: label, disabled: true };
  }
  if (state.session === 'unloading') {
    const label = 'Unloading Eva…';
    return { label, accessibleName: label, title: label, disabled: true };
  }
  if (state.preflight === 'checking') {
    const label = 'Checking Eva…';
    return { label, accessibleName: label, title: label, disabled: true };
  }
  if (state.preflight === 'unavailable') {
    const label = 'Eva unavailable';
    return { label, accessibleName: label, title: label, disabled: true };
  }
  const label = state.residency === 'on-disk'
    ? 'Load Eva from disk'
    : 'Load Eva from network';
  return {
    label,
    accessibleName: label,
    title: label,
    disabled: unavailableForMutation,
  };
}

export function deriveModelCacheUi(
  state: Readonly<ModelCacheUiState>,
  options: DeriveModelCacheUiOptions = {},
): ModelCacheUiView {
  const isGenerating = options.isGenerating === true;
  const cacheIsMutating = state.cacheAction !== 'idle';
  const load = loadControlForState(state, isGenerating || cacheIsMutating);
  const unloadDisabled = state.session !== 'ready' || isGenerating || cacheIsMutating;
  const hasStoredFiles = (options.hasStoredFiles ?? state.residency === 'on-disk')
    || state.warning?.code === 'remove-failed';
  return {
    retryRuntime: state.preflight === 'unavailable' || state.session === 'unloaded' && state.error !== null,
    bubble: bubbleForState(state),
    load,
    unload: {
      label: 'Unload Eva',
      accessibleName: 'Unload Eva',
      title: 'Unload Eva',
      disabled: unloadDisabled,
    },
    loadSourceLabel: state.loadSource === 'disk'
      ? 'Disk'
      : state.loadSource === 'network'
        ? 'Network'
        : '—',
    canRemove: hasStoredFiles
      && state.session !== 'loading'
      && state.session !== 'unloading'
      && !isGenerating
      && !cacheIsMutating,
  };
}

export const MODEL_CACHE_CORRUPTION_WARNING: Readonly<ModelCacheWarning> = Object.freeze({
  code: 'cache-corrupt',
  message: 'Cached model data was invalid and was removed. Eva is loading from the network.',
  recoverable: true,
});
