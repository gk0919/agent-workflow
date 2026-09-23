import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { workflowRoot } from '../../src/config/workspace-paths.js';
import { markdownSections, renderTaskSummary, validateHandoffState } from '../../src/core/task-handoff.js';

const cli = path.join(workflowRoot, 'dist/bin/agent-workflow.js');

export const main = (): number => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'handoff-regression-'));
  const run = (args: string[], expected = 0): string => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    assert.equal(result.status, expected, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout + result.stderr;
  };
  const git = (args: string[]): void => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    writeFileSync(path.join(root, 'package.json'), '{"name":"handoff-fixture","private":true}\n');
    run(['init']);
    git(['init']);
    writeFileSync(path.join(root, 'tracked.txt'), 'baseline\n');
    git(['add', 'tracked.txt']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
    assert.equal(JSON.parse(run(['task', 'current', '--format', 'json'], 1)).status, 'none');
    const taskId = 'handoff-fixture';
    const directory = path.join(root, '.agent-workflow/tasks/local', taskId);
    mkdirSync(directory, { recursive: true });
    const manifest = `# Task Manifest

## Identity
- Schema Version: 1
- Task ID: ${taskId}
- Run ID: run-1234567890abcdef
- Route ID: task-workflow-maintenance
- Status: in_progress
- Current Stage: Inspect
- State Mode: Portable
- Last Updated: 2026-09-10T00:00:00.000Z

## Source Record
- Entry Mode: not-applicable
- Type: none

## Scope
- Goal: Preserve recovery context

## Repository Matrix
| Repository | Root | Module | Branch | Remote | Allowed Git Actions |
|------------|------|--------|--------|--------|---------------------|
| workspace | \`.\` | fixture | current | none | Inspect |

## Stage Status
| Stage | Status | Artifact / Reason |
|-------|--------|-------------------|
| Inspect | in_progress | inspect |
| Implement | pending | |
| Review | pending | |
| Verify | pending | |
| Git Inspect | pending | |

## Authorization
- Git Stage: no
- Commit: no
- Push: no

## Resume
- Last Completed Stage: none
- Next Pending Stage: Inspect
- Next Action: inspect the recovery evidence
- Known Blockers: none
`;
    writeFileSync(path.join(directory, 'manifest.md'), manifest);
    const current = (): { status: string; task: { taskId: string } | null; candidates: unknown[] } =>
      JSON.parse(run(['task', 'current', '--format', 'json']));
    assert.equal(current().task?.taskId, taskId);
    const secondId = 'second-fixture';
    const secondDirectory = path.join(root, '.agent-workflow/tasks/local', secondId);
    mkdirSync(secondDirectory);
    const secondManifest = manifest.replace(`Task ID: ${taskId}`, `Task ID: ${secondId}`);
    writeFileSync(path.join(secondDirectory, 'manifest.md'), secondManifest);
    const ambiguous = JSON.parse(run(['task', 'current', '--format', 'json'], 1));
    assert.equal(ambiguous.status, 'ambiguous');
    assert.equal(ambiguous.candidates.length, 2);
    assert.match(run(['task', 'handoff'], 1), /多个同样最近/);
    run(['task', 'current', '--task', 'missing-task', '--format', 'json'], 1);
    run(['task', 'summary', '--task'], 1);
    writeFileSync(path.join(secondDirectory, 'manifest.md'), secondManifest.replace('2026-09-10T00:00:00.000Z', '2026-09-11T00:00:00.000Z'));
    assert.equal(current().task?.taskId, secondId);
    assert.equal(JSON.parse(run(['task', 'current', '--task', taskId, '--format', 'json'])).task.taskId, taskId);
    const completed = secondManifest.replace('2026-09-10T00:00:00.000Z', '2026-09-12T00:00:00.000Z')
      .replace('Status: in_progress', 'Status: complete').replace('Current Stage: Inspect', 'Current Stage: complete')
      .replaceAll('| in_progress |', '| complete |').replaceAll('| pending |', '| complete |')
      .replace('Next Pending Stage: Inspect', 'Next Pending Stage: none').replace('Next Action: inspect the recovery evidence', 'Next Action: none');
    writeFileSync(path.join(secondDirectory, 'manifest.md'), completed);
    assert.equal(current().task?.taskId, taskId);
    assert.match(run(['task', 'continue', '--task', secondId]), /已完成/);
    writeFileSync(path.join(secondDirectory, 'manifest.md'), '# broken');
    assert.equal(JSON.parse(run(['task', 'current', '--format', 'json'], 1)).status, 'invalid');
    assert.equal(JSON.parse(run(['task', 'current', '--task', taskId, '--format', 'json'])).task.taskId, taskId);
    rmSync(secondDirectory, { recursive: true, force: true });
    const prepare = run(['task', 'prepare']);
    assert.match(prepare, /task-handoff\/prepare/);
    assert.match(prepare, new RegExp(`已选择任务：${taskId}`));
    assert.match(prepare, /manifest.md#Scope/);
    writeFileSync(path.join(directory, 'handoff.md'), '# Handoff\n\n## Required Context\nlegacy evidence\n\n## Authorization\nNo Git writes authorized\n');
    const legacy = run(['task', 'summary', '--task', taskId]);
    assert.match(legacy, /legacy evidence/);
    assert.match(legacy, /No Git writes authorized/);
    assert.match(legacy, /freshness unverified/);
    run(['task', 'handoff', '--task', taskId], 1);
    const notes = `# Handoff Notes

## Checkpoint
Inspection complete; implementation has not started. Only tracked.txt is owned by this fixture.

## Decisions
Preserve full evidence sections because truncation can remove stop conditions.

## Attempts / Unknowns
No failed attempts; integration behavior still needs verification.

## Next Steps
Read the scope, inspect tracked.txt in workspace, expect baseline content; stop on any mismatch.

## Required Context
- \`manifest.md#Scope\`: establishes the accepted goal.
`;
    writeFileSync(path.join(directory, 'handoff-notes.md'), notes);
    const packet = JSON.parse(run(['route', '--route', 'task-handoff', '--stage', 'prepare', '--entry', 'not-applicable', '--format', 'json', '--no-log'])) as { skillDocs: string[] };
    assert.equal(packet.skillDocs.length, 1);
    const resumePacket = JSON.parse(run(['route', '--route', 'task-portable-resume', '--stage', 'resume', '--entry', 'not-applicable', '--format', 'json', '--no-log'])) as { skillDocs: string[] };
    assert.deepEqual(resumePacket.skillDocs, packet.skillDocs);
    run(['task', 'handoff', '--task', taskId]);
    run(['task', 'handoff-check', '--task', taskId]);
    run(['task', 'handoff-check']);
    run(['task', 'handoff']);
    const continueOutput = run(['task', 'continue']);
    assert.match(continueOutput, /task-portable-resume\/resume/);
    assert.equal(readFileSync(path.join(directory, 'manifest.md'), 'utf8'), manifest);
    const generated = readFileSync(path.join(directory, 'handoff.md'), 'utf8');
    assert.match(generated, /Preserve full evidence/);
    assert.match(generated, /Commit: no/);
    assert.match(generated, /Repository Snapshot/);
    assert.match(readFileSync(path.join(directory, 'handoff-legacy.md'), 'utf8'), /legacy evidence/);
    const state = JSON.parse(readFileSync(path.join(directory, 'handoff-state.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(validateHandoffState(state), []);
    assert.ok(validateHandoffState({ ...state, taskId: '../escape' }).length > 0);
    const profilePath = path.join(root, '.agent-workflow/profile/profile.json');
    const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as Record<string, unknown>;
    mkdirSync(path.join(root, '.agents/skills/custom-handoff'), { recursive: true });
    writeFileSync(path.join(root, '.agents/skills/custom-handoff/SKILL.md'), '---\nname: custom-handoff\ndescription: Fixture handoff skill\n---\nUse fixture handoff instructions.\n');
    writeFileSync(profilePath, JSON.stringify({ ...profile, capabilitySkills: { handoff: '.agents/skills/custom-handoff/SKILL.md' } }));
    const custom = JSON.parse(run(['route', '--route', 'task-handoff', '--stage', 'prepare', '--entry', 'not-applicable', '--format', 'json', '--no-log'])) as { skillDocs: string[] };
    assert.deepEqual(custom.skillDocs, ['.agents/skills/custom-handoff/SKILL.md']);
    const standalone = JSON.parse(readFileSync(path.join(workflowRoot, 'resources/profiles/default/profile.json'), 'utf8')) as Record<string, unknown>;
    delete standalone.capabilitySkills;
    writeFileSync(profilePath, JSON.stringify(standalone));
    const inherited = JSON.parse(run(['route', '--route', 'task-portable-resume', '--stage', 'resume', '--entry', 'not-applicable', '--format', 'json', '--no-log'])) as { skillDocs: string[] };
    assert.deepEqual(inherited.skillDocs, packet.skillDocs);
    writeFileSync(profilePath, JSON.stringify(profile));
    writeFileSync(path.join(root, 'untracked.bin'), Buffer.from([0, 255, 1]));
    run(['task', 'handoff', '--task', taskId]);
    writeFileSync(path.join(root, 'untracked.bin'), Buffer.from([0, 254, 1]));
    assert.match(run(['task', 'handoff-check', '--task', taskId], 1), /Repository state changed/);
    writeFileSync(path.join(root, 'tracked.txt'), 'first change\n');
    assert.match(run(['task', 'handoff-check', '--task', taskId], 1), /Repository state changed/);
    assert.match(run(['task', 'continue'], 1), /交接需要核对/);
    run(['task', 'handoff', '--task', taskId]);
    writeFileSync(path.join(root, 'tracked.txt'), 'second change\n');
    assert.match(run(['task', 'handoff-check', '--task', taskId], 1), /Repository state changed/);
    run(['task', 'handoff', '--task', taskId]);
    writeFileSync(path.join(directory, 'manifest.md'), manifest.replace('Preserve recovery context', 'Updated recovery goal'));
    assert.match(run(['task', 'handoff-check', '--task', taskId], 1), /Stale artifact: manifest.md/);
    run(['task', 'handoff', '--task', taskId]);
    writeFileSync(path.join(directory, 'handoff.md'), generated);
    assert.match(run(['task', 'handoff-check', '--task', taskId], 1), /edited or is incomplete/);
    writeFileSync(path.join(directory, 'handoff-notes.md'), notes.replace('manifest.md#Scope', '../outside.md'));
    assert.match(run(['task', 'handoff', '--task', taskId], 1), /task-relative path/);
    writeFileSync(path.join(directory, 'handoff-notes.md'), notes.replace('manifest.md#Scope', 'manifest.md#Missing'));
    assert.match(run(['task', 'handoff', '--task', taskId], 1), /Missing section/);
    const longEvidence = 'evidence '.repeat(1500) + 'STOP CONDITION';
    writeFileSync(path.join(directory, 'handoff-notes.md'), notes.replace('Preserve full evidence sections because truncation can remove stop conditions.', longEvidence));
    run(['task', 'handoff', '--task', taskId]);
    const summary = run(['task', 'summary', '--task', taskId]);
    assert.ok(Array.from(summary).length <= 8001);
    assert.match(summary, /Deferred Context/);
    assert.match(summary, /handoff-notes.md#Decisions/);
    assert.match(run(['task', 'summary', '--task', taskId, '--section', 'handoff-notes.md#Decisions']), /STOP CONDITION/);
    const contract = JSON.parse(readFileSync(path.join(workflowRoot, 'resources/examples/verification-contract.sample.json'), 'utf8')) as Record<string, unknown>;
    contract.taskId = taskId;
    writeFileSync(path.join(directory, 'verification.json'), JSON.stringify(contract));
    const json = JSON.parse(run(['task', 'summary', '--task', taskId, '--format', 'json'])) as { sections: Array<{ locator: string }> };
    assert.ok(json.sections.some((section) => section.locator === 'verification.json#testPoints'));
    assert.match(run(['task', 'summary', '--task', taskId, '--section', 'verification.json#testPoints']), /VT1/);
    const notesBeforeRefresh = readFileSync(path.join(directory, 'handoff-notes.md'), 'utf8');
    run(['task', 'handoff', '--task', taskId]);
    assert.equal(readFileSync(path.join(directory, 'handoff-notes.md'), 'utf8'), notesBeforeRefresh);
    run(['task', 'advance', '--task', taskId, '--to', 'Implement', '--action', 'Implement scoped change', '--evidence', 'Inspection completed', '--user-approved']);
    assert.match(run(['task', 'handoff-check', '--task', taskId], 1), /Stale artifact: manifest.md/);
    run(['quality:tasks']);
    const binding = JSON.parse(run(['worktree', 'create', '--task', taskId, '--repository', '.', '--base', 'HEAD', '--target', 'new-file.txt', '--user-approved', '--json'])) as { bindingId: string; baseCommit: string; worktreePath: string };
    const activeManifest = readFileSync(path.join(directory, 'manifest.md'), 'utf8');
    const withBinding = activeManifest + `\n## Worktree Binding\n| Repository | Binding ID | Base Commit | Checkout Mode | Branch |\n|------------|------------|-------------|---------------|--------|\n| workspace | ${binding.bindingId} | ${binding.baseCommit} | detached | none |\n`;
    writeFileSync(path.join(directory, 'manifest.md'), withBinding);
    run(['task', 'handoff', '--task', taskId]);
    run(['task', 'handoff-check', '--task', taskId]);
    const worktreeState = JSON.parse(readFileSync(path.join(directory, 'handoff-state.json'), 'utf8')) as { repositories: Array<{ bindingId: string }> };
    assert.equal(worktreeState.repositories[0]?.bindingId, binding.bindingId);
    writeFileSync(path.join(binding.worktreePath, 'tracked.txt'), 'worktree change\n');
    assert.match(run(['task', 'handoff-check', '--task', taskId], 1), /Repository state changed/);
    writeFileSync(path.join(directory, 'manifest.md'), withBinding.replace(binding.bindingId, 'invalid-binding'));
    assert.match(run(['task', 'handoff', '--task', taskId], 1), /Worktree Binding does not match/);
    assert.equal(markdownSections('## Decisions\n```md\n## Fake\n```\nretained').get('Decisions'), '```md\n## Fake\n```\nretained');
    const bounded = renderTaskSummary({ taskId, warnings: ['warning '.repeat(2000)], sections: [] });
    assert.ok(bounded.length <= 8000);
    assert.match(bounded, /--format json/);
    process.stdout.write('Handoff regression passed: CLI generation, stale artifacts and patches, legacy recovery, references, bounded summaries, verification and skill routing.\n');
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
