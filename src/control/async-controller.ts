import type { ControlledSearch, SearchResult } from './files.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ControlledWrite, ControlledProposal, ControlledSpecCapture, ControlledTaskInit, ControlledTaskSnapshot, WorkflowController } from './index.js';
import type { AutomationDelivery, AutomationOptions, StageSubmission } from './orchestration-contract.js';

/**
 * Nonblocking host facade. One workspace child owns each controller and serializes requests.
 * Cancellation waits for the bounded current operation, then pauses/revokes before rejecting;
 * a writer is never killed mid-batch and reported as if no side effect occurred.
 */
export class AsyncWorkflowController {
  readonly #worker: ChildProcess;
  readonly #exited: Promise<void>;
  readonly #progress = new Set<(phase: string) => void>();
  #nextId = 0;
  #closed = false;
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(workspace: string, options: AutomationOptions = {}) {
    this.#worker = spawn(process.execPath, [fileURLToPath(new URL('./control-worker.js', import.meta.url))], {
      cwd: workspace, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    this.#exited = new Promise(resolve => this.#worker.once('close', () => resolve()));
    this.#worker.on('message', (reply: { id: number; value?: unknown; error?: string; progress?: string }) => {
      if (reply.progress) {
        for (const listener of this.#progress) {
          try { listener(reply.progress); }
          catch (error) { console.error('Workflow progress observer failed:', error); }
        }
        return;
      }
      const pending = this.#pending.get(reply.id);
      if (!pending) return;
      this.#pending.delete(reply.id);
      if (reply.error) pending.reject(new Error(reply.error)); else pending.resolve(reply.value);
    });
    const fail = (error: Error): void => {
      this.#closed = true;
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    };
    this.#worker.on('error', fail);
    this.#worker.send!({ workspace, options });
    this.#worker.on('exit', (code) => fail(new Error(`Workflow worker exited (${code}); inspect pending changes before resuming`)));
  }

  async #call<T>(method: string, args: unknown[] = [], signal?: AbortSignal): Promise<T> {
    if (this.#closed) throw new Error('Controller was disposed');
    signal?.throwIfAborted();
    const id = ++this.#nextId;
    let result: T;
    try {
      result = await new Promise<T>((resolve, reject) => {
        this.#pending.set(id, { resolve: (value) => resolve(value as T), reject });
        this.#worker.send!({ id, method, args });
      });
    } catch (error: unknown) {
      if (signal?.aborted && !this.#closed) await this.#call('pause');
      throw error;
    }
    if (signal?.aborted) {
      await this.#call('pause');
      throw new Error('Operation cancelled after reaching quiescence; workflow paused. Inspect status/diff for completed side effects.');
    }
    return result;
  }

  onProgress(listener: (phase: string) => void): () => void {
    this.#progress.add(listener); return () => { this.#progress.delete(listener); };
  }

  doctor(signal?: AbortSignal): Promise<ReturnType<WorkflowController['doctor']>> { return this.#call('doctor', [], signal); }
  search(input: ControlledSearch, signal?: AbortSignal): Promise<SearchResult> { return this.#call('search', [input], signal); }
  rules(skills: string[] = [], signal?: AbortSignal): Promise<ReturnType<WorkflowController['rules']>> { return this.#call('rules', [skills], signal); }
  start(input: ControlledTaskInit, signal?: AbortSignal): Promise<ControlledTaskSnapshot> { return this.#call('start', [input], signal); }
  run(target: string, intent = 'auto', signal?: AbortSignal): Promise<AutomationDelivery> { return this.#call('run', [target, intent], signal); }
  lookup(reference: string, signal?: AbortSignal): Promise<ReturnType<WorkflowController['lookup']>> { return this.#call('lookup', [reference], signal); }
  recover(signal?: AbortSignal): Promise<AutomationDelivery> { return this.#call('recover', [], signal); }
  resume(taskId: string, signal?: AbortSignal): Promise<AutomationDelivery> { return this.#call('resume', [taskId], signal); }
  status(signal?: AbortSignal): Promise<ReturnType<WorkflowController['status']>> { return this.#call('status', [], signal); }
  canApply(): Promise<boolean> { return this.#call('canApply'); }
  delivery(signal?: AbortSignal): Promise<AutomationDelivery> { return this.#call('delivery', [], signal); }
  context(signal?: AbortSignal): Promise<string> { return this.#call('context', [], signal); }
  list(relative?: string, signal?: AbortSignal): Promise<string[]> { return this.#call('list', [relative], signal); }
  read(relative: string, signal?: AbortSignal): Promise<{ path: string; hash: string; content: string }> { return this.#call('read', [relative], signal); }
  diff(signal?: AbortSignal): Promise<ReturnType<WorkflowController['diff']>> { return this.#call('diff', [], signal); }
  artifact(file: string, content: string, signal?: AbortSignal): Promise<ControlledTaskSnapshot> { return this.#call('artifact', [file, content], signal); }
  artifacts(artifacts: Array<{ file: string; content: string }>, expectedToken: string, signal?: AbortSignal): Promise<ControlledTaskSnapshot> { return this.#call('artifacts', [artifacts, expectedToken], signal); }
  propose(summary: string, paths: string[], signal?: AbortSignal): Promise<ControlledProposal> { return this.#call('propose', [summary, paths], signal); }
  approve(id: string, signal?: AbortSignal): Promise<AutomationDelivery> { return this.#call('approve', [id], signal); }
  apply(id: string, changes: ControlledWrite[], signal?: AbortSignal): Promise<ReturnType<WorkflowController['apply']>> { return this.#call('apply', [id, changes], signal); }
  submit(submission: StageSubmission, signal?: AbortSignal): Promise<AutomationDelivery> { return this.#call('submit', [submission], signal); }
  task(args: string[], signal?: AbortSignal): Promise<ControlledTaskSnapshot> { return this.#call('task', [args], signal); }
  captureSpec(input: ControlledSpecCapture, signal?: AbortSignal): Promise<ControlledTaskSnapshot> { return this.#call('captureSpec', [input], signal); }
  pause(reason = 'Paused by human command'): Promise<AutomationDelivery> { return this.#call('pause', [reason]); }
  continue(signal?: AbortSignal): Promise<AutomationDelivery> { return this.#call('continue', [], signal); }

  async dispose(): Promise<void> {
    if (this.#closed) { await this.#exited; return; }
    const closing = this.#call('dispose');
    this.#closed = true;
    try { await closing; }
    finally { this.#progress.clear(); await this.#exited; }
  }
}
