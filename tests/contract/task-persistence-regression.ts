import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { workflowRoot } from '../../src/config/workspace-paths.js';

interface Diagnosis {
  stage: string;
  status: string;
  action: string;
  nextWorkItem: string | null;
  issues: string[];
  verification: Array<{ id: string; status: string }>;
}

interface SavedCheckpoint {
  revision: number;
  approval: { planHash: string } | null;
  artifacts: Record<string, string>;
  route: { reconstructed: boolean };
}

const cli = path.join(workflowRoot, 'dist/bin/agent-workflow.js');

export const main = (): number => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'task-persistence-regression-'));
  const taskId = 'persistent-fixture';
  const directory = path.join(root, '.agent-workflow/tasks/local', taskId);
  const invoke = (args: string[], expected = 0): { stdout: string; stderr: string } => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    assert.equal(result.status, expected, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return { stdout: result.stdout, stderr: result.stderr };
  };
  const run = (args: string[], expected = 0): string => {
    const result = invoke(args, expected);
    return result.stdout + result.stderr;
  };
  const git = (args: string[]): void => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  };
  const read = (file: string): string => readFileSync(path.join(directory, file), 'utf8');
  const write = (file: string, content: string): void => { writeFileSync(path.join(directory, file), content); };
  const checkpoint = (): SavedCheckpoint => JSON.parse(read('checkpoint.json')) as SavedCheckpoint;
  const stamp = (): string => /^- Last Updated: (.+)$/m.exec(read('manifest.md'))![1]!;
  const status = (expected = 0): Diagnosis => JSON.parse(invoke(['task', 'status', '--task', taskId, '--format', 'json'], expected).stdout) as Diagnosis;
  const lifecycle = (command: string, args: string[] = [], expected = 0): string =>
    run(['task', command, '--task', taskId, '--expected-last-updated', stamp(), ...args], expected);
  const advance = (stage: string, extra: string[] = [], expected = 0): string => lifecycle('advance', [
    '--to', stage, '--action', `Continue ${stage}`, '--evidence', 'Fixture phase checked', ...extra,
  ], expected);
  const save = (reason: string, expected = 0): string => run([
    'task', 'checkpoint', '--task', taskId, '--expected-revision', String(checkpoint().revision), '--reason', reason, '--reconcile',
  ], expected);
  const item = (id: string, nextStatus: string, extra: string[] = [], expected = 0): string => run([
    'task', 'item', '--task', taskId, '--item', id, '--status', nextStatus,
    '--expected-revision', String(checkpoint().revision), '--reason', `Record ${id} ${nextStatus}`, ...extra,
  ], expected);
  const record = (evidence = 'evidence.md#Result', expected = 0): string => run([
    'task', 'verify-record', '--task', taskId, '--test', 'VT1', '--status', 'passed',
    '--evidence', evidence,
    '--expected-revision', String(checkpoint().revision), '--reason', 'Fixture code readback passed',
  ], expected);
  const begin = (evidence = 'evidence.md#Result', expected = 0): string => run([
    'task', 'verify-begin', '--task', taskId, '--test', 'VT1', '--evidence', evidence,
    '--environment', 'Disposable fixture checkout', '--expected-revision', String(checkpoint().revision),
    '--reason', 'Capture code and definition before the fixture test',
  ], expected);
  try {
    writeFileSync(path.join(root, 'package.json'), '{"name":"persistence-host-fixture","private":true}\n');
    run(['init']);
    git(['init']);
    writeFileSync(path.join(root, 'tracked.txt'), 'baseline\n');
    git(['add', 'tracked.txt']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture baseline']);

    run(['task', 'init', '--task', taskId, '--route', 'standard-change', '--entry', 'direct',
      '--goal', 'Persist execution progress for a fresh process', '--source-type', 'requirement',
      '--source-text', 'Resume remaining work directly from saved task artifacts']);
    const initialManifest = read('manifest.md');
    assert.match(initialManifest, /Schema Version: 2/);
    assert.match(initialManifest, /State Mode: Persistent/);
    assert.equal(checkpoint().revision, 1);
    assert.equal(status().stage, 'Source Capture');
    assert.equal(existsSync(path.join(directory, 'handoff.md')), false);
    assert.match(run(['next', '--task', taskId, '--format', 'json']), /capture/);

    write('intake.md', '# Intake\n\n## Goal\nResume the remaining operation from recorded progress.\n');
    write('spec.md', `---\ntask_id: ${taskId}\nentry_mode: direct\nsource_type: requirement\nspec_level: S\nstatus: confirmed\ncreated_at: 2026-09-10T00:00:00.000Z\ncontract_version: 2\n---\n\n# Specification\n\n## Approach\nPersist each completed operation and verify readback before marking it done.\n`);
    write('plan.md', `---\nplan_version: 1\ntask_id: ${taskId}\n---\n\n## Approach\nUse the saved task directory to recover across processes.\n\n## Work Items\n\n- [ ] T1: Write persistent operation\n  - Stage: Implement\n  - Planned Change: C1\n  - Verify: VT1\n  - Done When: Stored operation is readable\n\n- [ ] T2: Finish remaining operation\n  - Stage: Implement\n  - Planned Change: C1\n  - Verify: VT1\n  - Depends On: T1\n  - Done When: Recorded next operation is completed\n\n- [ ] T3: Review behavior\n  - Stage: Review\n  - Artifact: review.md#Findings\n  - Depends On: T2\n  - Done When: Findings are evaluated\n\n- [ ] T4: Verify current implementation\n  - Stage: Verify\n  - Planned Change: C1\n  - Verify: VT1\n  - Depends On: T3\n  - Done When: Evidence covers current checkout\n`);
    write('review.md', '# Review\n\n## Findings\nFixture operation is bounded to tracked.txt; no open findings.\n');
    write('verification.json', `${JSON.stringify({
      schemaVersion: 2, taskId, contractStatus: 'planned',
      goals: [{ id: 'G1', statement: 'Resume remaining operations' }],
      acceptanceCriteria: [{ id: 'AC1', goalIds: ['G1'], statement: 'A fresh process finds the next operation' }],
      outOfScope: [{ id: 'OOS1', statement: 'No external synchronization' }],
      plannedChanges: [{ id: 'C1', repository: '.', path: 'tracked.txt', summary: 'Persist fixture operation', acceptanceIds: ['AC1'] }],
      actualChanges: [],
      testPoints: [{ id: 'VT1', acceptanceIds: ['AC1'], method: 'cli', executor: 'agent', instructions: 'Read the fixture operation', expected: 'Operation matches saved content', status: 'planned', evidence: [], blocker: '' }],
    }, null, 2)}\n`);
    assert.equal(status(1).action, 'reconcile');
    save('Record confirmed specification and work items');
    lifecycle('skip', ['--stage', 'PRD', '--reason', 'No separate product document needed']);
    advance('Intake');
    advance('Spec');
    advance('Plan');
    assert.match(advance('Implement', [], 1), /Approval|批准/);
    advance('Implement', ['--user-approved', '--approval-source', 'Fixture user approved the implementation']);
    const approval = checkpoint().approval;
    assert.ok(approval);
    // A recorded approval is applicability only; activating work still needs the current session.
    assert.match(item('T1', 'active', ['--checkpoint', 'Implementation started'], 1), /当前会话用户确认/);
    item('T1', 'active', ['--checkpoint', 'Implementation started', '--user-approved']);
    assert.equal(checkpoint().approval?.planHash, approval.planHash);

    writeFileSync(path.join(root, 'tracked.txt'), 'persisted operation\n');
    const actualContent = readFileSync(path.join(root, 'tracked.txt'), 'utf8');
    assert.equal(actualContent, 'persisted operation\n');
    const contract = JSON.parse(read('verification.json')) as Record<string, unknown>;
    contract.actualChanges = [{ id: 'A1', repository: '.', path: 'tracked.txt', summary: 'Persisted fixture operation', plannedChangeIds: ['C1'], acceptanceIds: ['AC1'] }];
    contract.contractStatus = 'implemented';
    write('verification.json', `${JSON.stringify(contract, null, 2)}\n`);
    save('Inspect the implementation and record actual changes');
    begin();
    assert.ok(existsSync(path.join(directory, 'verification-start/VT1.json')));
    write('evidence.md', `# Verification\n\n## Result\nRead tracked.txt and asserted exact content: ${JSON.stringify(actualContent)}.\n`);
    record();
    assert.equal(existsSync(path.join(directory, 'verification-start/VT1.json')), false);
    assert.equal(status().verification[0]?.status, 'current');
    item('T1', 'complete', ['--evidence', 'VT1']);
    assert.equal(status().nextWorkItem, 'T2');

    const beforeContinue = read('manifest.md');
    const beforeRevision = checkpoint().revision;
    const continued = run(['task', 'continue', '--task', taskId]);
    assert.match(continued, /"nextWorkItem": "T2"/);
    assert.match(continued, /spec.md#Approach/);
    assert.match(continued, /plan.md#Work Items/);
    assert.equal(read('manifest.md'), beforeContinue, 'continue must remain read-only');
    assert.equal(checkpoint().revision, beforeRevision, 'viewing does not create recent work');
    assert.equal(existsSync(path.join(directory, 'handoff.md')), false, 'no handoff operation is needed');
    const logs = path.resolve(root, '.agent-workflow/runtime/logs');
    assert.ok(logs.startsWith(`${root}${path.sep}`));
    rmSync(logs, { recursive: true, force: true });
    assert.match(run(['next', '--task', taskId, '--format', 'json', '--user-approved']), /implement/);
    assert.match(run(['route', '--route', 'standard-change', '--stage', 'implement', '--entry', 'direct', '--task', taskId, '--format', 'json', '--user-approved']), /implement/);

    const staleRevision = checkpoint().revision;
    item('T2', 'active', ['--user-approved']);
    assert.match(run(['task', 'checkpoint', '--task', taskId, '--expected-revision', String(staleRevision), '--reason', 'Stale writer'], 1), /expected-revision/);
    const baselineContract = read('verification.json');
    writeFileSync(path.join(root, 'tracked.txt'), 'externally changed operation\n');
    const staleDiagnosis = status(1);
    assert.equal(staleDiagnosis.action, 'reconcile');
    assert.equal(staleDiagnosis.verification[0]?.status, 'stale');
    save('Inspect external code difference without rerunning the test');
    assert.equal(status().verification[0]?.status, 'stale');
    assert.equal(read('verification.json'), baselineContract, 'checkpoint must never refresh executedAgainst');
    assert.match(item('T2', 'complete', ['--evidence', 'VT1'], 1), /current passed evidence/);

    writeFileSync(path.join(root, 'tracked.txt'), 'persisted operation\n');
    save('Restore the verified implementation before a second test');
    begin('evidence-2.md#Result');
    writeFileSync(path.join(root, 'tracked.txt'), 'changed while test ran\n');
    write('evidence-2.md', '# Verification\n\n## Result\nThis result must not attach to changed code.\n');
    assert.match(record('evidence-2.md#Result', 1), /代码或验证定义已变化/);
    assert.ok(existsSync(path.join(directory, 'verification-start/VT1.json')));
    rmSync(path.join(directory, 'evidence-2.md'));
    writeFileSync(path.join(root, 'tracked.txt'), 'persisted operation\n');
    run(['task', 'verify-record', '--task', taskId, '--test', 'VT1', '--status', 'blocked',
      '--expected-revision', String(checkpoint().revision), '--reason', 'Discard invalidated test attempt']);
    assert.equal(existsSync(path.join(directory, 'verification-start/VT1.json')), false);
    begin('evidence-3.md#Result');
    write('evidence-3.md', '# Verification\n\n## Result\nThe rerun covers the restored fixture code.\n');
    record('evidence-3.md#Result');

    save('Restore the previously verified implementation');
    assert.equal(status().verification[0]?.status, 'current');
    item('T2', 'blocked');
    assert.equal(status().status, 'blocked');
    assert.equal(status().action, 'resolve-blocker');
    assert.match(run(['next', '--task', taskId, '--format', 'json'], 1), /resolve-blocker/);
    lifecycle('resume', ['--action', 'The blocking condition has been resolved']);
    item('T2', 'active', ['--user-approved']);
    item('T2', 'complete', ['--evidence', 'VT1']);
    advance('Review');
    item('T3', 'complete', ['--evidence', 'review.md#Findings']);
    advance('Verify');

    const publishedManifest = read('manifest.md');
    const publishedRevision = checkpoint().revision;
    const unpublishedManifest = publishedManifest.replace('Current Stage: Verify', 'Current Stage: Git Inspect')
      .replace(/\| Verify \| in_progress \|[^\n]*\|/, '| Verify | complete | Interrupted publication |')
      .replace(/\| Git Inspect \| pending \|[^\n]*\|/, '| Git Inspect | in_progress | Interrupted publication |')
      .replace('Next Pending Stage: Verify', 'Next Pending Stage: Git Inspect');
    write('manifest.md', unpublishedManifest);
    assert.equal(status(1).action, 'reconcile');
    assert.match(run(['next', '--task', taskId], 1), /Unpublished/);
    assert.match(run(['route', '--route', 'standard-change', '--stage', 'git-inspect', '--entry', 'direct', '--task', taskId], 1), /Unpublished/);
    assert.match(lifecycle('complete', ['--evidence', 'Must not publish interrupted state'], 1), /Unpublished/);
    assert.match(advance('Git Inspect', [], 1), /Unpublished/);
    assert.match(lifecycle('block', ['--reason', 'Must not write through interrupted state'], 1), /Unpublished/);
    assert.match(save('Do not bless an interrupted lifecycle mutation', 1), /Unpublished lifecycle/);
    assert.equal(checkpoint().revision, publishedRevision);
    write('manifest.md', publishedManifest);

    const oldEvidence = read('verification.json');
    // A recorded approval never replaces the current session's confirmation.
    assert.match(lifecycle('reopen', ['--to', 'Implement', '--reason', 'Review found a necessary correction', '--action', 'Recheck implementation within the same approved scope'], 1), /当前会话用户确认/);
    lifecycle('reopen', ['--to', 'Implement', '--reason', 'Review found a necessary correction', '--action', 'Recheck implementation within the same approved scope', '--user-approved']);
    assert.equal(status().stage, 'Implement');
    assert.equal(status().nextWorkItem, 'T1');
    assert.doesNotMatch(read('plan.md'), /^- \[x\]/m);
    assert.equal(read('verification.json'), oldEvidence, 'reopen preserves historical test evidence');
    assert.ok(existsSync(path.join(directory, `history/revision-${publishedRevision}/manifest.md`)));
    assert.equal(checkpoint().approval?.planHash, approval.planHash, 'same approved definitions remain applicable');
    item('T1', 'complete', ['--evidence', 'VT1']);
    item('T2', 'complete', ['--evidence', 'VT1']);
    advance('Review');
    item('T3', 'complete', ['--evidence', 'review.md#Findings']);
    advance('Verify');
    item('T4', 'complete', ['--evidence', 'VT1']);
    assert.match(advance('Git Inspect', [], 1), /verified contract/);

    const verifiedContract = JSON.parse(read('verification.json')) as Record<string, unknown>;
    verifiedContract.contractStatus = 'verified';
    write('verification.json', `${JSON.stringify(verifiedContract, null, 2)}\n`);
    save('Confirm all required current evidence is passed');
    writeFileSync(path.join(root, 'tracked.txt'), 'later unverified change\n');
    save('Observe later code change without changing passed evidence');
    assert.match(advance('Git Inspect', [], 1), /current passed evidence|stale or unknown/);
    writeFileSync(path.join(root, 'tracked.txt'), 'persisted operation\n');
    save('Return to verified code');
    advance('Git Inspect');
    lifecycle('complete', ['--evidence', 'All fixture acceptance and work items verified']);
    assert.equal(status().action, 'complete');
    assert.match(run(['task', 'continue', '--task', taskId]), /已完成/);

    const legacyId = 'legacy-persistence-fixture';
    const legacyDirectory = path.join(root, '.agent-workflow/tasks/local', legacyId);
    const legacyRoute = JSON.parse(invoke(['route', '--route', 'standard-change', '--stage', 'capture', '--entry', 'direct', '--format', 'json']).stdout) as { runId: string };
    mkdirSync(legacyDirectory, { recursive: true });
    const legacyManifest = initialManifest.replace('Schema Version: 2', 'Schema Version: 1').replace('State Mode: Persistent', 'State Mode: Conversation')
      .replace(`Task ID: ${taskId}`, `Task ID: ${legacyId}`).replace(/^- Run ID: .*$/m, `- Run ID: ${legacyRoute.runId}`);
    writeFileSync(path.join(legacyDirectory, 'manifest.md'), legacyManifest);
    writeFileSync(path.join(legacyDirectory, 'source.md'), read('source.md'));
    writeFileSync(path.join(legacyDirectory, 'spec.md'), read('spec.md').replace(`task_id: ${taskId}`, `task_id: ${legacyId}`).replace('contract_version: 2', 'contract_version: 1'));
    writeFileSync(path.join(legacyDirectory, 'plan.md'), `---\nplan_version: 1\ntask_id: ${legacyId}\n---\n\n## Work Items\n\n- [ ] T1: Reconcile legacy progress\n  - Stage: Implement\n  - Planned Change: C1\n  - Verify: VT1\n  - Done When: Historical implementation and evidence are reconciled\n`);
    const historicalContract = JSON.parse(read('verification.json')) as { schemaVersion: number; taskId: string; testPoints: Array<Record<string, unknown>> };
    historicalContract.schemaVersion = 1;
    historicalContract.taskId = legacyId;
    for (const point of historicalContract.testPoints) delete point.executedAgainst;
    const legacyEvidence = `${JSON.stringify(historicalContract, null, 2)}\n`;
    writeFileSync(path.join(legacyDirectory, 'verification.json'), legacyEvidence);
    run(['task', 'migrate', '--task', legacyId, '--reason', 'Adopt persistence without inventing old progress']);
    assert.equal(readFileSync(path.join(legacyDirectory, 'manifest-legacy.md'), 'utf8'), legacyManifest);
    assert.match(readFileSync(path.join(legacyDirectory, 'manifest.md'), 'utf8'), /Schema Version: 2/);
    assert.equal(existsSync(path.join(legacyDirectory, 'handoff.md')), false);
    assert.equal(readFileSync(path.join(legacyDirectory, 'verification.json'), 'utf8'), legacyEvidence, 'migration must retain historical evidence without assigning a current baseline');
    const migratedStatus = JSON.parse(invoke(['task', 'status', '--task', legacyId, '--format', 'json']).stdout) as Diagnosis;
    assert.equal(migratedStatus.verification[0]?.status, 'unknown');
    assert.match(run(['task', 'continue', '--task', legacyId]), /Source Capture/);
    assert.match(run(['task', 'migrate', '--task', legacyId, '--reason', 'Duplicate migration'], 1), /already persistent/);

    const missingId = 'legacy-missing-continuity';
    const missingDirectory = path.join(root, '.agent-workflow/tasks/local', missingId);
    mkdirSync(missingDirectory);
    const missingManifest = legacyManifest.replace(`Task ID: ${legacyId}`, `Task ID: ${missingId}`).replace(/^- Run ID: .*$/m, '- Run ID: run-0000000000000000');
    writeFileSync(path.join(missingDirectory, 'manifest.md'), missingManifest);
    writeFileSync(path.join(missingDirectory, 'source.md'), read('source.md'));
    assert.match(run(['task', 'migrate', '--task', missingId, '--reason', 'Migration without prior run evidence'], 1), /Cannot establish legacy run continuity/);
    assert.equal(readFileSync(path.join(missingDirectory, 'manifest.md'), 'utf8'), missingManifest);
    assert.equal(existsSync(path.join(missingDirectory, 'checkpoint.json')), false, 'missing lineage must not create fabricated continuity');
    // With an explicit user-confirmed reconstruction the task may be adopted, but the
    // weaker provenance must be recorded and surfaced instead of faked as lineage.
    run(['task', 'migrate', '--task', missingId, '--reason', 'Reconstruct from inspected artifacts',
      '--user-approved', '--approval-source', 'Fixture user confirmed reconstruction from artifacts']);
    const missingCheckpoint = JSON.parse(readFileSync(path.join(missingDirectory, 'checkpoint.json'), 'utf8')) as SavedCheckpoint;
    assert.equal(missingCheckpoint.route.reconstructed, true);
    const missingStatus = JSON.parse(invoke(['task', 'status', '--task', missingId, '--format', 'json']).stdout) as { continuity: string; warnings: string[] };
    assert.equal(missingStatus.continuity, 'reconstructed');
    assert.match(missingStatus.warnings.join('\n'), /重建/);

    // A migrated version 1 contract keeps its history but cannot record a baseline
    // until the contract version is upgraded.
    const legacyRevision = (JSON.parse(readFileSync(path.join(legacyDirectory, 'checkpoint.json'), 'utf8')) as SavedCheckpoint).revision;
    assert.match(run(['task', 'verify-begin', '--task', legacyId, '--test', 'VT1', '--evidence', 'evidence.md#Result',
      '--environment', 'Legacy fixture checkout', '--expected-revision', String(legacyRevision),
      '--reason', 'Attempt a baseline on a legacy contract'], 1), /schemaVersion 1/);

    // Specs created after the version 2 enablement time must declare contract_version 2.
    const lateId = 'late-contract-version';
    const lateDirectory = path.join(root, '.agent-workflow/tasks/local', lateId);
    cpSync(legacyDirectory, lateDirectory, { recursive: true });
    for (const file of ['manifest.md', 'manifest-legacy.md', 'source.md', 'spec.md', 'plan.md', 'verification.json', 'checkpoint.json']) {
      const target = path.join(lateDirectory, file);
      if (existsSync(target)) writeFileSync(target, readFileSync(target, 'utf8').replaceAll(legacyId, lateId));
    }
    const lateSpec = path.join(lateDirectory, 'spec.md');
    writeFileSync(lateSpec, readFileSync(lateSpec, 'utf8').replace('created_at: 2026-09-10T00:00:00.000Z', 'created_at: 2026-09-12T00:00:00.000Z'));
    assert.match(run(['task', 'checkpoint', '--task', lateId, '--expected-revision', String(legacyRevision),
      '--reason', 'Validate a spec created after the baseline cutover', '--reconcile'], 1), /contract_version: 2/);

    console.log('Task persistence regression passed: fresh-process resume, checkpoints, evidence, interrupted publication, rework, approval scope, and legacy migration.');
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
