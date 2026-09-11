import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Ajv2020 } from 'ajv/dist/2020.js';
import { isJsonObject } from '../types/guards.js';

export interface WorkItem {
  id: string;
  title: string;
  stage: string;
  complete: boolean;
  progress: 'pending' | 'active' | 'blocked';
  plannedChangeIds: string[];
  verificationIds: string[];
  dependencies: string[];
  doneWhen: string;
  evidence: string[];
  checkpoint: string;
  blocker: string;
  artifact: string;
  deferred: boolean;
  deferredReason: string;
}

export interface TaskPlan {
  version: 1;
  taskId: string;
  items: WorkItem[];
}

export interface WorkItemUpdate {
  progress?: WorkItem['progress'];
  complete?: boolean;
  evidence?: string[];
  checkpoint?: string;
  blocker?: string;
}

interface Line {
  text: string;
  start: number;
  end: number;
}

interface ItemNode {
  item: WorkItem;
  line: number;
  lastLine: number;
  fields: Map<string, number>;
}

interface PlanDocument {
  plan: TaskPlan;
  lines: Line[];
  nodes: ItemNode[];
}

const require = createRequire(import.meta.url);
const Ajv = (require('ajv/dist/2020.js') as { default: typeof Ajv2020 }).default;
const validateSchema = new Ajv({ allErrors: true, strict: true }).compile<TaskPlan>(
  JSON.parse(readFileSync(new URL('../../../resources/schemas/task-plan.schema.json', import.meta.url), 'utf8')),
);
const MAX_PLAN_BYTES = 1024 * 1024;
const FIELDS = new Set([
  'Stage', 'Progress', 'Planned Change', 'Verify', 'Depends On', 'Done When',
  'Evidence', 'Checkpoint', 'Blocker', 'Artifact', 'Deferred Reason',
]);

function fail(line: number, message: string): never {
  throw new Error(`plan.md:${line + 1}: ${message}`);
}

const readLines = (content: string): Line[] => {
  const result: Line[] = [];
  let start = 0;
  for (const text of content.split('\n')) {
    result.push({ text: text.endsWith('\r') ? text.slice(0, -1) : text, start, end: Math.min(start + text.length + 1, content.length) });
    start += text.length + 1;
  }
  return result;
};

const values = (value: string): string[] => value === 'none' ? [] : value.split(',').map((part) => part.trim());

const validArtifact = (value: string): boolean => {
  const file = value.split('#')[0] ?? '';
  return file.length > 0 && !/^(?:[A-Za-z]:|\/)/.test(file) && !file.includes('\\') &&
    !file.split('/').some((part) => part === '..' || part === '') && !/[\r\n]/.test(value);
};

// The machine-owned sections use a deliberately small Markdown grammar. Other sections remain opaque.
const parseDocument = (content: string, expectedTaskId?: string): PlanDocument => {
  if (Buffer.byteLength(content, 'utf8') > MAX_PLAN_BYTES) throw new Error('plan.md exceeds 1 MiB');
  const lines = readLines(content);
  if (lines[0]?.text !== '---') fail(0, 'missing plan_version/task_id frontmatter; migrate the legacy plan first');
  const frontmatter = new Map<string, string>();
  let cursor = 1;
  for (; cursor < lines.length && lines[cursor]?.text !== '---'; cursor += 1) {
    const line = lines[cursor]!.text;
    const field = /^(plan_version|task_id):\s*(\S+)\s*$/.exec(line);
    if (!field) fail(cursor, 'frontmatter only accepts plan_version and task_id scalar fields');
    const key = field[1]!;
    if (frontmatter.has(key)) fail(cursor, `duplicate frontmatter field ${key}`);
    frontmatter.set(key, field[2]!);
  }
  if (lines[cursor]?.text !== '---') fail(cursor, 'unterminated frontmatter');
  if (frontmatter.get('plan_version') !== '1') fail(1, 'unsupported plan_version; expected 1');
  const taskId = frontmatter.get('task_id') ?? '';
  if (expectedTaskId !== undefined && taskId !== expectedTaskId) fail(1, `task_id does not match ${expectedTaskId}`);
  const nodes: ItemNode[] = [];
  const sections = new Set<string>();
  let section = '';
  let node: ItemNode | undefined;
  let fence = '';
  for (cursor += 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]!.text;
    const fenced = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (fenced && fenced[1]![0] === fence[0] && fenced[1]!.length >= fence.length && !fenced[2]!.trim()) fence = '';
      continue;
    }
    if (fenced) {
      if (section) fail(cursor, 'fenced content is not allowed in Work Items sections');
      fence = fenced[1]!;
      continue;
    }
    if (/^ {0,3}</.test(line)) fail(cursor, 'raw HTML is not supported in task plans; use a fenced example');
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const title = heading[2]!;
      const reserved = title === 'Work Items' || title === 'Deferred Work Items';
      if (reserved && heading[1] !== '##') fail(cursor, 'Work Items headings must use level 2');
      if (section && heading[1]!.length > 2) fail(cursor, 'nested headings are not allowed in Work Items sections');
      section = reserved ? title : '';
      node = undefined;
      if (reserved) {
        if (sections.has(title)) fail(cursor, `duplicate section ${title}`);
        sections.add(title);
      }
      continue;
    }
    if (!section || !line.trim()) continue;
    const item = /^- \[([ xX])\] (T[1-9][0-9]*):\s*(\S.*?)\s*$/.exec(line);
    if (item) {
      node = {
        item: {
          id: item[2]!, title: item[3]!, stage: '', complete: item[1]!.toLowerCase() === 'x',
          progress: 'pending', plannedChangeIds: [], verificationIds: [], dependencies: [],
          doneWhen: '', evidence: [], checkpoint: '', blocker: '', artifact: '',
          deferred: section === 'Deferred Work Items', deferredReason: '',
        },
        line: cursor, lastLine: cursor, fields: new Map(),
      };
      nodes.push(node);
      continue;
    }
    const field = /^  - ([A-Za-z][A-Za-z ]*):\s*(.*?)\s*$/.exec(line);
    if (!node || !field) fail(cursor, 'expected - [ ] T<number>: title or an indented metadata field');
    const key = field[1]!;
    const value = field[2]!;
    if (!FIELDS.has(key)) fail(cursor, `unknown metadata field ${key}`);
    if (node.fields.has(key)) fail(cursor, `duplicate metadata field ${key}`);
    if (!value) fail(cursor, `${key} must not be empty; omit optional fields instead`);
    node.fields.set(key, cursor);
    node.lastLine = cursor;
    switch (key) {
      case 'Stage': node.item.stage = value; break;
      case 'Progress':
        if (!['pending', 'active', 'blocked'].includes(value)) fail(cursor, `invalid Progress ${value}`);
        if (node.item.complete) fail(cursor, 'completed work items must omit Progress');
        node.item.progress = value as WorkItem['progress']; break;
      case 'Planned Change': node.item.plannedChangeIds = values(value); break;
      case 'Verify': node.item.verificationIds = values(value); break;
      case 'Depends On': node.item.dependencies = values(value); break;
      case 'Done When': node.item.doneWhen = value; break;
      case 'Evidence': node.item.evidence = values(value); break;
      case 'Checkpoint': node.item.checkpoint = value; break;
      case 'Blocker': node.item.blocker = value; break;
      case 'Artifact': node.item.artifact = value; break;
      case 'Deferred Reason': node.item.deferredReason = value; break;
    }
  }
  if (fence) fail(lines.length - 1, 'unterminated fenced block');
  if (!sections.has('Work Items')) throw new Error('plan.md: missing ## Work Items section');
  const plan: TaskPlan = { version: 1, taskId, items: nodes.map((entry) => entry.item) };
  const errors = validateTaskPlan(plan);
  if (errors.length) throw new Error(`Invalid task plan:\n${errors.join('\n')}`);
  return { plan, lines, nodes };
};

export const parseTaskPlan = (content: string, expectedTaskId?: string): TaskPlan =>
  parseDocument(content, expectedTaskId).plan;

export const validateTaskPlan = (
  plan: unknown,
  options: { stages?: string[]; contract?: unknown } = {},
): string[] => {
  if (!validateSchema(plan)) return (validateSchema.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message}`);
  const errors: string[] = [];
  const byId = new Map<string, WorkItem>();
  for (const item of plan.items) {
    if (byId.has(item.id)) errors.push(`Duplicate work item ${item.id}`);
    byId.set(item.id, item);
  }
  const contract = options.contract;
  const hasContract = contract !== undefined;
  const plannedIds = new Set<string>();
  const verificationIds = new Set<string>();
  if (hasContract) {
    if (!isJsonObject(contract) || !Array.isArray(contract.plannedChanges) || !Array.isArray(contract.testPoints)) {
      errors.push('Work item references require a contract with plannedChanges and testPoints');
    } else {
      if (contract.taskId !== plan.taskId) errors.push('Contract taskId does not match plan taskId');
      for (const change of contract.plannedChanges) if (isJsonObject(change) && typeof change.id === 'string') plannedIds.add(change.id);
      for (const point of contract.testPoints) if (isJsonObject(point) && typeof point.id === 'string') verificationIds.add(point.id);
    }
  }
  for (const item of plan.items) {
    const issue = (message: string): void => { errors.push(`${item.id}: ${message}`); };
    if (options.stages && !options.stages.includes(item.stage)) issue(`Stage ${item.stage} does not belong to this route`);
    if (!item.artifact.trim() && (!item.plannedChangeIds.length || !item.verificationIds.length)) issue('requires Planned Change and Verify, or an Artifact locator');
    if (item.artifact && !validArtifact(item.artifact)) issue('Artifact must be a safe relative locator');
    if (item.complete && item.progress !== 'pending') issue('complete conflicts with Progress');
    if (item.complete && !item.evidence.length) issue('completion requires Evidence');
    if (item.progress === 'blocked' && !item.blocker.trim()) issue('blocked work requires a Blocker');
    if (item.progress !== 'blocked' && item.blocker.trim()) issue('Blocker requires blocked Progress');
    if (item.deferred && (!item.deferredReason.trim() || !item.artifact.trim())) issue('deferred work requires Deferred Reason and an Artifact follow-up locator');
    if (item.deferred && item.progress === 'active') issue('deferred work cannot be active');
    if (!item.deferred && item.deferredReason) issue('Deferred Reason belongs in Deferred Work Items');
    for (const dependencyId of item.dependencies) {
      const dependency = byId.get(dependencyId);
      if (!dependency) issue(`unknown dependency ${dependencyId}`);
      else if (dependencyId === item.id) issue('cannot depend on itself');
      else if (!item.deferred && dependency.deferred) issue(`active scope depends on deferred ${dependencyId}`);
      else if (!item.deferred && (item.complete || item.progress === 'active') && !dependency.complete) issue(`dependency ${dependencyId} is not complete`);
    }
    if (hasContract) {
      for (const id of item.plannedChangeIds) if (!plannedIds.has(id)) issue(`unknown Planned Change ${id}`);
      for (const id of item.verificationIds) if (!verificationIds.has(id)) issue(`unknown Verify ${id}`);
      for (const reference of item.evidence) {
        if (/^VT[1-9][0-9]*$/.test(reference) && !verificationIds.has(reference)) issue(`unknown Evidence ${reference}`);
      }
    }
  }
  if (plan.items.filter((item) => !item.deferred && item.progress === 'active').length > 1) errors.push('Only one work item may be active per task');
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { errors.push(`Cyclic work item dependency at ${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) if (byId.has(dependency)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
  return errors;
};

export const updateWorkItem = (content: string, id: string, update: WorkItemUpdate): string => {
  const document = parseDocument(content);
  const node = document.nodes.find((entry) => entry.item.id === id);
  if (!node) throw new Error(`Unknown work item ${id}`);
  if (node.item.deferred) throw new Error(`${id}: deferred work must be restored through an explicit scope revision`);
  const allowed = ['progress', 'complete', 'evidence', 'checkpoint', 'blocker'];
  if (Object.keys(update).some((key) => !allowed.includes(key))) throw new Error('Unknown work item update field');
  if (update.complete === true && update.progress !== undefined) throw new Error('Completion update must omit Progress');
  const item: WorkItem = { ...node.item, ...update };
  if (update.complete === true) { item.progress = 'pending'; item.blocker = ''; }
  if (update.progress !== undefined && update.progress !== 'blocked') item.blocker = '';
  const plan = { ...document.plan, items: document.plan.items.map((entry) => entry.id === id ? item : entry) };
  const errors = validateTaskPlan(plan);
  if (errors.length) throw new Error(`Invalid work item update:\n${errors.join('\n')}`);
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const edits: { start: number; end: number; text: string }[] = [];
  if (update.complete !== undefined) {
    const line = document.lines[node.line]!;
    edits.push({ start: line.start + 3, end: line.start + 4, text: item.complete ? 'x' : ' ' });
  }
  const fields = new Map<string, string | undefined>();
  if (update.progress !== undefined || update.complete !== undefined) fields.set('Progress', item.complete ? undefined : item.progress);
  if (update.evidence !== undefined) fields.set('Evidence', item.evidence.length ? item.evidence.join(', ') : undefined);
  if (update.checkpoint !== undefined) fields.set('Checkpoint', item.checkpoint || undefined);
  if (update.blocker !== undefined || update.progress !== undefined || update.complete === true) fields.set('Blocker', item.blocker || undefined);
  const additions: string[] = [];
  for (const [key, value] of fields) {
    const index = node.fields.get(key);
    if (index === undefined) {
      if (value !== undefined) additions.push(`  - ${key}: ${value}`);
      continue;
    }
    const line = document.lines[index]!;
    const lineEnding = content.slice(line.start, line.end).endsWith('\n') ? newline : '';
    edits.push({ start: line.start, end: line.end, text: value === undefined ? '' : `  - ${key}: ${value}${lineEnding}` });
  }
  if (additions.length) {
    const end = document.lines[node.lastLine]!.end;
    const separator = end > 0 && content[end - 1] !== '\n' ? newline : '';
    edits.push({ start: end, end, text: `${separator}${additions.join(newline)}${newline}` });
  }
  let result = content;
  for (const edit of edits.sort((left, right) => right.start - left.start || right.end - left.end)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  const parsed = parseTaskPlan(result, document.plan.taskId);
  if (JSON.stringify(parsed) !== JSON.stringify(plan)) throw new Error('Work item update could not round-trip without loss');
  return result;
};

export const planDefinitionHash = (content: string): string => {
  const document = parseDocument(content);
  const plan = document.plan;
  const items = plan.items.map(({ complete: _complete, progress: _progress, evidence: _evidence, checkpoint: _checkpoint, blocker: _blocker, ...definition }) => definition);
  let context = content;
  for (const node of [...document.nodes].reverse()) {
    context = context.slice(0, document.lines[node.line]!.start) + context.slice(document.lines[node.lastLine]!.end);
  }
  return createHash('sha256').update(JSON.stringify({
    version: plan.version, taskId: plan.taskId, items, context: context.replaceAll('\r\n', '\n').trim(),
  })).digest('hex');
};
