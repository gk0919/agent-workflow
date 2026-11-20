import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { BridgeRequest } from './bridge.js';
import { applyLiteralEdits } from './patch.js';
import type { LiteralEdit } from './patch.js';
import type { SpecInspection } from '../core/spec-change.js';
import { ControlledFiles } from './files.js';
import type { ControlledChange } from './files.js';
import type { SourceCaptureResult } from '../contracts/capabilities.js';
import type { StageSubmission, AutomationProgress, FixedCheck } from './orchestration-contract.js';
export type { ControlledChange, ControlledSearch, SearchResult } from './files.js';
export type ControlledWrite = (ControlledChange & { edits?: never }) | { path: string; beforeHash: string; edits: LiteralEdit[]; content?: never };
export type { StageSubmission, AutomationOptions, AutomationProgress, FixedCheck, AutomationDelivery } from './orchestration-contract.js';
export { AsyncWorkflowController } from './async-controller.js';

export interface ControlledTaskSnapshot {
  stageSubmission: { authoredArtifacts: string[]; sourceEvidence: string | null; items: Array<{ id: string; title: string; artifact: string }> };
  taskId: string; stage: string; status: string; route: string; entry: string; runId: string;
  taskDirectory: string; runtimeStage?: string; lastUpdated: string; revision: number; planHash: string | null;
  plan: string | null; repositoryCurrent: boolean; stateToken: string;
  specChange?: SpecInspection;
}
export interface ControlledProposal {
  id: string; taskId: string; planHash: string; summary: string;
  files: Array<{ path: string; beforeHash: string | null }>;
}
export interface ControlledTaskInit { taskId: string; route: string; entry: string; goal: string; sourceType?: string; sourceText?: string; sourceId?: string }
export interface ControlledSpecCapture { action: 'init' | 'refresh'; baselines?: string[]; capabilities?: string[] }

/**
 * Trusted host API. Only a human command handler may call approve/task/start/resume.
 * The model gets read, artifact, propose and apply capabilities, never this object.
 * Lifecycle and validation remain owned by existing task/route commands.
 */
export class WorkflowController {
  readonly files: ControlledFiles;
  #taskId: string | undefined;
  #proposal: ControlledProposal | undefined;
  #proposedState: string | undefined;
  #approvedState: string | undefined;
  #approvedId: string | undefined;
  #proposalIssue = '';
  #disposed = false;

  constructor(workspace: string, private readonly bridge?: (request: BridgeRequest) => unknown,
    private readonly report: (phase: string) => void = () => {}) { this.files = new ControlledFiles(workspace); }

  #request<T>(action: string, payload: object = {}, timeout = 60_000): T {
    if (this.#disposed) throw new Error('Controller was disposed');
    if (!this.#taskId && !['prepare', 'lookup', 'automation-policy', 'doctor'].includes(action)) throw new Error('Use the human workflow start/resume command first');
    if (this.bridge) return this.bridge({ ...payload, action, taskId: this.#taskId! }) as T;
    return JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('./bridge.js', import.meta.url))], {
      cwd: this.files.root, input: JSON.stringify({ ...payload, action, taskId: this.#taskId }),
      encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024,
    })) as T;
  }

  revoke(): void { this.#approvedState = undefined; this.#approvedId = undefined; }
  dispose(): void { this.revoke(); this.#disposed = true; }

  /** Human command entry: resolve source and classify through the active Core profile. */
  run(target: string, intent = 'auto'): ControlledTaskSnapshot {
    this.report('source');
    const prepared = this.#request<ControlledTaskInit & { sourceContent: string; intent: string }>('prepare', { target, intent });
    this.report('initialize');
    const result = this.start({ ...prepared, ...(prepared.sourceText ? { sourceText: 'Imported source; full text is recorded below' } : {}) });
    this.#request('automation-route', { intent: prepared.intent, entry: prepared.entry });
    if (intent === 'workflow-maintenance') return this.artifact('intake.md', `# Task input\n\n${prepared.sourceContent}`);
    return this.#request('source-content', { content: prepared.sourceContent, revision: result.revision });
  }

  lookup(reference: string, intent = 'auto'): { capture: SourceCaptureResult; intent: string } {
    return this.#request('lookup', { target: reference, intent });
  }

  doctor(): { coreVersion: string; nodeVersion: string; coreProcessId: number; profile: string; provider: string; runtimeIgnored: boolean; tasksReady: boolean; gitRoot: string; skills: string[] } {
    return this.#request('doctor');
  }

  rules(skills: string[] = []): { skills: string[]; context: string } {
    return { skills: this.#request('skills'), context: this.context(skills) };
  }

  correctionLimit(): number { return this.#request('automation-policy'); }

  /** Host orchestration operations. Never expose progress-save or checks as generic model RPC. */
  progress(value?: AutomationProgress): AutomationProgress {
    if (value) return this.#request('progress-save', { progress: value });
    return this.#request('progress-read');
  }

  submitStage(submission: StageSubmission): { waitingFor: string; task: ControlledTaskSnapshot } {
    this.revoke();
    return this.#request('submit-stage', { submission });
  }

  verifyChecks(checks: FixedCheck[]): ControlledTaskSnapshot {
    this.revoke();
    return this.#request('verify-checks', { checks }, 60_000 + checks.reduce((sum, check) => sum + check.timeoutMs, 0));
  }

  start(input: ControlledTaskInit): ControlledTaskSnapshot {
    this.revoke(); this.#proposal = undefined; this.#proposalIssue = ''; this.#taskId = input.taskId;
    return this.#request('init', { args: ['--route', input.route, '--entry', input.entry, '--goal', input.goal, '--repository', '.',
      ...(input.sourceType ? ['--source-type', input.sourceType] : []), ...(input.sourceText ? ['--source-text', input.sourceText] : []),
      ...(input.sourceId ? ['--source-id', input.sourceId] : [])] });
  }

  resume(taskId: string): ControlledTaskSnapshot {
    this.revoke(); this.#proposal = undefined; this.#proposalIssue = ''; this.#taskId = taskId;
    return this.inspect().task;
  }

  inspect(): { task: ControlledTaskSnapshot; issue: string } { return this.#request('inspection'); }
  operationDirectory(): string { return this.#request('operation-directory'); }

  status(): { task: ControlledTaskSnapshot; proposal: ControlledProposal | null; approved: boolean; issue: string; proposalIssue: string } {
    const { task, issue } = this.inspect();
    if (issue) this.revoke();
    if (this.#approvedState !== task.stateToken) this.revoke();
    // Git fingerprints omit ignored files; their approved preimages still bind permission.
    if (this.#approvedState && this.#proposal?.files.some((file) => this.files.baseline(file.path) !== file.beforeHash)) this.revoke();
    if (this.#proposal && !this.#approvedState && (issue || this.#proposedState !== task.stateToken ||
        this.#proposal.files.some(file => this.files.baseline(file.path) !== file.beforeHash))) {
      this.#proposal = undefined;
      this.#proposalIssue = 'Proposal expired: task checkpoint, repository or file preimage changed. Reload stage and submit a new proposal before asking for approval.';
    }
    return { task, proposal: this.#proposal ? structuredClone(this.#proposal) : null, approved: this.#approvedState !== undefined, issue, proposalIssue: this.#proposalIssue };
  }

  /** No repository scan is needed when this controller has no live write grant. */
  canApply(): boolean { return this.#approvedState !== undefined && this.status().approved; }

  /** Fixed read-only Git operations; untracked text is inspected with files.read(). */
  diff(): { status: string; diff: string; untracked: string[] } {
    if (this.#disposed) throw new Error('Controller was disposed');
    const git = (args: string[]): string => execFileSync('git', ['--no-optional-locks', ...args], {
      cwd: this.files.root, encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
    });
    return { status: git(['status', '--short']), diff: git(['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--']),
      untracked: git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean) };
  }

  context(skills: string[] = []): string {
    const state = this.status();
    if (state.issue) throw new Error(state.issue);
    if (state.task.stage === 'Implement' && !state.approved) throw new Error('Renew human approval before loading implementation context');
    return this.#request('context', { skills });
  }

  artifact(file: string, content: string): ControlledTaskSnapshot {
    this.revoke(); this.#proposal = undefined;
    return this.#request('artifact', { file, content });
  }
  artifacts(artifacts: Array<{ file: string; content: string }>, expectedToken: string): ControlledTaskSnapshot {
    this.revoke(); this.#proposal = undefined;
    return this.#request('artifact-batch', { artifacts, expectedToken });
  }

  /** Human-only escape hatch into the existing task CLI, not a shell. */
  task(args: string[]): ControlledTaskSnapshot {
    this.revoke(); this.#proposal = undefined;
    if (!args.length || args.includes('--task') || args[0] === 'init') throw new Error('Task identity is bound to this controller');
    return this.#request('task', { args });
  }

  /** Human host entry; captures only explicit sources through the public spec CLI. */
  captureSpec(input: ControlledSpecCapture): ControlledTaskSnapshot {
    this.revoke(); this.#proposal = undefined;
    if (!['init', 'refresh'].includes(input.action) ||
        [input.baselines, input.capabilities].some(values => values !== undefined && (!Array.isArray(values) || values.some(value => typeof value !== 'string' || value.startsWith('--'))))) {
      throw new Error('Invalid spec capture input');
    }
    const revision = this.inspect().task.revision;
    return this.#request('capture-spec', { args: [input.action, '--expected-revision', String(revision),
      ...(input.baselines ?? []).flatMap(value => ['--baseline', value]), ...(input.capabilities ?? []).flatMap(value => ['--capability', value])] });
  }

  propose(summary: string, paths: string[]): ControlledProposal {
    this.revoke(); this.#proposal = undefined;
    const task = this.#request<ControlledTaskSnapshot>('snapshot');
    if (!task.planHash || !task.plan?.trim()) throw new Error('Author the Core task plan before proposing changes');
    if (!task.repositoryCurrent) throw new Error('Inspect and reconcile the current repository before proposing');
    if (!summary.trim() || paths.length > 100 || new Set(paths.map((value) => value.toLowerCase())).size !== paths.length) throw new Error('Expected summary and 0–100 distinct file paths; empty scope means verification only');
    const definition = { taskId: task.taskId, planHash: task.planHash, summary, files: paths.map((value) => ({ path: value, beforeHash: this.files.baseline(value) })) };
    const id = createHash('sha256').update(JSON.stringify({ definition, state: task.stateToken })).digest('hex');
    this.#proposedState = task.stateToken;
    this.#proposalIssue = '';
    this.#proposal = { id, ...definition };
    return structuredClone(this.#proposal);
  }

  approve(id: string): { task: ControlledTaskSnapshot; proposal: ControlledProposal | null; approved: boolean } {
    this.revoke();
    const { proposal, proposalIssue } = this.status();
    const state = this.#request<ControlledTaskSnapshot>('snapshot');
    if (!proposal || proposal.id !== id || this.#proposedState !== state.stateToken) throw new Error(proposalIssue || 'Proposal is missing or stale; propose again');
    for (const file of proposal.files) if (this.files.baseline(file.path) !== file.beforeHash) throw new Error(`File baseline changed: ${file.path}`);
    this.#request('approve');
    const admitted = this.#request<ControlledTaskSnapshot>('admit');
    if (admitted.planHash !== proposal.planHash) throw new Error('Plan changed during approval');
    if (proposal.files.length) { this.#approvedState = admitted.stateToken; this.#approvedId = id; }
    else this.#proposal = undefined;
    return this.status();
  }

  apply(proposalId: string, changes: ControlledWrite[]): { applied: string[]; task: ControlledTaskSnapshot } {
    try {
      return this.files.lock(() => {
        const proposal = this.#proposal;
        const task = this.#request<ControlledTaskSnapshot>('admit');
        if (!proposal || this.#approvedId !== proposalId || proposal.id !== proposalId || this.#approvedState !== task.stateToken) throw new Error('Human approval is missing or stale');
        for (const file of proposal.files) if (this.files.baseline(file.path) !== file.beforeHash) throw new Error(`File baseline changed: ${file.path}`);
        for (const change of changes) {
          const file = proposal.files.find((entry) => entry.path === change.path);
          if (!file || file.beforeHash !== change.beforeHash) throw new Error(`Change is outside the approved scope/baseline: ${change.path}`);
        }
        // Expand all patches before any file is written, inside the same approval/write lock.
        const resolved: ControlledChange[] = changes.map(change => {
          if ('edits' in change) {
            if ('content' in change || change.beforeHash === null) throw new Error('Patch requires an existing file and cannot include content');
            const original = this.files.read(change.path);
            if (original.hash !== change.beforeHash) throw new Error(`File baseline changed: ${change.path}`);
            return { path: change.path, beforeHash: change.beforeHash, content: applyLiteralEdits(original.content, change.edits!) };
          }
          return change;
        });
        const applied = this.files.apply(resolved);
        // Approval is consumed once, so another batch requires a new concrete human decision.
        this.revoke();
        try { return { applied, task: this.#request('checkpoint') }; }
        catch (error: unknown) { throw new Error(`Files applied but checkpoint failed: ${applied.join(', ')}; inspect before resuming`, { cause: error }); }
      });
    } catch (error: unknown) { this.revoke(); throw error; }
  }
}
