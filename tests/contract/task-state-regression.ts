import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  readManifestModel,
  transitionManifestContent,
  validateManifestTaskFlow,
} from '../../src/core/task-lifecycle.js';
import type {
  TaskTransitionCommand,
  TaskTransitionOptions,
} from '../../src/core/task-lifecycle.js';
import {
  replaceFileAtomically,
  validateTaskUpdateArtifacts,
  withManifestLock,
} from '../../src/core/task-state.js';
import { errorMessage } from '../../src/types/guards.js';

const fixture = `# Task Manifest

## Identity
- Schema Version: 1
- Task ID: 20260726-direct-state-regression
- Run ID: run-0123456789abcdef
- Source: synthetic
- Type: defect
- Mode: Pair
- State Mode: Portable
- Route: Standard
- Route ID: standard-change
- Status: pending
- Current Stage: Source Capture
- Last Executor: Test
- Last Updated: 2026-07-26T00:00:00.000Z

## Source Record
- Entry Mode: direct
- Type: defect
- SN:
- ID:
- Capture Method: user-pasted
- Captured At: 2026-07-26T00:00:00.000Z
- Freshness: user-provided
- Snapshot: source.md

## Scope
- Goal: regression
- In Scope: lifecycle
- Out of Scope: business

## Repository Matrix
| Repository | Root | Module | Branch | Remote | Allowed Git Actions |
|------------|------|--------|--------|--------|---------------------|
| workspace | \`.\` | workflow | none | none | Inspect |

## Stage Status
| Stage | Status | Artifact / Reason |
|-------|--------|-------------------|
| Source Capture | pending | source.md |
| Intake | pending | |
| PRD | pending | |
| Spec | pending | |
| Plan | pending | |
| Implement | pending | |
| Review | pending | |
| Verify | pending | |
| Git Inspect | pending | |

## Authorization
- Persist Artifacts: allowed
- Git Stage: no
- Commit: no
- Push: no
- PR: no

## Resume
- Last Completed Stage: none
- Next Pending Stage: Source Capture
- Next Action: capture
- Suggested Follow-up: none
- Required Inputs: none
- Known Blockers: none
- Working Tree Notes: none
`;

const transition = (
  content: string,
  command: TaskTransitionCommand,
  options: Omit<TaskTransitionOptions, 'command' | 'updatedAt'> = {},
): string =>
  transitionManifestContent(content, {
    ...options,
    command,
    updatedAt: '2026-07-26T01:00:00.000Z',
  });

export const main = (): number => {
  try {
    assert.deepEqual(validateManifestTaskFlow(readManifestModel(fixture)), []);
    const invalidCalendarDate = fixture.replace(
      '2026-07-26T00:00:00.000Z',
      '2026-02-31T00:00:00.000Z',
    );
    assert.match(
      validateManifestTaskFlow(readManifestModel(invalidCalendarDate)).join('\n'),
      /Last Updated 必须是合法 date-time/,
    );
    assert.throws(
      () => transitionManifestContent(fixture, {
        action: 'capture source',
        command: 'start',
        updatedAt: '2026-02-31T00:00:00.000Z',
      }),
      /updatedAt 必须是合法 date-time/,
    );
    let validatedTaskId = '';
    validateTaskUpdateArtifacts(
      '20260726-direct-state-regression',
      (taskId) => {
        validatedTaskId = taskId;
        return [];
      },
    );
    assert.equal(validatedTaskId, '20260726-direct-state-regression');
    assert.throws(
      () => validateTaskUpdateArtifacts(
        '20260726-direct-state-regression',
        () => ['target task invalid'],
      ),
      /target task invalid/,
    );
    let validatedManifest = '';
    validateTaskUpdateArtifacts(
      '20260726-direct-state-regression',
      (taskId, options) => {
        assert.equal(taskId, '20260726-direct-state-regression');
        validatedManifest = options.manifestContent ?? '';
        return [];
      },
      { manifestContent: fixture },
    );
    assert.equal(validatedManifest, fixture);
    const atomicDirectory = mkdtempSync(path.join(os.tmpdir(), 'task-state-'));
    const atomicManifest = path.join(atomicDirectory, 'manifest.md');
    writeFileSync(atomicManifest, 'original\n', 'utf8');
    replaceFileAtomically(atomicManifest, 'updated\n');
    assert.equal(readFileSync(atomicManifest, 'utf8'), 'updated\n');
    withManifestLock(atomicManifest, () => {
      assert.throws(
        () => withManifestLock(atomicManifest, () => {}),
        /正在被其他执行者更新/,
      );
      assert.equal(existsSync(`${atomicManifest}.lock`), true);
    });
    assert.equal(existsSync(`${atomicManifest}.lock`), false);
    let content = transition(fixture, 'start', { action: 'capture source' });
    assert.equal(readManifestModel(content).status, 'in_progress');

    content = transition(content, 'advance', {
      action: 'structure facts',
      evidence: 'source.md complete',
      to: 'Intake',
    });
    assert.throws(
      () => transition(content, 'advance', {
        action: 'invalid approval',
        evidence: 'intake pending',
        to: 'Spec',
        userApproved: true,
      }),
      /只允许用于转入 Implement/,
    );
    content = transition(content, 'skip', {
      reason: 'low-risk defect',
      stage: 'PRD',
    });
    assert.throws(
      () => transition(content, 'advance', {
        action: 'invalid jump',
        evidence: 'intake complete',
        to: 'Plan',
      }),
      /不能转换/,
    );
    content = transition(content, 'block', { reason: 'needs evidence' });
    assert.equal(readManifestModel(content).status, 'blocked');
    content = transition(content, 'resume', { action: 'evidence provided' });

    const remainingTransitions: Array<[string, string, string]> = [
      ['Spec', 'spec confirmed', 'plan tasks'],
      ['Plan', 'plan complete', 'implement'],
      ['Implement', 'implementation complete', 'review'],
      ['Review', 'review passed', 'verify'],
      ['Verify', 'static checks passed', 'inspect git'],
      ['Git Inspect', 'diff inspected', 'finish'],
    ];
    remainingTransitions.forEach(([to, evidence, action]) => {
      if (to === 'Implement') {
        assert.throws(
          () => transition(content, 'advance', { action, evidence, to }),
          /Implementation Approval Gate/,
        );
      }
      content = transition(content, 'advance', {
        action,
        evidence,
        to,
        userApproved: to === 'Implement',
      });
    });
    content = transition(content, 'complete', {
      evidence: 'git inspect complete',
    });
    const completed = readManifestModel(content);
    assert.equal(completed.status, 'complete');
    assert.equal(completed.currentStage, 'complete');
    assert.deepEqual(validateManifestTaskFlow(completed), []);

    process.stdout.write(
      '任务状态回归检查通过：6 个转换命令、2 个时间戳反例、2 个目标任务校验场景。\n',
    );
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`任务状态回归检查失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
