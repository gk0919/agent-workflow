import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { workspaceRoot as repositoryRoot } from '../config/workspace-paths.js';
import { loadWorkflowPaths } from '../config/workflow-config.js';

const skillsRoot = loadWorkflowPaths().skillsRoot;
const skillsDisplayPath = path.relative(repositoryRoot, skillsRoot)
  .split(path.sep)
  .join('/');

interface SkillFrontmatter {
  description: string | undefined;
  keys: Array<string | undefined>;
  name: string | undefined;
}

const parseFrontmatter = (content: string): SkillFrontmatter | null => {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return null;
  }

  const body = match[1] ?? '';
  const keys = [...body.matchAll(/^([a-zA-Z][\w-]*):/gm)].map((item) => item[1]);
  const name = body.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  const description = body.match(/^description:\s*(.*)$/m)?.[1]?.trim();
  return { keys, name, description };
};

const findRelativeLinks = (content: string): string[] =>
  [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
  .map((match) => match[1])
  .filter((target): target is string =>
    typeof target === 'string' && !/^(?:https?:|mailto:|#)/i.test(target));

/** Validates every Skill below the configured project Skill root. */
export const main = (): number => {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(skillsRoot)) {
    process.stderr.write(`Skill 检查失败：缺少 ${skillsDisplayPath}。\n`);
    return 1;
  }

  const directories = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const names = new Map<string, string>();

  directories.forEach((directoryName) => {
    const skillDirectory = path.join(skillsRoot, directoryName);
    const skillFile = path.join(skillDirectory, 'SKILL.md');

    if (!existsSync(skillFile)) {
      errors.push(`${directoryName}: 缺少 SKILL.md`);
      return;
    }

    const content = readFileSync(skillFile, 'utf8');
    const frontmatter = parseFrontmatter(content);

    if (!frontmatter) {
      errors.push(`${directoryName}: SKILL.md 缺少合法 YAML frontmatter`);
      return;
    }

    if (!frontmatter.name || !frontmatter.description) {
      errors.push(`${directoryName}: frontmatter 必须包含 name 和 description`);
    }

    if (frontmatter.name !== directoryName) {
      errors.push(`${directoryName}: name 必须与目录名一致，当前为 ${frontmatter.name || '空'}`);
    }

    const duplicateDirectory = frontmatter.name
      ? names.get(frontmatter.name)
      : undefined;
    if (duplicateDirectory) {
      errors.push(`${directoryName}: Skill 名称与 ${duplicateDirectory} 重复`);
    } else if (frontmatter.name) {
      names.set(frontmatter.name, directoryName);
    }

    const extraKeys = frontmatter.keys.filter(
      (key): key is string => Boolean(key) && !['name', 'description'].includes(key ?? ''),
    );
    if (extraKeys.length > 0) {
      warnings.push(`${directoryName}: 建议移除非标准 frontmatter 字段：${extraKeys.join(', ')}`);
    }

    if (content.split(/\r?\n/).length > 500) {
      warnings.push(`${directoryName}: SKILL.md 超过 500 行，建议把详细内容移入 references/`);
    }

    if (/\bTODO\b|TODO:|\[TODO\]/i.test(content)) {
      errors.push(`${directoryName}: SKILL.md 仍包含 TODO 占位内容`);
    }

    findRelativeLinks(content).forEach((target) => {
      const fileTarget = target.split('#')[0];
      if (!fileTarget) {
        return;
      }
      const resolved = path.resolve(skillDirectory, fileTarget);
      if (!existsSync(resolved)) {
        errors.push(`${directoryName}: 引用不存在 ${target}`);
      }
    });

    const openaiFile = path.join(skillDirectory, 'agents', 'openai.yaml');
    if (!existsSync(openaiFile)) {
      warnings.push(`${directoryName}: 缺少推荐的 agents/openai.yaml`);
    } else {
      const metadata = readFileSync(openaiFile, 'utf8');
      const displayName = metadata.match(/^\s{2}display_name:\s*"([^"]+)"\s*$/m)?.[1];
      const shortDescription = metadata.match(/^\s{2}short_description:\s*"([^"]+)"\s*$/m)?.[1];
      const defaultPrompt = metadata.match(/^\s{2}default_prompt:\s*"([^"]+)"\s*$/m)?.[1];

      if (!/^interface:\s*$/m.test(metadata) || !displayName || !shortDescription || !defaultPrompt) {
        errors.push(`${directoryName}: agents/openai.yaml 必须使用 interface.display_name、short_description 和 default_prompt`);
      } else {
        const descriptionLength = Array.from(shortDescription).length;
        if (descriptionLength < 25 || descriptionLength > 64) {
          errors.push(`${directoryName}: short_description 长度必须为 25-64 个字符，当前为 ${descriptionLength}`);
        }
        if (!defaultPrompt.includes(`$${directoryName}`)) {
          errors.push(`${directoryName}: default_prompt 必须显式包含 $${directoryName}`);
        }
      }
    }
  });

  errors.forEach((message) => process.stderr.write(`ERROR: ${message}\n`));
  warnings.forEach((message) => process.stderr.write(`WARNING: ${message}\n`));

  if (errors.length > 0) {
    process.stderr.write(`Skill 检查失败：${errors.length} 个错误。\n`);
    return 1;
  }

  process.stdout.write(`Skill 检查通过：${directories.length} 个 Skill，${warnings.length} 个迁移建议。\n`);
  return 0;
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
