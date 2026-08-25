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
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Ajv2020, ErrorObject } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import type {
  ExecutionArtifactReference,
  ExecutionIntegrationFinding,
  ExecutionIntegrationRequest,
  ExecutionIntegrationResult,
  ExecutionWorkspaceBinding,
  ExecutionWorkspaceBindRequest,
  ExecutionWorkspaceChange,
  ExecutionWorkspaceFinalizeRequest,
  ExecutionWorkspaceRecoveryRequest,
  ExecutionWorkspaceRecoveryResult,
  ExecutionWorkspaceService,
} from '../contracts/execution.js';
import { hashPortableJson } from '../core/execution-plan.js';
import {
  normalizeRepositoryPath,
  normalizeTargetPath,
  repositoryKeyFor,
} from '../core/worktree-state.js';
import { errorMessage } from '../types/guards.js';

const RUN_ID_PATTERN = /^run-[a-z0-9]{16,64}$/;
const NODE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const TARGET_PATH_PATTERN = /^[A-Za-z0-9._{}-]+(?:\/[A-Za-z0-9._{}-]+)*$/;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_AGENT_OWNED_PATHS = 50;
const MAX_INTEGRATED_PATHS = 5000;

type StoredBindingState =
  | 'active'
  | 'conflicted'
  | 'finalized'
  | 'finalizing'
  | 'verification-failed';

interface StoredExecutionWorkspaceBinding extends ExecutionWorkspaceBinding {
  changedPaths: string[];
  commit: string | null;
  conflicts: string[];
  effectId: string | null;
  findings: ExecutionIntegrationFinding[];
  outputArtifact: ExecutionArtifactReference | null;
  purpose: 'agent' | 'integrator';
  state: StoredBindingState;
}

interface ExecutionWorkspaceState {
  bindings: StoredExecutionWorkspaceBinding[];
  runId: string;
  schemaVersion: 1;
  updatedAt: string;
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(moduleDirectory, '..', '..', '..');
const require = createRequire(import.meta.url);
const Ajv2020Constructor = (require('ajv/dist/2020.js') as {
  default: typeof Ajv2020;
}).default;
const addFormats = (require('ajv-formats') as { default: FormatsPlugin }).default;
const stateAjv = new Ajv2020Constructor({
  addUsedSchema: false,
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
});
addFormats(stateAjv);
const stateSchema = JSON.parse(readFileSync(path.join(
  packageRoot,
  'resources',
  'schemas',
  'execution-workspace-state.schema.json',
), 'utf8')) as Record<string, unknown>;
const stateValidator = stateAjv.compile<ExecutionWorkspaceState>(stateSchema);

export interface GitWorkspaceVerificationRequest {
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
  readonly repository: string;
  readonly rootPath: string;
}

export interface GitWorktreeWorkspaceOptions {
  readonly now?: () => Date;
  readonly stateRoot: string;
  readonly verify?: (
    request: GitWorkspaceVerificationRequest,
  ) => Promise<readonly ExecutionIntegrationFinding[]>;
  readonly workspaceRoot: string;
  readonly worktreeRoot: string;
}

interface GitResult {
  readonly error?: Error;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

const isInsideOrEqual = (rootPath: string, targetPath: string): boolean => {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`)
  );
};

const samePath = (left: string, right: string): boolean => {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
};

const git = (argumentsList: readonly string[], cwd: string): GitResult => spawnSync(
  'git',
  ['--no-optional-locks', '--literal-pathspecs', ...argumentsList],
  {
    cwd,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  },
);

const requireGit = (
  argumentsList: readonly string[],
  cwd: string,
  fallback: string,
): string => {
  const result = git(argumentsList, cwd);
  if (result.status !== 0) {
    const detail = (result.error?.message || result.stderr || fallback)
      .trim()
      .replace(/[\u0000-\u001f\u007f]/g, '?')
      .slice(0, 1000);
    throw new Error(detail || fallback);
  }
  return result.stdout.trim();
};

const splitZero = (value: string): string[] => value.split('\u0000').filter(Boolean).sort();

const stableUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();

const normalizeFindings = (value: unknown): ExecutionIntegrationFinding[] => {
  hashPortableJson(value, 256 * 1024);
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error('Verifier findings 必须是最多 100 项的 array');
  }
  return value.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Verifier finding 必须是 object');
    }
    const finding = item as Record<string, unknown>;
    if (
      Object.keys(finding).some((key) => !['code', 'message', 'severity'].includes(key)) ||
      typeof finding.code !== 'string' ||
      finding.code.length < 1 ||
      finding.code.length > 120 ||
      typeof finding.message !== 'string' ||
      finding.message.length < 1 ||
      finding.message.length > 2000 ||
      !['error', 'info', 'warning'].includes(String(finding.severity))
    ) {
      throw new Error('Verifier finding 字段无效');
    }
    return {
      code: finding.code,
      message: finding.message,
      severity: finding.severity as ExecutionIntegrationFinding['severity'],
    };
  });
};

const assertIdentity = (runId: string, nodeId: string, laneId?: string): void => {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error('Execution Workspace runId 非法');
  }
  if (
    nodeId.length > 120 ||
    !NODE_ID_PATTERN.test(nodeId) ||
    (laneId !== undefined && (laneId.length > 120 || !NODE_ID_PATTERN.test(laneId)))
  ) {
    throw new Error('Execution Workspace nodeId/laneId 非法');
  }
};

const assertEffectId = (effectId: string): void => {
  if (
    typeof effectId !== 'string' ||
    effectId.length < 1 ||
    effectId.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(effectId)
  ) {
    throw new Error('Execution Workspace effectId 非法');
  }
};

const bindingIdFor = (request: ExecutionWorkspaceBindRequest): string => [
  request.runId,
  repositoryKeyFor(request.repository),
  request.nodeId,
  request.laneId ?? request.purpose,
].join('/');

const toPublicBinding = (
  binding: StoredExecutionWorkspaceBinding,
): ExecutionWorkspaceBinding => ({
  baseCommit: binding.baseCommit,
  bindingId: binding.bindingId,
  ...(binding.laneId ? { laneId: binding.laneId } : {}),
  nodeId: binding.nodeId,
  ownedPaths: [...binding.ownedPaths],
  repository: binding.repository,
  rootPath: binding.rootPath,
});

const toChange = (binding: StoredExecutionWorkspaceBinding): ExecutionWorkspaceChange => {
  if (!binding.commit || !binding.effectId || !binding.outputArtifact) {
    throw new Error(`Workspace binding ${binding.bindingId} 缺少已确认 change`);
  }
  return {
    baseCommit: binding.baseCommit,
    bindingId: binding.bindingId,
    changedPaths: [...binding.changedPaths],
    commit: binding.commit,
    effectId: binding.effectId,
    outputArtifact: structuredClone(binding.outputArtifact),
    ownedPaths: [...binding.ownedPaths],
    repository: binding.repository,
  };
};

const validateState = (value: unknown, expectedRunId: string): string[] => {
  const findings: string[] = [];
  try {
    hashPortableJson(value, MAX_STATE_BYTES);
  } catch {
    return ['Execution Workspace state 不是受限可移植 JSON'];
  }
  if (!stateValidator(value)) {
    const stableError = (error: ErrorObject): string => {
      const location = error.instancePath || '$';
      return `${location}: ${error.keyword}`;
    };
    findings.push(...(stateValidator.errors ?? []).map(stableError));
    return findings;
  }
  if (value.runId !== expectedRunId) {
    findings.push('Execution Workspace state runId 不匹配');
  }
  const ids = new Set<string>();
  for (const binding of value.bindings) {
    if (
      ids.has(binding.bindingId) ||
      !path.isAbsolute(binding.rootPath) ||
      !COMMIT_PATTERN.test(binding.baseCommit)
    ) {
      findings.push('Execution Workspace binding 字段无效或重复');
      break;
    }
    ids.add(binding.bindingId);
  }
  return findings;
};

/** Node implementation for isolated Git effects; it never edits the caller's main worktree. */
export class GitWorktreeWorkspaceService implements ExecutionWorkspaceService {
  readonly id = 'git-worktree/v1';
  readonly #now: () => Date;
  readonly #stateRoot: string;
  readonly #verify: GitWorktreeWorkspaceOptions['verify'];
  readonly #workspaceRoot: string;
  readonly #worktreeRoot: string;

  constructor(options: GitWorktreeWorkspaceOptions) {
    this.#workspaceRoot = this.#safeRoot(options.workspaceRoot, 'workspaceRoot', false);
    this.#stateRoot = this.#safeRoot(options.stateRoot, 'stateRoot', true);
    this.#worktreeRoot = this.#safeRoot(options.worktreeRoot, 'worktreeRoot', true);
    if (
      !isInsideOrEqual(this.#workspaceRoot, this.#stateRoot) ||
      !isInsideOrEqual(this.#workspaceRoot, this.#worktreeRoot)
    ) {
      throw new Error('Execution Workspace state/worktree root 必须位于 workspaceRoot 内');
    }
    this.#now = options.now ?? (() => new Date());
    this.#verify = options.verify;
  }

  async bind(request: ExecutionWorkspaceBindRequest): Promise<ExecutionWorkspaceBinding> {
    assertIdentity(request.runId, request.nodeId, request.laneId);
    if (request.purpose !== 'agent' && request.purpose !== 'integrator') {
      throw new Error('Execution Workspace purpose 非法');
    }
    const repository = normalizeRepositoryPath(request.repository);
    const ownedPaths = stableUnique(request.ownedPaths.map(normalizeTargetPath));
    const maxOwnedPaths = request.purpose === 'integrator'
      ? MAX_INTEGRATED_PATHS
      : MAX_AGENT_OWNED_PATHS;
    if (
      repository.length > 200 ||
      ownedPaths.length === 0 ||
      ownedPaths.length > maxOwnedPaths ||
      ownedPaths.some((ownedPath) =>
        ownedPath.length > 500 || !TARGET_PATH_PATTERN.test(ownedPath))
    ) {
      throw new Error('Execution Workspace binding 必须声明 ownedPaths');
    }
    const normalizedRequest: ExecutionWorkspaceBindRequest = {
      ...(request.laneId ? { laneId: request.laneId } : {}),
      nodeId: request.nodeId,
      ownedPaths,
      purpose: request.purpose,
      repository,
      runId: request.runId,
    };
    return await this.#withStateLock(request.runId, async () => {
      const state = this.#readState(request.runId);
      const bindingId = bindingIdFor(normalizedRequest);
      const existing = state.bindings.find((binding) => binding.bindingId === bindingId);
      if (existing) {
        if (
          existing.repository !== repository ||
          existing.purpose !== request.purpose ||
          JSON.stringify(existing.ownedPaths) !== JSON.stringify(ownedPaths)
        ) {
          throw new Error(`Execution Workspace binding ${bindingId} 与现有声明不一致`);
        }
        if (!existsSync(existing.rootPath)) {
          throw new Error(`Execution Workspace binding ${bindingId} 的本机路径缺失`);
        }
        return toPublicBinding(existing);
      }

      const repositoryRoot = this.#repositoryRoot(repository);
      const previous = state.bindings.find((binding) => binding.repository === repository);
      const baseCommit = previous?.baseCommit ?? requireGit(
        ['rev-parse', '--verify', 'HEAD^{commit}'],
        repositoryRoot,
        '无法解析 Execution Workspace 基线',
      );
      if (!COMMIT_PATTERN.test(baseCommit)) {
        throw new Error('Execution Workspace 基线 commit 无效');
      }
      const rootPath = this.#bindingPath(normalizedRequest);
      if (existsSync(rootPath)) {
        throw new Error(`Execution Workspace 目标路径已存在：${bindingId}`);
      }
      const bindingParent = path.dirname(rootPath);
      mkdirSync(bindingParent, { recursive: true });
      this.#assertSafeExistingDescendant(
        this.#worktreeRoot,
        bindingParent,
        'Execution Workspace binding parent',
      );
      requireGit(
        ['worktree', 'add', '--detach', rootPath, baseCommit],
        repositoryRoot,
        'Execution Workspace worktree 创建失败',
      );
      const binding: StoredExecutionWorkspaceBinding = {
        baseCommit,
        bindingId,
        changedPaths: [],
        commit: null,
        conflicts: [],
        effectId: null,
        findings: [],
        ...(request.laneId ? { laneId: request.laneId } : {}),
        nodeId: request.nodeId,
        outputArtifact: null,
        ownedPaths,
        purpose: request.purpose,
        repository,
        rootPath,
        state: 'active',
      };
      try {
        state.bindings.push(binding);
        this.#writeState(state);
      } catch (error: unknown) {
        const rollback = git(['worktree', 'remove', rootPath], repositoryRoot);
        if (rollback.status !== 0) {
          throw new Error(
            `Workspace 状态写入失败且 worktree 回滚失败：${errorMessage(error)}`,
          );
        }
        throw error;
      }
      return toPublicBinding(binding);
    });
  }

  async finalize(request: ExecutionWorkspaceFinalizeRequest): Promise<ExecutionWorkspaceChange> {
    assertEffectId(request.effectId);
    return await this.#withStateLock(
      this.#runIdFromBinding(request.binding.bindingId),
      async () => {
        const state = this.#readState(this.#runIdFromBinding(request.binding.bindingId));
        const binding = this.#requireBinding(state, request.binding.bindingId);
        this.#assertBindingMatches(binding, request.binding);
        if (binding.state === 'finalized') {
          if (binding.effectId !== request.effectId) {
            throw new Error('Workspace binding 已由不同 effect 确认');
          }
          return toChange(binding);
        }
        if (binding.state !== 'active' && binding.state !== 'finalizing') {
          throw new Error(`Workspace binding 当前状态不能 finalize：${binding.state}`);
        }
        binding.effectId = request.effectId;
        binding.outputArtifact = structuredClone(request.outputArtifact);
        binding.state = 'finalizing';
        this.#writeState(state);
        return this.#finalizeRepositoryChange(state, binding);
      },
    );
  }

  async recover(request: ExecutionWorkspaceRecoveryRequest): Promise<ExecutionWorkspaceRecoveryResult> {
    assertEffectId(request.effectId);
    return await this.#withStateLock(
      this.#runIdFromBinding(request.binding.bindingId),
      async () => {
        const state = this.#readState(this.#runIdFromBinding(request.binding.bindingId));
        const binding = this.#requireBinding(state, request.binding.bindingId);
        this.#assertBindingMatches(binding, request.binding);
        if (binding.state === 'finalized') {
          if (binding.effectId !== request.effectId) {
            return { message: 'binding 已由其他 effect 确认', status: 'ambiguous' };
          }
          return { change: toChange(binding), status: 'recovered' };
        }
        if (binding.state === 'finalizing' && binding.effectId === request.effectId) {
          try {
            return {
              change: this.#finalizeRepositoryChange(state, binding),
              status: 'recovered',
            };
          } catch (error: unknown) {
            return { message: errorMessage(error), status: 'ambiguous' };
          }
        }
        if (binding.state !== 'active') {
          return { message: `binding 状态为 ${binding.state}`, status: 'ambiguous' };
        }
        const changed = this.#changedPaths(binding.rootPath);
        const head = requireGit(['rev-parse', 'HEAD'], binding.rootPath, '无法读取 worktree HEAD');
        return changed.length === 0 && head === binding.baseCommit
          ? { status: 'ready' }
          : { message: '上次写入未留下可确认结果，Worktree 已变化', status: 'ambiguous' };
      },
    );
  }

  async integrate(request: ExecutionIntegrationRequest): Promise<ExecutionIntegrationResult> {
    assertIdentity(request.runId, request.nodeId);
    assertEffectId(request.effectId);
    const repository = normalizeRepositoryPath(request.repository);
    if (request.changes.length === 0) {
      throw new Error('Integrator 至少需要一个 change');
    }
    if (new Set(request.changes.map(({ bindingId }) => bindingId)).size !== request.changes.length) {
      throw new Error('Integrator change bindingId 不能重复');
    }
    const changedOwners = new Map<string, string>();
    const collisions = new Set<string>();
    for (const change of request.changes) {
      if (change.repository !== repository) {
        throw new Error('Integrator change repository 不一致');
      }
      for (const changedPath of change.changedPaths) {
        const owner = changedOwners.get(changedPath);
        if (owner && owner !== change.bindingId) {
          collisions.add(changedPath);
        } else {
          changedOwners.set(changedPath, change.bindingId);
        }
      }
    }
    const ownedPaths = stableUnique(request.changes.flatMap(({ changedPaths }) => changedPaths));
    const binding = await this.bind({
      nodeId: request.nodeId,
      ownedPaths,
      purpose: 'integrator',
      repository,
      runId: request.runId,
    });
    return await this.#withStateLock(request.runId, async () => {
      const state = this.#readState(request.runId);
      for (const change of request.changes) {
        this.#assertStoredChange(state, change);
      }
      const stored = this.#requireBinding(state, binding.bindingId);
      if (stored.state === 'finalized' && stored.effectId === request.effectId) {
        return this.#integrationResult(stored, 'succeeded');
      }
      if (stored.state === 'conflicted' && stored.effectId === request.effectId) {
        return this.#integrationResult(stored, 'conflicted');
      }
      if (stored.state === 'verification-failed' && stored.effectId === request.effectId) {
        return this.#integrationResult(stored, 'failed');
      }
      if (collisions.size > 0) {
        stored.effectId = request.effectId;
        stored.conflicts = [...collisions].sort();
        stored.state = 'conflicted';
        this.#writeState(state);
        return this.#integrationResult(stored, 'conflicted');
      }
      const currentHead = requireGit(['rev-parse', 'HEAD'], stored.rootPath, '无法读取 Integrator HEAD');
      const currentChanges = this.#changedPaths(stored.rootPath);
      if (stored.state === 'finalizing') {
        if (currentChanges.length > 0 || currentHead === stored.baseCommit) {
          return {
            ...this.#integrationResult(stored, 'failed'),
            findings: [{
              code: 'integration-recovery-required',
              message: 'Integrator 中断于未确认状态，拒绝自动重复 cherry-pick',
              severity: 'error',
            }],
          };
        }
        stored.changedPaths = this.#commitChangedPaths(
          stored.rootPath,
          stored.baseCommit,
          currentHead,
        );
        stored.commit = currentHead;
        stored.state = 'finalized';
        this.#writeState(state);
        return this.#integrationResult(stored, 'succeeded');
      }
      if (stored.state !== 'active' || currentChanges.length > 0 || currentHead !== stored.baseCommit) {
        throw new Error('Integrator Worktree 不是干净基线');
      }
      stored.effectId = request.effectId;
      stored.state = 'finalizing';
      this.#writeState(state);
      for (const change of [...request.changes].sort((left, right) =>
        left.bindingId.localeCompare(right.bindingId))) {
        const cherryPick = git(['cherry-pick', '--no-commit', change.commit], stored.rootPath);
        if (cherryPick.status !== 0) {
          stored.conflicts = this.#unmergedPaths(stored.rootPath);
          stored.findings = [{
            code: 'git-merge-conflict',
            message: 'Git 无法无冲突地集成 change',
            severity: 'error',
          }];
          stored.state = 'conflicted';
          this.#writeState(state);
          return this.#integrationResult(stored, 'conflicted');
        }
      }
      stored.changedPaths = this.#changedPaths(stored.rootPath);
      const findings: ExecutionIntegrationFinding[] = [];
      try {
        requireGit(
          ['diff', '--cached', '--check'],
          stored.rootPath,
          '集成结果未通过 git diff --check',
        );
      } catch (error: unknown) {
        findings.push({
          code: 'git-diff-check-failed',
          message: errorMessage(error),
          severity: 'error',
        });
      }
      if (this.#verify && findings.length === 0) {
        try {
          const reported: unknown = await this.#verify({
            baseCommit: stored.baseCommit,
            changedPaths: [...stored.changedPaths],
            repository,
            rootPath: stored.rootPath,
          });
          findings.push(...normalizeFindings(reported));
        } catch (error: unknown) {
          findings.push({
            code: 'post-merge-verifier-failed',
            message: errorMessage(error),
            severity: 'error',
          });
        }
        const afterVerification = this.#changedPaths(stored.rootPath);
        if (JSON.stringify(afterVerification) !== JSON.stringify(stored.changedPaths)) {
          findings.push({
            code: 'post-merge-verifier-mutated-workspace',
            message: '合并后 Verifier 必须只读，检测到 Workspace 变化',
            severity: 'error',
          });
        }
      }
      stored.findings = findings.map((finding) => ({ ...finding }));
      if (findings.some(({ severity }) => severity === 'error')) {
        stored.state = 'verification-failed';
        this.#writeState(state);
        return this.#integrationResult(stored, 'failed');
      }
      requireGit(
        [
          '-c', 'user.name=agent-workflow',
          '-c', 'user.email=agent-workflow@localhost',
          'commit', '--no-gpg-sign', '-m', `agent-workflow integrate ${request.nodeId}`,
        ],
        stored.rootPath,
        'Integrator commit 创建失败',
      );
      stored.commit = requireGit(['rev-parse', 'HEAD'], stored.rootPath, '无法读取 Integrator commit');
      stored.state = 'finalized';
      this.#writeState(state);
      return this.#integrationResult(stored, 'succeeded');
    });
  }

  #safeRoot(requestedPath: string, label: string, create: boolean): string {
    const resolved = path.resolve(requestedPath);
    if (create) {
      mkdirSync(resolved, { recursive: true });
    }
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new Error(`${label} 必须是已存在目录`);
    }
    if (lstatSync(resolved).isSymbolicLink()) {
      throw new Error(`${label} 不能是 symlink`);
    }
    return realpathSync(resolved);
  }

  #repositoryRoot(repository: string): string {
    const resolved = path.resolve(this.#workspaceRoot, ...repository.split('/'));
    if (
      !isInsideOrEqual(this.#workspaceRoot, resolved) ||
      !existsSync(resolved) ||
      !statSync(resolved).isDirectory()
    ) {
      throw new Error('Execution Workspace repository 不存在或越界');
    }
    this.#assertSafeExistingDescendant(
      this.#workspaceRoot,
      resolved,
      'Execution Workspace repository',
    );
    const root = path.resolve(requireGit(
      ['rev-parse', '--show-toplevel'],
      resolved,
      'Execution Workspace repository 不是 Git 仓库',
    ));
    const realRoot = realpathSync(root);
    if (
      !isInsideOrEqual(this.#workspaceRoot, realRoot) ||
      !samePath(realpathSync(resolved), realRoot)
    ) {
      throw new Error('Execution Workspace repository 必须精确指向 Git 根目录');
    }
    return realRoot;
  }

  #assertSafeExistingDescendant(rootPath: string, targetPath: string, label: string): void {
    if (!isInsideOrEqual(rootPath, targetPath)) {
      throw new Error(`${label} 越界`);
    }
    const relative = path.relative(rootPath, targetPath);
    let current = rootPath;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (!existsSync(current) || lstatSync(current).isSymbolicLink()) {
        throw new Error(`${label} 包含缺失目录或 symlink`);
      }
    }
    if (!isInsideOrEqual(rootPath, realpathSync(targetPath))) {
      throw new Error(`${label} 的真实路径越界`);
    }
  }

  #bindingPath(request: ExecutionWorkspaceBindRequest): string {
    const target = path.resolve(
      this.#worktreeRoot,
      'executions',
      request.runId,
      repositoryKeyFor(request.repository),
      request.nodeId,
      request.laneId ?? request.purpose,
    );
    if (!isInsideOrEqual(this.#worktreeRoot, target)) {
      throw new Error('Execution Workspace binding path 越界');
    }
    return target;
  }

  #stateFile(runId: string): string {
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new Error('Execution Workspace runId 非法');
    }
    return path.join(this.#stateRoot, `${runId}.json`);
  }

  #readState(runId: string): ExecutionWorkspaceState {
    const filePath = this.#stateFile(runId);
    if (!existsSync(filePath)) {
      return {
        bindings: [],
        runId,
        schemaVersion: 1,
        updatedAt: this.#now().toISOString(),
      };
    }
    if (lstatSync(filePath).isSymbolicLink() || statSync(filePath).size > MAX_STATE_BYTES) {
      throw new Error('Execution Workspace state 文件无效');
    }
    const value: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    const findings = validateState(value, runId);
    if (findings.length > 0) {
      throw new Error(findings.join('；'));
    }
    const state = value as ExecutionWorkspaceState;
    this.#validateLocalBindings(state);
    return state;
  }

  #validateLocalBindings(state: ExecutionWorkspaceState): void {
    for (const binding of state.bindings) {
      assertIdentity(state.runId, binding.nodeId, binding.laneId);
      if (
        normalizeRepositoryPath(binding.repository) !== binding.repository ||
        JSON.stringify(binding.ownedPaths.map(normalizeTargetPath).sort()) !==
          JSON.stringify(binding.ownedPaths)
      ) {
        throw new Error('Execution Workspace state repository/ownership 非规范化');
      }
      const expectedBindingId = bindingIdFor({
        ...(binding.laneId ? { laneId: binding.laneId } : {}),
        nodeId: binding.nodeId,
        ownedPaths: binding.ownedPaths,
        purpose: binding.purpose,
        repository: binding.repository,
        runId: state.runId,
      });
      const expectedRoot = this.#bindingPath({
        ...(binding.laneId ? { laneId: binding.laneId } : {}),
        nodeId: binding.nodeId,
        ownedPaths: binding.ownedPaths,
        purpose: binding.purpose,
        repository: binding.repository,
        runId: state.runId,
      });
      if (
        binding.bindingId !== expectedBindingId ||
        !samePath(binding.rootPath, expectedRoot)
      ) {
        throw new Error('Execution Workspace state 包含非确定性 binding 路径');
      }
      if (existsSync(binding.rootPath)) {
        this.#assertSafeExistingDescendant(
          this.#worktreeRoot,
          binding.rootPath,
          'Execution Workspace binding',
        );
      }
    }
  }

  #writeState(state: ExecutionWorkspaceState): void {
    state.updatedAt = this.#now().toISOString();
    const findings = validateState(state, state.runId);
    if (findings.length > 0) {
      throw new Error(findings.join('；'));
    }
    this.#validateLocalBindings(state);
    const filePath = this.#stateFile(state.runId);
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
      renameSync(temporary, filePath);
    } finally {
      if (existsSync(temporary)) {
        unlinkSync(temporary);
      }
    }
  }

  async #withStateLock<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const lockPath = `${this.#stateFile(runId)}.lock`;
    let descriptor: number;
    try {
      descriptor = openSync(lockPath, 'wx');
    } catch {
      throw new Error(`Execution Workspace ${runId} 正在被其他执行者更新`);
    }
    try {
      return await action();
    } finally {
      closeSync(descriptor);
      unlinkSync(lockPath);
    }
  }

  #runIdFromBinding(bindingId: string): string {
    const runId = bindingId.split('/')[0] ?? '';
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new Error('Workspace bindingId 不包含合法 runId');
    }
    return runId;
  }

  #requireBinding(
    state: ExecutionWorkspaceState,
    bindingId: string,
  ): StoredExecutionWorkspaceBinding {
    const binding = state.bindings.find((candidate) => candidate.bindingId === bindingId);
    if (!binding) {
      throw new Error(`Execution Workspace binding 不存在：${bindingId}`);
    }
    return binding;
  }

  #assertBindingMatches(
    stored: StoredExecutionWorkspaceBinding,
    provided: ExecutionWorkspaceBinding,
  ): void {
    if (
      stored.baseCommit !== provided.baseCommit ||
      stored.repository !== provided.repository ||
      !samePath(stored.rootPath, provided.rootPath)
    ) {
      throw new Error('Execution Workspace binding 与持久化状态不一致');
    }
  }

  #assertStoredChange(
    state: ExecutionWorkspaceState,
    provided: ExecutionWorkspaceChange,
  ): void {
    const stored = this.#requireBinding(state, provided.bindingId);
    if (stored.state !== 'finalized' || stored.purpose !== 'agent') {
      throw new Error('Integrator change 尚未由 Agent binding 最终确认');
    }
    const expected = toChange(stored);
    if (
      expected.baseCommit !== provided.baseCommit ||
      expected.commit !== provided.commit ||
      expected.effectId !== provided.effectId ||
      expected.repository !== provided.repository ||
      JSON.stringify(expected.changedPaths) !== JSON.stringify(provided.changedPaths) ||
      JSON.stringify(expected.ownedPaths) !== JSON.stringify(provided.ownedPaths) ||
      expected.outputArtifact.id !== provided.outputArtifact.id ||
      expected.outputArtifact.sha256 !== provided.outputArtifact.sha256 ||
      expected.outputArtifact.byteLength !== provided.outputArtifact.byteLength ||
      expected.outputArtifact.mediaType !== provided.outputArtifact.mediaType
    ) {
      throw new Error('Integrator change 与持久化 Agent binding 不匹配');
    }
  }

  #changedPaths(rootPath: string): string[] {
    const tracked = splitZero(requireGit(
      ['diff', '--no-renames', '--name-only', '-z', 'HEAD'],
      rootPath,
      '无法读取未暂存变更',
    ));
    const staged = splitZero(requireGit(
      ['diff', '--cached', '--no-renames', '--name-only', '-z'],
      rootPath,
      '无法读取已暂存变更',
    ));
    const untracked = splitZero(requireGit(
      ['ls-files', '--others', '--exclude-standard', '-z'],
      rootPath,
      '无法读取未跟踪文件',
    ));
    const ignored = splitZero(requireGit(
      ['status', '--porcelain=v1', '-z', '--ignored=matching'],
      rootPath,
      '无法读取 ignored 文件',
    )).filter((entry) => entry.startsWith('!! '));
    if (ignored.length > 0) {
      throw new Error('Execution Workspace 包含 ignored 写入，拒绝确认 effect');
    }
    const changedPaths = stableUnique(
      [...tracked, ...staged, ...untracked].map(normalizeTargetPath),
    );
    if (changedPaths.length > MAX_INTEGRATED_PATHS) {
      throw new Error('Execution Workspace changed paths 超过上限');
    }
    return changedPaths;
  }

  #commitChangedPaths(rootPath: string, baseCommit: string, commit: string): string[] {
    return splitZero(requireGit(
      ['diff', '--no-renames', '--name-only', '-z', baseCommit, commit],
      rootPath,
      '无法读取 commit changed paths',
    )).map(normalizeTargetPath);
  }

  #unmergedPaths(rootPath: string): string[] {
    return splitZero(requireGit(
      ['diff', '--name-only', '--diff-filter=U', '-z'],
      rootPath,
      '无法读取 merge conflicts',
    )).map(normalizeTargetPath);
  }

  #finalizeRepositoryChange(
    state: ExecutionWorkspaceState,
    binding: StoredExecutionWorkspaceBinding,
  ): ExecutionWorkspaceChange {
    if (!binding.effectId || !binding.outputArtifact) {
      throw new Error('Workspace finalize 缺少 effect/output artifact');
    }
    const head = requireGit(['rev-parse', 'HEAD'], binding.rootPath, '无法读取 Worktree HEAD');
    let changedPaths = this.#changedPaths(binding.rootPath);
    if (head !== binding.baseCommit && changedPaths.length === 0) {
      const commitCount = Number(requireGit(
        ['rev-list', '--count', `${binding.baseCommit}..${head}`],
        binding.rootPath,
        '无法读取 Worktree commit 数量',
      ));
      if (commitCount !== 1) {
        throw new Error('Worktree HEAD 偏离基线且不能唯一恢复 effect commit');
      }
      changedPaths = this.#commitChangedPaths(binding.rootPath, binding.baseCommit, head);
      this.#assertOwned(binding, changedPaths);
      binding.changedPaths = changedPaths;
      binding.commit = head;
      binding.state = 'finalized';
      this.#writeState(state);
      return toChange(binding);
    }
    if (head !== binding.baseCommit) {
      throw new Error('Worktree 同时存在已提交和未提交变化，恢复状态不明确');
    }
    if (changedPaths.length === 0) {
      throw new Error('repository-write effect 没有产生文件变化');
    }
    this.#assertOwned(binding, changedPaths);
    requireGit(['add', '-A', '--', ...changedPaths], binding.rootPath, '无法暂存 Workspace change');
    requireGit(['diff', '--cached', '--check'], binding.rootPath, 'Workspace change 未通过 diff check');
    requireGit(
      [
        '-c', 'user.name=agent-workflow',
        '-c', 'user.email=agent-workflow@localhost',
        'commit', '--no-gpg-sign', '-m', `agent-workflow effect ${binding.nodeId}`,
      ],
      binding.rootPath,
      'Workspace effect commit 创建失败',
    );
    binding.commit = requireGit(['rev-parse', 'HEAD'], binding.rootPath, '无法读取 effect commit');
    binding.changedPaths = changedPaths;
    binding.state = 'finalized';
    this.#writeState(state);
    return toChange(binding);
  }

  #assertOwned(binding: StoredExecutionWorkspaceBinding, changedPaths: readonly string[]): void {
    const owned = new Set(binding.ownedPaths);
    const outside = changedPaths.filter((changedPath) => !owned.has(changedPath));
    if (outside.length > 0) {
      throw new Error(`Workspace change 越出 ownership：${outside.sort().join(', ')}`);
    }
  }

  #integrationResult(
    binding: StoredExecutionWorkspaceBinding,
    status: ExecutionIntegrationResult['status'],
  ): ExecutionIntegrationResult {
    return {
      baseCommit: binding.baseCommit,
      bindingId: binding.bindingId,
      changedPaths: [...binding.changedPaths],
      ...(binding.commit ? { commit: binding.commit } : {}),
      conflicts: [...binding.conflicts],
      findings: binding.findings.map((finding) => ({ ...finding })),
      repository: binding.repository,
      status,
    };
  }
}
