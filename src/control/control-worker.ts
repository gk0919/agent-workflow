import { executeBridge } from './bridge.js';
import type { ControlledSearch } from './files.js';
import { ControlOperations } from './operations.js';
import { WorkflowController } from './index.js';
import type { ControlledWrite, ControlledSpecCapture, ControlledTaskInit } from './index.js';
import type { AutomationDelivery, AutomationOptions, FixedCheck, StageSubmission } from './orchestration-contract.js';

process.once('message', (configuration: { workspace: string; options: AutomationOptions }) => {
const { workspace, options } = configuration;
const checks: FixedCheck[] = options.checks ?? [];
const control = new WorkflowController(workspace, executeBridge, (phase) => process.send!({ progress: phase }));
process.once('disconnect', () => control.dispose());
const limit = control.correctionLimit();
const maxCorrections = options.maxCorrections ?? limit;
if (!Number.isInteger(maxCorrections) || maxCorrections < 1 || maxCorrections > limit) throw new Error(`maxCorrections must be 1–${limit}`);
if (new Set(checks.map((check) => check.id)).size !== checks.length || checks.some((check) =>
  !/^[a-z0-9-]+$/.test(check.id) || !check.command || !Array.isArray(check.args) || !check.args.every((arg) => typeof arg === 'string') ||
  !Number.isInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 120_000)) throw new Error('Invalid trusted check registry');
let operations: ControlOperations;
let executingOperation = false;
const operate = <T>(kind: string, args: unknown[], execute: () => T): T => operations.run(kind, args, () => {
  executingOperation = true;
  try { return execute(); } finally { executingOperation = false; }
}, control.status().task.stateToken);
const bindOperations = (): void => { operations = new ControlOperations(control.operationDirectory()); };
const delivery = (): AutomationDelivery => {
  const { task, issue, approved, proposal, proposalIssue } = control.status();
  const pending = executingOperation ? null : operations.pending();
  const progress = control.progress();
  const verificationOnly = task.stage === 'Implement' && !!progress.noCodePlanHash && progress.noCodePlanHash === task.planHash;
  const waitingFor = issue || pending || progress.paused || task.status === 'blocked' ? 'human'
    : task.status === 'complete' ? 'complete'
    : !approved && !verificationOnly && ((task.stage === 'Implement' && !progress.implementationWritten) || (task.stage !== 'Implement' && progress.approvalPending)) ? 'approval' : 'model';
  let context: string | null = null;
  if (waitingFor === 'model') {
    if (verificationOnly) {
      context = 'Human approved a verification-only plan. Repository remains read-only: inspect existing implementation and submit evidence for every Implement work item, then continue Review/Verify. Any code change requires a new exact file scope proposal and human approval.';
    } else if (task.stage === 'Implement' && progress.implementationWritten && !approved) {
      context = 'The approved batch has been written. Inspect workflow_diff and complete stage evidence; any further code write needs a new proposal and human approval.';
    } else {
      try { process.send!({ progress: 'context' }); context = control.context(); }
      catch (error: unknown) { context = `Core 无法加载当前 Packet，修正任务产物后重试：${error instanceof Error ? error.message : String(error)}`; }
    }
  }
  const nextAction = issue ? 'Inspect status/diff, then human task checkpoint --reconcile'
    : pending ? 'Inspect partial effects, reconcile if necessary, then human /workflow recover'
    : task.status === 'blocked' ? 'Resolve the Core blocker with evidence, then human task resume'
    : progress.paused ? `Human input required: ${progress.lastError || 'paused'}`
    : waitingFor === 'approval' ? (proposal ? 'Human review the current proposal, then /workflow approve' : proposalIssue || 'Agent must submit a proposal first; use empty file scope for verification only. Do not ask human to approve yet.')
    : waitingFor === 'complete' ? 'Deliver recorded results' : `Continue ${task.stage}; submit evidence from the latest stateToken`;
  return { task, progress, waitingFor, approval: { proposalId: proposal?.id ?? null, issue: proposalIssue, verificationOnly }, context, nextAction, recovery: { issue, pending }, taskDirectory: task.taskDirectory };
};
const requireRunning = (): void => {
  if (!executingOperation && operations.pending()) throw new Error('Uncertain operation; human recover is required');
  if (control.progress().paused) throw new Error('Workflow paused; human /workflow continue is required');
};
const reset = (preserve = false): void => {
  control.revoke();
  const { task } = control.status();
  const previous = preserve ? control.progress() : null;
  control.progress({ ...(previous?.stage === task.stage ? previous : {}), stage: task.stage, failures: 0, paused: false, lastError: '' });
};
const pause = (reason = 'Operation cancelled; inspect completed side effects before continuing'): void => {
  control.revoke();
  const progress = control.progress();
  control.progress({ ...progress, paused: true, lastError: reason });
};

const execute = (method: string, args: unknown[]): unknown => {
  switch (method) {
    case 'doctor': return control.doctor();
    case 'search': return control.files.search(args[0] as ControlledSearch);
    case 'rules': requireRunning(); return control.rules(args[0] as string[]);
    case 'start': { const task = control.start(args[0] as ControlledTaskInit); bindOperations(); return task; }
    case 'lookup': return control.lookup(args[0] as string);
    case 'run': control.run(args[0] as string, args[1] as string); bindOperations(); reset(); return delivery();
    case 'resume': control.resume(args[0] as string); bindOperations(); return delivery();
    case 'status': return control.status();
    case 'canApply': return control.canApply();
    case 'delivery': return delivery();
    case 'context': requireRunning(); return control.context();
    case 'list': return control.files.list(args[0] as string | undefined);
    case 'read': return control.files.read(args[0] as string);
    case 'diff': return control.diff();
    case 'artifact': requireRunning(); return control.artifact(args[0] as string, args[1] as string);
    case 'artifacts': requireRunning(); return control.artifacts(args[0] as Array<{ file: string; content: string }>, args[1] as string);
    case 'propose': {
      requireRunning();
      const progress = control.progress();
      if (progress.noCodePlanHash) {
        const { noCodePlanHash: _previousApproval, ...remaining } = progress;
        control.progress(remaining);
      }
      return control.propose(args[0] as string, args[1] as string[]);
    }
    case 'approve': {
      requireRunning();
      const verificationOnly = control.status().proposal?.files.length === 0;
      const result = control.approve(args[0] as string);
      if (verificationOnly) control.progress({ ...control.progress(), stage: result.task.stage, approvalPending: false, noCodePlanHash: result.task.planHash! });
      return delivery();
    }
    case 'apply': return operate('apply', args, () => {
      requireRunning();
      const result = control.apply(args[0] as string, args[1] as ControlledWrite[]);
      control.progress({ ...control.progress(), implementationWritten: true });
      return { ...result, task: control.status().task };
    });
    case 'task': return control.task(args[0] as string[]);
    case 'captureSpec': requireRunning(); return control.captureSpec(args[0] as ControlledSpecCapture);
    case 'pause': pause(args[0] as string | undefined); return delivery();
    case 'recover': return control.files.lock(() => {
      control.revoke();
      const inspected = control.inspect();
      if (inspected.issue) throw new Error(inspected.issue);
      operations.recover(); reset(); return delivery();
    });
    case 'continue': if (operations.pending()) throw new Error('Inspect and recover the uncertain operation first'); reset(true); return delivery();
    case 'submit': { const result = control.files.lock(() => operate('submit', args, () => {
      requireRunning();
      const submission = args[0] as StageSubmission;
      const stage = control.status().task.stage;
      try {
        // Checks run before transition and register their own real evidence. A model "ready"
        // never substitutes for process success or contract freshness.
        if (stage === 'Verify' && submission.verdict === 'ready') {
          const state = control.status().task;
          if (submission.stateToken !== state.stateToken) throw new Error('Stage submission baseline is stale');
          control.verifyChecks(checks);
          submission.stateToken = control.status().task.stateToken;
        }
        const result = control.submitStage(submission);
        if (result.waitingFor === 'approval') {
          control.progress({ stage, failures: 0, paused: false, lastError: '', approvalPending: true });
          return delivery();
        }
        reset(); return delivery();
      } catch (error: unknown) {
        control.revoke();
        const progress = control.progress();
        const failures = (progress.stage === stage ? progress.failures : 0) + 1;
        const message = error instanceof Error ? error.message : String(error);
        control.progress({ ...progress, stage, failures, paused: failures >= maxCorrections || submission.verdict !== 'ready', lastError: message });
        const next = delivery();
        return { ...next, context: next.waitingFor === 'model' ? `Core 拒绝阶段提交（${failures}/${maxCorrections}）：${message}\n修正产物并重新读取 stateToken 后提交。\n${next.context ?? ''}` : null };
      }
    })); return operations.replayed ? delivery() : result; }
    case 'dispose': control.dispose(); return null;
    default: throw new Error('Unknown controller capability');
  }
};

process.on('message', (request: { id: number; method: string; args: unknown[] }) => {
  try { process.send!({ id: request.id, value: execute(request.method, request.args) }); }
  catch (error: unknown) { process.send!({ id: request.id, error: error instanceof Error ? error.message : String(error) }); }
  finally { if (request.method === 'dispose') process.disconnect(); }
});

});
