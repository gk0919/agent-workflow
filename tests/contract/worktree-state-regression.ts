import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  attachWorktreeBranch,
  createWorktree,
  normalizeRepositoryPath,
  normalizeTargetPath,
  parseArguments,
  parseWorktreeList,
  planWorktree,
  removeWorktree,
  statusWorktrees,
  validateWorktreeState,
} from '../../src/core/worktree-state.js';
import type {
  GitResult,
  WorktreeOperationOptions,
} from '../../src/core/worktree-state.js';
import { errorMessage } from '../../src/types/guards.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const TASK_ID = '20260805-direct-worktree-regression';

interface SimulatedWorktree {
  branch: string | null;
  head: string;
  repositoryDirty: boolean;
  targetDirty: boolean;
  worktreeDirty: boolean;
  worktreeIgnored: boolean;
  worktreePath: string;
}

const createFixture = () => {
  const workspaceDirectory = mkdtempSync(path.join(os.tmpdir(), 'worktree-state-'));
  const repositoryRoot = path.join(workspaceDirectory, 'src', 'example');
  const worktreeRoot = path.join(workspaceDirectory, '.worktrees');
  const stateRoot = path.join(
    workspaceDirectory,
    '.agent-workflow',
    'runtime',
    'worktrees',
  );
  mkdirSync(repositoryRoot, { recursive: true });
  const simulated: SimulatedWorktree = {
    branch: null,
    head: SHA_A,
    repositoryDirty: true,
    targetDirty: false,
    worktreeDirty: false,
    worktreeIgnored: false,
    worktreePath: '',
  };

  const success = (stdout = ''): GitResult => ({ status: 0, stderr: '', stdout });
  const failure = (stderr = 'simulated failure'): GitResult => ({
    status: 1,
    stderr,
    stdout: '',
  });
  const worktreeList = (): string => {
    const records = [
      `worktree ${repositoryRoot}\0HEAD ${SHA_A}\0branch refs/heads/main\0\0`,
    ];
    if (simulated.worktreePath) {
      records.push(
        `worktree ${simulated.worktreePath}\0HEAD ${simulated.head}\0` +
        `${simulated.branch ? `branch refs/heads/${simulated.branch}\0` : 'detached\0'}\0`,
      );
    }
    return records.join('');
  };
  const runGit = (args: string[], cwd: string): GitResult => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return success(`${repositoryRoot}\n`);
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      return success(`${SHA_A}\n`);
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return success(`${simulated.head}\n`);
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      return success(worktreeList());
    }
    if (args[0] === 'status' && samePath(cwd, repositoryRoot)) {
      if (args.includes('--')) {
        return success(simulated.targetDirty ? ' M src/target.js\n' : '');
      }
      return success(simulated.repositoryDirty ? ' M unrelated.js\n' : '');
    }
    if (args[0] === 'status' && samePath(cwd, simulated.worktreePath)) {
      if (args.includes('--ignored=matching')) {
        return success(simulated.worktreeIgnored ? '!! local-output/\n' : '');
      }
      return success(simulated.worktreeDirty ? ' M src/target.js\n' : '');
    }
    if (args[0] === 'worktree' && args[1] === 'add') {
      simulated.worktreePath = args[3] ?? '';
      simulated.head = args[4] ?? '';
      simulated.branch = null;
      mkdirSync(simulated.worktreePath, { recursive: true });
      return success();
    }
    if (args[0] === 'symbolic-ref') {
      return simulated.branch
        ? success(`${simulated.branch}\n`)
        : failure();
    }
    if (args[0] === 'check-ref-format') {
      return success(`${args[2]}\n`);
    }
    if (args[0] === 'switch') {
      simulated.branch = args[2] ?? null;
      return success();
    }
    if (args[0] === 'worktree' && args[1] === 'remove') {
      rmSync(simulated.worktreePath, { recursive: true, force: true });
      simulated.worktreePath = '';
      simulated.branch = null;
      return success();
    }
    return failure(`unexpected git call: ${args.join(' ')}`);
  };

  return {
    context: {
      now: () => '2026-08-05T00:00:00.000Z',
      runGit,
      stateRoot,
      worktreeRoot,
      workspaceDirectory,
    },
    repositoryRoot,
    simulated,
    stateRoot,
    workspaceDirectory,
  };
};

const samePath = (left: string, right: string): boolean =>
  path.resolve(left) === path.resolve(right);

const worktreeOptions = (
  overrides: Partial<WorktreeOperationOptions> = {},
): WorktreeOperationOptions => ({
  task: TASK_ID,
  repository: 'src/example',
  base: 'main',
  targets: ['src/target.js'],
  ...overrides,
});

export const main = (): number => {
  const fixture = createFixture();
  try {
    assert.equal(normalizeRepositoryPath('src/example'), 'src/example');
    assert.equal(normalizeTargetPath('src/target.js'), 'src/target.js');
    assert.throws(() => normalizeRepositoryPath('../outside'), /非法或越界/);
    assert.throws(() => normalizeTargetPath('src/../outside.js'), /非法或越界/);
    assert.throws(
      () => parseArguments(['create', '--task', TASK_ID, '--repository', 'src/example']),
      /至少需要一个 --target/,
    );
    const parsed = parseArguments([
      'create',
      '--task', TASK_ID,
      '--repository', 'src/example',
      '--target', 'src/a.js',
      '--target', 'src/b.js',
      '--user-approved',
    ]);
    assert.deepEqual(parsed.targets, ['src/a.js', 'src/b.js']);
    assert.equal(parsed.userApproved, true);
    assert.throws(
      () => parseArguments(['status', '--task', TASK_ID, '--user-approved']),
      /status 只接受/,
    );

    assert.deepEqual(
      parseWorktreeList(
        `worktree C:/main\0HEAD ${SHA_A}\0branch refs/heads/main\0\0` +
        `worktree C:/task\0HEAD ${SHA_B}\0detached\0\0`,
      ),
      [
        { worktree: 'C:/main', HEAD: SHA_A, branch: 'refs/heads/main' },
        { worktree: 'C:/task', HEAD: SHA_B, detached: true },
      ],
    );

    const plan = planWorktree(worktreeOptions(), fixture.context);
    assert.equal(plan.repositoryDirty, true);
    assert.equal(plan.targetDirty, false);
    assert.equal(plan.ready, true);
    assert.throws(
      () => createWorktree(worktreeOptions(), fixture.context),
      /--user-approved/,
    );

    fixture.simulated.targetDirty = true;
    assert.throws(
      () => createWorktree(
        worktreeOptions({ userApproved: true }),
        fixture.context,
      ),
      /目标文件已有未提交改动/,
    );
    fixture.simulated.targetDirty = false;

    const created = createWorktree(
      worktreeOptions({ userApproved: true }),
      fixture.context,
    );
    assert.equal(created.checkoutMode, 'detached');
    assert.equal(existsSync(created.worktreePath), true);
    const stateFile = path.join(fixture.stateRoot, `${TASK_ID}.json`);
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.deepEqual(validateWorktreeState(state, TASK_ID), []);
    assert.equal(statusWorktrees({ task: TASK_ID }, fixture.context).bindings[0]?.dirty, false);

    assert.throws(
      () => attachWorktreeBranch({
        task: TASK_ID,
        repository: 'src/example',
        branch: 'codex/worktree-regression',
      }, fixture.context),
      /--user-approved/,
    );
    fixture.simulated.worktreeDirty = true;
    const attached = attachWorktreeBranch({
      task: TASK_ID,
      repository: 'src/example',
      branch: 'codex/worktree-regression',
      userApproved: true,
    }, fixture.context);
    assert.equal(attached.branch, 'codex/worktree-regression');
    assert.throws(
      () => removeWorktree({
        task: TASK_ID,
        repository: 'src/example',
        userApproved: true,
      }, fixture.context),
      /未提交改动/,
    );
    fixture.simulated.worktreeDirty = false;
    fixture.simulated.worktreeIgnored = true;
    assert.throws(
      () => removeWorktree({
        task: TASK_ID,
        repository: 'src/example',
        userApproved: true,
      }, fixture.context),
      /ignored 文件/,
    );
    fixture.simulated.worktreeIgnored = false;
    const removed = removeWorktree({
      task: TASK_ID,
      repository: 'src/example',
      userApproved: true,
    }, fixture.context);
    assert.equal(removed.branchPreserved, 'codex/worktree-regression');
    assert.equal(existsSync(stateFile), false);

    const detachedTask = '20260805-direct-detached-commit';
    createWorktree(
      worktreeOptions({ task: detachedTask, userApproved: true }),
      fixture.context,
    );
    fixture.simulated.head = SHA_B;
    assert.throws(
      () => removeWorktree({
        task: detachedTask,
        repository: 'src/example',
        userApproved: true,
      }, fixture.context),
      /必须先创建分支/,
    );

    rmSync(fixture.simulated.worktreePath, { recursive: true, force: true });
    fixture.simulated.worktreePath = '';
    const staleRemoved = removeWorktree({
      task: detachedTask,
      repository: 'src/example',
      userApproved: true,
    }, fixture.context);
    assert.equal(staleRemoved.bindingOnly, true);

    process.stdout.write(
      'Worktree 状态回归检查通过：路径、授权、脏目标、分支和安全删除门禁。\n',
    );
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`Worktree 状态回归检查失败：${errorMessage(error)}\n`);
    return 1;
  } finally {
    rmSync(fixture.workspaceDirectory, { recursive: true, force: true });
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
