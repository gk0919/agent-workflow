const cursorHeader = [
  '---',
  'description: 处理任何任务前先加载仓库的 AI 工作流。',
  'globs:',
  'alwaysApply: true',
  '---',
].join('\n');

interface BaseToolTarget {
  adapter: string;
  name: string;
}

interface SharedToolTarget extends BaseToolTarget {
  bootstrap: 'shared';
}

interface ManagedToolTarget extends BaseToolTarget {
  bootstrap: 'managed';
  bridgePath: string;
  detectPaths: string[];
  header?: string;
}

interface PromptToolTarget extends BaseToolTarget {
  bootstrap: 'prompt';
  manualPrompt: string;
}

export type ToolTarget = ManagedToolTarget | PromptToolTarget | SharedToolTarget;

export const TOOL_TARGETS: readonly ToolTarget[] = Object.freeze([
  {
    name: 'codex',
    adapter: 'resources/adapters/codex.md',
    bootstrap: 'shared',
  },
  {
    name: 'qoder',
    adapter: 'resources/adapters/qoder.md',
    bootstrap: 'shared',
  },
  {
    name: 'trae',
    adapter: 'resources/adapters/trae.md',
    bootstrap: 'shared',
  },
  {
    name: 'claude-code',
    adapter: 'resources/adapters/claude-code.md',
    bootstrap: 'managed',
    bridgePath: 'CLAUDE.md',
    detectPaths: ['CLAUDE.md', '.claude'],
  },
  {
    name: 'cursor',
    adapter: 'resources/adapters/cursor.md',
    bootstrap: 'managed',
    bridgePath: '.cursor/rules/ai-workflow.mdc',
    detectPaths: ['.cursor'],
    header: cursorHeader,
  },
  {
    name: 'github-copilot',
    adapter: 'resources/adapters/github-copilot.md',
    bootstrap: 'managed',
    bridgePath: '.github/copilot-instructions.md',
    detectPaths: ['.github/copilot-instructions.md'],
  },
  {
    name: 'generic',
    adapter: 'resources/adapters/generic-agent.md',
    bootstrap: 'prompt',
    manualPrompt: '本任务请遵守 agent-workflow/docs/START.md：<需求或缺陷>',
  },
]);

export const TOOL_TARGET_NAMES = Object.freeze(TOOL_TARGETS.map(({ name }) => name));

export const getToolTarget = (name: string): ToolTarget | undefined =>
  TOOL_TARGETS.find((target) => target.name === name);

export const managedToolTargets = (): ManagedToolTarget[] =>
  TOOL_TARGETS.filter((target): target is ManagedToolTarget => target.bootstrap === 'managed');
