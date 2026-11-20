import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncWorkflowController } from '../../src/control/index.js';
import { ControlOperations } from '../../src/control/operations.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'control-reliability-'));
const controllers: AsyncWorkflowController[] = [];
try {
  const configRoot = path.join(root, '.agent-workflow');
  mkdirSync(path.join(configRoot, 'tasks'), { recursive: true });
  const sdk = new URL('../../src/plugin-sdk/index.js', import.meta.url).href;
  writeFileSync(path.join(configRoot, 'provider.mjs'), `
import { sourceProviderService } from ${JSON.stringify(sdk)};
export default {
 manifest: { apiVersion: 1, id: 'fixture-source', version: '1.0.0', capabilities: ['source-provider'], provides: { services: [sourceProviderService.id] } },
 setup(ctx) { ctx.provide(sourceProviderService, { id: 'fixture-source', async capture({reference}) {
   if (!/^(REQ|BUG)-[0-9]+$/.test(reference)) throw new Error('No exact reference found');
   const entry = reference.startsWith('BUG') ? 'defect' : 'requirement';
   return { sourceId: entry + ':' + reference, sourceType: entry, capturedAt: new Date().toISOString(),
     facts: { entry, reference, result: { title: 'Fixture source', detail: 'Preserve user text and append line' } } };
 } }); }
};`);
  writeFileSync(path.join(configRoot, 'profile.json'), JSON.stringify({ schemaVersion: 1,
    extends: 'workflow:resources/profiles/default/profile.json', id: 'fixture-profile', description: 'V3 source fixture',
    sourceProviders: { pool: { kind: 'connector', name: 'fixture-source' } } }));
  writeFileSync(path.join(configRoot, 'config.json'), JSON.stringify({ schemaVersion: 1,
    activeProfile: '.agent-workflow/profile.json', plugins: [{ id: 'fixture-source', module: './.agent-workflow/provider.mjs', permissions: [] }],
    paths: { tasksRoot: '.agent-workflow/tasks', runtimeRoot: '.agent-workflow/runtime', skillsRoot: '.agents/skills', knowledgeRoot: '.agent-workflow/knowledge' } }));
  writeFileSync(path.join(root, '.gitignore'), '.agent-workflow/\n');
  writeFileSync(path.join(root, 'AGENTS.md'), '# Fixture host\n');
  writeFileSync(path.join(root, 'code.txt'), 'user text\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  git('init', '--quiet'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  const control = new AsyncWorkflowController(root); controllers.push(control);
  assert.equal((await control.lookup('REQ-1')).intent, 'requirement');
  assert.equal((await control.lookup('BUG-1')).intent, 'defect');
  assert.deepEqual(readdirSync(path.join(configRoot, 'tasks')), [], 'Lookup must not create tasks');
  await assert.rejects(control.run('BUG-1', 'requirement'), /conflicts/);
  await assert.rejects(control.lookup('missing'), /No exact reference/);
  const opened = await control.run('BUG-1');
  const taskId = opened.task.taskId;
  const directory = path.join(root, opened.taskDirectory);
  assert.equal(JSON.parse(readFileSync(path.join(directory, 'control-route.json'), 'utf8')).intent, 'defect');
  assert.match(readFileSync(path.join(directory, 'source.md'), 'utf8'), /BUG-1/);
  const submit = async (evidence: string, verdict: 'ready' | 'changes-required' = 'ready') => control.submit({
    stateToken: (await control.status()).task.stateToken, evidence, items: [], verdict, reason: verdict === 'ready' ? '' : 'Review requires another implementation pass' });
  const initial = { stateToken: opened.task.stateToken, evidence: 'source.md', items: [], verdict: 'ready' as const, reason: '' };
  assert.equal((await control.submit(initial)).task.stage, 'Intake');
  const after = await control.status();
  assert.equal((await control.submit(initial)).task.stage, 'Intake');
  assert.equal((await control.status()).task.revision, after.task.revision, 'Repeated stage submission cannot advance twice');
  await control.artifact('intake.md', '# Intake\nExact text behavior is required.\n');
  assert.equal((await submit('intake.md')).task.stage, 'PRD');
  await control.artifact('prd.md', '# PRD\nPreserve the existing text.\n');
  assert.equal((await submit('prd.md')).task.stage, 'Spec');
  const contract = { schemaVersion: 2, taskId, contractStatus: 'planned',
    goals: [{ id: 'G1', statement: 'Preserve user content' }],
    acceptanceCriteria: [{ id: 'AC1', goalIds: ['G1'], statement: 'Append line once' }], outOfScope: [],
    plannedChanges: [{ id: 'C1', repository: '.', path: 'code.txt', summary: 'Append line', acceptanceIds: ['AC1'] }], actualChanges: [],
    testPoints: [{ id: 'VT1', acceptanceIds: ['AC1'], method: 'static', executor: 'agent', instructions: 'Inspect text', expected: 'Text preserved', status: 'planned', evidence: [], blocker: '' }] };
  await control.artifact('verification.json', JSON.stringify(contract));
  await control.artifact('spec.md', `---\ntask_id: ${taskId}\nentry_mode: pool\nsource_type: defect\nsource_sn: defect:BUG-1\nspec_level: S\nstatus: confirmed\ncreated_at: 2026-11-19T00:00:00Z\ncontract_version: 2\n---\n\n# Spec\nPreserve text and append once.\n`);
  assert.equal((await submit('spec.md')).task.stage, 'Plan');
  await control.artifact('plan.md', `---\nplan_version: 1\ntask_id: ${taskId}\n---\n\n## Work Items\n- [ ] T1: Append line\n  - Stage: Implement\n  - Artifact: changes.md\n  - Done When: Text matches\n`);
  await control.artifact('changes.md', '# Changes\nPreserve text and append line.\n');
  assert.equal((await submit('plan.md')).waitingFor, 'approval');
  await control.pause();
  assert.equal((await control.continue()).waitingFor, 'approval', 'Continue preserves the approval barrier');
  const restarted = new AsyncWorkflowController(root); controllers.push(restarted);
  assert.equal((await restarted.resume(taskId)).waitingFor, 'approval');
  const before = await control.read('code.txt');
  let proposal = await control.propose('Append once', ['code.txt']);
  await control.approve(proposal.id);
  await control.artifact('changes.md', '# Changes\nPreserve text and append line.\n');
  assert.equal((await control.delivery()).waitingFor, 'approval', 'Lost proposal still allows controlled replanning');
  const replanning = await submit('changes.md', 'changes-required');
  assert.equal(replanning.task.stage, 'Plan', JSON.stringify(replanning));
  assert.equal(await control.canApply(), false, 'Replanning never carries code write authority');
  await control.artifact('plan.md', replanning.task.plan!.replace('Done When: Text matches', 'Done When: Text preserved and matches'));
  assert.equal((await submit('plan.md')).waitingFor, 'approval');
  proposal = await control.propose('Revised plan before implementation', ['code.txt']);
  await control.approve(proposal.id);
  const changes = [{ path: 'code.txt', beforeHash: before.hash, content: before.content + 'approved\n' }];
  await control.apply(proposal.id, changes);
  await restarted.apply(proposal.id, changes);
  assert.equal(readFileSync(path.join(root, 'code.txt'), 'utf8'), 'user text\napproved\n');
  const implemented = await control.submit({ stateToken: (await control.status()).task.stateToken, evidence: 'changes.md', items: [{ id: 'T1', evidence: 'changes.md' }], verdict: 'ready', reason: '' });
  assert.equal(implemented.task.stage, 'Review', JSON.stringify(implemented));
  await control.artifact('review.md', '# Findings\nNeed another approved line.\n');
  const rework = await submit('review.md', 'changes-required');
  assert.equal(rework.task.stage, 'Plan', JSON.stringify(rework));
  assert.equal((await control.status()).approved, false);
  assert.match(rework.task.plan!, /- \[ \] T1/);
  assert.equal((await submit('plan.md')).waitingFor, 'approval');
  const renewed = await control.propose('Second reviewed batch', ['code.txt']);
  await assert.rejects(control.apply(renewed.id, [{ path: 'code.txt', beforeHash: (await control.read('code.txt')).hash, content: 'bad' }]), /approval|Implement|implementing/);
  await control.approve(renewed.id);
  assert.equal((await control.status()).approved, true);
  // The same previously rejected payload is now admitted after explicit human approval.
  const rejectedPayload = [{ path: 'code.txt', beforeHash: (await control.read('code.txt')).hash, content: 'bad' }];
  await control.apply(renewed.id, rejectedPayload);
  assert.equal(readFileSync(path.join(root, 'code.txt'), 'utf8'), 'bad');

  // Simulate a process dying after a file write but before publishing its checkpoint/receipt.
  const operationsDirectory = path.join(configRoot, 'runtime', 'control-operations', taskId);
  writeFileSync(path.join(root, 'code.txt'), 'external edit');
  await assert.rejects(control.continue(), /Repository changed/, 'Budget reset must not silently reconcile external edits');
  writeFileSync(path.join(root, 'code.txt'), 'bad');
  const pendingId = 'a'.repeat(64);
  writeFileSync(path.join(operationsDirectory, 'pending.json'), JSON.stringify({ id: pendingId, kind: 'apply', startedAt: new Date().toISOString() }));
  writeFileSync(path.join(root, 'code.txt'), 'user text\napproved\npartial effect\n');
  const recovery = await restarted.resume(taskId);
  assert.equal(recovery.waitingFor, 'human'); assert.ok(recovery.recovery.pending); assert.ok(recovery.recovery.issue);
  await assert.rejects(restarted.continue(), /recover/);
  await assert.rejects(restarted.recover(), /Repository changed/);
  await restarted.task(['checkpoint', '--reconcile', '--expected-revision', String((await restarted.status()).task.revision), '--reason', 'Human inspected partial effect']);
  assert.equal((await restarted.recover()).waitingFor, 'approval');
  assert.equal((await restarted.status()).approved, false);
  const receipt = JSON.parse(readFileSync(path.join(operationsDirectory, `${pendingId}.json`), 'utf8'));
  assert.match(receipt.error, /do not replay/);

  const journal = new ControlOperations(operationsDirectory);
  let executions = 0;
  assert.equal(journal.run('fixture', { id: 1, version: 2 }, () => ++executions), 1);
  assert.equal(journal.run('fixture', { version: 2, id: 1 }, () => ++executions), 1);
  assert.equal(executions, 1);
  assert.throws(() => journal.run('failure', { id: 1 }, () => { executions++; throw new Error('known failure'); }), /known failure/);
  assert.throws(() => journal.run('failure', { id: 1 }, () => { executions++; }), /known failure/);
  assert.equal(executions, 2, 'Known failures are not blindly retried');
  process.stdout.write('Control V3 reliability regression passed: exact provider lookup, intent routing, durable deduplication, approval recovery, review rework and uncertain side effects.\n');
} finally {
  for (const controller of controllers) await controller.dispose();
  rmSync(root, { recursive: true, force: true });
}
