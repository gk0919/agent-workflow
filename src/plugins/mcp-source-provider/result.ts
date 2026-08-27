import type { PluginJsonValue } from '../../contracts/json.js';
import type { SourceCaptureResult } from '../../contracts/capabilities.js';

export interface McpSourceToolResult {
  readonly [key: string]: unknown;
  readonly content?: unknown | undefined;
  readonly isError?: boolean | undefined;
  readonly structuredContent?: unknown | undefined;
}

export interface SourceResultContext {
  readonly entry: string;
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
