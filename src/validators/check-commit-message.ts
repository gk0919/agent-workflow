import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadActiveProfile } from '../config/workflow-config.js';

const FORMAT = /^(feat|fix|docs|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .{4,72}$/;
const VAGUE = /^(?:update|changes|fix|bug|修改|更新|修复问题|改一下|调整)$/i;

export const buildIssueTrackingRule = (profile = loadActiveProfile()) => {
  const config = profile.issueTracking;
  return {
    ...config,
    expression: config.enabled
      ? new RegExp(config.pattern, config.flags || '')
      : null,
  };
};

export const main = (args = process.argv.slice(2)) => {
  const messageFile = args[0];
  if (!messageFile) {
    process.stderr.write('提交信息检查失败：缺少 commit message 文件路径。\n');
    return 1;
  }

  const lines = readFileSync(messageFile, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('#'));
  const subject = lines.find((line) => line.trim())?.trim() ?? '';

  if (/^(?:Merge|Revert|fixup!|squash!)/.test(subject)) {
    return 0;
  }

  if (!FORMAT.test(subject)) {
    process.stderr.write('提交信息格式应为 type(scope): summary，type 使用 feat/fix/docs/refactor/perf/test/build/ci/chore/revert。\n');
    return 1;
  }

  const summary = subject.slice(subject.indexOf(':') + 1).trim();
  if (VAGUE.test(summary)) {
    process.stderr.write('提交信息过于模糊，请说明具体行为变化。\n');
    return 1;
  }

  const commitType = subject.match(/^([a-z]+)/)?.[1] || '';
  const fullMessage = lines.join('\n');
  const issueRule = buildIssueTrackingRule();
  const issueRequired = issueRule.enabled &&
    issueRule.requiredForTypes.includes(commitType);
  if (issueRequired && issueRule.expression &&
      !issueRule.expression.test(fullMessage)) {
    const message = `${commitType} 提交未包含 ${issueRule.label}；` +
      '有任务来源时应补充以便追溯。';
    if (issueRule.enforceEnvironment &&
        process.env[issueRule.enforceEnvironment] === '1') {
      process.stderr.write(`${message}\n`);
      return 1;
    }
    process.stderr.write(`WARNING: ${message}\n`);
  }

  return 0;
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
