import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  loadActiveProfile,
  loadWorkflowPaths,
} from '../config/workflow-config.js';
import { loadRoutes } from '../core/context-budget.js';
import {
  readManifestModel,
  validateManifestTaskFlow,
} from '../core/task-lifecycle.js';
import type { ManifestModel } from '../core/task-lifecycle.js';
import {
  validateVerificationContractFile,
} from '../core/verification-contract.js';
import { errorMessage } from '../types/guards.js';

interface ArtifactStage {
  name: string;
  status: string;
}

interface ManifestArtifactData {
  currentStage: string;
  entryMode: string;
  nextAction: string;
  nextPendingStage: string;
  sourceSn: string;
  sourceType: string;
  stages: ArtifactStage[];
  stateMode: string;
  status: string;
  taskId: string;
}

const activeProfile = loadActiveProfile();
const taskModel = activeProfile.taskModel;
const tasksRoot = loadWorkflowPaths().tasksRoot;
const TASK_STATUS_VALUES = new Set(['pending', 'in_progress', 'blocked', 'complete']);
const STAGE_STATUS_VALUES = new Set(['pending', 'in_progress', 'blocked', 'complete', 'skipped']);
const SPEC_STATUS_VALUES = new Set(['draft', 'conditional', 'confirmed']);
const SPEC_LEVEL_VALUES = new Set(['S', 'M', 'L']);
const STATE_MODE_VALUES = new Set(['Conversation', 'Portable']);
const ENTRY_MODE_VALUES = new Set(taskModel.artifactEntryModes);
const SOURCE_TYPE_VALUES = new Set(taskModel.sourceTypes);
const KNOWN_STAGES = new Set(taskModel.knownStages);
const PROVIDER_ENTRY_MODE = taskModel.providerEntryMode;
const SOURCE_CAPTURE_STAGE = taskModel.sourceCaptureStage;
const INTAKE_STAGE = taskModel.intakeStage;
const NONE_VALUES = new Set(['none', '无', 'not applicable', 'n/a']);
const TASK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const verificationContractPolicy = loadRoutes().verificationContract;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const readSection = (content: string, heading: string): string => {
  const headingPattern = new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, 'm');
  const headingMatch = headingPattern.exec(content);
  if (!headingMatch) {
    return '';
  }

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const remainingContent = content.slice(sectionStart);
  const nextHeadingOffset = remainingContent.search(/^##\s/m);
  return nextHeadingOffset < 0
    ? remainingContent
    : remainingContent.slice(0, nextHeadingOffset);
};

const readField = (section: string, label: string): string => {
  const pattern = new RegExp(`^- ${escapeRegExp(label)}:\\s*(.*)$`, 'm');
  return section.match(pattern)?.[1]?.trim() ?? '';
};

const isNone = (value: string): boolean => NONE_VALUES.has(value.trim().toLowerCase());
const isAbsent = (value: string): boolean => value.trim().length === 0 || isNone(value);
const isAbsolutePath = (value: string): boolean =>
  path.posix.isAbsolute(value) || path.win32.isAbsolute(value);

const lineContainsAbsolutePath = (line: string): boolean => {
  const codeSpanValues = [...line.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1])
    .filter((value): value is string => typeof value === 'string');
  return codeSpanValues.some(isAbsolutePath);
};

const readMarkdownTable = (section: string): string[][] => section
  .split(/\r?\n/)
  .filter((line) => /^\s*\|.*\|\s*$/.test(line))
  .map((line) => line
    .trim()
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim()))
  .filter((cells) =>
    cells.length > 1 &&
    !cells.every((cell) => /^-+$/.test(cell)) &&
    cells[0] !== 'Stage' &&
    cells[0] !== 'Repository');

const parseFrontmatter = (content: string): Record<string, string> | null => {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return null;
  }

  return Object.fromEntries(
    (match[1] ?? '')
      .split(/\r?\n/)
      .map((line) => line.match(/^([a-z_]+):\s*(.*)$/))
      .filter((item): item is RegExpMatchArray => Boolean(item))
      .map((item) => [item[1] ?? '', (item[2] ?? '').trim()]),
  ) as Record<string, string>;
};

const listTaskDirectories = (): string[] => {
  if (!existsSync(tasksRoot)) {
    return [];
  }

  return readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort();
};

const listMarkdownFiles = (taskDirectory: string): string[] => readdirSync(taskDirectory)
  .filter((fileName) => fileName.endsWith('.md'))
  .map((fileName) => path.join(taskDirectory, fileName))
  .filter((filePath) => statSync(filePath).isFile());

const validatePortablePaths = (
  taskId: string,
  taskDirectory: string,
  repositoryRows: string[][],
  errors: string[],
  manifestOverride: string | null = null,
): void => {
  repositoryRows.forEach((cells) => {
    const root = cells[1]?.replaceAll('`', '') ?? '';
    if (isAbsolutePath(root)) {
      errors.push(`${taskId}/manifest.md: Repository Matrix Root 必须使用工作区相对路径，当前为 ${root}`);
    }
  });

  listMarkdownFiles(taskDirectory).forEach((filePath) => {
    const content = manifestOverride !== null &&
        path.basename(filePath) === 'manifest.md'
      ? manifestOverride
      : readFileSync(filePath, 'utf8');
    content.split(/\r?\n/).forEach((line, index) => {
      if (/(?:仓库|工作区|Repository|Root)/.test(line) && lineContainsAbsolutePath(line)) {
        const fileName = path.basename(filePath);
        errors.push(`${taskId}/${fileName}:${index + 1}: 仓库位置包含机器绝对路径`);
      }
    });
  });
};

const validateSpec = (
  taskId: string,
  taskDirectory: string,
  manifestData: ManifestArtifactData,
  errors: string[],
): void => {
  const specPath = path.join(taskDirectory, 'spec.md');
  const contractPath = path.join(taskDirectory, 'verification.json');
  if (!existsSync(specPath)) {
    const specStage = manifestData.stages.find(({ name }) => name === 'Spec');
    if (specStage?.status === 'complete') {
      errors.push(`${taskId}: Spec 阶段 complete 但缺少 spec.md`);
    }
    return;
  }

  const frontmatter = parseFrontmatter(readFileSync(specPath, 'utf8'));
  if (!frontmatter) {
    errors.push(`${taskId}/spec.md: 缺少合法 frontmatter`);
    return;
  }

  if (frontmatter.task_id !== taskId) {
    errors.push(`${taskId}/spec.md: task_id 与目录名不一致`);
  }
  if (!ENTRY_MODE_VALUES.has(frontmatter.entry_mode ?? '')) {
    errors.push(`${taskId}/spec.md: entry_mode 非法：${frontmatter.entry_mode || '空'}`);
  }
  if (!SOURCE_TYPE_VALUES.has(frontmatter.source_type ?? '')) {
    errors.push(`${taskId}/spec.md: source_type 非法：${frontmatter.source_type || '空'}`);
  }
  if (!SPEC_LEVEL_VALUES.has(frontmatter.spec_level ?? '')) {
    errors.push(`${taskId}/spec.md: spec_level 非法：${frontmatter.spec_level || '空'}`);
  }
  if (!SPEC_STATUS_VALUES.has(frontmatter.status ?? '')) {
    errors.push(`${taskId}/spec.md: status 非法：${frontmatter.status || '空'}`);
  }
  if (frontmatter.entry_mode !== manifestData.entryMode) {
    errors.push(`${taskId}: manifest 与 spec 的 Entry Mode 不一致`);
  }
  if (frontmatter.source_type !== manifestData.sourceType) {
    errors.push(`${taskId}: manifest 与 spec 的 Source Type 不一致`);
  }
  if (manifestData.entryMode === PROVIDER_ENTRY_MODE &&
      frontmatter.source_sn !== manifestData.sourceSn) {
    errors.push(`${taskId}: manifest 与 spec 的 Source SN 不一致`);
  }

  const specStage = manifestData.stages.find(({ name }) => name === 'Spec');
  if (specStage?.status === 'complete' && frontmatter.status !== 'confirmed') {
    errors.push(`${taskId}: Spec 阶段 complete 时 spec.status 必须为 confirmed`);
  }
  const contractVersion = frontmatter.contract_version || '';
  const hasContract = existsSync(contractPath);
  const createdAtMillis = Date.parse(frontmatter.created_at || '');
  if (Number.isNaN(createdAtMillis)) {
    errors.push(`${taskId}/spec.md: created_at 必须是合法 date-time`);
  }
  const contractRequiredAt = Date.parse(
    verificationContractPolicy.requiredForSpecsCreatedOnOrAfter,
  );
  const contractRequired = !Number.isNaN(createdAtMillis) &&
    createdAtMillis >= contractRequiredAt;
  if (contractRequired && contractVersion !== '1') {
    errors.push(
      `${taskId}/spec.md: 新 Spec 必须声明 contract_version: 1`,
    );
  }
  if (contractVersion && contractVersion !== '1') {
    errors.push(
      `${taskId}/spec.md: contract_version 非法：${contractVersion}`,
    );
  }
  if (contractVersion === '1' && !hasContract) {
    errors.push(
      `${taskId}: spec.contract_version 为 1 但缺少 verification.json`,
    );
  }
  if (!contractVersion && hasContract) {
    errors.push(
      `${taskId}: 存在 verification.json 但 spec.md 未声明 contract_version`,
    );
  }
  if (contractVersion === '1' && hasContract) {
    validateVerificationContractFile(
      contractPath,
      { expectedTaskId: taskId },
    ).forEach((message) =>
      errors.push(`${taskId}/verification.json: ${message}`));
  }
};

const validateSource = (
  taskId: string,
  taskDirectory: string,
  manifestData: ManifestArtifactData,
  errors: string[],
): void => {
  const sourcePath = path.join(taskDirectory, 'source.md');
  if (!existsSync(sourcePath)) {
    errors.push(`${taskId}: 业务任务缺少 source.md`);
    return;
  }

  const sourceContent = readFileSync(sourcePath, 'utf8');
  const identity = readSection(sourceContent, 'Identity');
  const sourceEntryMode = readField(identity, 'Entry Mode');
  const sourceType = readField(identity, 'Type').toLowerCase();
  const sourceSn = readField(identity, 'SN');

  if (sourceEntryMode !== manifestData.entryMode) {
    errors.push(`${taskId}: manifest 与 source 的 Entry Mode 不一致`);
  }
  if (sourceType !== manifestData.sourceType) {
    errors.push(`${taskId}: manifest 与 source 的 Source Type 不一致`);
  }
  if (manifestData.entryMode === PROVIDER_ENTRY_MODE &&
      sourceSn !== manifestData.sourceSn) {
    errors.push(`${taskId}: manifest 与 source 的 Source SN 不一致`);
  }
};

const validateLifecycle = (
  taskId: string,
  manifestData: ManifestArtifactData,
  errors: string[],
): void => {
  const {
    currentStage,
    nextAction,
    nextPendingStage,
    stages,
    status,
  } = manifestData;
  const activeStages = stages.filter(({ status: stageStatus }) => stageStatus === 'in_progress');
  const blockedStages = stages.filter(({ status: stageStatus }) => stageStatus === 'blocked');
  const openStages = stages.filter(({ status: stageStatus }) =>
    ['pending', 'in_progress', 'blocked'].includes(stageStatus));

  if (activeStages.length > 1) {
    errors.push(`${taskId}/manifest.md: 同一时间只能有一个 in_progress 阶段`);
  }

  if (status === 'in_progress') {
    const activeStage = activeStages[0];
    if (activeStages.length !== 1) {
      errors.push(`${taskId}/manifest.md: Status 为 in_progress 时必须且只能有一个 in_progress 阶段`);
    } else if (activeStage && activeStage.name !== currentStage) {
      errors.push(`${taskId}/manifest.md: Current Stage 必须与 in_progress 阶段一致`);
    }
    if (blockedStages.length > 0) {
      errors.push(`${taskId}/manifest.md: Status 为 in_progress 时不能存在 blocked 阶段`);
    }
  }

  if (status === 'blocked') {
    const blockedStage = blockedStages[0];
    if (blockedStages.length !== 1) {
      errors.push(`${taskId}/manifest.md: Status 为 blocked 时必须且只能有一个 blocked 阶段`);
    } else if (blockedStage && blockedStage.name !== currentStage) {
      errors.push(`${taskId}/manifest.md: Current Stage 必须与 blocked 阶段一致`);
    }
    if (activeStages.length > 0) {
      errors.push(`${taskId}/manifest.md: Status 为 blocked 时不能存在 in_progress 阶段`);
    }
  }

  if (status === 'pending') {
    if (activeStages.length > 0 || blockedStages.length > 0) {
      errors.push(`${taskId}/manifest.md: Status 为 pending 时不能存在 in_progress 或 blocked 阶段`);
    }
  }

  if (status === 'complete') {
    if (openStages.length > 0) {
      errors.push(`${taskId}/manifest.md: complete 任务不能存在 pending、in_progress 或 blocked 阶段`);
    }
    if (currentStage !== 'complete') {
      errors.push(`${taskId}/manifest.md: complete 任务的 Current Stage 必须为 complete`);
    }
    if (!isNone(nextPendingStage) || !isNone(nextAction)) {
      errors.push(`${taskId}/manifest.md: complete 任务的 Next Pending Stage 和 Next Action 必须为 none`);
    }
    return;
  }

  const [firstOpenStage] = openStages;
  if (firstOpenStage && nextPendingStage !== firstOpenStage.name) {
    errors.push(`${taskId}/manifest.md: Next Pending Stage 应为 ${firstOpenStage.name}`);
  }
  if (status === 'pending' && firstOpenStage && currentStage !== firstOpenStage.name) {
    errors.push(`${taskId}/manifest.md: pending 任务的 Current Stage 应为 ${firstOpenStage.name}`);
  }
};

const validateTask = (
  taskId: string,
  errors: string[],
  root: string = tasksRoot,
  manifestOverride: string | null = null,
): void => {
  if (!TASK_ID_PATTERN.test(taskId)) {
    errors.push(`${taskId}: 任务目录名只能包含小写字母、数字和连字符`);
    return;
  }
  const taskDirectory = path.join(root, taskId);

  const manifestPath = path.join(taskDirectory, 'manifest.md');
  if (!existsSync(manifestPath)) {
    errors.push(`${taskId}: 缺少 manifest.md`);
    return;
  }

  const manifestContent = manifestOverride === null
    ? readFileSync(manifestPath, 'utf8')
    : manifestOverride;
  let lifecycleModel: ManifestModel | undefined;
  try {
    lifecycleModel = readManifestModel(manifestContent);
    validateManifestTaskFlow(lifecycleModel)
      .forEach((message) =>
        errors.push(`${taskId}/manifest.md: ${message}`));
  } catch (error: unknown) {
    errors.push(`${taskId}/manifest.md: Schema 抽取失败：${errorMessage(error)}`);
  }
  const identity = readSection(manifestContent, 'Identity');
  const sourceRecord = readSection(manifestContent, 'Source Record');
  const stageSection = readSection(manifestContent, 'Stage Status');
  const repositorySection = readSection(manifestContent, 'Repository Matrix');
  const authorization = readSection(manifestContent, 'Authorization');
  const resume = readSection(manifestContent, 'Resume');
  const stages = readMarkdownTable(stageSection)
    .map((cells) => ({ name: cells[0] ?? '', status: cells[1] ?? '' }));
  const repositoryRows = readMarkdownTable(repositorySection);
  const manifestData: ManifestArtifactData = {
    taskId: readField(identity, 'Task ID'),
    stateMode: readField(identity, 'State Mode'),
    status: readField(identity, 'Status'),
    currentStage: readField(identity, 'Current Stage'),
    entryMode: readField(sourceRecord, 'Entry Mode'),
    sourceType: readField(sourceRecord, 'Type').toLowerCase(),
    sourceSn: readField(sourceRecord, 'SN'),
    nextPendingStage: readField(resume, 'Next Pending Stage'),
    nextAction: readField(resume, 'Next Action'),
    stages,
  };
  const hasSourceRecord =
    !isAbsent(manifestData.entryMode) ||
    !isAbsent(manifestData.sourceType);

  if (manifestData.taskId !== taskId) {
    errors.push(`${taskId}/manifest.md: Task ID 与目录名不一致`);
  }
  if (lifecycleModel && lifecycleModel.taskId !== taskId) {
    errors.push(`${taskId}/manifest.md: Schema 抽取的 Task ID 与目录名不一致`);
  }
  if (!STATE_MODE_VALUES.has(manifestData.stateMode)) {
    errors.push(`${taskId}/manifest.md: State Mode 非法：${manifestData.stateMode || '空'}`);
  }
  if (!TASK_STATUS_VALUES.has(manifestData.status)) {
    errors.push(`${taskId}/manifest.md: Status 非法：${manifestData.status || '空'}`);
  }
  if (hasSourceRecord) {
    if (!ENTRY_MODE_VALUES.has(manifestData.entryMode)) {
      errors.push(`${taskId}/manifest.md: Entry Mode 非法：${manifestData.entryMode || '空'}`);
    }
    if (!SOURCE_TYPE_VALUES.has(manifestData.sourceType)) {
      errors.push(`${taskId}/manifest.md: Source Type 非法：${manifestData.sourceType || '空'}`);
    }
    if (manifestData.entryMode === PROVIDER_ENTRY_MODE && !manifestData.sourceSn) {
      errors.push(
        `${taskId}/manifest.md: Provider Entry ${PROVIDER_ENTRY_MODE} 必须记录 SN`,
      );
    }
    const sourceCaptureStage = stages.find(({ name }) => name === SOURCE_CAPTURE_STAGE);
    if (!sourceCaptureStage || sourceCaptureStage.status === 'skipped') {
      errors.push(`${taskId}/manifest.md: 业务任务的 Source Capture 不得缺失或 skipped`);
    }
    const intakeStage = stages.find(({ name }) => name === INTAKE_STAGE);
    if (intakeStage?.status === 'complete' &&
        !existsSync(path.join(taskDirectory, 'intake.md'))) {
      errors.push(`${taskId}: Intake 阶段 complete 但缺少 intake.md`);
    }
    validateSource(taskId, taskDirectory, manifestData, errors);
  }
  if (manifestData.stateMode === 'Portable' && !existsSync(path.join(taskDirectory, 'handoff.md'))) {
    errors.push(`${taskId}: Portable 任务缺少 handoff.md`);
  }
  if (!readField(authorization, 'Git Stage')) {
    errors.push(`${taskId}/manifest.md: Authorization 必须使用 Git Stage 字段`);
  }
  if (readField(authorization, 'Stage')) {
    errors.push(`${taskId}/manifest.md: Authorization 的 Stage 字段已废弃，请使用 Git Stage`);
  }
  if (stages.length === 0) {
    errors.push(`${taskId}/manifest.md: Stage Status 不能为空`);
  }

  const stageNames = new Set<string>();
  stages.forEach(({ name, status }) => {
    if (!KNOWN_STAGES.has(name)) {
      errors.push(`${taskId}/manifest.md: 未知阶段 ${name}`);
    }
    if (stageNames.has(name)) {
      errors.push(`${taskId}/manifest.md: 阶段 ${name} 重复`);
    }
    stageNames.add(name);
    if (!STAGE_STATUS_VALUES.has(status)) {
      errors.push(`${taskId}/manifest.md: 阶段 ${name} 的状态非法：${status || '空'}`);
    }
  });

  validateLifecycle(taskId, manifestData, errors);
  if (hasSourceRecord) {
    validateSpec(taskId, taskDirectory, manifestData, errors);
  }
  validatePortablePaths(
    taskId,
    taskDirectory,
    repositoryRows,
    errors,
    manifestOverride,
  );
};

export const validateTaskArtifactsById = (
  taskId: string,
  {
    manifestContent = null,
    root = tasksRoot,
  }: { manifestContent?: string | null; root?: string } = {},
): string[] => {
  const errors: string[] = [];
  validateTask(taskId, errors, root, manifestContent);
  return errors;
};

export const main = (): number => {
  const errors: string[] = [];
  const taskIds = listTaskDirectories();

  taskIds.forEach((taskId) => validateTask(taskId, errors));

  errors.forEach((message) => process.stderr.write(`ERROR: ${message}\n`));
  if (errors.length > 0) {
    process.stderr.write(`任务产物检查失败：${errors.length} 个错误。\n`);
    return 1;
  }

  process.stdout.write(`任务产物检查通过：${taskIds.length} 个任务。\n`);
  return 0;
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
