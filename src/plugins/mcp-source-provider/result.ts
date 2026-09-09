import type { PluginJsonObject, PluginJsonValue } from '../../contracts/json.js';
import type { SourceCaptureResult } from '../../contracts/capabilities.js';
import type { FollowUpExecution } from './chain.js';

export interface McpSourceToolResult {
  readonly [key: string]: unknown;
  readonly content?: unknown | undefined;
  readonly isError?: boolean | undefined;
  readonly structuredContent?: unknown | undefined;
}

export interface SourceResultContext {
  readonly entry: string;
  readonly followUps?: readonly FollowUpExecution[];
  readonly maxTextChars: number;
  readonly now: () => Date;
  readonly reference: string;
  readonly sourceType: string;
  readonly tool: string;
}

interface SanitizationState {
  remainingNodes: number;
  remainingTextChars: number;
  readonly seen: WeakSet<object>;
}

const truncate = (value: string, state: SanitizationState): string => {
  const available = Math.max(0, state.remainingTextChars);
  const result = value.slice(0, available);
  state.remainingTextChars -= result.length;
  return result.length < value.length ? `${result}\n[truncated]` : result;
};

const sanitize = (
  value: unknown,
  state: SanitizationState,
  depth = 0,
): PluginJsonValue => {
  if (state.remainingNodes <= 0) {
    return '[maximum node count reached]';
  }
  state.remainingNodes -= 1;
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return truncate(value, state);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value !== 'object') {
    return null;
  }
  if (depth >= 8) {
    return '[maximum depth reached]';
  }
  if (state.seen.has(value)) {
    return '[circular reference]';
  }
  state.seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitize(item, state, depth + 1));
  }
  const result: Record<string, PluginJsonValue> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    result[key] = sanitize(item, state, depth + 1);
  }
  return result;
};

const textBlocks = (content: unknown): string[] => {
  if (!Array.isArray(content)) {
    return [];
  }
  const result: string[] = [];
  for (const block of content) {
    if (typeof block === 'object' && block !== null &&
        'type' in block && block.type === 'text' &&
        'text' in block && typeof block.text === 'string') {
      result.push(block.text);
    }
  }
  return result;
};

const parseText = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const createSanitizationState = (maxTextChars: number): SanitizationState => ({
  remainingNodes: 1_000,
  remainingTextChars: maxTextChars,
  seen: new WeakSet(),
});

const objectValue = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;

const parseList = (value: unknown): readonly unknown[] => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

const comparableUrl = (value: string): string => value.split(/[?#]/, 1)[0] ?? value;

interface ImageReference {
  readonly end: number;
  readonly start: number;
  readonly url: string;
  readonly alt: string;
}

const imageReferences = (text: string): readonly ImageReference[] => {
  const result: ImageReference[] = [];
  const expression = /!\[([^\]]*)\]\((\S+?)(?:\s+["'][^)]*["'])?\)|<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  for (const match of text.matchAll(expression)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const url = (match[2] ?? match[3])?.trim();
    if (!url) continue;
    result.push({ alt: match[1] ?? '', end, start, url });
  }
  return result;
};

const assetDescriptor = (
  value: unknown,
  index: number,
  kind: 'image' | 'attachment',
): PluginJsonObject | undefined => {
  const object = objectValue(value);
  if (!object) return undefined;
  const url = stringValue(object.url) ?? stringValue(object.finalUrl) ??
    stringValue(object.documentAddress);
  const descriptor: PluginJsonObject = {
    id: `${kind}-${index + 1}`,
    kind,
  };
  for (const key of ['key', 'name', 'title', 'url', 'finalUrl', 'documentAddress']) {
    const item = stringValue(object[key]);
    if (item) descriptor[key] = item;
  }
  if (url) descriptor.url = url;
  return descriptor;
};

const contentSegments = (
  text: string,
  references: readonly ImageReference[],
  referenceAssetIds: readonly string[],
): PluginJsonValue[] => {
  const segments: PluginJsonValue[] = [];
  let cursor = 0;
  references.forEach((reference, index) => {
    if (reference.start > cursor) {
      segments.push({ type: 'text', text: text.slice(cursor, reference.start) });
    }
    segments.push({
      alt: reference.alt,
      assetId: referenceAssetIds[index] ?? `image-ref-${index + 1}`,
      end: reference.end,
      start: reference.start,
      type: 'image',
      url: reference.url,
    });
    cursor = reference.end;
  });
  if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor) });
  return segments;
};

/** Build an additive AI view while keeping the provider's original text untouched. */
const normalizeDocument = (
  value: unknown,
  sourceValues: readonly string[],
): PluginJsonObject | undefined => {
  const object = objectValue(value);
  const text = stringValue(object?.docText);
  if (!text) return undefined;
  const references = imageReferences(text);
  const images = parseList(object?.pictureInfos)
    .slice(0, 100)
    .map((item, index) => assetDescriptor(item, index, 'image'))
    .filter((item): item is PluginJsonObject => item !== undefined);
  const attachments = parseList(object?.attachmentInfos)
    .slice(0, 100)
    .map((item, index) => assetDescriptor(item, index, 'attachment'))
    .filter((item): item is PluginJsonObject => item !== undefined);
  const assets = [...images];
  const imageByPath = new Map<string, PluginJsonObject>();
  for (const asset of images) {
    const url = stringValue(asset.url);
    if (url) imageByPath.set(comparableUrl(url), asset);
  }
  const referenceAssetIds: string[] = [];
  for (const [index, reference] of references.entries()) {
    const existing = imageByPath.get(comparableUrl(reference.url));
    if (!existing) {
      const generated: PluginJsonObject = {
        id: `image-${images.length + index + 1}`,
        kind: 'image',
        url: reference.url,
      };
      assets.push(generated);
      referenceAssetIds.push(generated.id as string);
    } else {
      referenceAssetIds.push(existing.id as string);
    }
  }
  const title = stringValue(object?.docTitle);
  return {
    ...(title ? { title } : {}),
    format: 'markdown-or-html',
    sourceValues: [...sourceValues],
    text,
    images: assets,
    attachments,
    imageReferences: references.map((reference, index) => ({
      assetId: referenceAssetIds[index] ?? `image-ref-${index + 1}`,
      alt: reference.alt,
      end: reference.end,
      start: reference.start,
      url: reference.url,
    })),
    segments: contentSegments(text, references, referenceAssetIds),
  };
};

const parsedResults = (result: McpSourceToolResult): readonly unknown[] => {
  const parsed = textBlocks(result.content).map(parseText);
  if (result.structuredContent !== undefined) parsed.push(result.structuredContent);
  return parsed;
};

const followUpFacts = (followUps: readonly FollowUpExecution[]): unknown =>
  followUps.map((followUp) => ({
    tool: followUp.tool,
    calls: followUp.calls.map((call) => ({
      ...(call.error ? { error: call.error } : {}),
      sourceValues: [...call.sourceValues],
      ...(call.result ? { result: call.result } : {}),
    })),
  }));

/** 把不可信 MCP 结果转换成有界且仅含 JSON 的工作流事实。 */
export const toSourceCaptureResult = (
  result: McpSourceToolResult,
  context: SourceResultContext,
): SourceCaptureResult => {
  const blocks = textBlocks(result.content);
  if (result.isError) {
    const detail = blocks.join('\n').slice(0, 1_000) ||
      'MCP 工具返回 isError=true';
    throw new Error(`MCP 工具 ${context.tool} 执行失败：${detail}`);
  }
  const facts: Record<string, PluginJsonValue> = {
    entry: context.entry,
    reference: context.reference,
    tool: context.tool,
  };
  facts.mcpResult = sanitize(result, createSanitizationState(context.maxTextChars));
  // Preserve every MCP content block (including image, audio and resource
  // blocks). `result` below remains the parsed text-only compatibility view.
  if (result.content !== undefined) {
    facts.content = sanitize(result.content, createSanitizationState(context.maxTextChars));
  }
  if (result.isError !== undefined) {
    facts.isError = sanitize(result.isError, createSanitizationState(context.maxTextChars));
  }
  if (blocks.length > 0) {
    const parsed = blocks.map(parseText);
    facts.result = sanitize(
      parsed.length === 1 ? parsed[0] : parsed,
      createSanitizationState(context.maxTextChars),
    );
  }
  if (result.structuredContent !== undefined) {
    facts.structuredContent = sanitize(
      result.structuredContent,
      createSanitizationState(context.maxTextChars),
    );
  }
  const executions = context.followUps ?? [];
  if (executions.length > 0) {
    facts.followUps = sanitize(
      followUpFacts(executions),
      createSanitizationState(context.maxTextChars),
    );
    const linkedDocuments = executions.flatMap((execution) => execution.calls.flatMap((call) => {
      if (!call.result) return [];
      return parsedResults(call.result)
        .map((value) => normalizeDocument(value, call.sourceValues))
        .filter((value): value is PluginJsonObject => value !== undefined);
    }));
    facts.aiContext = sanitize({
      primary: parsedResults(result)[0] ?? null,
      linkedDocuments,
      relation: 'linked documents retain the original text and image references',
    }, createSanitizationState(context.maxTextChars));
  }
  if (blocks.length === 0 && result.structuredContent === undefined) {
    facts.result = null;
  }
  return Object.freeze({
    capturedAt: context.now().toISOString(),
    facts: Object.freeze(facts),
    sourceId: `${context.entry}:${context.reference}`,
    sourceType: context.sourceType,
  });
};
