import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSpecChange, parseCapabilitySpec, readSpecBaseline, specChangeGateErrors, specContentHash } from '../../src/core/spec-change.js';
import type { CapabilitySpec, SpecChange } from '../../src/core/spec-change.js';
import { taskPlanHash } from '../../src/core/task-checkpoint.js';
import { verificationDefinitionHash } from '../../src/core/verification-baseline.js';
import { WorkflowController } from '../../src/control/index.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'spec-change-'));
const cli = fileURLToPath(new URL('../../bin/agent-workflow.js', import.meta.url));
const taskId = 'spec-fixture';
const directory = path.join(root, '.agent-workflow/tasks', taskId);
const baselineFile = '.agent-workflow/specs/export.json';
const baseline: CapabilitySpec = {
  schemaVersion: 1, capability: 'export', status: 'confirmed', evidence: ['Human reviewed existing export behavior'],
  requirements: [{ id: 'R1', statement: 'Export selected records', scenarios: [{ id: 'S1', when: 'Export is requested', then: 'Selected records are exported' }] }],
};
const write = (relative: string, value: unknown): string => {
  const content = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return content;
};
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
const success = (...args: string[]): string => {
  const result = run(...args); assert.equal(result.status, 0, result.stderr); return result.stdout;
};
try {
  write('.agent-workflow/config.json', { schemaVersion: 1, activeProfile: 'workflow:resources/profiles/default/profile.json', plugins: [],
    paths: { tasksRoot: '.agent-workflow/tasks', runtimeRoot: '.agent-workflow/runtime', skillsRoot: '.agents/skills', knowledgeRoot: '.agent-workflow/knowledge' } });
  mkdirSync(path.dirname(directory), { recursive: true });
  write('.gitignore', '.agent-workflow/\n'); write('AGENTS.md', '# Fixture\n'); write('code.txt', 'unchanged\n');
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' }); };
  git('init', '--quiet'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  const captured = write(baselineFile, baseline);
  success('task', 'init', '--task', taskId, '--route', 'level-2', '--entry', 'direct', '--source-type', 'requirement', '--source-text', 'Export change', '--goal', 'Export change');
  assert.equal(inspectSpecChange(directory, { root }).enabled, false, 'Legacy tasks do not acquire new gates');
  assert.equal(run('spec', 'init', '--task', taskId, '--baseline', baselineFile, '--expected-revision', '999').status, 1);
  const initialized = JSON.parse(success('spec', 'init', '--task', taskId, '--baseline', baselineFile, '--capability', 'notifications', '--expected-revision', '1'));
  assert.equal(initialized.revision, 2);
  const deltaFile = path.relative(root, path.join(directory, 'spec-change.json'));
  const delta = JSON.parse(readFileSync(path.join(directory, 'spec-change.json'), 'utf8')) as SpecChange;
  assert.equal(delta.capabilities[0]!.baseline!.content, captured);
  assert.equal(delta.capabilities[0]!.baseline!.hash, specContentHash(captured));
  assert.equal(inspectSpecChange(directory, { root }).artifacts.find(node => node.id === 'delta')!.status, 'blocked');
  assert.equal(run('spec', 'inspect', '--task', taskId, '--format', 'json').status, 1);
  delta.capabilities[0]!.changes.push({ operation: 'modified', requirementId: 'R1', reason: 'Add output feedback', acceptanceIds: ['AC1'], verificationIds: ['VT1'],
    requirement: { id: 'R1', statement: 'Export selected records and show completion', scenarios: [{ id: 'S1', when: 'Export is requested', then: 'Selected records are exported and completion is shown' }] } });
  delta.capabilities[1]!.changes.push({ operation: 'added', requirementId: 'R1', reason: 'Show completion', acceptanceIds: ['AC1'], verificationIds: ['VT1'],
    requirement: { id: 'R1', statement: 'Show completion', scenarios: [{ id: 'S1', when: 'Export completes', then: 'Completion is shown' }] } });
  const persistDelta = (): string => write(deltaFile, delta);
  const deltaContent = persistDelta();
  write(path.relative(root, path.join(directory, 'spec.md')), `---\ntask_id: ${taskId}\nentry_mode: direct\nsource_type: requirement\nspec_level: M\ncontract_version: 2\nstatus: confirmed\ncreated_at: 2026-11-20T00:00:00.000Z\n---\n# Spec\n## Behavior\nAC1 exports selected records and shows completion; VT1 covers both capability scenarios.\n## Design\nC1 changes code.txt.\n`);
  const contract = { schemaVersion: 2, taskId, specChangeHash: specContentHash(deltaContent), contractStatus: 'planned',
    goals: [{ id: 'G1', statement: 'Export with feedback' }], acceptanceCriteria: [{ id: 'AC1', goalIds: ['G1'], statement: 'Selected records export and completion is shown' }],
    outOfScope: [], plannedChanges: [{ id: 'C1', repository: '.', path: 'code.txt', summary: 'Show completion', acceptanceIds: ['AC1'] }], actualChanges: [],
    testPoints: [{ id: 'VT1', acceptanceIds: ['AC1'], method: 'static', executor: 'agent', instructions: 'Inspect selected export and completion feedback', expected: 'Both export and completion scenarios hold', status: 'planned', evidence: [], blocker: '' }] };
  const contractFile = path.relative(root, path.join(directory, 'verification.json'));
  const persistContract = (): void => { write(contractFile, contract); };
  persistContract();
  const specStages = [{ name: 'Spec', status: 'complete' }, { name: 'Plan', status: 'in_progress' }];
  const planStages = [{ name: 'Spec', status: 'complete' }, { name: 'Plan', status: 'complete' }];
  assert.deepEqual(specChangeGateErrors(directory, specStages, { root }), [], 'Spec can finish before plan exists');
  assert.match(specChangeGateErrors(directory, planStages, { root }).join('; '), /Missing plan/);
  write(path.relative(root, path.join(directory, 'plan.md')), `---\nplan_version: 1\ntask_id: ${taskId}\n---\n## Work Items\n- [ ] T1: Export feedback\n  - Stage: Implement\n  - Planned Change: C1\n  - Verify: VT1\n  - Done When: Both scenarios hold\n`);
  assert.deepEqual(specChangeGateErrors(directory, planStages, { root }), []);
  const ready = inspectSpecChange(directory, { root });
  assert.ok(ready.artifacts.every(node => node.status === 'ready'), JSON.stringify(ready));
  assert.equal(ready.impacts[0]!.before!.scenarios[0]!.then, baseline.requirements[0]!.scenarios[0]!.then);
  assert.notEqual(ready.impacts[0]!.before!.statement, ready.impacts[0]!.after!.statement);
  assert.equal(JSON.parse(success('spec', 'inspect', '--task', taskId, '--format', 'json')).impacts.length, 2);
  const readyDelta = structuredClone(delta);
  const readyContract = structuredClone(contract);
  const readySpec = readFileSync(path.join(directory, 'spec.md'), 'utf8');
  const readyPlan = readFileSync(path.join(directory, 'plan.md'), 'utf8');
  write(path.relative(root, path.join(directory, 'plan.md')), readyPlan.replace('Planned Change: C1', 'Artifact: spec.md#Behavior'));
  assert.match(inspectSpecChange(directory, { root }).artifacts.find(node => node.id === 'plan')!.issues.join('; '), /no work item for C1/);
  write(path.relative(root, path.join(directory, 'plan.md')), readyPlan.replace('Stage: Implement', 'Stage: Unknown'));
  assert.match(inspectSpecChange(directory, { root }).artifacts.find(node => node.id === 'plan')!.issues.join('; '), /does not belong/);
  write(path.relative(root, path.join(directory, 'plan.md')), readyPlan);
  const approvalHash = taskPlanHash(directory);
  const verificationHash = verificationDefinitionHash(contract, 'VT1');
  delta.capabilities[0]!.changes[0]!.reason = 'Revised rationale';
  persistDelta();
  assert.notEqual(taskPlanHash(directory), approvalHash, 'Delta mutation invalidates the approval definition');
  assert.match(specChangeGateErrors(directory, specStages, { root }).join('; '), /specChangeHash/);
  contract.specChangeHash = specContentHash(readFileSync(path.join(directory, 'spec-change.json'), 'utf8')); persistContract();
  assert.notEqual(verificationDefinitionHash(contract, 'VT1'), verificationHash, 'Rebound delta invalidates prior verification definitions');
  delta.capabilities[0]!.changes[0]!.acceptanceIds = ['AC2']; persistDelta();
  contract.specChangeHash = specContentHash(readFileSync(path.join(directory, 'spec-change.json'), 'utf8')); persistContract();
  assert.match(specChangeGateErrors(directory, specStages, { root }).join('; '), /Unknown AC|lacks VT coverage/);
  delta.capabilities[0]!.changes[0]!.acceptanceIds = ['AC1']; persistDelta();
  contract.specChangeHash = specContentHash(readFileSync(path.join(directory, 'spec-change.json'), 'utf8')); persistContract();
  const changedBaseline = structuredClone(baseline); changedBaseline.requirements[0]!.statement = 'Different baseline'; write(baselineFile, changedBaseline);
  assert.match(specChangeGateErrors(directory, planStages, { root }).join('; '), /Baseline changed/);
  assert.deepEqual(specChangeGateErrors(directory, planStages, { root, checkSources: false }), [], 'Historical inspection uses immutable task snapshot');
  write(baselineFile, baseline);
  delta.capabilities[0]!.changes[0]!.operation = 'removed'; delete delta.capabilities[0]!.changes[0]!.requirement; persistDelta();
  assert.equal(inspectSpecChange(directory, { root }).impacts[0]!.after, null, 'Removal previews old scenarios and has no replacement');
  delta.capabilities[0]!.changes[0]!.requirementId = 'R99'; persistDelta();
  assert.match(inspectSpecChange(directory, { root }).errors.join('; '), /Invalid removed target/);
  delta.capabilities[0]!.changes[0]!.requirementId = 'R1';
  delta.capabilities[0]!.baseline!.content += ' '; persistDelta();
  assert.match(inspectSpecChange(directory, { root }).errors.join('; '), /Snapshot hash mismatch/);
  assert.throws(() => readSpecBaseline('../outside.json', root), /relative/);
  const unconfirmed = { ...baseline, status: 'observed' as const, evidence: [] };
  assert.equal(parseCapabilitySpec(JSON.stringify(unconfirmed)).status, 'observed');
  assert.throws(() => parseCapabilitySpec(JSON.stringify({ ...baseline, evidence: [] })), /Invalid capability/);
  assert.throws(() => parseCapabilitySpec(JSON.stringify({ ...baseline, requirements: [...baseline.requirements, ...baseline.requirements] })), /Duplicate requirement/);
  const outside = mkdtempSync(path.join(os.tmpdir(), 'spec-outside-'));
  try {
    writeFileSync(path.join(outside, 'baseline.json'), captured);
    symlinkSync(outside, path.join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => readSpecBaseline('redirect/baseline.json', root), /越出/);
  } finally { rmSync(path.join(root, 'redirect'), { force: true, recursive: true }); rmSync(outside, { recursive: true, force: true }); }
  // Real CLI publication and transition validation: not just isolated policy functions.
  write(deltaFile, { ...readyDelta, capabilities: [{ ...readyDelta.capabilities[0]!, changes: [] }] });
  let revision = JSON.parse(readFileSync(path.join(directory, 'checkpoint.json'), 'utf8')).revision;
  success('task', 'checkpoint', '--task', taskId, '--reconcile', '--reason', 'Fixture inspected authoring changes', '--expected-revision', String(revision));
  revision++;
  write(baselineFile, changedBaseline);
  const refreshed = JSON.parse(success('spec', 'refresh', '--task', taskId, '--expected-revision', String(revision)));
  assert.equal(refreshed.revision, revision + 1);
  const recaptured = JSON.parse(readFileSync(path.join(directory, 'spec-change.json'), 'utf8')) as SpecChange;
  assert.equal(recaptured.capabilities[0]!.baseline!.content, readFileSync(path.join(root, baselineFile), 'utf8'));
  const validateCode = `const m=await import(${JSON.stringify(new URL('../../src/validators/check-task-artifacts.js', import.meta.url).href)}); const fs=await import('node:fs'); const content=fs.readFileSync(process.argv[1],'utf8').replace('| Spec | pending |','| Spec | complete |'); console.log(JSON.stringify(m.validateTaskArtifactsById(${JSON.stringify(taskId)},{manifestContent:content})));`;
  const checked = spawnSync(process.execPath, ['--input-type=module', '-e', validateCode, path.join(directory, 'manifest.md')], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /spec-change.json.*No changes declared/, 'Stage artifact validator rejects a blocked dependency');
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, baselineFile), 'utf8')), changedBaseline, 'Inspection and capture never mutate the registry');
  write(baselineFile, baseline);
  const controlled = new WorkflowController(root);
  const controlledId = 'spec-pipeline';
  try {
    controlled.start({ taskId: controlledId, route: 'level-2', entry: 'direct', goal: 'Exercise real Spec/Plan gates', sourceType: 'requirement', sourceText: 'Export with completion feedback' });
    const controlledDelta = { ...readyDelta, taskId: controlledId };
    const controlledContent = `${JSON.stringify(controlledDelta, null, 2)}\n`;
    controlled.artifact('spec-change.json', controlledContent);
    controlled.artifact('verification.json', JSON.stringify({ ...readyContract, taskId: controlledId, specChangeHash: specContentHash(controlledContent) }));
    controlled.artifact('spec.md', readySpec.replaceAll(taskId, controlledId));
    controlled.artifact('plan.md', readyPlan.replaceAll(taskId, controlledId));
    controlled.artifact('intake.md', '# Intake\nExport selected records with feedback.\n');
    controlled.artifact('prd.md', '# PRD\nPreserve selection behavior.\n');
    const advance = (to: string, evidence: string): void => {
      const state = controlled.status().task;
      controlled.task(['advance', '--to', to, '--evidence', evidence, '--action', `Continue ${to}`, '--expected-last-updated', state.lastUpdated]);
    };
    advance('Intake', 'source.md'); advance('PRD', 'intake.md'); advance('Spec', 'prd.md');
    controlled.artifact('spec-change.json', JSON.stringify({ ...controlledDelta, capabilities: [{ ...controlledDelta.capabilities[1]!, changes: [] }] }));
    assert.throws(() => advance('Plan', 'spec.md#Behavior'), /No changes declared|spec-change/, 'Actual Spec exit refuses blocked dependencies');
    assert.equal(controlled.status().task.stage, 'Spec');
    controlled.artifact('spec-change.json', controlledContent);
    advance('Plan', 'spec.md#Behavior');
    const proposal = controlled.propose('Preserve export and add completion feedback', ['code.txt']);
    controlled.approve(proposal.id);
    assert.equal(controlled.status().approved, true);
    assert.equal(controlled.status().task.specChange!.impacts.length, 2);
    write(baselineFile, changedBaseline);
    const drifted = controlled.status();
    assert.equal(drifted.approved, false, 'A changed live baseline revokes a resident write grant');
    assert.match(drifted.issue, /Baseline changed/);
    assert.throws(() => controlled.apply(proposal.id, [{ path: 'code.txt', beforeHash: specContentHash('unchanged\n'), content: 'not admitted' }]), /Baseline changed|approval|Task Gate/);
    assert.equal(readFileSync(path.join(root, 'code.txt'), 'utf8'), 'unchanged\n');
  } finally { controlled.dispose(); write(baselineFile, baseline); }
  process.stdout.write('Spec change regression passed: capture, add/modify/remove impact, dependency gates, freshness, approval/test binding, history and path boundaries.\n');
} finally { rmSync(root, { recursive: true, force: true }); }
