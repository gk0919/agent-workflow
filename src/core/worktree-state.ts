import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadWorkflowPaths } from '../config/workflow-config.js';
import { workspaceRoot } from '../config/workspace-paths.js';
import { errorMessage, isJsonObject } from '../types/guards.js';

type WorktreeCommand = 'branch' | 'create' | 'plan' | 'remove' | 'status';

export interface WorktreeBinding {
  baseCommit: string;
  baseRef: string;
  bindingId: string;
  branch: string | null;
  checkoutMode: 'branch' | 'detached';
  createdAt: string;
  repository: string;
  repositoryKey: string;
  updatedAt: string;
  worktreePath: string;
}

interface WorktreeState {
  bindings: WorktreeBinding[];
  schemaVersion: 1;
  taskId: string;
  updatedAt: string | null;
}

interface WorktreeListRecord {
  HEAD?: string | true;
  bare?: string | true;
  branch?: string | true;
  detached?: string | true;
  locked?: string | true;
  prunable?: string | true;
  worktree?: string;
}

export interface GitResult {
  error?: Error;
  status: number | null;
  stderr: string;
  stdout: string;
}

type RunGit = (args: string[], cwd: string) => GitResult;

interface WorktreeContext {
  now: () => string;
  runGit: RunGit;
  stateRoot: string;
  worktreeRoot: string;
  workspaceDirectory: string;
}

export interface WorktreeOptions {
  base?: string;
  branch?: string;
  command: WorktreeCommand;
  json: boolean;
  repository?: string;
  targets: string[];
  task: string;
  userApproved: boolean;
}

/** Minimal operation input; parser-only flags are optional for programmatic callers. */
export interface WorktreeOperationOptions {
  base?: string;
  branch?: string;
  repository?: string;
  targets?: string[];
  task: string;
  userApproved?: boolean;
}

interface ResolvedRepository {
  logicalRoot: string;
  repositoryKey: string;
  repositoryRoot: string;
}

interface InspectedBinding extends WorktreeBinding {
  actualBranch: string | null;
  actualState: 'active' | 'missing' | 'missing-path' | 'unregistered-path';
  dirty: boolean | null;
  head: string | null;
  ignored?: boolean;
  pathExists: boolean;
  registered: boolean;
}

interface WorktreePlan {
  action: 'plan';
  baseCommit: string;
  baseRef: string;
  existingBinding: string | null;
  ready: boolean;
  registeredAtTarget: boolean;
  repository: string;
  repositoryDirty: boolean;
  repositoryKey: string;
  targetDirty: boolean;
  targetExists: boolean;
  targets: string[];
  taskId: string;
  worktreePath: string;
}

interface WorktreeStatus {
  action: 'status';
  bindings: InspectedBinding[];
  taskId: string;
}

interface WorktreeMutation {
  action: 'branch' | 'create' | 'remove';
  bindingId: string;
  bindingOnly?: boolean;
  branch?: string | null;
  branchPreserved?: string | null;
  repository: string;
  worktreePath: string;
  [key: string]: unknown;
}

type WorktreeResult = WorktreeMutation | WorktreePlan | WorktreeStatus;

const TASK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const MUTATING_COMMANDS = new Set<WorktreeCommand>(['create', 'branch', 'remove']);
const COMMANDS = new Set<WorktreeCommand>(['plan', 'create', 'status', 'branch', 'remove']);
const MAX_BINDINGS = 50;
const MAX_TARGETS = 200;
const STATE_FIELDS = new Set(['schemaVersion', 'taskId', 'updatedAt', 'bindings']);
const BINDING_FIELDS = new Set([
  'bindingId',
  'repository',
  'repositoryKey',
  'worktreePath',
  'baseRef',
  'baseCommit',
  'checkoutMode',
  'branch',
  'createdAt',
  'updatedAt',
]);

export const defaultWorktreeRoot = path.join(workspaceRoot, '.worktrees');
export const defaultStateRoot = path.join(loadWorkflowPaths().runtimeRoot, 'worktrees');

const normalizeDisplayPath = (filePath: string): string => filePath
  .split(path.sep)
  .join('/');

const samePath = (left: string, right: string): boolean => {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
};

const isInsideOrEqual = (rootPath: string, targetPath: string): boolean => {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === '' || (
    !path.isAbsolute(relativePath) &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`)
  );
};

function assertTaskId(taskId: unknown): asserts taskId is string {
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId) || taskId.length > 120) {
    throw new Error('--task 只能包含小写字母、数字和连字符，且不超过 120 字符');
  }
}

const isValidDateTime = (value: unknown): value is string => typeof value === 'string' &&
  value.length <= 40 && !Number.isNaN(Date.parse(value));

export const normalizeRepositoryPath = (repository: unknown): string => {
  if (typeof repository !== 'string' || !repository || repository.length > 500 ||
      repository !== repository.trim() || repository.includes('\0') ||
      repository.includes('\\') || path.isAbsolute(repository)) {
    throw new Error('--repository 必须使用工作区内的规范相对路径');
  }
  if (repository === '.') {
    return repository;
  }
  const segments = repository.split('/');
  if (segments.some((segment) =>
    !segment || segment === '.' || segment === '..' ||
    !SAFE_PATH_SEGMENT_PATTERN.test(segment))) {
    throw new Error('--repository 包含非法或越界路径片段');
  }
  return segments.join('/');
};

export const normalizeTargetPath = (target: unknown): string => {
  if (typeof target !== 'string' || !target || target.length > 1000 ||
      target !== target.trim() || /[\u0000-\u001f\u007f]/.test(target) ||
      target.includes('\\') || path.isAbsolute(target)) {
    throw new Error('--target 必须使用仓库内的规范相对路径');
  }
  const segments = target.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('--target 包含非法或越界路径片段');
  }
  return segments.join('/');
};

export const repositoryKeyFor = (repository: string): string => repository === '.'
  ? 'workspace'
  : repository.split('/').join('--');

const validateRefInput = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value || value.length > 200 ||
      value.startsWith('-') || /[\u0000-\u001f\u007f\s]/.test(value)) {
    throw new Error(`${label} 不是安全的 Git ref`);
  }
  return value;
};

export const parseWorktreeList = (output: string): WorktreeListRecord[] => {
  const records: WorktreeListRecord[] = [];
  let record: WorktreeListRecord = {};
  output.split('\0').forEach((entry) => {
    if (!entry) {
      if (record.worktree) {
        records.push(record);
      }
      record = {};
      return;
    }
    const separator = entry.indexOf(' ');
    const key = separator < 0 ? entry : entry.slice(0, separator);
    const value = separator < 0 ? true : entry.slice(separator + 1);
    if (key === 'worktree' && typeof value === 'string') {
      record.worktree = value;
    } else if (key === 'HEAD' || key === 'branch' ||
        key === 'locked' || key === 'prunable' || key === 'bare' ||
        key === 'detached') {
      record[key] = value;
    }
  });
  if (record.worktree) {
    records.push(record);
  }
  return records;
};

const defaultRunGit: RunGit = (args, cwd) => spawnSync(
  'git',
  ['--no-optional-locks', '--literal-pathspecs', ...args],
  {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
    windowsHide: true,
  },
);

const gitFailureMessage = (result: GitResult, fallback: string): string => {
  const detail = (result.error?.message || result.stderr || '')
    .trim()
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '?')
    .slice(0, 1000);
  return detail || fallback;
};

const requireGitSuccess = (result: GitResult, fallback: string): string => {
  if (result.status !== 0) {
    throw new Error(gitFailureMessage(result, fallback));
  }
  return (result.stdout || '').trim();
};

const createContext = (overrides: Partial<WorktreeContext> = {}): WorktreeContext => ({
  now: () => new Date().toISOString(),
  runGit: defaultRunGit,
  stateRoot: defaultStateRoot,
  worktreeRoot: defaultWorktreeRoot,
  workspaceDirectory: workspaceRoot,
  ...overrides,
});

const resolveRepository = (
  repository: unknown,
  context: WorktreeContext,
): ResolvedRepository => {
  const logicalRoot = normalizeRepositoryPath(repository);
  const resolvedRoot = path.resolve(
    context.workspaceDirectory,
    ...logicalRoot.split('/'),
  );
  if (!isInsideOrEqual(context.workspaceDirectory, resolvedRoot) ||
      !existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    throw new Error(`目标仓库不存在或越界：${logicalRoot}`);
  }
  const result = context.runGit(['rev-parse', '--show-toplevel'], resolvedRoot);
  const actualRoot = path.resolve(requireGitSuccess(
    result,
    `目标路径不是 Git 仓库：${logicalRoot}`,
  ));
  if (!samePath(realpathSync(resolvedRoot), realpathSync(actualRoot))) {
    throw new Error(`--repository 必须精确指向 Git 仓库根：${logicalRoot}`);
  }
  if (!isInsideOrEqual(realpathSync(context.workspaceDirectory), realpathSync(actualRoot))) {
    throw new Error(`目标仓库不在当前工作区内：${logicalRoot}`);
  }
  return {
    logicalRoot,
    repositoryKey: repositoryKeyFor(logicalRoot),
    repositoryRoot: actualRoot,
  };
};

const stateFileFor = (taskId: string, context: WorktreeContext): string => {
  assertTaskId(taskId);
  const resolvedWorkspace = path.resolve(context.workspaceDirectory);
  const resolvedStateRoot = path.resolve(context.stateRoot);
  if (!isInsideOrEqual(resolvedWorkspace, resolvedStateRoot)) {
    throw new Error('worktree 状态目录越界');
  }
  let existingAncestor = resolvedStateRoot;
  while (!existsSync(existingAncestor)) {
    const parentPath = path.dirname(existingAncestor);
    if (parentPath === existingAncestor) {
      throw new Error('无法解析 worktree 状态目录');
    }
    existingAncestor = parentPath;
  }
  if (!isInsideOrEqual(
    realpathSync(resolvedWorkspace),
    realpathSync(existingAncestor),
  )) {
    throw new Error('worktree 状态目录通过链接指向工作区外部');
  }
  if (existsSync(resolvedStateRoot) && lstatSync(resolvedStateRoot).isSymbolicLink()) {
    throw new Error('worktree 状态目录不能是符号链接');
  }
  return path.join(resolvedStateRoot, `${taskId}.json`);
};

const worktreePathFor = (
  taskId: string,
  repositoryKey: string,
  context: WorktreeContext,
): string => {
  assertTaskId(taskId);
  const resolvedWorkspace = path.resolve(context.workspaceDirectory);
  const resolvedWorktreeRoot = path.resolve(context.worktreeRoot);
  const targetPath = path.resolve(resolvedWorktreeRoot, taskId, repositoryKey);
  if (!isInsideOrEqual(resolvedWorkspace, resolvedWorktreeRoot) ||
      !isInsideOrEqual(resolvedWorktreeRoot, targetPath)) {
    throw new Error('worktree 目标路径越界');
  }
  if (existsSync(resolvedWorktreeRoot) && !isInsideOrEqual(
    realpathSync(resolvedWorkspace),
    realpathSync(resolvedWorktreeRoot),
  )) {
    throw new Error('worktree 根目录通过链接指向工作区外部');
  }
  return targetPath;
};

const assertManagedBindingPath = (
  taskId: string,
  binding: WorktreeBinding,
  context: WorktreeContext,
): void => {
  const expectedKey = repositoryKeyFor(binding.repository);
  const expectedBindingId = `${taskId}/${expectedKey}`;
  const expectedPath = worktreePathFor(taskId, expectedKey, context);
  if (binding.repositoryKey !== expectedKey ||
      binding.bindingId !== expectedBindingId ||
      !samePath(binding.worktreePath, expectedPath)) {
    throw new Error(`worktree 绑定路径或标识与任务不一致：${binding.repository}`);
  }
};

const assertManagedParent = (worktreePath: string, context: WorktreeContext): void => {
  const parentPath = path.dirname(worktreePath);
  const realWorkspace = realpathSync(context.workspaceDirectory);
  const realWorktreeRoot = realpathSync(context.worktreeRoot);
  const realParent = realpathSync(parentPath);
  if (!isInsideOrEqual(realWorkspace, realWorktreeRoot) ||
      !isInsideOrEqual(realWorktreeRoot, realParent)) {
    throw new Error('worktree 父目录通过链接越出托管范围');
  }
};

export const validateWorktreeState = (state: unknown, expectedTaskId = ''): string[] => {
  const errors: string[] = [];
  if (!isJsonObject(state)) {
    return ['worktree state 必须是对象'];
  }
  if (state.schemaVersion !== 1) {
    errors.push('schemaVersion 必须为 1');
  }
  Object.keys(state)
    .filter((field) => !STATE_FIELDS.has(field))
    .forEach((field) => errors.push(`worktree state 包含未知字段：${field}`));
  const stateTaskId = typeof state.taskId === 'string' ? state.taskId : '';
  if (!TASK_ID_PATTERN.test(stateTaskId)) {
    errors.push('taskId 非法');
  } else if (expectedTaskId && state.taskId !== expectedTaskId) {
    errors.push('taskId 与状态文件不一致');
  }
  if (!Array.isArray(state.bindings)) {
    errors.push('bindings 必须是数组');
    return errors;
  }
  if (state.bindings.length > MAX_BINDINGS) {
    errors.push(`bindings 不能超过 ${MAX_BINDINGS} 项`);
  }
  if (!isValidDateTime(state.updatedAt)) {
    errors.push('updatedAt 必须是合法 date-time');
  }
  const repositories = new Set<string>();
  const bindingIds = new Set<string>();
  state.bindings.forEach((binding, index) => {
    if (!isJsonObject(binding)) {
      errors.push(`bindings[${index}] 必须是对象`);
      return;
    }
    Object.keys(binding)
      .filter((field) => !BINDING_FIELDS.has(field))
      .forEach((field) =>
        errors.push(`bindings[${index}] 包含未知字段：${field}`));
    try {
      const repository = normalizeRepositoryPath(binding.repository);
      const expectedKey = repositoryKeyFor(repository);
      if (binding.repositoryKey !== expectedKey) {
        errors.push(`bindings[${index}].repositoryKey 与 repository 不一致`);
      }
      if (binding.bindingId !== `${stateTaskId}/${expectedKey}`) {
        errors.push(`bindings[${index}].bindingId 与 task/repository 不一致`);
      }
    } catch (error: unknown) {
      errors.push(`bindings[${index}].repository: ${errorMessage(error)}`);
    }
    const bindingId = typeof binding.bindingId === 'string' ? binding.bindingId : '';
    const repositoryValue = typeof binding.repository === 'string' ? binding.repository : '';
    if (!bindingId || bindingIds.has(bindingId)) {
      errors.push(`bindings[${index}].bindingId 缺失或重复`);
    }
    if (repositories.has(repositoryValue)) {
      errors.push(`bindings[${index}].repository 重复`);
    }
    repositories.add(repositoryValue);
    bindingIds.add(bindingId);
    const worktreePath = typeof binding.worktreePath === 'string' ? binding.worktreePath : '';
    if (!path.isAbsolute(worktreePath)) {
      errors.push(`bindings[${index}].worktreePath 必须是本机绝对路径`);
    }
    const baseCommit = typeof binding.baseCommit === 'string' ? binding.baseCommit : '';
    if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) {
      errors.push(`bindings[${index}].baseCommit 非法`);
    }
    try {
      validateRefInput(binding.baseRef, `bindings[${index}].baseRef`);
    } catch (error: unknown) {
      errors.push(errorMessage(error));
    }
    if (typeof binding.checkoutMode !== 'string' ||
        !['detached', 'branch'].includes(binding.checkoutMode)) {
      errors.push(`bindings[${index}].checkoutMode 非法`);
    }
    if (binding.checkoutMode === 'detached' && binding.branch !== null) {
      errors.push(`bindings[${index}].branch 必须为 null`);
    }
    if (binding.checkoutMode === 'branch' && !binding.branch) {
      errors.push(`bindings[${index}].branch 缺失`);
    } else if (binding.checkoutMode === 'branch' && typeof binding.branch === 'string') {
      try {
        validateRefInput(binding.branch, `bindings[${index}].branch`);
        if (binding.branch.includes('@{')) {
          errors.push(`bindings[${index}].branch 不接受 reflog 选择器`);
        }
      } catch (error: unknown) {
        errors.push(errorMessage(error));
      }
    }
    if (!isValidDateTime(binding.createdAt) ||
        !isValidDateTime(binding.updatedAt)) {
      errors.push(`bindings[${index}] 时间戳非法`);
    }
  });
  return errors;
};

const emptyState = (taskId: string): WorktreeState => ({
  schemaVersion: 1,
  taskId,
  updatedAt: null,
  bindings: [],
});

const readState = (taskId: string, context: WorktreeContext): WorktreeState => {
  const filePath = stateFileFor(taskId, context);
  if (!existsSync(filePath)) {
    return emptyState(taskId);
  }
  if (lstatSync(filePath).isSymbolicLink() || !lstatSync(filePath).isFile()) {
    throw new Error('worktree 状态文件必须是普通文件');
  }
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error: unknown) {
    throw new Error(`无法读取 worktree 状态：${errorMessage(error)}`);
  }
  const errors = validateWorktreeState(state, taskId);
  if (errors.length > 0) {
    throw new Error(`worktree 状态非法：${errors.join('；')}`);
  }
  return state as WorktreeState;
};

const writeState = (state: WorktreeState, context: WorktreeContext): void => {
  const errors = validateWorktreeState(state, state.taskId);
  if (errors.length > 0) {
    throw new Error(`拒绝写入非法 worktree 状态：${errors.join('；')}`);
  }
  const filePath = stateFileFor(state.taskId, context);
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
    throw new Error('拒绝写入符号链接 worktree 状态文件');
  }
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    renameSync(temporaryPath, filePath);
  } finally {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
  }
};

const withStateLock = <T>(
  taskId: string,
  context: WorktreeContext,
  action: () => T,
): T => {
  const filePath = stateFileFor(taskId, context);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, 'wx');
  } catch (error: unknown) {
    if (isJsonObject(error) && error.code === 'EEXIST') {
      throw new Error(`任务 ${taskId} 的 worktree 状态正在被其他执行者更新`);
    }
    throw error;
  }
  try {
    return action();
  } finally {
    closeSync(descriptor);
    unlinkSync(lockPath);
  }
};

const listRepositoryWorktrees = (
  repositoryRoot: string,
  context: WorktreeContext,
): WorktreeListRecord[] => parseWorktreeList(
  requireGitSuccess(
    context.runGit(['worktree', 'list', '--porcelain', '-z'], repositoryRoot),
    '无法读取 Git worktree 列表',
  ),
);

const resolveBaseCommit = (
  base: string | undefined,
  repositoryRoot: string,
  context: WorktreeContext,
) => {
  const baseRef = validateRefInput(base || 'HEAD', '--base');
  const result = context.runGit(
    ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`],
    repositoryRoot,
  );
  const baseCommit = requireGitSuccess(result, `无法解析基线：${baseRef}`);
  if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) {
    throw new Error(`基线不是合法 commit：${baseRef}`);
  }
  return { baseCommit, baseRef };
};

const readDirtyState = (
  repositoryRoot: string,
  targets: string[],
  context: WorktreeContext,
) => {
  const repositoryStatus = requireGitSuccess(
    context.runGit(
      ['status', '--porcelain=v1', '--untracked-files=all'],
      repositoryRoot,
    ),
    '无法读取仓库状态',
  );
  const targetStatus = targets.length === 0 ? '' : requireGitSuccess(
    context.runGit(
      [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--ignored=matching',
        '--',
        ...targets,
      ],
      repositoryRoot,
    ),
    '无法读取目标文件状态',
  );
  return {
    repositoryDirty: Boolean(repositoryStatus),
    targetDirty: Boolean(targetStatus),
  };
};

const bindingFor = (state: WorktreeState, repository: string): WorktreeBinding | undefined =>
  state.bindings.find(
  (binding) => binding.repository === repository,
);

export const planWorktree = (
  options: WorktreeOperationOptions,
  overrides: Partial<WorktreeContext> = {},
): WorktreePlan => {
  const context = createContext(overrides);
  assertTaskId(options.task);
  const repository = resolveRepository(options.repository, context);
  const targets = [...new Set((options.targets || []).map(normalizeTargetPath))];
  if (targets.length > MAX_TARGETS) {
    throw new Error(`--target 不能超过 ${MAX_TARGETS} 项`);
  }
  const base = resolveBaseCommit(options.base, repository.repositoryRoot, context);
  const worktreePath = worktreePathFor(
    options.task,
    repository.repositoryKey,
    context,
  );
  const state = readState(options.task, context);
  const existingBinding = bindingFor(state, repository.logicalRoot) || null;
  const worktrees = listRepositoryWorktrees(repository.repositoryRoot, context);
  const registeredAtTarget = worktrees.some((item) =>
    typeof item.worktree === 'string' && samePath(item.worktree, worktreePath));
  const dirty = readDirtyState(repository.repositoryRoot, targets, context);
  const targetExists = existsSync(worktreePath);
  return {
    action: 'plan',
    taskId: options.task,
    repository: repository.logicalRoot,
    repositoryKey: repository.repositoryKey,
    baseRef: base.baseRef,
    baseCommit: base.baseCommit,
    targets,
    repositoryDirty: dirty.repositoryDirty,
    targetDirty: dirty.targetDirty,
    targetExists,
    registeredAtTarget,
    existingBinding: existingBinding?.bindingId || null,
    worktreePath,
    ready: targets.length > 0 && !dirty.targetDirty && !targetExists &&
      !registeredAtTarget && !existingBinding,
  };
};

const assertApproved = (options: WorktreeOperationOptions, action: string): void => {
  if (!options.userApproved) {
    throw new Error(`${action} 是独立 Git 写操作，必须提供 --user-approved`);
  }
};

export const createWorktree = (
  options: WorktreeOperationOptions,
  overrides: Partial<WorktreeContext> = {},
): WorktreeMutation => {
  const context = createContext(overrides);
  assertApproved(options, 'create');
  if (!options.targets?.length) {
    throw new Error('create 至少需要一个 --target，用于检查既有目标改动');
  }
  return withStateLock(options.task, context, () => {
    const plan = planWorktree(options, context);
    if (!plan.ready) {
      if (plan.targetDirty) {
        throw new Error('目标文件已有未提交改动；禁止自动 stash 或搬运 patch');
      }
      throw new Error('worktree 创建前检查未通过，请先运行 plan 查看冲突');
    }
    mkdirSync(path.dirname(plan.worktreePath), { recursive: true });
    assertManagedParent(plan.worktreePath, context);
    requireGitSuccess(
      context.runGit(
        ['worktree', 'add', '--detach', plan.worktreePath, plan.baseCommit],
        path.resolve(context.workspaceDirectory, ...plan.repository.split('/')),
      ),
      'Git worktree 创建失败',
    );
    const state = readState(options.task, context);
    const createdAt = context.now();
    const binding: WorktreeBinding = {
      bindingId: `${options.task}/${plan.repositoryKey}`,
      repository: plan.repository,
      repositoryKey: plan.repositoryKey,
      worktreePath: plan.worktreePath,
      baseRef: plan.baseRef,
      baseCommit: plan.baseCommit,
      checkoutMode: 'detached',
      branch: null,
      createdAt,
      updatedAt: createdAt,
    };
    try {
      state.bindings.push(binding);
      state.updatedAt = createdAt;
      writeState(state, context);
    } catch (error: unknown) {
      const rollback = context.runGit(
        ['worktree', 'remove', plan.worktreePath],
        path.resolve(context.workspaceDirectory, ...plan.repository.split('/')),
      );
      if (rollback.status !== 0) {
        throw new Error(
          `绑定状态写入失败且自动回滚失败：${errorMessage(error)}；` +
          gitFailureMessage(rollback, '请人工核对 worktree'),
        );
      }
      throw error;
    }
    return {
      action: 'create',
      ...binding,
    };
  });
};

const inspectBinding = (
  taskId: string,
  binding: WorktreeBinding,
  context: WorktreeContext,
): InspectedBinding => {
  assertManagedBindingPath(taskId, binding, context);
  const repository = resolveRepository(binding.repository, context);
  const registered = Boolean(listRepositoryWorktrees(
    repository.repositoryRoot,
    context,
  ).find((item) => typeof item.worktree === 'string' &&
    samePath(item.worktree, binding.worktreePath)));
  const pathExists = existsSync(binding.worktreePath);
  if (!registered || !pathExists) {
    const actualState = !registered && !pathExists
      ? 'missing'
      : registered
        ? 'missing-path'
        : 'unregistered-path';
    return {
      ...binding,
      actualState,
      registered,
      pathExists,
      dirty: null,
      head: null,
      actualBranch: null,
    };
  }
  const head = requireGitSuccess(
    context.runGit(['rev-parse', 'HEAD'], binding.worktreePath),
    '无法读取 worktree HEAD',
  );
  const status = requireGitSuccess(
    context.runGit(
      ['status', '--porcelain=v1', '--untracked-files=all'],
      binding.worktreePath,
    ),
    '无法读取 worktree 状态',
  );
  const ignoredStatus = requireGitSuccess(
    context.runGit(
      ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'],
      binding.worktreePath,
    ),
    '无法读取 worktree ignored 文件状态',
  );
  const ignored = ignoredStatus
    .split(/\r?\n/)
    .some((line) => line.startsWith('!! '));
  const branchResult = context.runGit(
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    binding.worktreePath,
  );
  if (![0, 1].includes(branchResult.status ?? -1)) {
    throw new Error(gitFailureMessage(branchResult, '无法读取 worktree 分支'));
  }
  return {
    ...binding,
    actualState: 'active',
    registered,
    pathExists,
    dirty: Boolean(status),
    ignored,
    head,
    actualBranch: branchResult.status === 0 ? (branchResult.stdout || '').trim() : null,
  };
};

export const statusWorktrees = (
  options: WorktreeOperationOptions,
  overrides: Partial<WorktreeContext> = {},
): WorktreeStatus => {
  const context = createContext(overrides);
  assertTaskId(options.task);
  const state = readState(options.task, context);
  const repository = options.repository
    ? normalizeRepositoryPath(options.repository)
    : '';
  const bindings = state.bindings
    .filter((binding) => !repository || binding.repository === repository)
    .map((binding) => inspectBinding(options.task, binding, context));
  if (repository && bindings.length === 0) {
    throw new Error(`任务未绑定仓库 worktree：${repository}`);
  }
  return {
    action: 'status',
    taskId: options.task,
    bindings,
  };
};

export const attachWorktreeBranch = (
  options: WorktreeOperationOptions,
  overrides: Partial<WorktreeContext> = {},
): WorktreeMutation => {
  const context = createContext(overrides);
  assertApproved(options, 'branch');
  const branch = validateRefInput(options.branch, '--branch');
  if (branch.includes('@{')) {
    throw new Error('--branch 不接受 reflog 选择器');
  }
  return withStateLock(options.task, context, () => {
    const repository = normalizeRepositoryPath(options.repository);
    const state = readState(options.task, context);
    const binding = bindingFor(state, repository);
    if (!binding) {
      throw new Error(`任务未绑定仓库 worktree：${repository}`);
    }
    const inspected = inspectBinding(options.task, binding, context);
    if (inspected.actualState !== 'active') {
      throw new Error('绑定的 worktree 不存在，禁止创建分支');
    }
    if (inspected.actualBranch) {
      throw new Error(`worktree 已位于分支：${inspected.actualBranch}`);
    }
    requireGitSuccess(
      context.runGit(['check-ref-format', '--branch', branch], binding.worktreePath),
      `分支名非法：${branch}`,
    );
    requireGitSuccess(
      context.runGit(['switch', '-c', branch], binding.worktreePath),
      `无法创建分支：${branch}`,
    );
    const updatedAt = context.now();
    binding.checkoutMode = 'branch';
    binding.branch = branch;
    binding.updatedAt = updatedAt;
    state.updatedAt = updatedAt;
    try {
      writeState(state, context);
    } catch (error: unknown) {
      throw new Error(
        `分支 ${branch} 已创建，但本机绑定状态更新失败：${errorMessage(error)}`,
      );
    }
    return {
      action: 'branch',
      bindingId: binding.bindingId,
      repository,
      branch,
      worktreePath: binding.worktreePath,
    };
  });
};

export const removeWorktree = (
  options: WorktreeOperationOptions,
  overrides: Partial<WorktreeContext> = {},
): WorktreeMutation => {
  const context = createContext(overrides);
  assertApproved(options, 'remove');
  return withStateLock(options.task, context, () => {
    const repository = normalizeRepositoryPath(options.repository);
    const state = readState(options.task, context);
    const binding = bindingFor(state, repository);
    if (!binding) {
      throw new Error(`任务未绑定仓库 worktree：${repository}`);
    }
    const inspected = inspectBinding(options.task, binding, context);
    const persistRemoval = () => {
      state.bindings = state.bindings.filter(
        (item) => item.bindingId !== binding.bindingId,
      );
      if (state.bindings.length === 0) {
        unlinkSync(stateFileFor(options.task, context));
      } else {
        state.updatedAt = context.now();
        writeState(state, context);
      }
    };
    if (inspected.actualState === 'missing') {
      persistRemoval();
      return {
        action: 'remove',
        bindingId: binding.bindingId,
        repository,
        bindingOnly: true,
        branchPreserved: binding.branch,
        worktreePath: binding.worktreePath,
      };
    }
    if (inspected.actualState !== 'active') {
      throw new Error(
        'worktree 路径与 Git 注册状态不一致；禁止隐式 prune 或删除现有目录',
      );
    }
    if (inspected.dirty) {
      throw new Error('worktree 存在未提交改动，禁止删除');
    }
    if (inspected.ignored) {
      throw new Error('worktree 存在 ignored 文件，删除会丢失本地数据');
    }
    if (!inspected.actualBranch && inspected.head !== binding.baseCommit) {
      throw new Error('detached worktree 含基线后的提交，必须先创建分支');
    }
    const repositoryRoot = resolveRepository(repository, context).repositoryRoot;
    requireGitSuccess(
      context.runGit(['worktree', 'remove', binding.worktreePath], repositoryRoot),
      'Git worktree 删除失败',
    );
    try {
      persistRemoval();
    } catch (error: unknown) {
      throw new Error(
        `Git worktree 已删除，但本机绑定清理失败：${errorMessage(error)}`,
      );
    }
    return {
      action: 'remove',
      bindingId: binding.bindingId,
      repository,
      branchPreserved: inspected.actualBranch,
      worktreePath: binding.worktreePath,
    };
  });
};

export const parseArguments = (args: string[]): WorktreeOptions => {
  const [command, ...rest] = args;
  if (!command || !COMMANDS.has(command as WorktreeCommand)) {
    throw new Error(
      'Usage: workflow:worktree <plan|create|status|branch|remove> ' +
      '--task <id> [--repository <path>] [--base <ref>] ' +
      '[--target <path> ...] [--branch <name>] [--user-approved] [--json]',
    );
  }
  const options: Partial<WorktreeOptions> & Pick<WorktreeOptions, 'command' | 'json' | 'targets' | 'userApproved'> = {
    command: command as WorktreeCommand,
    targets: [],
    userApproved: false,
    json: false,
  };
  const valueOptions = new Set(['--task', '--repository', '--base', '--branch']);
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--user-approved') {
      options.userApproved = true;
      continue;
    }
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument && (argument === '--target' || valueOptions.has(argument))) {
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} 缺少值`);
      }
      if (argument === '--target') {
        options.targets.push(value);
      } else {
        const key = argument.slice(2) as 'base' | 'branch' | 'repository' | 'task';
        if (options[key]) {
          throw new Error(`${argument} 不能重复`);
        }
        options[key] = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  assertTaskId(options.task);
  if (command === 'status') {
    if (options.base || options.branch || options.targets.length > 0 ||
        options.userApproved) {
      throw new Error('status 只接受 --task、--repository 和 --json');
    }
  } else if (!options.repository) {
    throw new Error(`${command} 必须提供 --repository`);
  }
  if (command === 'branch' && !options.branch) {
    throw new Error('branch 必须提供 --branch');
  }
  if (command === 'create' && options.targets.length === 0) {
    throw new Error('create 至少需要一个 --target，用于检查既有目标改动');
  }
  if (options.targets.length > MAX_TARGETS) {
    throw new Error(`--target 不能超过 ${MAX_TARGETS} 项`);
  }
  if (command !== 'branch' && options.branch) {
    throw new Error('--branch 只允许用于 branch 命令');
  }
  if (!['plan', 'create'].includes(command) &&
      (options.base || options.targets.length > 0)) {
    throw new Error('--base 和 --target 只允许用于 plan/create');
  }
  if (!MUTATING_COMMANDS.has(options.command) && options.userApproved) {
    throw new Error('--user-approved 只允许用于 create/branch/remove');
  }
  return options as WorktreeOptions;
};

const formatResult = (result: WorktreeResult): string => {
  if (result.action === 'plan') {
    return [
      `Worktree Plan: ${result.taskId}/${result.repositoryKey}`,
      `- Repository: ${result.repository}`,
      `- Base: ${result.baseRef} (${result.baseCommit})`,
      `- Target: ${normalizeDisplayPath(result.worktreePath)}`,
      `- Targets: ${result.targets.join(', ') || '未提供'}`,
      `- Repository Dirty: ${result.repositoryDirty ? 'yes' : 'no'}`,
      `- Target Dirty: ${result.targetDirty ? 'yes' : 'no'}`,
      `- Ready: ${result.ready ? 'yes' : 'no'}`,
    ].join('\n');
  }
  if (result.action === 'status') {
    const lines = [`Worktree Status: ${result.taskId}`];
    if (result.bindings.length === 0) {
      lines.push('- Bindings: none');
    }
    result.bindings.forEach((binding) => {
      lines.push(
        `- ${binding.repository}: ${binding.actualState}, ` +
        `branch=${binding.actualBranch || 'detached'}, ` +
        `dirty=${binding.dirty === null ? 'unknown' : binding.dirty ? 'yes' : 'no'}, ` +
        `ignored=${binding.ignored === undefined ? 'unknown' : binding.ignored ? 'yes' : 'no'}, ` +
        `path=${normalizeDisplayPath(binding.worktreePath)}`,
      );
    });
    return lines.join('\n');
  }
  return [
    `Worktree ${result.action}: ${result.bindingId}`,
    `- Repository: ${result.repository}`,
    result.branch ? `- Branch: ${result.branch}` : null,
    result.branchPreserved ? `- Branch Preserved: ${result.branchPreserved}` : null,
    result.bindingOnly ? '- Binding Only: yes' : null,
    `- Path: ${normalizeDisplayPath(result.worktreePath)}`,
  ].filter(Boolean).join('\n');
};

export const main = (
  args = process.argv.slice(2),
  overrides: Partial<WorktreeContext> = {},
): number => {
  const options = parseArguments(args);
  let result: WorktreeResult;
  switch (options.command) {
    case 'plan': result = planWorktree(options, overrides); break;
    case 'create': result = createWorktree(options, overrides); break;
    case 'status': result = statusWorktrees(options, overrides); break;
    case 'branch': result = attachWorktreeBranch(options, overrides); break;
    case 'remove': result = removeWorktree(options, overrides); break;
  }
  process.stdout.write(
    options.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatResult(result)}\n`,
  );
  return 0;
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  try {
    process.exitCode = main();
  } catch (error: unknown) {
    process.stderr.write(`Worktree 操作失败：${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
