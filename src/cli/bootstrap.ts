import type { ManagedBlockDefinition } from './managed-block.js';

export const BOOTSTRAP_BLOCK: ManagedBlockDefinition = Object.freeze({
  end: '<!-- ai-workflow:bootstrap:end -->',
  start: '<!-- ai-workflow:bootstrap:start -->',
});

export const buildBootstrapBlock = (workflowEntryReference: string): string => [
  BOOTSTRAP_BLOCK.start,
  '## AI Workflow Bootstrap',
  '',
  `处理本仓库中的任何任务前，必须先读取并遵守 \`${workflowEntryReference}\`。`,
  '',
  '此受管区块只负责自动启动工作流；项目约束和任务状态仍由仓库自己的文件管理。',
  BOOTSTRAP_BLOCK.end,
].join('\n');
