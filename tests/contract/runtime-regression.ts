import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  approveCandidate,
  buildCandidateContent,
  checkCandidate,
  containsSensitiveData,
  lintCandidate,
  promoteCandidate,
  stageCandidate,
  validateCandidateContent,
} from '../../src/core/knowledge-state.js';
import { loadRoutes } from '../../src/core/context-budget.js';
import {
  classifyRouteError,
  classifyRouteResult,
  filterRouteEventsByVersion,
  formatFeedbackSummary,
  loadRouteEvents,
  normalizeRouteEvent,
  recordWorkflowEvent,
  recordRouteEvent,
  summarizeRouteEvents,
} from '../../src/core/runtime-log.js';
import { errorMessage } from '../../src/types/guards.js';

const approvedCandidate = (content: string): string => content
  .replace(
    'TODO：补充可复核的代码、日志聚合或重复发生记录，不粘贴敏感原文。',
    '连续三次路由日志都出现相同错误码，并有对应静态检查记录。',
  )
  .replace(
    'TODO：描述可复用的处理规则、Skill 步骤或工具约束。',
    '先执行目标静态检查，失败时按错误码进入标准流程。',
  )
  .replace(
    'TODO：记录至少一个已验证正例，以及必要的反例或失败边界。',
    '正例和风险反例均已通过内存回归检查。',
  )
  .replace(
    'TODO：说明适用项目、场景、版本和不适用范围。',
    '只适用于工作流路由失败，不适用于业务异常。',
  )
  .replace('- Sensitive Data Review: pending', '- Sensitive Data Review: passed')
  .replace('- Decision: pending', '- Decision: approved')
  .replace('- Reviewer:', '- Reviewer: Human')
  .replace('- Review Note:', '- Review Note: 已复核证据、验证和复用边界。');

export const main = (): number => {
  try {
    const logsRoot = mkdtempSync(path.join(os.tmpdir(), 'workflow-logs-'));
    const now = new Date().toISOString();
    const routesVersion = loadRoutes().version;
    const excludedRoutesVersion = routesVersion + 1;
    recordRouteEvent({
      budgetChars: 8000,
      durationMs: 12,
      entry: 'direct',
      fallbackCode: 'tool-output-exceeded',
      loadedChars: 4200,
      materializationRequested: true,
      materializationComplete: false,
      materialized: false,
      omittedDocsCount: 3,
      outputChars: 2300,
      rawPrompt: 'must-not-be-logged',
      result: 'success',
      resultKind: 'allowed',
      riskFlags: [],
      route: 'micro-change',
      routesVersion: excludedRoutesVersion,
      skills: ['project-review'],
      stage: 'review',
      timestamp: now,
      usedChars: 5600,
    }, { logsRoot });
    recordRouteEvent({
      durationMs: 7,
      entry: 'direct',
      errorCode: 'blocked-risk',
      result: 'error',
      resultKind: 'blocked',
      riskFlags: ['interface-change'],
      route: 'micro-change',
      stage: 'locate-defect',
      timestamp: now,
    }, { logsRoot });
    recordWorkflowEvent({
      eventType: 'stage-transition',
      fromStage: 'Plan',
      implementationApproved: true,
      outcome: 'in-progress',
      result: 'success',
      route: 'standard-change',
      runId: 'run-0123456789abcdef',
      stage: 'Implement',
      timestamp: now,
      toStage: 'Implement',
    }, { logsRoot });
    recordWorkflowEvent({
      eventType: 'task-outcome',
      fromStage: 'Git Inspect',
      manualOverride: true,
      outcome: 'complete',
      parentRunId: 'run-fedcba9876543210',
      result: 'success',
      route: 'standard-change',
      runId: 'run-0123456789abcdef',
      secret: 'must-not-be-logged',
      stage: 'Git Inspect',
      timestamp: now,
      toStage: 'complete',
    }, { logsRoot });
    appendFileSync(
      path.join(logsRoot, `route-${now.slice(0, 10)}.jsonl`),
      'not-json\n',
      'utf8',
    );

    const loaded = loadRouteEvents({
      days: 1,
      logsRoot,
      now: Date.parse(now) + 1000,
    });
    assert.equal(loaded.events.length, 4);
    assert.equal(loaded.invalidRows, 1);
    const currentOnly = filterRouteEventsByVersion(loaded, {
      routesVersion,
    });
    assert.equal(currentOnly.events.length, 3);
    assert.equal(currentOnly.excludedEvents, 1);
    assert.equal('rawPrompt' in (loaded.events[0] ?? {}), false);
    const normalized = normalizeRouteEvent({
      changeType: 'defect',
      implementationApproved: true,
      microBriefHash: '1111222233334444',
      microBriefPlanHash: '5555666677778888',
      microPatchHash: '0123456789abcdef',
      microRepositoryId: '0123456789ab',
      microSourceHash: 'abcdef0123456789',
      parentRunId: 'run-fedcba9876543210',
      result: 'success',
      route: 'micro-change',
      secret: 'must-not-be-logged',
    });
    assert.equal('secret' in normalized, false);
    assert.equal(normalized.schemaVersion, 8);
    assert.equal(normalized.resultKind, 'allowed');
    assert.equal(normalized.changeType, 'defect');
    assert.equal(normalized.implementationApproved, true);
    assert.equal(normalized.microBriefHash, '1111222233334444');
    assert.equal(normalized.microBriefPlanHash, '5555666677778888');
    assert.equal(normalized.microPatchHash, '0123456789abcdef');
    assert.equal(normalized.microRepositoryId, '0123456789ab');
    assert.equal(normalized.microSourceHash, 'abcdef0123456789');
    assert.equal(normalized.parentRunId, 'run-fedcba9876543210');
    const summary = summarizeRouteEvents(loaded);
    assert.equal(summary.eventCount, 4);
    assert.deepEqual(summary.outcomes, [
      ['complete', 1],
      ['in-progress', 1],
    ]);
    assert.equal(summary.manualOverrides, 1);
    const currentSummary = summarizeRouteEvents(currentOnly);
    assert.equal(currentSummary.linkedRuns, 1);
    assert.equal(currentSummary.implementationApprovals, 1);
    assert.equal(currentSummary.runLineages, 1);
    assert.equal(currentSummary.unlinkedEvents, 1);
    assert.match(formatFeedbackSummary(currentSummary, 1), /excluded legacy: 1/);
    assert.match(formatFeedbackSummary(currentSummary, 1), /Parent Links: 1/);
    assert.match(
      formatFeedbackSummary(currentSummary, 1),
      /Implementation Approvals: 1/,
    );
    assert.match(formatFeedbackSummary(summary, 1), /Materialization Requests: 1/);
    assert.match(formatFeedbackSummary(summary, 1), /Result Kinds:/);
    assert.equal(
      loaded.events.find(({ eventType }) => eventType === 'task-outcome')?.stage,
      'git-inspect',
    );
    assert.match(formatFeedbackSummary(summary, 1), /blocked-risk\(1\)/);
    assert.match(
      formatFeedbackSummary(summary, 1),
      /Fallbacks: tool-output-exceeded\(1\)/,
    );
    assert.equal(summary.routeVersions.length, 2);
    assert.equal(new Map(summary.routeVersions).get(`v${routesVersion}`), 1);
    assert.equal(
      new Map(summary.routeVersions).get(`v${excludedRoutesVersion}`),
      1,
    );
    assert.equal(
      classifyRouteError(new Error('Task Gate: manifest stage mismatch')),
      'task-gate',
    );
    assert.equal(
      classifyRouteResult(new Error('Task Gate: manifest stage mismatch')),
      'blocked',
    );
    assert.equal(
      classifyRouteResult(new Error('未知 Route: missing')),
      'invalid-input',
    );
    assert.equal(
      classifyRouteError(new Error('Implementation Approval Gate: required')),
      'implementation-approval-gate',
    );
    assert.equal(
      classifyRouteError(new Error('Micro Change Run Gate: missing stage')),
      'micro-run-gate',
    );
    assert.equal(
      classifyRouteError(new Error('Run Route Gate: route mismatch')),
      'run-route-gate',
    );
    assert.equal(
      classifyRouteError(new Error('Micro Brief Gate: missing brief')),
      'micro-brief-gate',
    );
    assert.equal(
      classifyRouteError(new Error('Micro Change Source Gate: patch mismatch')),
      'micro-source-gate',
    );
    assert.equal(
      classifyRouteError(new Error('Materialized Packet 超过工具输出上限')),
      'tool-output-exceeded',
    );
    assert.equal(
      classifyRouteError(new Error('Route Packet 超过上下文预算')),
      'context-budget-exceeded',
    );

    const candidate = buildCandidateContent({
      createdAt: now,
      id: 'route-failure-pattern',
      signal: '同一路由失败码在短期内重复出现。',
      source: 'route-feedback',
      title: '路由失败模式候选',
    });
    assert.ok(validateCandidateContent(candidate).errors.length > 0);
    assert.deepEqual(validateCandidateContent(approvedCandidate(candidate)).errors, []);
    assert.deepEqual(
      validateCandidateContent(
        approvedCandidate(candidate).replace(
          '- Review Note: 已复核证据、验证和复用边界。',
          '- Review Note:',
        ),
      ).errors,
      [],
    );
    assert.match(
      validateCandidateContent(`${candidate}${'x'.repeat(12000)}`).errors.join('\n'),
      /超过 12000 字符上限/,
    );
    assert.equal(containsSensitiveData('token=abc123'), true);

    const knowledgeDirectory = mkdtempSync(
      path.join(os.tmpdir(), 'workflow-knowledge-'),
    );
    const stagedPath = stageCandidate({
      createdAt: now,
      id: 'route-failure-pattern',
      signal: '同一路由失败码在短期内重复出现。',
      source: 'route-feedback',
      title: '路由失败模式候选',
    }, { knowledgeDirectory, silent: true });
    writeFileSync(
      stagedPath,
      approvedCandidate(readFileSync(stagedPath, 'utf8')),
      'utf8',
    );
    const approvedStagingContent = readFileSync(stagedPath, 'utf8');
    checkCandidate(
      'route-failure-pattern',
      { knowledgeDirectory, silent: true },
    );
    const promoted = promoteCandidate(
      'route-failure-pattern',
      { knowledgeDirectory, silent: true },
    );
    assert.match(readFileSync(promoted.targetPath, 'utf8'), /status: approved/);
    assert.match(readFileSync(promoted.auditPath, 'utf8'), /status: promoted/);
    writeFileSync(promoted.auditPath, approvedStagingContent, 'utf8');
    const recoveredPromotion = promoteCandidate(
      'route-failure-pattern',
      { knowledgeDirectory, silent: true },
    );
    assert.equal(recoveredPromotion.targetPath, promoted.targetPath);
    assert.match(readFileSync(recoveredPromotion.auditPath, 'utf8'), /status: promoted/);
    assert.doesNotThrow(() => promoteCandidate(
      'route-failure-pattern',
      { knowledgeDirectory, silent: true },
    ));
    const activeLockPath = path.join(
      knowledgeDirectory,
      '_locks',
      'route-failure-pattern.lock',
    );
    writeFileSync(activeLockPath, 'another-process', 'utf8');
    assert.throws(() => promoteCandidate(
      'route-failure-pattern',
      { knowledgeDirectory, silent: true },
    ), /另一进程处理/);

    const approvalStagedPath = stageCandidate({
      createdAt: now,
      id: 'approval-shortcut',
      signal: '同类维护问题已在多个任务中重复出现。',
      source: 'manual',
      title: '批准晋升快捷路径候选',
    }, { knowledgeDirectory, silent: true });
    const approvalDraft = approvedCandidate(
      readFileSync(approvalStagedPath, 'utf8'),
    )
      .replace('- Decision: approved', '- Decision: pending')
      .replace('- Reviewer: Human', '- Reviewer:')
      .replace('- Review Note: 已复核证据、验证和复用边界。', '- Review Note:');
    writeFileSync(approvalStagedPath, approvalDraft, 'utf8');
    lintCandidate('approval-shortcut', { knowledgeDirectory, silent: true });
    const approvedShortcut = approveCandidate('approval-shortcut', {
      knowledgeDirectory,
      silent: true,
    });
    assert.match(
      readFileSync(approvedShortcut.targetPath, 'utf8'),
      /Reviewer: conversation-user/,
    );
    assert.match(
      readFileSync(approvedShortcut.targetPath, 'utf8'),
      /Decision: approved/,
    );

    process.stdout.write(
      '运行时回归检查通过：匿名日志、聚合反馈、候选门禁和敏感信息检查正常。\n',
    );
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`运行时回归检查失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
