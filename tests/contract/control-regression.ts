import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { applyLiteralEdits } from '../../src/control/patch.js';
import path from 'node:path';
import { WorkflowController } from '../../src/control/index.js';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(path.join(os.tmpdir(), 'workflow-control-'));
assert.equal(applyLiteralEdits('\uFEFFone\r\ntwo\r\n', [{ oldText: 'one', newText: 'first' }, { oldText: 'two', newText: 'second' }]), '\uFEFFfirst\r\nsecond\r\n');
assert.throws(() => applyLiteralEdits('aaa', [{ oldText: 'aa', newText: 'x' }]), /exactly once/);
assert.throws(() => applyLiteralEdits('abcdef', [{ oldText: 'abc', newText: 'x' }, { oldText: 'bcde', newText: 'y' }]), /overlap/);
assert.throws(() => applyLiteralEdits('abc', [{ oldText: '', newText: 'x' }]), /nonempty/);
assert.throws(() => applyLiteralEdits('abc', [{ oldText: 'missing', newText: 'x' }]), /exactly once/);
try {
  mkdirSync(path.join(root, '.agent-workflow', 'tasks'), { recursive: true });
  writeFileSync(path.join(root, '.agent-workflow', 'config.json'), JSON.stringify({
    schemaVersion: 1, activeProfile: 'workflow:resources/profiles/default/profile.json', plugins: [],
    paths: { tasksRoot: '.agent-workflow/tasks', runtimeRoot: '.agent-workflow/runtime', skillsRoot: '.agents/skills', knowledgeRoot: '.agent-workflow/knowledge' },
  }));
  writeFileSync(path.join(root, '.gitignore'), '.agent-workflow/\nignored.txt\n');
  writeFileSync(path.join(root, 'ignored.txt'), 'ignored initial content');
  writeFileSync(path.join(root, 'AGENTS.md'), '# Host constraints\n');
  writeFileSync(path.join(root, 'target.txt'), 'existing user edit\r\n');
  writeFileSync(path.join(root, 'bom.txt'), '\uFEFFexisting BOM\r\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  git('init', '--quiet'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  // Existing uncommitted content is part of the approved preimage, never reset by the controller.
  writeFileSync(path.join(root, 'target.txt'), 'existing user edit\r\nlocal change\r\n');
  const controller = new WorkflowController(root);
  assert.throws(() => controller.status(), /start\/resume/);
  assert.equal(controller.start({ taskId: 'control-test', route: 'task-workflow-maintenance', entry: 'not-applicable', goal: 'Exercise write admission' }).stage, 'Inspect');
  const doctor = controller.doctor();
  assert.equal(doctor.runtimeIgnored, true); assert.equal(doctor.tasksReady, true);
  assert.equal(doctor.profile, 'default');
  mkdirSync(path.join(root, '.agents', 'skills', 'fixture-rule'), { recursive: true });
  writeFileSync(path.join(root, '.agents', 'skills', 'fixture-rule', 'SKILL.md'), '# Fixture rule\nPreserve user text.\n');
  // This is a host configuration change: publish the inspected baseline before requesting a Packet.
  controller.task(['checkpoint', '--reconcile', '--expected-revision', String(controller.status().task.revision), '--reason', 'Fixture skill installed']);
  const rules = controller.rules(['fixture-rule']);
  assert.deepEqual(rules.skills, ['fixture-rule']); assert.match(rules.context, /Preserve user text/);
  assert.throws(() => controller.rules(['../outside']), /Skill|非法/);
  const found = controller.files.search({ query: 'existing user', extensions: ['txt'] });
  assert.ok(found.matches.some((match) => match.path === 'target.txt' && match.line === 1));
  assert.equal(controller.files.search({ query: 'existing', path: 'target.txt', maxResults: 1 }).matches.length, 1);
  assert.equal(controller.files.search({ query: 'absent literal' }).matches.length, 0);
  assert.throws(() => controller.files.search({ query: 'x', path: '../outside' }), /relative/);
  assert.throws(() => controller.files.search({ query: '', maxResults: 0 }), /literal/);
  const before = controller.files.read('target.txt');
  assert.equal(controller.files.read('bom.txt').content, '\uFEFFexisting BOM\r\n');
  assert.throws(() => controller.apply('fake', [{ path: 'target.txt', beforeHash: before.hash, content: 'bad' }]));
  assert.equal(readFileSync(path.join(root, 'target.txt'), 'utf8'), before.content);
  assert.throws(() => controller.propose('No plan', ['target.txt']), /plan/);
  controller.artifact('changes.md', '# Changes\n\n## Implementation\nPreserve existing text and add a line.\n');
  const plan = '---\nplan_version: 1\ntask_id: control-test\n---\n\n## Work Items\n- [ ] T1: Apply controlled edits\n  - Stage: Implement\n  - Artifact: changes.md#Implementation\n  - Done When: Expected content is present\n';
  controller.artifact('plan.md', plan);
  for (const file of ['manifest.md', 'checkpoint.json', 'verification.json', '../outside.md', 'history/plan.md']) {
    assert.throws(() => controller.artifact(file, 'forged'));
  }
  for (const file of ['../escape.txt', 'C:/escape.txt', 'dir/../escape', 'target.txt:stream', '.git/config', '.agent-workflow/config.json', 'AGENTS.md', '.agents/policy.md', 'NUL.txt', 'target.txt.']) {
    assert.throws(() => controller.propose('Invalid scope', [file]), Error, file);
  }
  const proposal = controller.propose('Preserve user lines, add approved line', ['target.txt', 'new.txt']);
  assert.throws(() => controller.approve('forged-id'), /Proposal/);
  assert.equal(controller.approve(proposal.id).approved, true);
  assert.match(controller.context(), /Implement Card/);
  const other = new WorkflowController(root);
  other.resume('control-test');
  assert.equal(other.status().approved, false);
  assert.throws(() => other.apply(proposal.id, [{ path: 'target.txt', beforeHash: before.hash, content: 'forged' }]));
  // A rejected out-of-scope batch revokes permission without touching any file.
  assert.throws(() => controller.apply(proposal.id, [{ path: 'outside.txt', beforeHash: null, content: 'bad' }]), /scope/);
  assert.equal(existsSync(path.join(root, 'outside.txt')), false);
  let next = controller.propose('Preserve user lines, add approved line', ['target.txt', 'new.txt']);
  controller.approve(next.id);
  assert.throws(() => controller.apply(next.id, [{ path: 'target.txt', beforeHash: 'incorrect', content: 'bad' }]), /baseline/);
  next = controller.propose('Preserve user lines, add approved line', ['target.txt', 'new.txt']);
  controller.approve(next.id);
  assert.throws(() => controller.apply(next.id, [
    { path: 'new.txt', beforeHash: null, content: 'must not be created' },
    { path: 'target.txt', beforeHash: before.hash, edits: [{ oldText: 'missing patch context', newText: 'bad' }] },
  ]), /exactly once/);
  assert.equal(existsSync(path.join(root, 'new.txt')), false, 'A patch failure must reject the whole batch before writes');
  assert.equal(readFileSync(path.join(root, 'target.txt'), 'utf8'), before.content);
  assert.equal(controller.status().approved, false);
  next = controller.propose('Preserve user lines, add approved line', ['target.txt', 'new.txt']);
  controller.approve(next.id);
  const content = before.content + 'approved\r\n';
  assert.deepEqual(controller.apply(next.id, [
    { path: 'target.txt', beforeHash: before.hash, edits: [{ oldText: before.content, newText: content }] },
    { path: 'new.txt', beforeHash: null, content: 'new content\n' },
  ]).applied, ['target.txt', 'new.txt']);
  assert.equal(controller.status().approved, false);
  assert.equal(readFileSync(path.join(root, 'target.txt'), 'utf8'), content);
  assert.match(controller.diff().diff, /approved/);
  assert.ok(controller.diff().untracked.includes('new.txt'));
  assert.throws(() => controller.apply(next.id, [{ path: 'new.txt', beforeHash: null, content: 'replay' }]));
  const ignoredProposal = controller.propose('Ignored file preimage is still binding', ['ignored.txt']);
  controller.approve(ignoredProposal.id);
  writeFileSync(path.join(root, 'ignored.txt'), 'externally changed ignored content');
  assert.equal(controller.status().approved, false);
  assert.throws(() => controller.task(['advance', '--to', 'Verify', '--expected-last-updated', controller.status().task.lastUpdated, '--evidence', 'skip']), /Command failed/);
  next = controller.propose('Stale plan case', ['target.txt']);
  assert.throws(() => controller.artifact('plan.md', plan.replace('Expected content', 'Different outcome')), /Approved plan definitions/);
  assert.equal(readFileSync(path.join(root, '.agent-workflow', 'tasks', 'control-test', 'plan.md'), 'utf8'), plan);
  assert.throws(() => controller.approve(next.id), /Proposal/);
  next = controller.propose('External edits revoke approval', ['target.txt']);
  controller.approve(next.id);
  writeFileSync(path.join(root, 'unrelated.txt'), 'external change');
  assert.throws(() => controller.apply(next.id, [{ path: 'target.txt', beforeHash: controller.files.read('target.txt').hash, content: 'bad' }]));
  assert.equal(controller.status().approved, false);
  assert.equal(readFileSync(path.join(root, 'target.txt'), 'utf8'), content);
  // Hard links and directory junctions must not make approved relative paths write elsewhere.
  linkSync(path.join(root, 'target.txt'), path.join(root, 'hard.txt'));
  assert.throws(() => controller.files.baseline('hard.txt'), /regular file/);
  rmSync(path.join(root, 'hard.txt'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'workflow-control-outside-'));
  try {
    writeFileSync(path.join(outside, 'external.txt'), 'outside');
    symlinkSync(outside, path.join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => controller.files.baseline('redirect/external.txt'), /Links/);
    assert.equal(readFileSync(path.join(outside, 'external.txt'), 'utf8'), 'outside');
  } finally { rmSync(path.join(root, 'redirect'), { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  other.dispose(); assert.throws(() => other.resume('control-test'), /disposed/);
  controller.resume('control-test'); assert.equal(controller.status().approved, false);
  controller.files.lock(() => assert.throws(() => other.files.lock(() => undefined), /EEXIST/));
  const contract = JSON.parse(readFileSync(fileURLToPath(new URL('../../../resources/examples/verification-contract.sample.json', import.meta.url)), 'utf8')) as {
    schemaVersion: number; taskId: string; contractStatus: string; actualChanges: unknown[];
    testPoints: Array<{ status: string; evidence: string[]; blocker: string }>;
  };
  contract.schemaVersion = 2; contract.taskId = 'control-test'; contract.contractStatus = 'planned'; contract.actualChanges = [];
  for (const point of contract.testPoints) { point.status = 'planned'; point.evidence = []; point.blocker = ''; }
  assert.throws(() => controller.artifact('verification.json', JSON.stringify(contract)), /Approved plan definitions/);
  contract.contractStatus = 'verified';
  assert.throws(() => controller.artifact('verification.json', JSON.stringify(contract)), /verified/);
  contract.contractStatus = 'conditional';
  assert.throws(() => controller.artifact('verification.json', JSON.stringify(contract)), /definitions only/);
  controller.dispose();
  process.stdout.write('Controlled workflow regression passed (real task lifecycle, approval, preimages, scope and path boundaries).\n');
} finally { rmSync(root, { recursive: true, force: true }); }
