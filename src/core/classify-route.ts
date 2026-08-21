import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadActiveProfile } from '../config/workflow-config.js';
import { loadRoutes } from './context-budget.js';
import type {
  RouteClassification,
  RouteFacts,
  RoutesConfig,
  TaskModel,
} from '../types/contracts.js';
import { errorMessage } from '../types/guards.js';

type BooleanRouteFactKey = Exclude<keyof RouteFacts,
  'changeType' | 'entry' | 'files' | 'intent' | 'repositories' | 'riskFlags' | 'semanticLines'>;
type NumberRouteFactKey = 'files' | 'repositories' | 'semanticLines';
type RouteFactsInput = Partial<RouteFacts>;
type ParsedRouteFacts = RouteFactsInput & { format?: string };

interface ExtractedClassificationArgs {
  facts: RouteFactsInput | null;
  remainingArgs: string[];
}

export const booleanOptions = new Map<string, BooleanRouteFactKey>([
  ['--acceptance-clear', 'acceptanceClear'],
  ['--async', 'requestsAsync'],
  ['--behavior-clear', 'behaviorClear'],
  ['--compatibility-clear', 'compatibilityClear'],
  ['--existing-pattern', 'usesExistingPattern'],
  ['--goal-clear', 'goalClear'],
  ['--independent-review', 'requestsIndependentReview'],
  ['--no-new-business-state', 'noNewBusinessState'],
  ['--persistence', 'requestsPersistence'],
  ['--unique-location', 'uniqueLocation'],
  ['--validation-path', 'hasValidationPath'],
]);

export const numberOptions = new Map<string, NumberRouteFactKey>([
  ['--files', 'files'],
  ['--repositories', 'repositories'],
  ['--semantic-lines', 'semanticLines'],
]);

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

export const extractRouteClassificationArgs = (
  args: string[],
): ExtractedClassificationArgs => {
  if (!args.includes('--intent')) {
    return {
      facts: null,
      remainingArgs: [...args],
    };
  }

  const facts: RouteFactsInput = {
    riskFlags: [],
  };
  const remainingArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const booleanKey = booleanOptions.get(argument ?? '');
    if (booleanKey) {
      facts[booleanKey] = true;
      continue;
    }
    const numberKey = numberOptions.get(argument ?? '');
    if (numberKey) {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${argument} 必须提供非负整数`);
      }
      facts[numberKey] = value;
      index += 1;
      continue;
    }
    if (argument && ['--change-type', '--entry', '--intent', '--risk'].includes(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} 缺少值`);
      }
      if (argument === '--risk') {
        facts.riskFlags?.push(value);
      } else if (argument === '--change-type') {
        facts.changeType = value;
      } else {
        const key = argument.slice(2) as 'entry' | 'intent';
        facts[key] = value;
      }
      index += 1;
      continue;
    }
    if (argument) {
      remainingArgs.push(argument);
    }
  }

  return {
    facts,
    remainingArgs,
  };
};

export const normalizeRouteFacts = (facts: RouteFactsInput = {}): RouteFacts => ({
  acceptanceClear: Boolean(facts.acceptanceClear),
  behaviorClear: Boolean(facts.behaviorClear),
  changeType: typeof facts.changeType === 'string' ? facts.changeType : '',
  compatibilityClear: Boolean(facts.compatibilityClear),
  entry: typeof facts.entry === 'string' ? facts.entry : '',
  files: typeof facts.files === 'number' && Number.isInteger(facts.files) ? facts.files : 0,
  goalClear: Boolean(facts.goalClear),
  hasValidationPath: Boolean(facts.hasValidationPath),
  intent: typeof facts.intent === 'string' ? facts.intent : '',
  noNewBusinessState: Boolean(facts.noNewBusinessState),
  repositories: typeof facts.repositories === 'number' && Number.isInteger(facts.repositories)
    ? facts.repositories
    : 0,
  requestsAsync: Boolean(facts.requestsAsync),
  requestsIndependentReview: Boolean(facts.requestsIndependentReview),
  requestsPersistence: Boolean(facts.requestsPersistence),
  riskFlags: unique(Array.isArray(facts.riskFlags) ? facts.riskFlags : []),
  semanticLines: typeof facts.semanticLines === 'number' && Number.isInteger(facts.semanticLines)
    ? facts.semanticLines
    : 0,
  uniqueLocation: Boolean(facts.uniqueLocation),
  usesExistingPattern: Boolean(facts.usesExistingPattern),
});

export const validateRouteFacts = (
  facts: RouteFacts,
  config = loadRoutes(),
  profile = loadActiveProfile(),
): string[] => {
  const errors: string[] = [];
  const taskModel = profile.taskModel;
  if (!Object.hasOwn(taskModel.intentRoutes, facts.intent)) {
    errors.push(`未知 intent：${facts.intent || '空'}`);
  }
  if (facts.changeType && !taskModel.changeTypes.includes(facts.changeType)) {
    errors.push(`未知 changeType：${facts.changeType}`);
  }
  const requiresExplicitChangeType = taskModel.changeIntents.includes(facts.intent) &&
    !Object.hasOwn(taskModel.changeTypeByIntent, facts.intent);
  if (requiresExplicitChangeType && !facts.changeType) {
    errors.push(
      `intent ${facts.intent} 必须提供 changeType：` +
      taskModel.changeTypes.join(' 或 '),
    );
  }
  if (Object.hasOwn(taskModel.changeTypeByIntent, facts.intent) &&
      facts.changeType &&
      facts.changeType !== taskModel.changeTypeByIntent[facts.intent]) {
    errors.push(`intent ${facts.intent} 与 changeType ${facts.changeType} 冲突`);
  }
  const allEntries = new Set(
    Object.values(config.routes).flatMap((route) => route.entryModes),
  );
  if (!allEntries.has(facts.entry)) {
    errors.push(`未知 entry：${facts.entry || '空'}`);
  }
  const numberFields: NumberRouteFactKey[] = ['files', 'repositories', 'semanticLines'];
  numberFields.forEach((field) => {
    if (!Number.isInteger(facts[field]) || facts[field] < 0) {
      errors.push(`${field} 必须是非负整数`);
    }
  });
  const unknownRisks = facts.riskFlags
    .filter((riskFlag) => !config.riskCatalog.includes(riskFlag));
  if (unknownRisks.length > 0) {
    errors.push(`未知风险标识：${unknownRisks.join(', ')}`);
  }
  const allowedEntries = taskModel.expectedIntentEntries[facts.intent];
  if (allowedEntries && !allowedEntries.includes(facts.entry)) {
    errors.push(`${facts.intent} 不接受 entry ${facts.entry}`);
  }
  return errors;
};

const commonMicroChangeBlockers = (
  facts: RouteFacts,
  gate: RoutesConfig['microChangeGate'],
): string[] => [
  ...(!facts.goalClear ? ['goal-unclear'] : []),
  ...(!facts.acceptanceClear ? ['acceptance-unclear'] : []),
  ...(!facts.uniqueLocation ? ['location-not-unique'] : []),
  ...(facts.repositories !== gate.repositories ? ['repository-count'] : []),
  ...(facts.files < gate.minFiles || facts.files > gate.maxFiles
    ? ['file-count']
    : []),
  ...(facts.semanticLines < gate.minSemanticLines ||
      facts.semanticLines > gate.maxSemanticLines
    ? ['semantic-diff-size']
    : []),
  ...(!facts.hasValidationPath ? ['validation-path-missing'] : []),
  ...(facts.requestsPersistence ? ['persistence-requested'] : []),
  ...(facts.requestsAsync ? ['async-requested'] : []),
  ...(facts.requestsIndependentReview ? ['independent-review-requested'] : []),
  ...facts.riskFlags.map((riskFlag) => `risk:${riskFlag}`),
];

const evolutionaryMicroChangeBlockers = (facts: RouteFacts): string[] => [
  ...(!facts.behaviorClear ? ['behavior-unclear'] : []),
  ...(!facts.usesExistingPattern ? ['existing-pattern-unconfirmed'] : []),
  ...(!facts.noNewBusinessState ? ['no-new-business-state-unconfirmed'] : []),
  ...(!facts.compatibilityClear ? ['compatibility-unclear'] : []),
];

const changeTypeFor = (facts: RouteFacts, taskModel: TaskModel): string => {
  const changeType = taskModel.changeTypeByIntent[facts.intent] || facts.changeType;
  if (!changeType) {
    throw new Error(`intent ${facts.intent} 缺少 changeType`);
  }
  return changeType;
};

export const classifyRouteFacts = (
  inputFacts: RouteFactsInput,
  config = loadRoutes(),
  profile = loadActiveProfile(),
): RouteClassification => {
  const facts = normalizeRouteFacts(inputFacts);
  const errors = validateRouteFacts(facts, config, profile);
  if (errors.length > 0) {
    throw new Error(errors.join('；'));
  }

  const taskModel = profile.taskModel;
  if (!taskModel.changeIntents.includes(facts.intent)) {
    const target = taskModel.intentRoutes[facts.intent];
    if (!target) {
      throw new Error(`intent ${facts.intent} 未绑定固定 Route`);
    }
    const [route, stage] = target;
    if (!config.routes[route]?.entryModes.includes(facts.entry)) {
      throw new Error(`Route ${route} 不接受 entry ${facts.entry}`);
    }
    return {
      blockers: [],
      changeClass: null,
      changeType: null,
      entry: facts.entry,
      microChangeEligible: false,
      reasonCodes: [`intent:${facts.intent}`],
      riskFlags: facts.riskFlags,
      route,
      stage,
    };
  }

  if (!taskModel.changeEntryModes.includes(facts.entry)) {
    throw new Error(`${facts.intent} 不接受 entry ${facts.entry}`);
  }
  const changeType = changeTypeFor(facts, taskModel);
  const gate = config.microChangeGate;
  const blockers = [
    ...commonMicroChangeBlockers(facts, gate),
    ...(taskModel.evolutionaryChangeTypes.includes(changeType)
      ? evolutionaryMicroChangeBlockers(facts)
      : []),
  ];
  const microChangeEligible = blockers.length === 0;
  const microStage = taskModel.microStages[changeType];
  if (microChangeEligible && !microStage) {
    throw new Error(`changeType ${changeType} 缺少 Micro Change Stage`);
  }
  return {
    blockers,
    changeClass: microChangeEligible ? 'micro' : 'standard',
    changeType,
    entry: facts.entry,
    microChangeEligible,
    reasonCodes: microChangeEligible
      ? [`intent:${changeType}`, 'all-micro-change-gates-passed']
      : [`intent:${changeType}`, 'standard-change-required', ...blockers],
    riskFlags: facts.riskFlags,
    route: microChangeEligible ? 'micro-change' : 'standard-change',
    stage: microChangeEligible ? microStage ?? 'capture' : 'capture',
  };
};

const readArguments = (args: string[]): ParsedRouteFacts => {
  const facts: ParsedRouteFacts = {
    riskFlags: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const booleanKey = booleanOptions.get(argument ?? '');
    if (booleanKey) {
      facts[booleanKey] = true;
      continue;
    }
    const numberKey = numberOptions.get(argument ?? '');
    if (numberKey) {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${argument} 必须提供非负整数`);
      }
      facts[numberKey] = value;
      index += 1;
      continue;
    }
    if (argument && ['--change-type', '--entry', '--intent', '--risk'].includes(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} 缺少值`);
      }
      if (argument === '--risk') {
        facts.riskFlags?.push(value);
      } else if (argument === '--change-type') {
        facts.changeType = value;
      } else {
        const key = argument.slice(2) as 'entry' | 'intent';
        facts[key] = value;
      }
      index += 1;
      continue;
    }
    if (argument === '--format') {
      const format = args[index + 1];
      if (!format) {
        throw new Error('--format 缺少值');
      }
      facts.format = format;
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  return facts;
};

export const main = (args = process.argv.slice(2)): number => {
  try {
    const facts = readArguments(args);
    const format = facts.format ?? 'text';
    delete facts.format;
    if (!['text', 'json'].includes(format)) {
      throw new Error('--format 只支持 text 或 json');
    }
    const decision = classifyRouteFacts(facts);
    const output = format === 'json'
      ? JSON.stringify(decision, null, 2)
      : [
        `Route: ${decision.route}/${decision.stage}`,
        `Entry: ${decision.entry}`,
        `Change Type: ${decision.changeType ?? 'not-applicable'}`,
        `Change Class: ${decision.changeClass ?? 'not-applicable'}`,
        `Micro Change Eligible: ${decision.microChangeEligible}`,
        `Reasons: ${decision.reasonCodes.join(', ')}`,
      ].join('\n');
    process.stdout.write(`${output}\n`);
    return 0;
  } catch (error: unknown) {
    process.stderr.write(
      `路由事实分类失败：${errorMessage(error)}\n` +
      'Usage: agent-workflow classify ' +
      '--intent <intent> [--change-type defect|requirement] ' +
      '--entry <entry> [fact flags]\n',
    );
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
