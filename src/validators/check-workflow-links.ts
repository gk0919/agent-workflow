import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  workflowEntryReference,
  workflowRoot,
  workspaceRoot as repositoryRoot,
} from '../config/workspace-paths.js';
import {
  TOOL_TARGETS,
  managedToolTargets,
} from '../adapters/tool-targets.js';
import {
  activeProfilePathFor,
  loadActiveProfile,
  loadWorkflowConfig,
  resolveWorkflowLocator,
  workflowRelativePath,
} from '../config/workflow-config.js';

const workflowConfig = loadWorkflowConfig();
const activeProfile = loadActiveProfile(workflowConfig);

const REQUIRED_GITIGNORE_ENTRIES = [
  `${workflowRelativePath('runtimeRoot')}/*`,
  `!${workflowRelativePath('runtimeRoot')}/README.md`,
  `${workflowRelativePath('tasksRoot')}/`,
  '.worktrees/',
];
const CORE_REQUIRED_PATHS = [
  '.gitignore',
  'AGENTS.md',
  'workflow:docs/START.md',
  'workflow:docs/ROUTER.md',
  'workflow:README.md',
  'workflow:docs/ARCHITECTURE.md',
  'workflow:docs/PORTABILITY.md',
  'workflow:package.json',
  'workflow:dist/bin/agent-workflow.js',
  'workflow:dist/scripts/pack-artifact.js',
  'workflow:dist/tests/contract/cli-regression.js',
  'workflow:dist/src/cli/init.js',
  'workflow:dist/tests/contract/init-regression.js',
  '.agent-workflow/config.json',
  'workflow:resources/routes.json',
  'workflow:resources/profiles/default/profile.json',
  'workflow:resources/profiles/default/evals/route-cases.json',
  'workflow:resources/schemas/workflow-config.schema.json',
  'workflow:resources/schemas/workflow-profile.schema.json',
  'workflow:examples/generic-host/README.md',
  'workflow:examples/generic-host/package.json',
  'workflow:examples/generic-host/AGENTS.md',
  'workflow:examples/generic-host/gitignore.template',
  'workflow:examples/generic-host/.agent-workflow/config.json',
  'workflow:examples/generic-host/.agent-workflow/profile/profile.json',
  'workflow:examples/generic-host/.github/workflows/agent-workflow.yml',
  'workflow:resources/cards/source-lite.md',
  'workflow:resources/cards/micro-change.md',
  'workflow:resources/cards/implementation-approval.md',
  'workflow:resources/cards/intent-defect.md',
  'workflow:resources/cards/intent-requirement.md',
  'workflow:resources/cards/review.md',
  'workflow:resources/cards/verify.md',
  'workflow:resources/cards/worktree.md',
  workflowRelativePath('knowledgeRoot', 'README.md'),
  workflowRelativePath('runtimeRoot', 'README.md'),
  'workflow:resources/policies/security-policy.json',
  'workflow:docs/security-boundaries.md',
  'workflow:resources/policies/retention-policy.json',
  'workflow:docs/retention-policy.md',
  'workflow:resources/schemas/task-manifest.schema.json',
  'workflow:resources/schemas/ci-verification.schema.json',
  'workflow:resources/schemas/verification-contract.schema.json',
  'workflow:resources/schemas/worktree-binding.schema.json',
  'workflow:docs/ci-verification.md',
  'workflow:docs/verification-contract.md',
  'workflow:resources/examples/ci-verification.sample.json',
  'workflow:resources/examples/micro-change-brief.sample.json',
  'workflow:resources/examples/verification-contract.sample.json',
  'workflow:docs/micro-change.md',
  'workflow:docs/analyze.md',
  'workflow:docs/source-capture.md',
  'workflow:dist/src/adapters/tool-targets.js',
  'workflow:resources/hooks/pre-commit',
  'workflow:resources/hooks/commit-msg',
  'workflow:dist/src/config/workflow-config.js',
  'workflow:dist/src/config/workspace-paths.js',
  'workflow:dist/src/validators/check-task-artifacts.js',
  'workflow:dist/src/validators/check-js-diff.js',
  'workflow:dist/tests/contract/check-js-diff-regression.js',
  'workflow:dist/src/validators/install-git-hooks.js',
  'workflow:dist/src/core/task-state.js',
  'workflow:dist/src/core/context-budget.js',
  'workflow:dist/src/core/context-check.js',
  'workflow:dist/src/core/classify-route.js',
  'workflow:dist/src/core/fact-extraction-eval.js',
  'workflow:dist/src/core/ci-verification.js',
  'workflow:dist/tests/contract/ci-verification-regression.js',
  'workflow:dist/src/core/verification-contract.js',
  'workflow:dist/src/core/render-routes.js',
  'workflow:dist/src/core/retention-report.js',
  'workflow:dist/src/core/route.js',
  'workflow:dist/src/core/route-eval.js',
  'workflow:dist/tests/contract/route-regression.js',
  'workflow:dist/src/core/runtime-log.js',
  'workflow:dist/tests/contract/runtime-regression.js',
  'workflow:dist/src/core/security-policy.js',
  'workflow:dist/tests/contract/security-policy-regression.js',
  'workflow:dist/src/core/task-lifecycle.js',
  'workflow:dist/src/core/task-route-guard.js',
  'workflow:dist/tests/contract/task-state-regression.js',
  'workflow:dist/src/core/knowledge-state.js',
  'workflow:dist/src/core/micro-change-guard.js',
  'workflow:dist/src/core/micro-brief.js',
  'workflow:dist/src/core/workflow-input.js',
  'workflow:dist/src/core/profile.js',
  'workflow:dist/tests/contract/profile-regression.js',
  'workflow:dist/src/core/worktree-state.js',
  'workflow:dist/tests/contract/worktree-state-regression.js',
  ...TOOL_TARGETS.map(({ adapter }) => `workflow:${adapter}`),
];
const REQUIRED_PATHS = [
  ...CORE_REQUIRED_PATHS,
  activeProfilePathFor(workflowConfig),
  activeProfile.evals.routeCases,
  ...activeProfile.governance.requiredPaths,
];

const DEPRECATED_REFERENCES = activeProfile.governance.deprecatedReferences;
const EXCLUDED_MARKDOWN_DIRECTORIES = new Set([
  '.git',
  'artifacts',
  'dist',
  'node_modules',
]);

const walkMarkdown = (directory: string): string[] => {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_MARKDOWN_DIRECTORIES.has(entry.name)) {
        return [];
      }
      return walkMarkdown(fullPath);
    }
    return entry.isFile() && entry.name.endsWith('.md') ? [fullPath] : [];
  });
};

const markdownFiles = () => [
  ...walkMarkdown(workflowRoot),
  ...activeProfile.governance.markdownFiles
    .map((relativePath) => path.join(repositoryRoot, relativePath)),
  ...activeProfile.governance.markdownRoots
    .flatMap((relativePath) => walkMarkdown(path.join(repositoryRoot, relativePath))),
].filter(existsSync);

const relativeLinks = (content: string): string[] =>
  [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
  .map((match) => match[1])
  .filter((target): target is string =>
    typeof target === 'string' && !/^(?:https?:|mailto:|#)/i.test(target));

const managedStart = '<!-- ai-workflow:bootstrap:start -->';
const managedEnd = '<!-- ai-workflow:bootstrap:end -->';

const validateManagedBridge = (relativePath: string, errors: string[]): void => {
  const bridgePath = path.join(repositoryRoot, relativePath);
  if (!existsSync(bridgePath)) {
    return;
  }

  const content = readFileSync(bridgePath, 'utf8');
  const startIndex = content.indexOf(managedStart);
  const endIndex = content.indexOf(managedEnd);
  if (startIndex < 0 || endIndex <= startIndex) {
    errors.push(`${relativePath}: 缺少合法的 ai-workflow managed block`);
    return;
  }

  const duplicateStart = content.indexOf(managedStart, startIndex + managedStart.length);
  const duplicateEnd = content.indexOf(managedEnd, endIndex + managedEnd.length);
  if (duplicateStart >= 0 || duplicateEnd >= 0) {
    errors.push(`${relativePath}: 存在重复的 ai-workflow managed block`);
  }

  const managedBlock = content.slice(startIndex, endIndex + managedEnd.length);
  if (!managedBlock.includes(workflowEntryReference)) {
    errors.push(`${relativePath}: managed block 未指向 ${workflowEntryReference}`);
  }
};

/** Validates package resources and the Active Profile's project references. */
export const main = (): number => {
  const errors: string[] = [];

  REQUIRED_PATHS.forEach((relativePath) => {
    if (!existsSync(resolveWorkflowLocator(relativePath, 'required path'))) {
      errors.push(`缺少必需路径：${relativePath}`);
    }
  });

  const gitignorePath = path.join(repositoryRoot, '.gitignore');
  if (existsSync(gitignorePath)) {
    const gitignoreEntries = new Set(
      readFileSync(gitignorePath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#')),
    );
    REQUIRED_GITIGNORE_ENTRIES.forEach((entry) => {
      if (!gitignoreEntries.has(entry)) {
        errors.push(`.gitignore: 缺少本地运行数据忽略项 ${entry}`);
      }
    });
  }

  managedToolTargets().forEach(({ bridgePath }) => {
    validateManagedBridge(bridgePath, errors);
  });

  markdownFiles().forEach((filePath) => {
    const content = readFileSync(filePath, 'utf8');
    const displayPath = path.relative(repositoryRoot, filePath).split(path.sep).join('/');

    DEPRECATED_REFERENCES.forEach((deprecated) => {
      if (content.includes(deprecated)) {
        errors.push(`${displayPath}: 仍引用已废弃路径 ${deprecated}`);
      }
    });

    relativeLinks(content).forEach((target) => {
      let cleanTarget;
      try {
        cleanTarget = decodeURIComponent(target.split('#')[0] ?? '');
      } catch {
        errors.push(`${displayPath}: Markdown 链接包含非法 URL 编码 ${target}`);
        return;
      }
      if (!cleanTarget) {
        return;
      }
      const resolved = path.resolve(path.dirname(filePath), cleanTarget);
      if (!existsSync(resolved)) {
        errors.push(`${displayPath}: Markdown 链接不存在 ${target}`);
      }
    });
  });

  errors.forEach((message) => process.stderr.write(`ERROR: ${message}\n`));
  if (errors.length > 0) {
    process.stderr.write(`工作流链接检查失败：${errors.length} 个错误。\n`);
    return 1;
  }

  process.stdout.write('工作流链接检查通过。\n');
  return 0;
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
