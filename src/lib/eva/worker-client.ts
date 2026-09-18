import { deriveEvaBudgets, type EvaBudgets, type EvaKvAllowance } from './generation-budget';
import type { EvaTextWindow } from './continuation';
import {
  EVA_WORKER_PROTOCOL_VERSION,
  isEvaWorkerResponse,
  type EvaFunctionToolDefinition,
  type EvaGenerationOptions,
  type EvaModelConfig,
  type EvaModelMessage,
  type EvaWorkerRequest,
  type EvaWorkerResponse,
  type EvaWorkerState,
} from './worker-protocol';

export interface EvaGenerationResult {
  text: string;
  inputTokens: number | null;
  generatedTokens: number | null;
  elapsedMs: number;
  finishReason: 'length' | 'stop';
  cancelled: boolean;
  tokenLimit: number;
}

export interface EvaLoadProgress {
  file: string | null;
  loaded: number | null;
  total: number | null;
  progress: number | null;
  status: string;
}

interface PendingRequest<T> {
  kind: 'load' | 'generate' | 'dispose' | 'measure' | 'tail' | 'set-budget';
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: EvaLoadProgress) => void;
  onToken?: (text: string) => void;
}

export class EvaWorkerClient extends EventTarget {
  #worker: Worker;
  #pending = new Map<string, PendingRequest<unknown>>();
  #state: EvaWorkerState = 'idle';
  budgets = deriveEvaBudgets();

  constructor() {
    super();
    this.#worker = new Worker(new URL('../../workers/eva.worker.ts', import.meta.url), {
      type: 'module',
      name: 'eva-inference',
    });
    this.#worker.addEventListener('message', this.#handleMessage);
    this.#worker.addEventListener('error', this.#handleWorkerError);
  }

  get state(): EvaWorkerState {
    return this.#state;
  }

  async load(config: EvaModelConfig, onProgress?: (progress: EvaLoadProgress) => void): Promise<void> {
    const requestId = crypto.randomUUID();
    const completion = this.#waitFor<void>(requestId, 'load', { onProgress });
    this.#post({
      protocolVersion: EVA_WORKER_PROTOCOL_VERSION,
      type: 'load',
      requestId,
      config,
    });
    return completion;
  }

  async generate(
    messages: EvaModelMessage[],
    options: EvaGenerationOptions,
    tools: EvaFunctionToolDefinition[],
    onToken?: (text: string) => void,
  ): Promise<EvaGenerationResult> {
    const requestId = crypto.randomUUID();
    const completion = this.#waitFor<EvaGenerationResult>(requestId, 'generate', { onToken });
    this.#post({
      protocolVersion: EVA_WORKER_PROTOCOL_VERSION,
      type: 'generate',
      requestId,
      messages,
      options,
      tools,
    });
    return completion;
  }

  cancel(): void {
    this.#post({
      protocolVersion: EVA_WORKER_PROTOCOL_VERSION,
      type: 'cancel',
      requestId: crypto.randomUUID(),
    });
  }

  async measure(messages: EvaModelMessage[], tools: EvaFunctionToolDefinition[] = []): Promise<number> {
    const requestId = crypto.randomUUID();
    const result = this.#waitFor<number>(requestId, 'measure');
    this.#post({ protocolVersion: EVA_WORKER_PROTOCOL_VERSION, type: 'measure', requestId, messages, tools });
    return result;
  }

  async tail(text: string): Promise<EvaTextWindow> {
    const requestId = crypto.randomUUID();
    const result = this.#waitFor<EvaTextWindow>(requestId, 'tail');
    this.#post({ protocolVersion: EVA_WORKER_PROTOCOL_VERSION, type: 'tail', requestId, text });
    return result;
  }

  async setBudget(allowance: EvaKvAllowance): Promise<EvaBudgets> {
    const requestId = crypto.randomUUID();
    const result = this.#waitFor<EvaBudgets>(requestId, 'set-budget');
    this.#post({ protocolVersion: EVA_WORKER_PROTOCOL_VERSION, type: 'set-budget', requestId, allowance });
    return result;
  }

  async dispose(): Promise<void> {
    const requestId = crypto.randomUUID();
    const completion = this.#waitFor<void>(requestId, 'dispose');
    this.#post({
      protocolVersion: EVA_WORKER_PROTOCOL_VERSION,
      type: 'dispose',
      requestId,
    });
    await completion;
  }

  terminate(): void {
    this.#worker.removeEventListener('message', this.#handleMessage);
    this.#worker.removeEventListener('error', this.#handleWorkerError);
    this.#worker.terminate();
    for (const pending of this.#pending.values()) {
      pending.reject(new Error('Eva worker was terminated.'));
    }
    this.#pending.clear();
  }

  #post(request: EvaWorkerRequest): void {
    this.#worker.postMessage(request);
  }

  #waitFor<T>(
    requestId: string,
    kind: PendingRequest<T>['kind'],
    handlers: Pick<PendingRequest<T>, 'onProgress' | 'onToken'> = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(requestId, {
        kind,
        resolve: resolve as (value: unknown) => void,
        reject,
        ...handlers,
      });
    });
  }

  #handleMessage = (event: MessageEvent<unknown>): void => {
    if (!isEvaWorkerResponse(event.data)) {
      return;
    }
    const response = event.data;
    const pending = this.#pending.get(response.requestId);

    if (response.type === 'state') {
      this.#state = response.state;
      this.dispatchEvent(new CustomEvent<EvaWorkerState>('statechange', { detail: response.state }));
      if (pending?.kind === 'load' && response.state === 'ready') {
        pending.resolve(undefined);
        this.#pending.delete(response.requestId);
      } else if (pending?.kind === 'dispose' && response.state === 'disposed') {
        pending.resolve(undefined);
        this.#pending.delete(response.requestId);
      }
    } else if (response.type === 'budgets' && (pending?.kind === 'load' || pending?.kind === 'set-budget')) {
      this.budgets = response.budgets;
      if (pending.kind === 'set-budget') { pending.resolve(response.budgets); this.#pending.delete(response.requestId); }
    } else if (response.type === 'measured') {
      pending?.resolve(response.inputTokens);
      this.#pending.delete(response.requestId);
    } else if (response.type === 'text-window') {
      pending?.resolve(response.window);
      this.#pending.delete(response.requestId);
    } else if (response.type === 'progress') {
      pending?.onProgress?.(response);
    } else if (response.type === 'token') {
      pending?.onToken?.(response.text);
    } else if (response.type === 'done') {
      pending?.resolve({
        text: response.text,
        inputTokens: response.inputTokens,
        generatedTokens: response.generatedTokens,
        elapsedMs: response.elapsedMs,
        finishReason: response.finishReason,
        cancelled: response.cancelled,
        tokenLimit: response.tokenLimit,
      });
      this.#pending.delete(response.requestId);
    } else if (response.type === 'error') {
      pending?.reject(new Error(response.message));
      this.#pending.delete(response.requestId);
      this.dispatchEvent(new CustomEvent<Extract<EvaWorkerResponse, { type: 'error' }>>('evaerror', {
        detail: response,
      }));
    }
  };

  #handleWorkerError = (event: ErrorEvent): void => {
    const error = new Error(event.message || 'Eva worker failed unexpectedly.');
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
    this.dispatchEvent(new CustomEvent<Error>('evaerror', { detail: error }));
  };
}
