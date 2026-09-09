import type { PluginJsonValue } from '../../contracts/json.js';
import type { McpSourceConnection, McpSourceTool, McpSourceToolRequest } from './index.js';
import type { McpSourceFollowUp, McpSourceFollowUpMapping } from './options.js';
import type { McpSourceToolResult } from './result.js';

export interface FollowUpExecution {
  readonly calls: readonly FollowUpCall[];
  readonly tool: string;
}

export interface FollowUpCall {
  readonly result?: McpSourceToolResult;
  readonly sourceValues: readonly string[];
  readonly error?: string;
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const collectText = (value: unknown, result: string[] = [], depth = 0): readonly string[] => {
  if (depth > 8 || value === null || value === undefined) return result;
  if (typeof value === 'string') {
    result.push(value);
    return result;
  }
  if (typeof value !== 'object') return result;
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, result, depth + 1);
    return result;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'data' && isObject(value) && value.type === 'image') continue;
    collectText(item, result, depth + 1);
  }
  return result;
};

const textSources = (result: McpSourceToolResult): readonly string[] => {
  const sources = new Set<string>();
  for (const text of collectText(result.content)) sources.add(text);
  for (const text of collectText(result.structuredContent)) sources.add(text);
  return [...sources];
};

const findMatches = (
  sources: readonly string[],
  mapping: McpSourceFollowUpMapping,
): readonly string[] => {
  const matches = new Set<string>();
  for (const source of sources) {
    const expression = new RegExp(mapping.pattern, 'g');
    for (const match of source.matchAll(expression)) {
      const value = match[0]?.trim();
      if (value && value.length <= 2_048) matches.add(value);
    }
  }
  return [...matches];
};

const buildCalls = (
  followUp: McpSourceFollowUp,
  result: McpSourceToolResult,
): readonly Readonly<Record<string, PluginJsonValue>>[] => {
  const sources = textSources(result);
  const mappingMatches = Object.entries(followUp.argumentMappings).map(
    ([argument, mapping]) => ({ argument, values: findMatches(sources, mapping) }),
  );
  const callCount = Math.min(
    followUp.maxCalls,
    Math.max(...mappingMatches.map(({ values }) => values.length), 0),
  );
  const calls: Readonly<Record<string, PluginJsonValue>>[] = [];
  for (let index = 0; index < callCount; index += 1) {
    const argumentsValue: Record<string, PluginJsonValue> = { ...(followUp.staticArguments ?? {}) };
    for (const { argument, values } of mappingMatches) {
      const value = values[index] ?? values[0];
      if (value !== undefined) argumentsValue[argument] = value;
    }
    calls.push(Object.freeze(argumentsValue));
  }
  return calls;
};

const toolByName = (tools: readonly McpSourceTool[], name: string): McpSourceTool => {
  const tool = tools.find(({ name: toolName }) => toolName === name);
  if (!tool) throw new Error(`MCP 服务未提供已配置工具：${name}`);
  return tool;
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);

/** Execute configured follow-up calls without changing the primary response. */
export const executeFollowUps = async (
  followUps: readonly McpSourceFollowUp[] | undefined,
  primary: McpSourceToolResult,
  tools: readonly McpSourceTool[],
  connection: McpSourceConnection,
  timeoutMs: number,
): Promise<readonly FollowUpExecution[]> => {
  if (!followUps || followUps.length === 0) return [];
  const executions: FollowUpExecution[] = [];
  let input = primary;
  for (const followUp of followUps) {
    toolByName(tools, followUp.tool);
    const calls = buildCalls(followUp, input);
    if (calls.length === 0) {
      if (followUp.required) {
        throw new Error(`Follow-up ${followUp.tool} 未从上一步结果提取到调用参数`);
      }
      executions.push(Object.freeze({ calls: [], tool: followUp.tool }));
      continue;
    }
    const completed: FollowUpCall[] = [];
    for (const argumentsValue of calls) {
      const sourceValues = Object.values(argumentsValue)
        .filter((value): value is string => typeof value === 'string');
      try {
        const result = await connection.callTool({
          arguments: argumentsValue,
          name: followUp.tool,
        } satisfies McpSourceToolRequest, timeoutMs);
        completed.push(Object.freeze({ result, sourceValues }));
        input = result;
      } catch (error: unknown) {
        if (followUp.required) throw error;
        completed.push(Object.freeze({ error: errorText(error), sourceValues }));
      }
    }
    executions.push(Object.freeze({ calls: completed, tool: followUp.tool }));
  }
  return executions;
};
