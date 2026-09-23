import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { loadActiveProfile } from '../config/workflow-config.js';
import { loadRoutes } from './context-budget.js';
import { createRunId, loadRouteEvents } from './runtime-log.js';
import { readManifestModel, transitionManifestContent } from './task-lifecycle.js';
import type { TaskTransitionCommand } from './task-lifecycle.js';
import { taskPath, readTaskFile, replaceFileAtomically, withManifestLock } from './task-files.js';
import { hasTaskApproval, persistentTask, publishCheckpoint, readCheckpoint, requirePublishedTask, taskArtifactHashes, taskPlanHash } from './task-checkpoint.js';
import type { TaskCheckpoint } from './task-checkpoint.js';
import { parseTaskPlan, validateTaskPlan, updateWorkItem } from './task-plan.js';
import type { TaskPlan, WorkItem } from './task-plan.js';
import { collectRepositories, markdownSections, readSummarySection } from './task-handoff.js';
import { createVerificationBaseline, validateVerificationBaseline, verificationDefinitionHash, verificationFreshness } from './verification-baseline.js';
import { validateVerificationContract } from './verification-contract.js';
import { validateCiVerification } from './ci-verification.js';
import { validateTaskArtifactsById } from '../validators/check-task-artifacts.js';
import { errorMessage, isJsonObject } from '../types/guards.js';

const failErrors = (errors: string[]): void => { if (errors.length) throw new Error(errors.join('; ')); };
/** Version 2 carries executedAgainst; results recorded without a baseline stay unknown. */
const baselineContractError = (contract: Record<string, unknown> | undefined): string =>
  contract && contract.schemaVersion === 1
    ? 'verification.json 仍为 schemaVersion 1：没有执行基线的旧通过结论不能用于当前完成判断；先按 docs/verification-contract.md 升级为 schemaVersion 2 并重新登记证据'
    : '验证执行基线要求 verification.json schemaVersion 2；先升级合同版本（见 docs/verification-contract.md）再登记证据';
const inline = (value: string, label: string): string => {
  if (!value.trim() || /[\r\n|]/.test(value)) throw new Error(`${label} requires a nonempty single line`);
  return value.trim();
};
const evidenceLocator = (value: string): { locator: string; file: string } => {
  const locator = inline(value, 'Evidence locator');
  const parts = locator.split('#');
  const file = parts.shift() ?? '';
  if (!file || parts.length > 1 || (parts.length === 1 && !parts[0]) ||
      path.win32.isAbsolute(file) || path.posix.isAbsolute(file) || file.includes('\\') ||
      file.split('/').some((part) => !part || part === '..')) {
    throw new Error('Evidence locator must name one task-relative file and optional section');
  }
  return { locator, file };
};
const contractFor = (directory: string): Record<string, unknown> | undefined => {
  if (!existsSync(path.join(directory, 'verification.json'))) return undefined;
  const contract: unknown = JSON.parse(readTaskFile(directory, 'verification.json'));
  failErrors(validateVerificationContract(contract, { expectedTaskId: readManifestModel(readTaskFile(directory, 'manifest.md')).taskId }));
  if (!isJsonObject(contract)) throw new Error('Invalid verification contract');
  return contract;
};

export const persistentPlan = (directory: string): TaskPlan | null => {
  const model = readManifestModel(readTaskFile(directory, 'manifest.md'));
  const needsPlan = ['Plan', 'Implement', 'Review', 'Verify', 'Git Inspect', 'complete'].includes(model.currentStage);
  if (!existsSync(path.join(directory, 'plan.md'))) {
    if (needsPlan) throw new Error('Missing plan.md; create the work-item plan before continuing');
    return null;
  }
  const plan = parseTaskPlan(readTaskFile(directory, 'plan.md'), model.taskId);
  const contract = contractFor(directory);
  failErrors(validateTaskPlan(plan, { stages: model.stages.map((stage) => stage.name), ...(contract ? { contract } : {}) }));
  for (const item of plan.items) {
    if (item.artifact) readSummarySection(directory, item.artifact);
    if (!contract && (item.plannedChangeIds.length || item.verificationIds.length)) throw new Error(`${item.id}: missing verification contract`);
    if (item.progress === 'active' && item.stage !== model.currentStage) throw new Error(`${item.id}: active work item is outside Current Stage`);
  }
  return plan;
};

const verifyItemEvidence = (directory: string, item: WorkItem): void => {
  const contract = contractFor(directory);
  const points = contract && Array.isArray(contract.testPoints) ? contract.testPoints.filter(isJsonObject) : [];
  const freshness = contract ? verificationFreshness(contract, collectRepositories(directory, readManifestModel(readTaskFile(directory, 'manifest.md')).taskId)) : [];
  for (const id of item.verificationIds) {
    const point = points.find((point) => point.id === id);
    if (!point || point.status !== 'passed' || freshness.find((result) => result.id === id)?.status !== 'current') throw new Error(`${item.id}: ${id} requires current passed evidence`);
  }
  for (const reference of item.evidence) {
    if (/^VT[1-9]\d*$/.test(reference)) {
      const point = points.find((entry) => entry.id === reference);
      if (!point || point.status !== 'passed' || freshness.find((entry) => entry.id === reference)?.status !== 'current') throw new Error(`${item.id}: evidence ${reference} is not current passed evidence`);
    } else readSummarySection(directory, reference);
  }
  if (!item.verificationIds.length && !item.artifact) throw new Error(`${item.id}: missing delivery evidence`);
};

export const persistentExitGate = (directory: string, command: TaskTransitionCommand): void => {
  if (!persistentTask(directory) || !['advance', 'complete'].includes(command)) return;
  const model = readManifestModel(readTaskFile(directory, 'manifest.md'));
  const plan = persistentPlan(directory);
  for (const item of plan?.items.filter((entry) => !entry.deferred && (command === 'complete' || entry.stage === model.currentStage)) ?? []) {
    if (!item.complete) throw new Error(`Unfinished work item: ${item.id}`);
    verifyItemEvidence(directory, item);
  }
  if (model.currentStage === 'Review' && !readTaskFile(directory, 'review.md').trim()) throw new Error('Review report is empty');
  if (model.currentStage === 'Verify' || command === 'complete') {
    const contract = contractFor(directory);
    const routeGates = loadRoutes().routes[model.routeId];
    if (routeGates?.verifiedContractRequired === true &&
        (!contract || contract.contractStatus !== 'verified')) throw new Error('Verify requires a verified contract; retain blocked or conditional results');
    if (contract) {
      if (contract.schemaVersion !== 2 &&
          (contract.testPoints as unknown[]).filter(isJsonObject).some((point) => point.status === 'passed')) {
        throw new Error(baselineContractError(contract));
      }
      const freshness = verificationFreshness(contract, collectRepositories(directory, model.taskId));
      for (const point of (contract.testPoints as unknown[]).filter(isJsonObject)) {
        if (point.status === 'passed' && freshness.find((entry) => entry.id === point.id)?.status !== 'current') throw new Error(`${String(point.id)}: evidence is stale or unknown`);
      }
    }
  }
};

export interface TaskDiagnosis {
  taskId: string;
  stage: string;
  status: string;
  revision: number | null;
  nextWorkItem: string | null;
  action: 'reconcile' | 'resolve-blocker' | 'work-item' | 'stage' | 'complete';
  continuity: 'runtime' | 'reconstructed';
  issues: string[];
  warnings: string[];
  verification: ReturnType<typeof verificationFreshness>;
}

export const diagnosePersistentTask = (directory: string): TaskDiagnosis => {
  const model = readManifestModel(readTaskFile(directory, 'manifest.md'));
  const issues: string[] = [];
  const warnings: string[] = [];
  let checkpoint: TaskCheckpoint | null = null;
  let plan: TaskPlan | null = null;
  let verification: ReturnType<typeof verificationFreshness> = [];
  try { checkpoint = requirePublishedTask(directory, true); } catch (error) { issues.push(errorMessage(error)); }
  try {
    plan = persistentPlan(directory);
    const contract = contractFor(directory);
    if (contract) verification = verificationFreshness(contract, collectRepositories(directory, model.taskId));
  } catch (error) { issues.push(errorMessage(error)); }
  const continuity = checkpoint?.route.reconstructed ? 'reconstructed' : 'runtime';
  if (continuity === 'reconstructed') {
    warnings.push('运行血缘为重建：迁移时没有可核实的 runtime 记录；继续前重新核对产物、代码与批准来源，不把历史结论当作已验证');
  }
  const item = plan?.items.find((entry) => !entry.complete && !entry.deferred && entry.stage === model.currentStage &&
    entry.dependencies.every((id) => plan?.items.find((candidate) => candidate.id === id)?.complete));
  return { taskId: model.taskId, stage: model.currentStage, status: model.status, revision: checkpoint?.revision ?? null,
    nextWorkItem: item?.id ?? null, action: issues.length ? 'reconcile' : model.status === 'complete' ? 'complete' : model.status === 'blocked' ? 'resolve-blocker' : item ? 'work-item' : 'stage', continuity, issues, warnings, verification };
};

const checkRevision = (checkpoint: TaskCheckpoint, value: string): void => {
  if (!value || Number(value) !== checkpoint.revision) throw new Error(`--expected-revision ${checkpoint.revision} is required; reload task status before writing`);
};

export const persistentCommands = new Set(['init', 'checkpoint', 'status', 'item', 'migrate', 'verify-begin', 'verify-record']);

/** Agent-facing persistence operations; no shell execution, Git writes, or generated test outcomes. */
export const runPersistentCommand = (command: string, args: string[], taskId: string): number => {
  const arg = (name: string): string => {
    if (args.filter((value) => value === name).length > 1) throw new Error(`Duplicate ${name}`);
    const index = args.indexOf(name);
    if (index < 0) return '';
    const value = args[index + 1] ?? '';
    if (!value || value.startsWith('--')) throw new Error(`Missing ${name}`);
    return value;
  };
  const directory = taskPath(taskId);
  if (command === 'init') {
    if (existsSync(directory)) throw new Error(`Task already exists: ${taskId}`);
    const routeId = arg('--route') || 'level-2';
    const route = loadRoutes().routes[routeId];
    if (!route?.taskFlow) throw new Error('Route does not support persistent tasks yet');
    const entry = arg('--entry') || (routeId === 'task-workflow-maintenance' ? 'not-applicable' : 'direct');
    if (!route.entryModes.includes(entry)) throw new Error('Entry does not belong to route');
    const goal = inline(arg('--goal'), 'Goal');
    const repository = inline(arg('--repository') || '.', 'Repository');
    const sourceType = entry === 'not-applicable' ? 'none' : inline(arg('--source-type'), 'Source type');
    if (entry !== 'not-applicable' && !loadActiveProfile().taskModel.sourceTypes.includes(sourceType)) throw new Error('Unknown source type');
    const source = entry === 'not-applicable' ? '' : inline(arg('--source-text'), 'Source text');
    const sn = arg('--source-id');
    if (entry === loadActiveProfile().taskModel.providerEntryMode && !sn) throw new Error('Provider task requires --source-id');
    const stage = route.taskFlow.stages[0]!;
    const now = new Date().toISOString();
    const manifest = `# Task Manifest\n\n## Identity\n- Schema Version: 2\n- Task ID: ${taskId}\n- Run ID: ${createRunId()}\n- Route ID: ${routeId}\n- State Mode: Persistent\n- Status: in_progress\n- Current Stage: ${stage}\n- Last Updated: ${now}\n\n## Source Record\n- Entry Mode: ${entry}\n- Type: ${sourceType}\n${sn ? `- SN: ${inline(sn, 'Source ID')}\n` : ''}\n## Scope\n- Goal: ${goal}\n- In Scope: ${goal}\n- Out of Scope: 尚待分析明确\n\n## Repository Matrix\n| Repository | Root | Module | Branch | Remote | Allowed Git Actions |\n|---|---|---|---|---|---|\n| workspace | ${repository} | task | current | none | Inspect |\n\n## Stage Status\n| Stage | Status | Artifact / Reason |\n|---|---|---|\n${route.taskFlow.stages.map((name, index) => `| ${name} | ${index ? 'pending' : 'in_progress'} | ${index ? '' : 'Task initialized'} |`).join('\n')}\n\n## Authorization\n- Git Stage: no\n- Commit: no\n- Push: no\n\n## Resume\n- Last Completed Stage: none\n- Next Pending Stage: ${stage}\n- Next Action: 分析已记录的任务目标\n- Known Blockers: none\n`;
    mkdirSync(directory, { recursive: true });
    replaceFileAtomically(path.join(directory, 'manifest.md'), manifest);
    if (source) replaceFileAtomically(path.join(directory, 'source.md'), `# Source\n\n## Identity\n- Entry Mode: ${entry}\n- Type: ${sourceType}\n${sn ? `- SN: ${sn}\n` : ''}\n## User Additions\n${source}\n`);
    withManifestLock(path.join(directory, 'manifest.md'), () => publishCheckpoint(directory, { reason: 'Task initialized' }));
    process.stdout.write(`持久任务已创建：${taskId}\n`);
    return 0;
  }
  if (command === 'status') {
    const diagnosis = diagnosePersistentTask(directory);
    if (arg('--format') === 'json') process.stdout.write(`${JSON.stringify(diagnosis, null, 2)}\n`);
    else process.stdout.write(`任务 ${taskId} | ${diagnosis.stage} | ${diagnosis.action} | ${diagnosis.nextWorkItem ?? 'none'} | 血缘 ${diagnosis.continuity}\n${[...diagnosis.issues, ...diagnosis.warnings].join('\n')}\n`);
    return diagnosis.issues.length ? 1 : 0;
  }
  return withManifestLock(path.join(directory, 'manifest.md'), () => {
    const manifestFile = path.join(directory, 'manifest.md');
    let manifest = readTaskFile(directory, 'manifest.md');
    const model = readManifestModel(manifest);
    if (command === 'migrate') {
      if (model.schemaVersion === 2) throw new Error('Task is already persistent');
      const reason = inline(arg('--reason'), 'Migration reason');
      const events = loadRouteEvents({ days: 90 }).events;
      // Runtime lineage is verified when it still exists. When the observations were
      // cleaned or expired, adoption is allowed only as an explicitly user-confirmed
      // reconstruction that is marked in the checkpoint, never as renewed lineage.
      const verifiedLineage = events.some((event) => event.runId === model.runId && event.route === model.routeId && event.result === 'success');
      if (!verifiedLineage && !args.includes('--user-approved')) {
        throw new Error('Cannot establish legacy run continuity; 用 --user-approved --approval-source <核对依据> 确认按无血缘重建迁移，检查点会标记 reconstructed');
      }
      if (existsSync(path.join(directory, 'manifest-legacy.md'))) throw new Error('Legacy migration backup already exists');
      persistentPlan(directory);
      failErrors(validateTaskArtifactsById(taskId));
      replaceFileAtomically(path.join(directory, 'manifest-legacy.md'), manifest);
      manifest = manifest.replace(/^- Schema Version:.*$/m, '- Schema Version: 2').replace(/^- State Mode:.*$/m, '- State Mode: Persistent');
      replaceFileAtomically(manifestFile, manifest);
      publishCheckpoint(directory, {
        reason,
        reconstructed: !verifiedLineage,
        ...(args.includes('--user-approved') ? { approvalSource: inline(arg('--approval-source'), 'Approval source') } : {}),
      });
      process.stdout.write(`任务已迁移：${taskId}；旧验证结果仍需核实基线${verifiedLineage ? '' : '，运行血缘标记为 reconstructed'}。\n`);
      return 0;
    }
    if (model.schemaVersion !== 2) throw new Error('Use task migrate before persistent operations');
    const previous = readCheckpoint(directory);
    checkRevision(previous, arg('--expected-revision'));
    const reason = inline(arg('--reason'), 'Reason');
    if (command === 'checkpoint') {
      if (!args.includes('--reconcile')) requirePublishedTask(directory, true);
      if (previous.artifacts['manifest.md'] !== taskArtifactHashes(directory)['manifest.md']) {
        const archived = readManifestModel(readTaskFile(directory, `history/revision-${previous.revision}/manifest.md`));
        if (model.currentStage !== archived.currentStage || model.status !== archived.status || JSON.stringify(model.stages) !== JSON.stringify(archived.stages)) throw new Error('Unpublished lifecycle mutation; restore the last published manifest before reconciliation');
      }
      persistentPlan(directory);
      failErrors(validateTaskArtifactsById(taskId));
      if (existsSync(path.join(directory, 'plan.md')) && previous.approval && !hasTaskApproval(directory, previous) && !['Spec', 'Plan'].includes(model.currentStage)) throw new Error('Approved plan changed; reopen Spec/Plan before accepting new scope');
      const saved = publishCheckpoint(directory, { reason, previous });
      process.stdout.write(`检查点已保存：${taskId} revision ${saved.revision}\n`);
      return 0;
    }
    // verify-record may follow an evidence file written by the test runner. Only
    // that exact file may be unpublished; source, code and plan edits still stop.
    const allowEvidenceChange = (file: string): void => {
      const actual = taskArtifactHashes(directory);
      const changed = [...new Set([...Object.keys(actual), ...Object.keys(previous.artifacts)])]
        .filter((file) => actual[file] !== previous.artifacts[file]);
      if (changed.length !== 1 || changed[0] !== file) {
        requirePublishedTask(directory, false);
      }
    };
    if (command !== 'verify-record') requirePublishedTask(directory, false);
    if (command === 'verify-begin') {
      const contract = contractFor(directory);
      if (!contract || contract.schemaVersion !== 2) throw new Error(baselineContractError(contract));
      const id = arg('--test');
      const point = (contract.testPoints as unknown[]).filter(isJsonObject).find((entry) => entry.id === id);
      if (!point) throw new Error('Unknown test point');
      const environment = inline(arg('--environment'), 'Environment');
      const evidence = evidenceLocator(arg('--evidence'));
      const repositories = collectRepositories(directory, taskId);
      const baseline = createVerificationBaseline(contract, id, repositories, environment);
      const startsDirectory = path.join(directory, 'verification-start');
      if (existsSync(path.join(startsDirectory, `${id}.json`))) throw new Error('已有未收口的验证开始记录；先记录 blocked 或完成该测试');
      if (existsSync(path.join(directory, evidence.file))) throw new Error('验证证据文件必须在测试开始后新建，不能复用历史输出');
      mkdirSync(startsDirectory, { recursive: true });
      replaceFileAtomically(path.join(startsDirectory, `${id}.json`), `${JSON.stringify({
        schemaVersion: 1, taskId, testId: id, evidence: evidence.locator, baseline,
      }, null, 2)}\n`);
      publishCheckpoint(directory, { reason, previous });
      process.stdout.write(`验证基线已登记：${taskId} ${id}\n`);
      return 0;
    }
    if (command === 'item') {
      const plan = persistentPlan(directory);
      const id = arg('--item');
      const item = plan?.items.find((entry) => entry.id === id);
      if (!item || item.stage !== model.currentStage || model.status !== 'in_progress') throw new Error('Work item must belong to active Current Stage');
      const status = arg('--status');
      if (!['pending', 'active', 'blocked', 'complete'].includes(status)) throw new Error('Invalid work item status');
      const evidence = arg('--evidence');
      const next = updateWorkItem(readTaskFile(directory, 'plan.md'), id, {
        ...(status === 'complete' ? { complete: true } : { complete: false, progress: status as 'pending' | 'active' | 'blocked' }),
        ...(evidence ? { evidence: evidence.split(',').map((value) => value.trim()) } : {}),
        ...(arg('--checkpoint') ? { checkpoint: arg('--checkpoint') } : {}),
        ...(status === 'blocked' ? { blocker: reason } : {}),
      });
      const updated = parseTaskPlan(next, taskId).items.find((entry) => entry.id === id)!;
      if (status === 'complete') verifyItemEvidence(directory, updated);
      if (status === 'active' &&
          loadRoutes().routes[model.routeId]?.workItemApprovalRequired === true &&
          model.currentStage === 'Implement') {
        if (!hasTaskApproval(directory, previous)) throw new Error('Implementation approval is missing or no longer matches the plan');
        if (!args.includes('--user-approved')) throw new Error('激活工作项仍需当前会话用户确认继续实施；确认后追加 --user-approved');
      }
      if (status === 'blocked') manifest = transitionManifestContent(manifest, { command: 'block', reason });
      replaceFileAtomically(path.join(directory, 'plan.md'), next);
      replaceFileAtomically(manifestFile, manifest);
    } else if (command === 'verify-record') {
      const evidence = arg('--evidence') ? evidenceLocator(arg('--evidence')) : null;
      allowEvidenceChange(evidence?.file ?? '');
      const contract = contractFor(directory);
      if (!contract || contract.schemaVersion !== 2) throw new Error(baselineContractError(contract));
      const id = arg('--test');
      const point = (contract.testPoints as unknown[]).filter(isJsonObject).find((entry) => entry.id === id);
      if (!point) throw new Error('Unknown test point');
      const status = arg('--status');
      if (!['passed', 'failed', 'blocked', 'not-applicable'].includes(status)) throw new Error('Invalid verification status');
      if (['passed', 'failed'].includes(status)) {
        if (!evidence || !readSummarySection(directory, evidence.locator).trim()) throw new Error('Evidence is empty');
        const repositories = collectRepositories(directory, taskId);
        const startPath = path.join(directory, 'verification-start', `${id}.json`);
        if (!existsSync(startPath)) throw new Error('请先执行 verify-begin 登记测试开始时的代码基线');
        const started = JSON.parse(readTaskFile(directory, `verification-start/${id}.json`)) as Record<string, unknown>;
        if (started.taskId !== taskId || started.testId !== id || started.evidence !== evidence.locator || !isJsonObject(started.baseline)) throw new Error('验证开始记录无效');
        const baseline = started.baseline;
        const baselineErrors = validateVerificationBaseline(baseline);
        if (baselineErrors.length || baseline.definitionHash !== verificationDefinitionHash(contract, id) ||
            JSON.stringify(baseline.repositories) !== JSON.stringify(repositories.map(({ repository, root, head, fingerprint }) => ({ repository, root, head, fingerprint })).sort((a, b) => a.repository.localeCompare(b.repository)))) {
          throw new Error('测试开始后的代码或验证定义已变化；请重新执行 verify-begin');
        }
        if (point.method === 'ci') {
          const ci: unknown = JSON.parse(readTaskFile(directory, evidence.file));
          failErrors(validateCiVerification(ci, { expectedTaskId: taskId }));
          if (!isJsonObject(ci) || !isJsonObject(ci.repository)) throw new Error('Invalid CI evidence');
          const ciRepository = ci.repository;
          const repository = repositories.find((entry) => entry.root === ciRepository.root);
          if (!repository || repository.head !== ciRepository.commitSha || repository.changedFiles.length) throw new Error('CI evidence does not cover the current clean checkout');
          const check = Array.isArray(ci.checks) ? ci.checks.filter(isJsonObject).find((entry) => entry.id === arg('--ci-check')) : undefined;
          if (!check || check.status !== status) throw new Error('CI check does not match the recorded result');
        }
        point.executedAgainst = baseline as typeof point.executedAgainst;
        unlinkSync(startPath);
      } else delete point.executedAgainst;
      point.status = status;
      point.evidence = evidence ? [evidence.locator] : [];
      point.blocker = ['blocked', 'not-applicable'].includes(status) ? reason : '';
      const abandonedStart = path.join(directory, 'verification-start', `${id}.json`);
      if (!['passed', 'failed'].includes(status) && existsSync(abandonedStart)) unlinkSync(abandonedStart);
      contract.contractStatus = (contract.actualChanges as unknown[]).length ? 'implemented' : 'planned';
      failErrors(validateVerificationContract(contract, { expectedTaskId: taskId }));
      replaceFileAtomically(path.join(directory, 'verification.json'), `${JSON.stringify(contract, null, 2)}\n`);
    }
    publishCheckpoint(directory, { reason, previous });
    process.stdout.write(`任务记录已更新：${taskId}\n`);
    return 0;
  });
};

/** Reopen retains the published revision in history and resets affected work instead of inventing success. */
export const reopenPlan = (directory: string, stage: string): void => {
  const model = readManifestModel(readTaskFile(directory, 'manifest.md'));
  const index = model.stages.findIndex((entry) => entry.name === stage);
  let content = readTaskFile(directory, 'plan.md');
  const affected = parseTaskPlan(content).items.filter((item) => !item.deferred && model.stages.findIndex((entry) => entry.name === item.stage) >= index);
  for (const item of [...affected].reverse()) content = updateWorkItem(content, item.id, { complete: false, progress: 'pending', evidence: [], checkpoint: '', blocker: '' });
  replaceFileAtomically(path.join(directory, 'plan.md'), content);
};

export const approvedPlanUnchanged = (directory: string): boolean => {
  try { return hasTaskApproval(directory) && Boolean(taskPlanHash(directory)); } catch { return false; }
};

export const persistentContextSections = (directory: string): Array<{ locator: string; content: string }> => {
  const output: Array<{ locator: string; content: string }> = [];
  for (const file of ['plan.md', 'spec.md', 'review.md']) {
    if (!existsSync(path.join(directory, file))) continue;
    for (const [heading, content] of markdownSections(readTaskFile(directory, file))) output.push({ locator: `${file}#${heading}`, content });
  }
  return output;
};
