import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceCaptureResult } from '../contracts/capabilities.js';
import { loadActiveProfile } from '../config/workflow-config.js';
import { classifyRouteFacts } from '../core/classify-route.js';
import { loadRoutes } from '../core/context-budget.js';
import { taskPath, readTaskFile, replaceFileAtomically, withManifestLock } from '../core/task-files.js';
import { readManifestModel } from '../core/task-lifecycle.js';
import { requirePublishedTask, publishCheckpoint } from '../core/task-checkpoint.js';
import { persistentPlan } from '../core/task-persistence.js';
import { readSummarySection } from '../core/task-handoff.js';
import { validateVerificationContract } from '../core/verification-contract.js';
import { verificationFreshness } from '../core/verification-baseline.js';
import { collectRepositories } from '../core/task-handoff.js';
import { ControlledFiles } from './files.js';
import type { ControlledTaskSnapshot } from './index.js';
import type { StageSubmission, AutomationProgress, FixedCheck } from './orchestration-contract.js';

export interface AutomationRequest {
  action: string; taskId: string; target?: string; intent?: string;
  submission?: StageSubmission; progress?: AutomationProgress; checks?: FixedCheck[];
}
const script = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const child = (file: string, args: string[]): string => execFileSync(process.execPath, [script(file), ...args],
  { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });

/** Provider metadata selects intent; issue prefixes and tool names remain adapter configuration. */
export const lookupAutomation = (reference: string, requestedIntent = 'auto') => {
  const profile = loadActiveProfile();
  const capture = JSON.parse(child('../host-node/source-capture-cli.js', ['--entry', profile.taskModel.providerEntryMode,
    '--reference', reference, '--format', 'json'])) as SourceCaptureResult;
  if (!capture.sourceId || !profile.taskModel.sourceTypes.includes(capture.sourceType) || !Object.keys(capture.facts).length) throw new Error('Provider returned no usable source facts');
  const detected = [capture.facts.entry, capture.sourceType].find((value): value is string =>
    typeof value === 'string' && profile.taskModel.changeIntents.includes(value));
  if (detected && requestedIntent !== 'auto' && requestedIntent !== detected) throw new Error(`Requested intent ${requestedIntent} conflicts with provider type ${detected}`);
  const intent = detected ?? (requestedIntent === 'auto' ? null : requestedIntent);
  if (!intent) throw new Error('Provider type does not identify a change intent; use an explicit requirement/defect command');
  return { capture, intent };
};

/** Human-provided target selects a document or the Active Profile's configured source provider. */
export const prepareAutomation = (target: string, requestedIntent: string) => {
  const profile = loadActiveProfile();
  let intent = requestedIntent === 'auto' ? 'requirement' : requestedIntent;
  let entry = 'direct', sourceType = intent, sourceId: string | undefined, content: string;
  const candidate = path.resolve(target);
  if (existsSync(candidate)) {
    if (path.extname(candidate).toLowerCase() !== '.md') throw new Error('Source document must be a Markdown file');
    content = new ControlledFiles(path.dirname(candidate)).read(path.basename(candidate)).content;
    if (intent !== 'workflow-maintenance' && !profile.taskModel.sourceTypes.includes(sourceType)) throw new Error(`Profile does not support document source type ${sourceType}; configure its sourceTypes before using this document entry`);
  } else {
    if (/[/\\]|\.md$/i.test(target)) throw new Error('Source document does not exist');
    if (intent === 'workflow-maintenance') throw new Error('Maintenance requires a document, not a provider item');
    const resolved = lookupAutomation(target, requestedIntent);
    intent = resolved.intent;
    const captured = resolved.capture;
    entry = profile.taskModel.providerEntryMode;
    content = JSON.stringify(captured, null, 2); sourceId = captured.sourceId; sourceType = captured.sourceType;
  }
  if (!content.trim()) throw new Error('Source is empty');
  const maintenance = intent === 'workflow-maintenance';
  const classification = classifyRouteFacts({ intent, entry: maintenance ? 'not-applicable' : entry });
  const taskId = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  return { taskId, route: classification.route, entry: classification.entry, intent,
    goal: `Process ${path.basename(target)}`,
    ...(maintenance ? {} : { sourceType, sourceText: content, ...(sourceId ? { sourceId } : {}) }),
    sourceContent: content, classification };
};

/** Reuses task CLI gates for every mutation; this module derives actions, never rewrites lifecycle. */
export const automationAction = (request: AutomationRequest, snapshot: () => ControlledTaskSnapshot,
  task: (args: string[]) => string): unknown => {
  const directory = taskPath(request.taskId);
  const progressPath = path.join(directory, 'control-progress.json');
  const save = (callback: () => void, reason: string): void => withManifestLock(path.join(directory, 'manifest.md'), () => {
    const previous = requirePublishedTask(directory);
    callback(); publishCheckpoint(directory, { previous, reason });
  });
  if (request.action === 'progress-read') return existsSync(progressPath)
    ? JSON.parse(readTaskFile(directory, 'control-progress.json')) as AutomationProgress
    : { stage: readManifestModel(readTaskFile(directory, 'manifest.md')).currentStage, failures: 0, paused: false, lastError: '' };
  if (request.action === 'progress-save') {
    requirePublishedTask(directory, true);
    save(() => replaceFileAtomically(progressPath, JSON.stringify(request.progress)), 'Control progress');
    return request.progress;
  }
  if (request.action === 'submit-stage') {
    const submission = request.submission!;
    const state = snapshot();
    if (submission.stateToken !== state.stateToken) throw new Error('Stage submission baseline is stale; reload workflow_status');
    if (state.status !== 'in_progress') throw new Error('Task is not in progress');
    if (!readSummarySection(directory, submission.evidence).trim()) throw new Error('Stage evidence is empty');
    const model = readManifestModel(readTaskFile(directory, 'manifest.md'));
    const flow = loadRoutes().routes[state.route]!.taskFlow!;
    if (submission.verdict === 'changes-required' && ['Implement', 'Review', 'Verify', 'Git Inspect'].includes(state.stage) &&
        loadRoutes().routes[state.route]!.reopenable && flow.stages.includes('Plan')) {
      if (!submission.reason.trim()) throw new Error('Rework requires a concrete reason');
      task(['reopen', '--to', 'Plan', '--expected-last-updated', state.lastUpdated, '--evidence', submission.evidence,
        '--reason', submission.reason, '--action', 'Revise plan from review findings; obtain fresh implementation approval']);
      return { waitingFor: 'model', task: snapshot() };
    }
    if (submission.verdict !== 'ready') throw new Error(submission.reason || submission.verdict);
    const candidates = flow.transitions[state.stage] ?? [];
    // Follow the declared stage order and include optional stages instead of silently skipping them.
    // Competing mandatory branches still need a human decision.
    if (!candidates.length || candidates.filter((stage) => !flow.optionalStages.includes(stage)).length > 1) throw new Error('Stage has multiple next steps; human task command must choose the branch');
    const next = flow.stages.find((stage) => candidates.includes(stage)) ?? candidates[0]!;
    const items = persistentPlan(directory)?.items.filter((item) => item.stage === state.stage && !item.complete && !item.deferred) ?? [];
    if (submission.items.length !== items.length || new Set(submission.items.map((item) => item.id)).size !== items.length ||
        submission.items.some((item) => !items.some((pending) => pending.id === item.id))) throw new Error('Stage submission must cover every unfinished work item exactly once');
    for (const item of items) {
      if (item.dependencies.some((id) => !persistentPlan(directory)?.items.find((entry) => entry.id === id)?.complete)) throw new Error(`Unfinished dependency for ${item.id}`);
      const delivery = submission.items.find((entry) => entry.id === item.id)!;
      if (!readSummarySection(directory, delivery.evidence).trim()) throw new Error(`Empty evidence for ${item.id}`);
      const current = snapshot();
      task(['item', '--item', item.id, '--status', 'complete', '--evidence', delivery.evidence, '--expected-revision', String(current.revision), '--reason', 'Validated stage delivery']);
    }
    const current = snapshot();
    if (next === 'Implement') return { waitingFor: 'approval', task: current };
    // Existing lifecycle validates optional stages and every persistent exit gate.
    task([next === 'complete' ? 'complete' : 'advance', ...(next === 'complete' ? [] : ['--to', next]),
      '--expected-last-updated', model.lastUpdated === current.lastUpdated ? model.lastUpdated : current.lastUpdated,
      '--evidence', submission.evidence, '--action', `Continue ${next}`]);
    return { waitingFor: next === 'complete' ? 'complete' : 'model', task: snapshot() };
  }
  if (request.action === 'verify-checks') {
    const state = snapshot();
    if (state.stage !== 'Verify' || state.status !== 'in_progress') throw new Error('Fixed checks only run during Verify');
    const checks = request.checks ?? [];
    if (!checks.length) throw new Error('No trusted checks configured; human/CI verification is required');
    const contractFile = path.join(directory, 'verification.json');
    const contract = existsSync(contractFile) ? JSON.parse(readTaskFile(directory, 'verification.json')) as {
      contractStatus: string; testPoints: Array<{ id: string; method: string; executor: string; status: string }>;
    } : null;
    for (const check of checks) {
      const point = contract?.testPoints.find((entry) => entry.id === check.testId);
      if (contract && (!point || !['static', 'cli'].includes(point.method) || point.executor !== 'agent')) throw new Error(`Check ${check.id} does not bind an agent static/cli test point`);
      const relative = `control-evidence/${check.id}-${randomUUID()}.json`;
      const reason = `Fixed check ${check.id}`;
      if (contract) task(['verify-begin', '--test', check.testId!, '--evidence', relative, '--environment', 'trusted host fixed check',
        '--reason', reason, '--expected-revision', String(snapshot().revision)]);
      const beforeCheck = snapshot().stateToken;
      let status: 'passed' | 'failed' = 'passed', stdout = '', stderr = '', exitCode: number | null = 0;
      try { stdout = execFileSync(check.command, check.args, { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', windowsHide: true,
        timeout: check.timeoutMs, maxBuffer: 1024 * 1024 }); }
      catch (error: unknown) {
        const failure = error as { stdout?: string; stderr?: string; status?: number };
        status = 'failed'; stdout = String(failure.stdout ?? ''); stderr = String(failure.stderr ?? error); exitCode = failure.status ?? null;
      }
      if (snapshot().stateToken !== beforeCheck) throw new Error(`Check ${check.id} changed the code/task baseline; inspect before retrying`);
      const evidence = { checkId: check.id, command: check.command, args: check.args, status, stdout, stderr, exitCode, finishedAt: new Date().toISOString() };
      mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
      if (contract) writeFileSync(path.join(directory, relative), JSON.stringify(evidence), { flag: 'wx' });
      else save(() => writeFileSync(path.join(directory, relative), JSON.stringify(evidence), { flag: 'wx' }), reason);
      if (contract) task(['verify-record', '--test', check.testId!, '--status', status, '--evidence', relative, '--reason', reason,
        '--expected-revision', String(snapshotRevision(directory))]);
      if (status === 'failed') throw new Error(`Fixed check ${check.id} failed; evidence: ${relative}`);
    }
    if (contract) save(() => {
      const current = JSON.parse(readTaskFile(directory, 'verification.json')) as typeof contract;
      if (current.testPoints.some((point) => point.status !== 'passed') || verificationFreshness(current, collectRepositories(directory, state.taskId)).some((point) => point.status !== 'current')) {
        throw new Error('Manual/CI/unexecuted/stale verification remains; cannot mark verified');
      }
      current.contractStatus = 'verified';
      const errors = validateVerificationContract(current, { expectedTaskId: state.taskId });
      if (errors.length) throw new Error(errors.join('; '));
      replaceFileAtomically(contractFile, JSON.stringify(current));
    }, 'Fixed verification complete');
    return snapshot();
  }
  throw new Error(`Unknown automation action: ${request.action}`);
};

// verify-record deliberately permits its newly written evidence to be unpublished.
const snapshotRevision = (directory: string): number => (JSON.parse(readFileSync(path.join(directory, 'checkpoint.json'), 'utf8')) as { revision: number }).revision;
