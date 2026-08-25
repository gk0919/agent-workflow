import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { PluginJsonValue } from '../contracts/json.js';
import type {
  ExecutionArtifactReference,
  ExecutionEvent,
  ExecutionJournalStore,
} from '../contracts/execution.js';
import {
  hashPortableJson,
  serializeCanonicalJson,
  validateExecutionEvent,
} from '../core/execution-plan.js';
import { errorMessage } from '../types/guards.js';

const RUN_ID_PATTERN = /^run-[a-z0-9]{16,64}$/;
const ARTIFACT_ID_PATTERN = /^artifact-([a-f0-9]{64})$/;
const EVENT_FILE_PATTERN = /^(\d{8})\.json$/;
const MAX_EVENT_FILE_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024;

const isWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const writeImmutableFile = (targetPath: string, content: string): void => {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
  try {
    // A hard link publishes a fully written file and refuses to replace an existing target.
    linkSync(temporaryPath, targetPath);
  } finally {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
  }
};

const ensureSafeDirectory = (
  runDirectory: string,
  directory: string,
  create: boolean,
): string => {
  if (create) {
    mkdirSync(directory, { recursive: true });
  }
  if (!existsSync(directory)) {
    return directory;
  }
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Execution 存储目录类型无效：${path.basename(directory)}`);
  }
  const realDirectory = realpathSync(directory);
  if (!isWithin(runDirectory, realDirectory)) {
    throw new Error('Execution 存储目录越出 Run 根目录');
  }
  return realDirectory;
};

const jsonObject = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Journal 内容必须是 JSON 对象');
  }
  return value as Record<string, unknown>;
};

export const calculateExecutionEventHash = (event: ExecutionEvent): string => {
  const eventWithoutHash = Object.fromEntries(
    Object.entries(event).filter(([key]) => key !== 'eventHash'),
  );
  return hashPortableJson(eventWithoutHash, MAX_EVENT_FILE_BYTES);
};

export interface FileExecutionJournalOptions {
  readonly create?: boolean;
}

/** Node filesystem implementation; event files are immutable and ordered by sequence. */
export class FileExecutionJournalStore implements ExecutionJournalStore {
  readonly runId: string;
  readonly #artifactsDirectory: string;
  readonly #eventsDirectory: string;
  readonly #runDirectory: string;

  constructor(executionsRoot: string, runId: string, options: FileExecutionJournalOptions = {}) {
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new Error('Run ID 格式无效');
    }
    this.runId = runId;
    if (options.create === false && !existsSync(executionsRoot)) {
      throw new Error(`Execution Run 不存在：${runId}`);
    }
    mkdirSync(executionsRoot, { recursive: true });
    const realRoot = realpathSync(executionsRoot);
    const requestedRunDirectory = path.join(realRoot, runId);
    if (!existsSync(requestedRunDirectory)) {
      if (options.create === false) {
        throw new Error(`Execution Run 不存在：${runId}`);
      }
      mkdirSync(requestedRunDirectory);
    }
    this.#runDirectory = realpathSync(requestedRunDirectory);
    if (!isWithin(realRoot, this.#runDirectory)) {
      throw new Error('Execution Run 目录越出 executions 根目录');
    }
    this.#eventsDirectory = path.join(this.#runDirectory, 'events');
    this.#artifactsDirectory = path.join(this.#runDirectory, 'artifacts');
    if (options.create !== false) {
      ensureSafeDirectory(this.#runDirectory, this.#eventsDirectory, true);
      ensureSafeDirectory(this.#runDirectory, this.#artifactsDirectory, true);
    }
  }

  append(event: ExecutionEvent): void {
    const findings = validateExecutionEvent(event);
    if (findings.length > 0) {
      throw new Error(`Execution Event 无效：${findings[0]}`);
    }
    if (event.runId !== this.runId) {
      throw new Error('Execution Event 的 runId 与 Journal 不匹配');
    }
    if (!event.eventHash || event.previousEventHash === undefined) {
      throw new Error('持久化事件必须包含 eventHash 和 previousEventHash');
    }
    if (calculateExecutionEventHash(event) !== event.eventHash) {
      throw new Error('Execution Event hash 校验失败');
    }
    const existing = this.readEvents();
    const expectedSequence = existing.length;
    const previousHash = existing.at(-1)?.eventHash ?? null;
    if (event.sequence !== expectedSequence) {
      throw new Error(`Execution Event sequence 应为 ${expectedSequence}`);
    }
    if (event.previousEventHash !== previousHash) {
      throw new Error('Execution Event previousEventHash 不匹配');
    }
    const previousTimestamp = existing.at(-1)?.timestamp;
    if (previousTimestamp && Date.parse(event.timestamp) < Date.parse(previousTimestamp)) {
      throw new Error('Execution Event timestamp 必须单调不减');
    }
    const eventsDirectory = ensureSafeDirectory(
      this.#runDirectory,
      this.#eventsDirectory,
      true,
    );
    // Sequence-only targets make concurrent append attempts contend on one immutable path.
    const filename = `${String(event.sequence).padStart(8, '0')}.json`;
    writeImmutableFile(
      path.join(eventsDirectory, filename),
      serializeCanonicalJson(event),
    );
  }

  readEvents(): readonly ExecutionEvent[] {
    if (!existsSync(this.#eventsDirectory)) {
      return [];
    }
    const eventsDirectory = ensureSafeDirectory(
      this.#runDirectory,
      this.#eventsDirectory,
      false,
    );
    const filenames = readdirSync(eventsDirectory)
      .filter((filename) => !filename.endsWith('.tmp'))
      .sort();
    const events: ExecutionEvent[] = [];
    let expectedPreviousHash: string | null = null;
    let previousTimestamp: number | undefined;
    for (const filename of filenames) {
      const match = EVENT_FILE_PATTERN.exec(filename);
      if (!match) {
        throw new Error(`Journal 包含非法事件文件：${filename}`);
      }
      const filePath = path.join(eventsDirectory, filename);
      const fileStats = lstatSync(filePath);
      if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
        throw new Error(`Journal 事件文件类型无效：${filename}`);
      }
      if (fileStats.size > MAX_EVENT_FILE_BYTES) {
        throw new Error(`Journal 事件文件超过上限：${filename}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
      } catch (error: unknown) {
        throw new Error(`Journal 事件无法解析：${filename}（${errorMessage(error)}）`);
      }
      const event = jsonObject(parsed) as unknown as ExecutionEvent;
      const findings = validateExecutionEvent(event);
      if (findings.length > 0) {
        throw new Error(`Journal 事件无效：${filename}（${findings[0]}）`);
      }
      if (event.runId !== this.runId || event.sequence !== events.length) {
        throw new Error(`Journal 事件身份或 sequence 不连续：${filename}`);
      }
      if (Number(match[1]) !== event.sequence) {
        throw new Error(`Journal 事件文件名与内容不匹配：${filename}`);
      }
      if (!event.eventHash || event.previousEventHash !== expectedPreviousHash) {
        throw new Error(`Journal 事件 hash 链不连续：${filename}`);
      }
      if (calculateExecutionEventHash(event) !== event.eventHash) {
        throw new Error(`Journal 事件 hash 校验失败：${filename}`);
      }
      const timestamp = Date.parse(event.timestamp);
      if (previousTimestamp !== undefined && timestamp < previousTimestamp) {
        throw new Error(`Journal 事件 timestamp 非单调：${filename}`);
      }
      previousTimestamp = timestamp;
      expectedPreviousHash = event.eventHash;
      events.push(Object.freeze(event));
    }
    return Object.freeze(events);
  }

  readJsonArtifact(reference: ExecutionArtifactReference): PluginJsonValue {
    const match = ARTIFACT_ID_PATTERN.exec(reference.id);
    if (!match || match[1] !== reference.sha256 || reference.mediaType !== 'application/json') {
      throw new Error('Artifact 引用格式或 hash 不匹配');
    }
    const artifactsDirectory = ensureSafeDirectory(
      this.#runDirectory,
      this.#artifactsDirectory,
      false,
    );
    const artifactPath = path.join(artifactsDirectory, `${reference.id}.json`);
    if (!existsSync(artifactPath)) {
      throw new Error(`Artifact 不存在：${reference.id}`);
    }
    const stats = lstatSync(artifactPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Artifact 文件类型无效：${reference.id}`);
    }
    if (stats.size !== reference.byteLength || stats.size > MAX_ARTIFACT_BYTES) {
      throw new Error(`Artifact 字节长度不匹配：${reference.id}`);
    }
    const content = readFileSync(artifactPath, 'utf8');
    const actualHash = createHash('sha256').update(content).digest('hex');
    if (actualHash !== reference.sha256) {
      throw new Error(`Artifact 内容 hash 不匹配：${reference.id}`);
    }
    const value = JSON.parse(content) as PluginJsonValue;
    hashPortableJson(value, MAX_ARTIFACT_BYTES);
    return value;
  }

  writeJsonArtifact(value: PluginJsonValue): ExecutionArtifactReference {
    hashPortableJson(value, MAX_ARTIFACT_BYTES);
    const content = serializeCanonicalJson(value);
    const byteLength = Buffer.byteLength(content, 'utf8');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const id = `artifact-${sha256}`;
    const reference: ExecutionArtifactReference = Object.freeze({
      byteLength,
      id,
      mediaType: 'application/json',
      sha256,
    });
    const artifactsDirectory = ensureSafeDirectory(
      this.#runDirectory,
      this.#artifactsDirectory,
      true,
    );
    const artifactPath = path.join(artifactsDirectory, `${id}.json`);
    if (!existsSync(artifactPath)) {
      writeImmutableFile(artifactPath, content);
    } else {
      this.readJsonArtifact(reference);
    }
    return reference;
  }
}
