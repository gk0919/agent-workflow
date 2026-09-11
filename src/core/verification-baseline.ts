import { createHash } from 'node:crypto';

export interface VerificationRepository {
  repository: string;
  root: string;
  head: string;
  fingerprint: string;
}

export interface VerificationBaseline {
  executedAt: string;
  repositories: VerificationRepository[];
  definitionHash: string;
  environment: string;
}

export interface VerificationFreshness {
  id: string;
  status: 'current' | 'stale' | 'unknown';
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonempty = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 &&
  Array.from(value).length <= maxLength;

const HASH = /^[a-f0-9]{64}$/;
const HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const canonicalTime = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
};

const validRepository = (value: unknown): value is VerificationRepository =>
  object(value) && exactKeys(value, ['repository', 'root', 'head', 'fingerprint']) &&
  nonempty(value.repository, 200) && nonempty(value.root, 300) &&
  typeof value.head === 'string' && HEAD.test(value.head) &&
  typeof value.fingerprint === 'string' && HASH.test(value.fingerprint);

const validRepositories = (value: unknown): value is VerificationRepository[] =>
  Array.isArray(value) && value.length > 0 && value.length <= 100 &&
  value.every(validRepository) &&
  new Set(value.map((repository) => canonical(repository))).size === value.length;

const unambiguousRepositories = (value: VerificationRepository[]): boolean =>
  new Set(value.map((repository) => repository.repository)).size === value.length &&
  new Set(value.map((repository) => repository.root)).size === value.length;

export const validateVerificationBaseline = (value: unknown): string[] => {
  if (!object(value)) return ['executedAgainst 必须是对象'];
  const errors: string[] = [];
  if (!exactKeys(value, ['executedAt', 'repositories', 'definitionHash', 'environment'])) {
    errors.push('executedAgainst 必须且只能包含 executedAt、repositories、definitionHash、environment');
  }
  if (!canonicalTime(value.executedAt)) errors.push('executedAgainst.executedAt 必须是毫秒精度的 UTC ISO 时间');
  if (!validRepositories(value.repositories)) errors.push('executedAgainst.repositories 必须包含 1-100 个完整且不重复的仓库基线');
  if (typeof value.definitionHash !== 'string' || !HASH.test(value.definitionHash)) {
    errors.push('executedAgainst.definitionHash 必须是 SHA-256');
  }
  if (!nonempty(value.environment, 1000)) errors.push('executedAgainst.environment 必须是 1-1000 字符环境说明');
  return errors;
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const definitionRecords = (value: unknown, keys: string[]): unknown[] => {
  if (!Array.isArray(value)) throw new Error('Verification definition must contain arrays');
  return value.map((item) => {
    if (!object(item)) throw new Error('Verification definition entries must be objects');
    return Object.fromEntries(keys.map((key) => {
      if (!Object.hasOwn(item, key)) throw new Error(`Verification definition is missing ${key}`);
      const field = item[key];
      return [key, Array.isArray(field) ? [...field].sort() : field];
    }));
  }).sort((left, right) => compare(canonical(left), canonical(right)));
};

export const verificationDefinitionHash = (contract: unknown, testPointId: string): string => {
  if (!object(contract) || !Array.isArray(contract.testPoints)) throw new Error('Verification contract has no test points');
  const matching = contract.testPoints.filter((point) => object(point) && point.id === testPointId);
  if (matching.length !== 1) throw new Error(`Verification test point must resolve uniquely: ${testPointId}`);
  // Hash only the accepted plan and this test's definition, never mutable execution results.
  const definition = {
    goals: definitionRecords(contract.goals, ['id', 'statement']),
    acceptanceCriteria: definitionRecords(contract.acceptanceCriteria, ['id', 'goalIds', 'statement']),
    outOfScope: definitionRecords(contract.outOfScope, ['id', 'statement']),
    plannedChanges: definitionRecords(contract.plannedChanges, ['id', 'repository', 'path', 'summary', 'acceptanceIds']),
    testPoint: definitionRecords(matching, ['id', 'acceptanceIds', 'method', 'executor', 'instructions', 'expected'])[0],
  };
  return createHash('sha256').update(canonical(definition)).digest('hex');
};

const repositoryProjection = (repositories: VerificationRepository[]): VerificationRepository[] =>
  repositories.map(({ repository, root, head, fingerprint }) => ({ repository, root, head, fingerprint }))
    .sort((left, right) => compare(left.repository, right.repository));

const declaredRepositoriesCovered = (contract: unknown, repositories: VerificationRepository[]): boolean =>
  object(contract) && Array.isArray(contract.plannedChanges) &&
  contract.plannedChanges.every((change) => object(change) && repositories.some((repository) =>
    change.repository === repository.repository || change.repository === repository.root));

export const createVerificationBaseline = (
  contract: unknown,
  id: string,
  repositories: VerificationRepository[],
  environment: string,
  executedAt = new Date().toISOString(),
): VerificationBaseline => {
  const baseline: VerificationBaseline = {
    executedAt,
    repositories: repositoryProjection(repositories),
    definitionHash: verificationDefinitionHash(contract, id),
    environment,
  };
  const errors = validateVerificationBaseline(baseline);
  if (!unambiguousRepositories(baseline.repositories)) errors.push('执行基线的仓库名称或路径重复');
  if (!declaredRepositoriesCovered(contract, baseline.repositories)) errors.push('执行基线未覆盖全部计划仓库');
  if (errors.length) throw new Error(errors.join('; '));
  return baseline;
};

export const verificationFreshness = (
  contract: unknown,
  repositories: VerificationRepository[],
): VerificationFreshness[] => {
  if (!object(contract) || !Array.isArray(contract.testPoints)) return [];
  const observed = repositoryProjection(repositories);
  return contract.testPoints.filter(object).map((testPoint) => {
    const id = typeof testPoint.id === 'string' ? testPoint.id : '';
    const unknown: VerificationFreshness = { id, status: 'unknown' };
    if (contract.schemaVersion !== 2 || !['passed', 'failed'].includes(String(testPoint.status)) ||
        validateVerificationBaseline(testPoint.executedAgainst).length || !validRepositories(observed)) return unknown;
    const baseline = testPoint.executedAgainst as unknown as VerificationBaseline;
    try {
      if (baseline.definitionHash !== verificationDefinitionHash(contract, id)) return { id, status: 'stale' };
      if (!unambiguousRepositories(baseline.repositories) || !unambiguousRepositories(observed) ||
          !declaredRepositoriesCovered(contract, baseline.repositories) || !declaredRepositoriesCovered(contract, observed)) return unknown;
      return {
        id,
        status: canonical(repositoryProjection(baseline.repositories)) === canonical(observed) ? 'current' : 'stale',
      };
    } catch {
      return unknown;
    }
  });
};
