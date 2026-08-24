import type { PluginJsonValue } from '../../contracts/json.js';
import type { SourceCaptureResult } from '../../contracts/capabilities.js';

export interface McpSourceToolResult {
  readonly content?: unknown;
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
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

const SIGNED_URL_PARAMETER = /([?&](?:amp;)?(?:access_token|ossaccesskeyid|signature|token|x-amz-credential|x-amz-security-token|x-amz-signature)=)[^&#\s<>"']*/gi;
const AUTHENTICATION_SCHEME = /\b(bearer|basic)\s+[^\s,;<>}"']+/gi;
const TEXT_CREDENTIAL = /(\b(?:access[-_]?token|api[-_]?key|authorization|client[-_]?secret|cookie|password|passwd|private[-_]?key|refresh[-_]?token|secret|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi;
const JSON_WEB_TOKEN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const SENSITIVE_KEY = /^(?:access[-_]?token|api[-_]?key|authorization|client[-_]?secret|cookie|password|passwd|private[-_]?key|refresh[-_]?token|secret|token)$/i;

/** 保留上下文，同时让嵌入的签名 URL 无法在日志或产物中继续使用。 */
const redactSignedUrlParameters = (value: string): string =>
  value.replace(SIGNED_URL_PARAMETER, '$1[redacted]');

const redactSensitiveText = (value: string): string =>
  redactSignedUrlParameters(value)
    .replace(AUTHENTICATION_SCHEME, '$1 [redacted]')
    .replace(TEXT_CREDENTIAL, '$1[redacted]')
    .replace(JSON_WEB_TOKEN, '[redacted]');

const truncate = (value: string, state: SanitizationState): string => {
  const redacted = redactSensitiveText(value);
  const available = Math.max(0, state.remainingTextChars);
  const result = redacted.slice(0, available);
  state.remainingTextChars -= result.length;
  return result.length < redacted.length ? `${result}\n[truncated]` : result;
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
    result[key] = SENSITIVE_KEY.test(key)
      ? '[redacted]'
      : sanitize(item, state, depth + 1);
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

/** 把不可信 MCP 结果转换成有界且仅含 JSON 的工作流事实。 */
export const toSourceCaptureResult = (
  result: McpSourceToolResult,
  context: SourceResultContext,
): SourceCaptureResult => {
  const blocks = textBlocks(result.content);
  if (result.isError) {
    const detail = redactSensitiveText(blocks.join('\n')).slice(0, 1_000) ||
      'MCP 工具返回 isError=true';
    throw new Error(`MCP 工具 ${context.tool} 执行失败：${detail}`);
  }
  const state: SanitizationState = {
    remainingNodes: 1_000,
    remainingTextChars: context.maxTextChars,
    seen: new WeakSet(),
  };
  const facts: Record<string, PluginJsonValue> = {
    entry: context.entry,
    reference: context.reference,
    tool: context.tool,
  };
  if (blocks.length > 0) {
    const parsed = blocks.map(parseText);
    facts.result = sanitize(parsed.length === 1 ? parsed[0] : parsed, state);
  }
  if (result.structuredContent !== undefined) {
    facts.structuredContent = sanitize(result.structuredContent, state);
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
