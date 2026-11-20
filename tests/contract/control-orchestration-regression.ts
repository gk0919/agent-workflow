import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncWorkflowController } from '../../src/control/index.js';
import type { StageSubmission } from '../../src/control/index.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'control-orchestration-'));
const controllers: AsyncWorkflowController[] = [];
try {
  mkdirSync(path.join(root, '.agent-workflow', 'tasks'), { recursive: true });
  writeFileSync(path.join(root, '.agent-workflow', 'config.json'), JSON.stringify({ schemaVersion: 1,
    activeProfile: 'workflow:resources/profiles/default/profile.json', plugins: [],
    paths: { tasksRoot: '.agent-workflow/tasks', runtimeRoot: '.agent-workflow/runtime', skillsRoot: '.agents/skills', knowledgeRoot: '.agent-workflow/knowledge' } }));
  writeFileSync(path.join(root, '.gitignore'), '.agent-workflow/\n');
  writeFileSync(path.join(root, 'AGENTS.md'), '# Fixture constraints\n');
  writeFileSync(path.join(root, 'request.md'), '# Request\nAdd the approved line to code.txt, preserve user text.\n');
  writeFileSync(path.join(root, 'code.txt'), 'existing user text\n');
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' }); };
  git('init', '--quiet'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  const control = new AsyncWorkflowController(root, { maxCorrections: 2, checks: [{ id: 'content-check', command: process.execPath,
    args: ['-e', "if(require('node:fs').readFileSync('code.txt','utf8')!=='existing user text\\napproved\\n')process.exit(1)"], timeoutMs: 10_000, testId: 'VT1' }] });
  controllers.push(control);
  const firstRuntime = await control.doctor(), secondRuntime = await control.doctor();
  assert.equal(firstRuntime.coreProcessId, secondRuntime.coreProcessId, 'Repeated requests reuse the workspace Core process');
  assert.notEqual(firstRuntime.coreProcessId, process.pid);
  const phases: string[] = [];
  const removeProgress = control.onProgress(phase => phases.push(phase));
  let ticking = false;
  const timer = setTimeout(() => { ticking = true; }, 10);
  const opened = await control.run(path.join(root, 'request.md'), 'workflow-maintenance');
  removeProgress();
  assert.deepEqual(phases, ['source', 'initialize', 'context']);
  clearTimeout(timer); assert.equal(ticking, true, 'Core child operations must not block the host event loop');
  assert.equal(opened.task.stage, 'Inspect');
  const taskId = opened.task.taskId;
  const batchBefore = await control.status();
  const taskDirectory = path.join(root, opened.taskDirectory);
  await assert.rejects(control.artifacts([
    { file: 'spec.md', content: `---\ntask_id: ${taskId}\ncontract_version: 2\n---\n# Spec\n` },
    { file: 'plan.md', content: 'invalid plan' },
  ], batchBefore.task.stateToken), /plan/);
  assert.equal(existsSync(path.join(taskDirectory, 'spec.md')), false, 'Invalid final artifact must not publish earlier files');
  assert.equal((await control.status()).task.stateToken, batchBefore.task.stateToken, 'Rejected batch keeps revision and token');
  const batchSaved = await control.artifacts([
    { file: 'review.md', content: '# Review\nDraft\n' },
    { file: 'verify.md', content: '# Verify\nDraft\n' },
  ], batchBefore.task.stateToken);
  assert.equal(batchSaved.revision, batchBefore.task.revision + 1, 'A valid batch publishes one checkpoint');
  assert.deepEqual(batchSaved.stageSubmission.items, []);
  const contract = {
    schemaVersion: 2, taskId, contractStatus: 'planned',
    goals: [{ id: 'G1', statement: 'Preserve user content and append approved line' }],
    acceptanceCriteria: [{ id: 'AC1', goalIds: ['G1'], statement: 'Exact expected text is present' }], outOfScope: [],
    plannedChanges: [{ id: 'C1', repository: '.', path: 'code.txt', summary: 'Append line', acceptanceIds: ['AC1'] }],
    actualChanges: [] as object[],
    testPoints: [{ id: 'VT1', acceptanceIds: ['AC1'], method: 'cli', executor: 'agent', instructions: 'Run fixed text check',
      expected: 'Exact text matches', status: 'planned', evidence: [], blocker: '' }],
  };
  await control.artifact('verification.json', JSON.stringify(contract));
  await control.artifact('changes.md', '# Changes\n\n## Delivery\nPreserve old text and append approved line.\n');
  await control.artifact('plan.md', `---\nplan_version: 1\ntask_id: ${taskId}\n---\n\n## Work Items\n- [ ] T1: Append approved line\n  - Stage: Implement\n  - Artifact: changes.md#Delivery\n  - Done When: Approved content exists\n`);
  const submit = async (evidence: string, items: StageSubmission['items'] = []) => control.submit({
    stateToken: (await control.status()).task.stateToken, evidence, items, verdict: 'ready', reason: '' });
  const barrier = await submit('changes.md#Delivery');
  assert.equal(barrier.waitingFor, 'approval'); assert.equal(barrier.task.stage, 'Inspect');
  assert.equal((await control.delivery()).waitingFor, 'approval', 'Approval barrier survives fresh status');
  const before = await control.read('code.txt');
  let proposal = await control.propose('Append line while preserving user edits', ['code.txt']);
  await assert.rejects(control.apply(proposal.id, [{ path: 'code.txt', beforeHash: before.hash, content: 'bad' }]));
  await control.approve(proposal.id);
  const recovered = new AsyncWorkflowController(root); controllers.push(recovered);
  const recovery = await recovered.resume(taskId);
  assert.equal(recovery.waitingFor, 'approval'); assert.equal((await recovered.status()).approved, false);
  await assert.rejects(recovered.approve(proposal.id), /Proposal/);
  await control.apply(proposal.id, [{ path: 'code.txt', beforeHash: before.hash, edits: [{ oldText: 'existing user text', newText: 'existing user text\napproved' }] }]);
  const replay = await recovered.apply(proposal.id, [{ path: 'code.txt', beforeHash: before.hash, edits: [{ oldText: 'existing user text', newText: 'existing user text\napproved' }] }]);
  assert.deepEqual(replay.applied, ['code.txt'], 'Replay returns a receipt without another write or approval');
  assert.equal((await recovered.delivery()).waitingFor, 'model', 'Written implementation resumes evidence completion');
  const writtenState = await control.status();
  const originalPlan = readFileSync(path.join(taskDirectory, 'plan.md'), 'utf8');
  await assert.rejects(control.artifacts([
    { file: 'changes.md', content: '# Changes\nShould not publish\n' },
    { file: 'plan.md', content: originalPlan.replace('Artifact: changes.md#Delivery', 'Artifact: review.md') },
  ], writtenState.task.stateToken), /Approved plan definitions/);
  assert.equal((await control.status()).task.stateToken, writtenState.task.stateToken);
  assert.equal(readFileSync(path.join(taskDirectory, 'plan.md'), 'utf8'), originalPlan);
  assert.match(readFileSync(path.join(taskDirectory, 'changes.md'), 'utf8'), /## Delivery/);
  const evidenceFailure = await submit('missing.md', [{ id: 'T1', evidence: 'changes.md#Delivery' }]);
  assert.equal(evidenceFailure.waitingFor, 'model', 'Rejected evidence must not manufacture an approval barrier');
  assert.equal(evidenceFailure.progress.implementationWritten, true);
  const pausedEvidence = await submit('missing-again.md', [{ id: 'T1', evidence: 'changes.md#Delivery' }]);
  assert.equal(pausedEvidence.waitingFor, 'human');
  const continuedEvidence = await control.continue();
  assert.equal(continuedEvidence.waitingFor, 'model', 'Human continue preserves the already written batch');
  await control.artifacts([
    { file: 'changes.md', content: '# Changes\n\n## Delivery\nWritten batch inspected; evidence corrected.\n' },
    { file: 'plan.md', content: originalPlan.replace('  - Done When: Approved content exists', '  - Done When: Approved content exists\n  - Evidence: changes.md#Delivery') },
  ], (await control.status()).task.stateToken);
  contract.contractStatus = 'implemented';
  contract.actualChanges = [{ id: 'A1', repository: '.', path: 'code.txt', summary: 'Appended approved line', plannedChangeIds: ['C1'], acceptanceIds: ['AC1'] }];
  await control.artifact('verification.json', JSON.stringify(contract));
  assert.equal(readFileSync(path.join(root, 'code.txt'), 'utf8'), before.content + 'approved\n');
  assert.equal((await submit('changes.md#Delivery', [{ id: 'T1', evidence: 'changes.md#Delivery' }])).task.stage, 'Review');
  await control.artifact('review.md', '# Review\nNo unresolved findings in this fixture.\n');
  assert.equal((await submit('review.md')).task.stage, 'Verify');
  await control.artifact('verify.md', '# Verify\nTrusted content check is required.\n');
  const noChecks = new AsyncWorkflowController(root); controllers.push(noChecks);
  await noChecks.resume(taskId);
  const noCheckResult = await noChecks.submit({ stateToken: (await noChecks.status()).task.stateToken, evidence: 'verify.md', items: [], verdict: 'ready', reason: '' });
  assert.equal(noCheckResult.task.stage, 'Verify'); assert.match(noCheckResult.progress.lastError, /No trusted checks/);
  const failing = new AsyncWorkflowController(root, { checks: [{ id: 'fail-check', command: process.execPath, args: ['-e', 'process.exit(7)'], timeoutMs: 10_000, testId: 'VT1' }] });
  controllers.push(failing); await failing.resume(taskId);
  const failed = await failing.submit({ stateToken: (await failing.status()).task.stateToken, evidence: 'verify.md', items: [], verdict: 'ready', reason: '' });
  assert.equal(failed.task.stage, 'Verify'); assert.match(failed.progress.lastError, /fail-check failed/);
  const failedContract = JSON.parse(readFileSync(path.join(root, '.agent-workflow', 'tasks', taskId, 'verification.json'), 'utf8'));
  assert.equal(failedContract.testPoints[0].status, 'failed'); assert.ok(failedContract.testPoints[0].executedAgainst);
  assert.equal((await submit('verify.md')).task.stage, 'Git Inspect');
  const verified = JSON.parse(readFileSync(path.join(root, '.agent-workflow', 'tasks', taskId, 'verification.json'), 'utf8')) as {
    contractStatus: string; testPoints: Array<{ status: string; executedAgainst?: unknown; evidence: string[] }>;
  };
  assert.equal(verified.contractStatus, 'verified'); assert.equal(verified.testPoints[0]!.status, 'passed');
  assert.ok(verified.testPoints[0]!.executedAgainst); assert.equal(verified.testPoints[0]!.evidence.length, 1);
  const diff = await control.diff(); assert.match(diff.diff, /approved/);
  assert.equal((await submit('changes.md#Delivery')).waitingFor, 'complete');
  assert.equal((await control.status()).task.status, 'complete');

  // A second run exercises persisted correction budgets, empty evidence and human-only reset.
  await control.run(path.join(root, 'request.md'), 'workflow-maintenance');
  let failure = await submit('missing.md');
  assert.equal(failure.progress.failures, 1); assert.equal(failure.waitingFor, 'model');
  failure = await submit('missing.md');
  assert.equal(failure.progress.failures, 2); assert.equal(failure.waitingFor, 'human');
  const blockedId = failure.task.taskId;
  await assert.rejects(control.propose('Cannot bypass persisted pause', ['code.txt']), /paused/);
  await assert.rejects(control.artifact('review.md', 'cannot bypass pause'), /paused/);
  assert.equal((await recovered.resume(blockedId)).waitingFor, 'human');
  assert.equal((await recovered.continue()).progress.failures, 0);
  const cancellation = new AbortController(); cancellation.abort();
  await assert.rejects(control.status(cancellation.signal));

  // No automatic downgrade of a business document to maintenance; no guessed provider facts.
  const cancel = new AbortController();
  const cancelled = recovered.run(path.join(root, 'request.md'), 'workflow-maintenance', cancel.signal);
  setTimeout(() => cancel.abort(), 10);
  await assert.rejects(cancelled, /cancelled|quiescence/);
  assert.equal((await recovered.delivery()).waitingFor, 'human');
  assert.equal((await recovered.status()).approved, false);

  const business = await recovered.run(path.join(root, 'request.md'));
  assert.equal(business.task.route, 'level-2'); assert.equal(business.task.stage, 'Source Capture');
  assert.ok(business.context?.includes('BEGIN'), business.context ?? 'No Packet');
  const captured = await recovered.submit({ stateToken: business.task.stateToken, evidence: 'source.md', items: [], verdict: 'ready', reason: '' });
  assert.equal(captured.task.stage, 'Intake', JSON.stringify(captured));
  await assert.rejects(recovered.run('missing.md'), /does not exist/);
  await assert.rejects(recovered.run('ITEM-123'), /Source Capture|Provider|Connector|插件|Entry/);
  process.stdout.write('Control orchestration regression passed: asynchronous full lifecycle, approval barrier, real fixed check, recovery and bounded correction.\n');
} finally {
  for (const controller of controllers) await controller.dispose();
  rmSync(root, { recursive: true, force: true });
}
