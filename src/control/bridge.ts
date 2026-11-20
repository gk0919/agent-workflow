/** Runs in a workspace-specific child process: existing Core modules bind cwd at import time. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { loadWorkflowPaths, loadActiveProfile, assertRealPathWithin } from '../config/workflow-config.js';
import { workflowRoot } from '../config/workspace-paths.js';
import { loadRoutes } from '../core/context-budget.js';
import { readManifestModel, validateManifestTaskFlow } from '../core/task-lifecycle.js';
import { taskPath, readTaskFile, replaceFileAtomically, withManifestLock } from '../core/task-files.js';
import { requirePublishedTask, readCheckpoint, taskPlanHash, publishCheckpoint } from '../core/task-checkpoint.js';
import { collectRepositories } from '../core/task-handoff.js';
import { guardRouteTask } from '../core/task-route-guard.js';
import { errorMessage } from '../types/guards.js';
import { validateVerificationContract } from '../core/verification-contract.js';
import { loadSecurityPolicy } from '../core/security-policy.js';
import { deriveNextRoute, buildNextRouteArguments } from '../core/workflow-next.js';
import { automationAction, prepareAutomation, lookupAutomation } from './orchestration-bridge.js';
import type { AutomationRequest } from './orchestration-bridge.js';
import { inspectSpecChange, specReadinessErrors } from '../core/spec-change.js';
import { parseTaskPlan } from '../core/task-plan.js';
import { authoredArtifacts, validateArtifactBatch, assertApprovedArtifacts } from './artifacts.js';
import type { AuthoredArtifact } from './artifacts.js';

export interface BridgeRequest extends AutomationRequest { entry?: string; args?: string[]; file?: string; content?: string; skills?: string[]; artifacts?: AuthoredArtifact[]; expectedToken?: string }
/** One synchronous request owns its snapshot; never cache authorization across requests. */
export const executeBridge = (request: BridgeRequest): unknown => {
const directory = ['prepare', 'lookup', 'automation-policy', 'doctor'].includes(request.action) ? '' : taskPath(request.taskId);
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const runTask = (args: string[]): string => execFileSync(process.execPath,
  [fileURLToPath(new URL('../core/task-state.js', import.meta.url)), ...args, '--task', request.taskId],
  { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });

let inspectionIssue = "";
const snapshot = () => {
  const model = readManifestModel(readTaskFile(directory, 'manifest.md'));
  const errors = validateManifestTaskFlow(model);
  if (errors.length) throw new Error(errors.join('; '));
  let checkpoint;
  try { checkpoint = requirePublishedTask(directory); }
  catch (error) {
    if (request.action !== 'inspection') throw error;
    inspectionIssue = errorMessage(error); checkpoint = readCheckpoint(directory);
  }
  if (!checkpoint) throw new Error('Controlled execution requires a persistent task');
  const repositories = collectRepositories(directory, request.taskId);
  const route = loadRoutes().routes[model.routeId]!;
  const runtimeStage = Object.entries(route.stages).find(([, value]) => value.taskStages?.includes(model.currentStage))?.[0];
  const specChange = inspectSpecChange(directory, { checkSources: model.status !== 'complete' });
  const specIssues = specReadinessErrors(specChange, model.stages);
  if (specIssues.length) inspectionIssue ||= specIssues.join('; ');
  return {
    taskDirectory: path.relative(process.cwd(), directory).split(path.sep).join('/'),
    taskId: model.taskId, stage: model.currentStage, status: model.status,
    route: model.routeId, entry: model.entryMode, runId: model.runId, ...(runtimeStage ? { runtimeStage } : {}),
    lastUpdated: model.lastUpdated, revision: checkpoint.revision,
    planHash: existsSync(path.join(directory, 'plan.md')) ? taskPlanHash(directory) : null,
    plan: existsSync(path.join(directory, 'plan.md')) ? readTaskFile(directory, 'plan.md') : null,
    stageSubmission: { authoredArtifacts, sourceEvidence: model.currentStage === 'Source Capture' ? 'source.md#Identity' : null,
      items: existsSync(path.join(directory, 'plan.md')) ? parseTaskPlan(readTaskFile(directory, 'plan.md'), request.taskId).items.filter(item => item.stage === model.currentStage && !item.complete && !item.deferred).map(item => ({ id: item.id, title: item.title, artifact: item.artifact })) : [] },
    repositoryCurrent: hash(repositories) === hash(checkpoint.repositories),
    ...(specChange.enabled ? { specChange } : {}),
    stateToken: hash({ checkpoint, repositories, ...(specChange.enabled ? { specChange } : {}) }),
  };
};

const skillNames = (): string[] => {
  const root = loadWorkflowPaths().skillsRoot;
  return existsSync(root) ? readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(root, entry.name, 'SKILL.md')))
    .map((entry) => entry.name).sort() : [];
};
const execute = (): unknown => {
  if (request.action === 'skills') return skillNames();
  if (request.action === 'doctor') {
    const profile = loadActiveProfile();
    const paths = loadWorkflowPaths();
    const git = (...args: string[]): string => execFileSync('git', ['--no-optional-locks', ...args],
      { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 15_000 }).trim();
    let runtimeIgnored = false;
    try { git('check-ignore', '--quiet', '--', path.join(paths.runtimeRoot, 'control-operations', 'probe.json')); runtimeIgnored = true; }
    catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
    return { coreVersion: (JSON.parse(readFileSync(path.join(workflowRoot, 'package.json'), 'utf8')) as { version: string }).version,
      nodeVersion: process.versions.node, coreProcessId: process.pid, profile: profile.id,
      provider: profile.sourceProviders[profile.taskModel.providerEntryMode]?.name || 'none',
      runtimeIgnored, tasksReady: existsSync(paths.tasksRoot), gitRoot: git('rev-parse', '--show-toplevel'), skills: skillNames() };
  }
  if (request.action === 'inspection') { const task = snapshot(); return { task, issue: inspectionIssue || (!task.repositoryCurrent ? 'Repository changed; inspect diff and reconcile checkpoint' : '') }; }
  if (request.action === 'operation-directory') {
    const runtime = loadWorkflowPaths().runtimeRoot;
    mkdirSync(runtime, { recursive: true });
    const target = path.join(runtime, 'control-operations', request.taskId);
    assertRealPathWithin(target, runtime, 'control operations');
    // Receipt writes must not alter the repository baseline they describe.
    try { execFileSync('git', ['check-ignore', '--quiet', '--', path.join(target, 'pending.json')], { cwd: process.cwd(), windowsHide: true, stdio: 'pipe' }); }
    catch { throw new Error('Control operation runtime must be Git-ignored; configure runtimeRoot ignore rules before starting'); }
    mkdirSync(target, { recursive: true });
    assertRealPathWithin(target, runtime, 'control operations');
    return target;
  }
  if (request.action === 'automation-policy') return loadSecurityPolicy().executionBudgets.maxConsecutiveFailures;
  if (request.action === 'automation-route') withManifestLock(path.join(directory, 'manifest.md'), () => {
    const previous = requirePublishedTask(directory);
    replaceFileAtomically(path.join(directory, 'control-route.json'), JSON.stringify({ intent: request.intent, entry: request.entry }));
    publishCheckpoint(directory, { previous, reason: 'Recorded host classification inputs' });
  });
  if (request.action === 'lookup') return lookupAutomation(request.target!, request.intent);
  if (request.action === 'prepare') return prepareAutomation(request.target!, request.intent!);
  if (['progress-read', 'progress-save', 'submit-stage', 'verify-checks'].includes(request.action)) return automationAction(request, snapshot, runTask);
  if (request.action === 'init') runTask(['init', ...(request.args ?? [])]);
  if (request.action === 'source-content') withManifestLock(path.join(directory, 'manifest.md'), () => {
    const previous = requirePublishedTask(directory);
    replaceFileAtomically(path.join(directory, 'source.md'), `${readTaskFile(directory, 'source.md')}\n## Source Content\n${request.content!}\n`);
    publishCheckpoint(directory, { previous, reason: 'Imported complete source content' });
  });
  if (request.action === 'task') runTask(request.args ?? []);
  if (request.action === 'capture-spec') execFileSync(process.execPath,
    [fileURLToPath(new URL('../core/spec-cli.js', import.meta.url)), ...(request.args ?? []), '--task', request.taskId],
    { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (request.action === 'artifact') {
    // Models can author documents, never lifecycle, approval, verification results or history.
    if (!['intake.md', 'prd.md', 'spec.md', 'plan.md', 'changes.md', 'review.md', 'verify.md', 'verification.json', 'spec-change.json'].includes(request.file ?? '')) {
      throw new Error('Artifact is not a model-authored workflow document');
    }
    if (typeof request.content !== 'string' || Buffer.byteLength(request.content) > 4 * 1024 * 1024) throw new Error('Invalid artifact content');
    // A malformed plan cannot be published: checkpoint approval projection parses it.
    if (request.file === 'plan.md') parseTaskPlan(request.content, request.taskId);
    if (request.file === 'verification.json') {
      const contract = JSON.parse(request.content) as { contractStatus: string; testPoints: Array<{ status: string; evidence: unknown[]; executedAgainst?: unknown }> };
      const errors = validateVerificationContract(contract, { expectedTaskId: request.taskId });
      if (errors.length) throw new Error(errors.join('; '));
      // Definitions are model-authored. Results and execution baselines are not.
      if (!['planned', 'implemented'].includes(contract.contractStatus) || contract.testPoints.some((point) =>
        point.status !== 'planned' || point.evidence.length || point.executedAgainst !== undefined)) {
        throw new Error('Model-authored verification contracts may contain definitions only, never verification results');
      }
    }
    withManifestLock(path.join(directory, 'manifest.md'), () => {
      const previous = requirePublishedTask(directory);
      if (!previous) throw new Error('Persistent task required');
      assertApprovedArtifacts(directory, readManifestModel(readTaskFile(directory, 'manifest.md')).currentStage,
        previous.approval?.planHash, [{ file: request.file!, content: request.content! }]);
      replaceFileAtomically(path.join(directory, request.file!), request.content!);
      publishCheckpoint(directory, { previous, reason: `Authored ${request.file}` });
    });
  }
  if (request.action === 'artifact-batch') withManifestLock(path.join(directory, 'manifest.md'), () => {
    const state = snapshot();
    if (state.stateToken !== request.expectedToken) throw new Error('Artifact batch baseline is stale; reload stage');
    const artifacts = request.artifacts ?? [];
    const model = readManifestModel(readTaskFile(directory, 'manifest.md'));
    validateArtifactBatch(directory, request.taskId, artifacts, model.stages.map(stage => stage.name));
    const previous = requirePublishedTask(directory);
    assertApprovedArtifacts(directory, model.currentStage, previous?.approval?.planHash, artifacts);
    for (const artifact of artifacts) replaceFileAtomically(path.join(directory, artifact.file), artifact.content);
    publishCheckpoint(directory, { previous, reason: 'Authored validated artifact batch' });
  });
  if (request.action === 'approve') {
    const state = snapshot();
    if (state.stage !== 'Implement') runTask(['advance', '--to', 'Implement',
      '--expected-last-updated', state.lastUpdated, '--evidence', 'Human command approved the proposed plan and file scope',
      '--action', 'Apply approved changes', '--user-approved', '--approval-source', 'Human workflow command']);
    else withManifestLock(path.join(directory, 'manifest.md'), () => {
      const previous = requirePublishedTask(directory);
      publishCheckpoint(directory, { previous, reason: 'Human renewed implementation approval', approvalSource: 'Human workflow command' });
    });
  }
  if (request.action === 'admit') {
    const state = snapshot();
    if (state.stage !== 'Implement' || state.status !== 'in_progress') throw new Error('Task is not implementing');
    guardRouteTask({ entry: state.entry, route: state.route, runId: state.runId, stage: 'implement', taskId: request.taskId });
  }
  if (request.action === 'checkpoint') withManifestLock(path.join(directory, 'manifest.md'), () => {
    const previous = requirePublishedTask(directory);
    publishCheckpoint(directory, { previous, reason: 'Controlled changes applied' });
  });
  if (request.action === 'context') {
    const state = snapshot();
    if (!state.runtimeStage) throw new Error('No runtime stage for this task');
    const routeFile = path.join(directory, 'control-route.json');
    const routeFacts = existsSync(routeFile) ? JSON.parse(readTaskFile(directory, 'control-route.json')) as { intent: string } : null;
    const flags = ['--materialize', ...(state.stage === 'Implement' ? ['--user-approved'] : [])];
    const routed = routeFacts || request.skills?.length;
    const script = routed ? '../core/route.js' : '../core/workflow-next.js';
    const args = routed ? [...buildNextRouteArguments(deriveNextRoute(state.taskId)), ...(routeFacts ? ['--intent', routeFacts.intent] : []), ...(request.skills ?? []).flatMap((skill) => ['--skill', skill]), ...flags] : ['--task', state.taskId, ...flags];
    return execFileSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args],
    { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  }
  return snapshot();
};

return execute();
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(executeBridge(JSON.parse(readFileSync(0, 'utf8')) as BridgeRequest))); }
  catch (error: unknown) { process.stderr.write(errorMessage(error)); process.exitCode = 1; }
}
