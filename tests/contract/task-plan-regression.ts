import assert from 'node:assert/strict';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseTaskPlan, planDefinitionHash, updateWorkItem, validateTaskPlan } from '../../src/core/task-plan.js';

const fixture = `---
plan_version: 1
task_id: plan-fixture
---

# Plan

## Approach

Keep this explanation exactly as written.

\`\`\`markdown
## Work Items
- [x] T99: This is an example, not task progress
\`\`\`

## Work Items

- [ ] T1: Implement persistence
  - Stage: Implement
  - Planned Change: C1
  - Verify: VT1
  - Depends On: none
  - Done When: Records can be read back

- [ ] T2: Check recovery
  - Stage: Verify
  - Planned Change: C1
  - Verify: VT2
  - Depends On: T1
  - Done When: A fresh reader finds the next action

## Notes

This prose is unrelated to progress and must survive updates.
`;

const contract = {
  taskId: 'plan-fixture', plannedChanges: [{ id: 'C1' }], testPoints: [{ id: 'VT1' }, { id: 'VT2' }],
};

export const main = (): number => {
  const plan = parseTaskPlan(fixture, 'plan-fixture');
  assert.equal(plan.items.length, 2, 'fenced example must not become a task');
  assert.deepEqual(validateTaskPlan(plan, { stages: ['Implement', 'Verify'], contract }), []);
  const active = updateWorkItem(fixture, 'T1', { progress: 'active', checkpoint: 'Write path implemented; read path remains' });
  assert.equal(parseTaskPlan(active).items[0]?.progress, 'active');
  assert.equal(planDefinitionHash(active), planDefinitionHash(fixture), 'progress must not change the approved plan projection');
  assert.ok(active.startsWith(fixture.slice(0, fixture.indexOf('## Work Items\n\n'))));
  assert.ok(active.endsWith('## Notes\n\nThis prose is unrelated to progress and must survive updates.\n'));
  const complete = updateWorkItem(active, 'T1', { complete: true, evidence: ['VT1'] });
  assert.equal(parseTaskPlan(complete).items[0]?.complete, true);
  assert.doesNotMatch(complete.split('- [ ] T2:')[0]!, /  - Progress:/);
  assert.equal(planDefinitionHash(complete), planDefinitionHash(fixture));
  const resumed = updateWorkItem(complete, 'T2', { progress: 'active' });
  assert.equal(parseTaskPlan(resumed).items[1]?.progress, 'active');
  const blocked = updateWorkItem(active, 'T1', { progress: 'blocked', blocker: 'Required environment unavailable' });
  assert.equal(parseTaskPlan(blocked).items[0]?.blocker, 'Required environment unavailable');
  const unblocked = updateWorkItem(blocked, 'T1', { progress: 'active' });
  assert.equal(parseTaskPlan(unblocked).items[0]?.blocker, '');
  assert.equal(planDefinitionHash(blocked), planDefinitionHash(unblocked));
  assert.notEqual(planDefinitionHash(fixture.replace('Records can be read back', 'Records preserve their revision')), planDefinitionHash(fixture));
  assert.notEqual(planDefinitionHash(fixture.replace('Depends On: T1', 'Depends On: none')), planDefinitionHash(fixture));
  assert.notEqual(planDefinitionHash(fixture.replace('Keep this explanation exactly as written.', 'A different approach changes the approved plan.')), planDefinitionHash(fixture));

  const malformed: [string, string][] = [
    ['duplicate frontmatter', fixture.replace('plan_version: 1', 'plan_version: 1\nplan_version: 1')],
    ['future version', fixture.replace('plan_version: 1', 'plan_version: 2')],
    ['missing work section', fixture.replace('## Work Items\n\n', '## Work\n\n')],
    ['duplicate item', fixture.replace('T2: Check recovery', 'T1: Check recovery')],
    ['malformed checkbox', fixture.replace('- [ ] T1:', '- [yes] T1:')],
    ['unknown metadata', fixture.replace('  - Stage: Implement', '  - Unknown: value\n  - Stage: Implement')],
    ['duplicate metadata', fixture.replace('  - Stage: Implement', '  - Stage: Implement\n  - Stage: Verify')],
    ['missing done when', fixture.replace('  - Done When: Records can be read back\n', '')],
    ['self dependency', fixture.replace('Depends On: none', 'Depends On: T1')],
    ['cyclic dependency', fixture.replace('Depends On: none', 'Depends On: T2')],
    ['unknown dependency', fixture.replace('Depends On: none', 'Depends On: T3')],
    ['invalid planned ID', fixture.replace('Planned Change: C1', 'Planned Change: A1')],
    ['duplicate reference', fixture.replace('Planned Change: C1', 'Planned Change: C1, C1')],
    ['invalid verification ID', fixture.replace('Verify: VT1', 'Verify: AC1')],
    ['completed pending conflict', complete.replace('  - Stage: Implement', '  - Stage: Implement\n  - Progress: pending')],
    ['missing completion evidence', fixture.replace('- [ ] T1:', '- [x] T1:')],
    ['missing blocked reason', fixture.replace('  - Stage: Implement', '  - Stage: Implement\n  - Progress: blocked')],
    ['unfulfilled dependency', fixture.replace('  - Stage: Verify', '  - Stage: Verify\n  - Progress: active')],
    ['multiple active items', active.replace('Depends On: T1', 'Depends On: none').replace('  - Stage: Verify', '  - Stage: Verify\n  - Progress: active')],
    ['fenced fake work', fixture.replace('## Work Items\n\n', '## Work Items\n\n```markdown\n- [x] T3: Hidden\n```\n')],
    ['hidden indented work', fixture.replace('- [ ] T1:', '    - [ ] T1:')],
    ['HTML-hidden items', fixture.replace('## Work Items\n\n', '<!--\n## Work Items\n\n')],
  ];
  for (const [name, content] of malformed) assert.throws(() => parseTaskPlan(content), name);
  assert.throws(() => parseTaskPlan(fixture, 'another-task'), /does not match/);
  assert.ok(validateTaskPlan(plan, { stages: ['Inspect'], contract }).some((error) => error.includes('Stage')));
  assert.ok(validateTaskPlan(plan, { contract: { ...contract, plannedChanges: [] } }).some((error) => error.includes('unknown Planned Change')));
  assert.ok(validateTaskPlan(plan, { contract: { ...contract, testPoints: [] } }).some((error) => error.includes('unknown Verify')));
  assert.ok(validateTaskPlan(plan, { contract: {} }).length > 0);
  assert.ok(validateTaskPlan(parseTaskPlan(complete.replace('Evidence: VT1', 'Evidence: VT99')), { contract }).some((error) => error.includes('unknown Evidence')));
  assert.ok(validateTaskPlan({ ...plan, unknown: true }).length > 0, 'data schema must reject undeclared fields');
  assert.throws(() => updateWorkItem(fixture, 'T1', { complete: true }), /requires Evidence/);
  assert.throws(() => updateWorkItem(fixture, 'T2', { complete: true, evidence: ['VT2'] }), /dependency T1/);
  assert.throws(() => updateWorkItem(fixture, 'T1', { complete: true, progress: 'active', evidence: ['VT1'] }), /must omit Progress/);
  assert.throws(() => updateWorkItem(fixture, 'T1', { checkpoint: 'Injected\n  - Stage: Verify' }));
  assert.throws(() => updateWorkItem(fixture, 'T3', { progress: 'active' }), /Unknown work item/);

  const crlf = fixture.replaceAll('\n', '\r\n');
  const crlfUpdated = updateWorkItem(crlf, 'T1', { progress: 'active' });
  assert.equal(crlfUpdated.replaceAll('\r\n', ''), crlfUpdated.replaceAll(/\r?\n/g, ''), 'preserve CRLF line endings');
  const endOfFile = fixture.slice(0, fixture.indexOf('\n## Notes')).trimEnd();
  assert.equal(parseTaskPlan(updateWorkItem(endOfFile, 'T2', { checkpoint: 'Pending dependency' })).items[1]?.checkpoint, 'Pending dependency');
  const maintenance = fixture.replaceAll('  - Planned Change: C1\n', '').replaceAll(/  - Verify: VT[12]\n/g, '  - Artifact: task-analysis.md#Findings\n');
  assert.deepEqual(validateTaskPlan(parseTaskPlan(maintenance)), []);
  assert.throws(() => parseTaskPlan(maintenance.replaceAll('task-analysis.md#Findings', '../outside.md')), /safe relative locator/);
  const deferred = `${fixture}\n## Deferred Work Items\n\n- [ ] T3: Broader migration\n  - Stage: Implement\n  - Done When: Legacy tasks are migrated\n  - Artifact: follow-up.md\n  - Deferred Reason: Separate accepted scope\n`;
  assert.equal(parseTaskPlan(deferred).items[2]?.deferredReason, 'Separate accepted scope');
  assert.throws(() => parseTaskPlan(deferred.replace('  - Deferred Reason: Separate accepted scope\n', '')), /Deferred Reason/);
  assert.throws(() => parseTaskPlan(deferred.replace('Depends On: T1', 'Depends On: T3')), /depends on deferred/);
  assert.throws(() => updateWorkItem(deferred, 'T3', { progress: 'active' }), /scope revision/);
  console.log('Task plan regression passed.');
  return 0;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
