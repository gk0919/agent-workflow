import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { workflowRoot } from '../../src/config/workspace-paths.js';
import { validateVerificationContract } from '../../src/core/verification-contract.js';
import {
  createVerificationBaseline,
  verificationDefinitionHash,
  verificationFreshness,
} from '../../src/core/verification-baseline.js';
import type { VerificationBaseline, VerificationRepository } from '../../src/core/verification-baseline.js';

const require = createRequire(import.meta.url);
const Ajv = (require('ajv/dist/2020.js') as { default: typeof Ajv2020 }).default;
const addFormats = (require('ajv-formats') as { default: FormatsPlugin }).default;

interface TestPoint {
  id: string;
  acceptanceIds: string[];
  method: string;
  executor: string;
  instructions: string;
  expected: string;
  status: string;
  evidence: string[];
  blocker: string;
  capability?: { available: string; authorized: string; environmentReady: string };
  executedAgainst?: VerificationBaseline;
}

const fixture = () => ({
  schemaVersion: 1,
  taskId: 'baseline-fixture',
  contractStatus: 'implemented',
  goals: [{ id: 'G1', statement: 'Persist the requested value' }],
  acceptanceCriteria: [{ id: 'AC1', goalIds: ['G1'], statement: 'Reload restores the saved value' }],
  outOfScope: [{ id: 'OOS1', statement: 'No server persistence' }],
  plannedChanges: [{ id: 'C1', repository: '.', path: 'state.ts', summary: 'Persist state', acceptanceIds: ['AC1'] }],
  actualChanges: [{ id: 'A1', repository: '.', path: 'state.ts', summary: 'Persisted state', acceptanceIds: ['AC1'], plannedChangeIds: ['C1'] }],
  testPoints: [{
    id: 'VT1', acceptanceIds: ['AC1'], method: 'cli', executor: 'agent',
    instructions: 'Run persistence tests', expected: 'Saved state survives reload',
    status: 'passed', evidence: ['test.log'], blocker: '',
  }] as TestPoint[],
});

const repositories = (): VerificationRepository[] => [{
  repository: 'workspace', root: '.', head: 'a'.repeat(40), fingerprint: 'b'.repeat(64),
}];
const executedAt = '2026-09-10T10:11:12.000Z';

export const main = (): number => {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  const validators = new Map([1, 2].map((version) => {
    const file = version === 1 ? 'verification-contract.schema.json' : 'verification-contract-v2.schema.json';
    const schema = JSON.parse(readFileSync(path.join(workflowRoot, 'resources/schemas', file), 'utf8'));
    return [version, ajv.compile(schema)];
  }));
  const validateSchema = (value: unknown): boolean => {
    const version = (value as { schemaVersion: number }).schemaVersion;
    return validators.get(version)?.(value) === true;
  };
  const expectValid = (value: unknown): void => {
    assert.deepEqual(validateVerificationContract(value), []);
    assert.equal(validateSchema(value), true);
  };
  const expectInvalid = (value: unknown): void => {
    assert.notEqual(validateVerificationContract(value).length, 0);
    assert.equal(validateSchema(value), false);
  };
  try {
    const legacy = fixture();
    expectValid(legacy);
    const serialized = JSON.stringify(legacy);
    assert.deepEqual(verificationFreshness(legacy, repositories()), [{ id: 'VT1', status: 'unknown' }]);
    assert.equal(JSON.stringify(legacy), serialized);

    const current = fixture();
    current.schemaVersion = 2;
    expectInvalid(current);
    const point = current.testPoints[0]!;
    point.executedAgainst = createVerificationBaseline(current, 'VT1', repositories(), 'Node test fixture', executedAt);
    expectValid(current);
    assert.deepEqual(verificationFreshness(current, repositories()), [{ id: 'VT1', status: 'current' }]);
    const legacyWithBaseline = structuredClone(current);
    legacyWithBaseline.schemaVersion = 1;
    expectInvalid(legacyWithBaseline);

    const malformed: Array<(baseline: Record<string, unknown>) => void> = [
      (baseline) => { delete baseline.executedAt; },
      (baseline) => { baseline.executedAt = '2026-02-30T10:11:12.000Z'; },
      (baseline) => { baseline.executedAt = '2026-09-10'; },
      (baseline) => { baseline.executedAt = '2026-09-10T10:11:12.000+00:00'; },
      (baseline) => { baseline.executedAt = '2026-09-10T23:59:60.000Z'; },
      (baseline) => { baseline.environment = ' '; },
      (baseline) => { baseline.definitionHash = 'invalid'; },
      (baseline) => { baseline.observedAt = executedAt; },
      (baseline) => { baseline.repositories = []; },
      (baseline) => { baseline.repositories = [{ ...repositories()[0], fingerprint: 'invalid' }]; },
      (baseline) => { baseline.repositories = [{ ...repositories()[0], head: 'a'.repeat(42) }]; },
      (baseline) => { baseline.repositories = [{ ...repositories()[0], branch: 'main' }]; },
      (baseline) => { baseline.repositories = [repositories()[0], repositories()[0]]; },
    ];
    for (const mutate of malformed) {
      const invalid = structuredClone(current);
      mutate(invalid.testPoints[0]!.executedAgainst as unknown as Record<string, unknown>);
      expectInvalid(invalid);
    }

    const failed = structuredClone(current);
    failed.testPoints[0]!.status = 'failed';
    expectValid(failed);
    assert.deepEqual(verificationFreshness(failed, repositories()), [{ id: 'VT1', status: 'current' }]);
    delete failed.testPoints[0]!.executedAgainst;
    expectInvalid(failed);
    const planned = structuredClone(current);
    planned.testPoints[0]!.status = 'planned';
    planned.testPoints[0]!.evidence = [];
    delete planned.testPoints[0]!.executedAgainst;
    expectValid(planned);

    const baselineBefore = JSON.stringify(point.executedAgainst);
    const observed = repositories();
    observed[0]!.fingerprint = 'c'.repeat(64);
    assert.deepEqual(verificationFreshness(current, observed), [{ id: 'VT1', status: 'stale' }]);
    const refreshedCheckpoint = { repositories: observed, observedAt: new Date().toISOString() };
    assert.deepEqual(verificationFreshness(current, refreshedCheckpoint.repositories), [{ id: 'VT1', status: 'stale' }]);
    assert.equal(JSON.stringify(point.executedAgainst), baselineBefore);
    assert.equal(point.status, 'passed');
    const headChanged = repositories();
    headChanged[0]!.head = 'd'.repeat(40);
    assert.equal(verificationFreshness(current, headChanged)[0]?.status, 'stale');
    assert.equal(verificationFreshness(current, [])[0]?.status, 'unknown');

    for (const mutate of [
      (value: ReturnType<typeof fixture>) => { value.goals[0]!.statement = 'Changed goal'; },
      (value: ReturnType<typeof fixture>) => { value.acceptanceCriteria[0]!.statement = 'Changed acceptance'; },
      (value: ReturnType<typeof fixture>) => { value.outOfScope[0]!.statement = 'Changed exclusion'; },
      (value: ReturnType<typeof fixture>) => { value.plannedChanges[0]!.path = 'other.ts'; },
      (value: ReturnType<typeof fixture>) => { value.plannedChanges[0]!.repository = 'another'; },
      (value: ReturnType<typeof fixture>) => { value.testPoints[0]!.instructions = 'Changed instructions'; },
      (value: ReturnType<typeof fixture>) => { value.testPoints[0]!.expected = 'Changed expected result'; },
    ]) {
      const changed = structuredClone(current);
      mutate(changed);
      assert.equal(verificationFreshness(changed, repositories())[0]?.status, 'stale');
      assert.equal(changed.testPoints[0]!.status, 'passed');
    }

    const outcomeOnly = structuredClone(current);
    outcomeOnly.actualChanges[0]!.summary = 'More detailed actual implementation';
    outcomeOnly.testPoints[0]!.evidence.push('more-evidence.log');
    outcomeOnly.testPoints[0]!.blocker = 'Historical explanation';
    outcomeOnly.testPoints[0]!.capability = { available: 'unknown', authorized: 'no', environmentReady: 'no' };
    outcomeOnly.contractStatus = 'conditional';
    assert.equal(verificationDefinitionHash(outcomeOnly, 'VT1'), verificationDefinitionHash(current, 'VT1'));
    const shuffled = Object.fromEntries(Object.entries(current).reverse());
    assert.equal(verificationDefinitionHash(shuffled, 'VT1'), verificationDefinitionHash(current, 'VT1'));
    const independentPoint = structuredClone(current);
    independentPoint.testPoints.push({ ...structuredClone(point), id: 'VT2', expected: 'Another independent result' });
    assert.equal(verificationDefinitionHash(independentPoint, 'VT1'), verificationDefinitionHash(current, 'VT1'));
    independentPoint.testPoints.reverse();
    assert.equal(verificationDefinitionHash(independentPoint, 'VT1'), verificationDefinitionHash(current, 'VT1'));
    assert.throws(() => verificationDefinitionHash(current, 'VT9'));
    assert.throws(() => createVerificationBaseline(current, 'VT1', [], 'fixture', executedAt));
    assert.throws(() => createVerificationBaseline(current, 'VT1', [{ ...repositories()[0]!, root: 'missing' }], 'fixture', executedAt));

    const multiple = fixture();
    multiple.schemaVersion = 2;
    multiple.plannedChanges.push({ id: 'C2', repository: 'second', path: 'state.ts', summary: 'Use persisted value', acceptanceIds: ['AC1'] });
    const both = [...repositories(), { repository: 'second', root: 'second', head: 'e'.repeat(40), fingerprint: 'f'.repeat(64) }];
    const saved = createVerificationBaseline(multiple, 'VT1', both, 'fixture', executedAt);
    multiple.testPoints[0]!.executedAgainst = saved;
    assert.equal(verificationFreshness(multiple, both.toReversed())[0]?.status, 'current');
    both[1]!.fingerprint = 'a'.repeat(64);
    assert.equal(verificationFreshness(multiple, both)[0]?.status, 'stale');
    assert.equal(saved.repositories.find((repository) => repository.repository === 'second')?.fingerprint, 'f'.repeat(64));
    assert.equal(verificationFreshness(multiple, repositories())[0]?.status, 'unknown');
    const reorderedPlan = structuredClone(multiple);
    reorderedPlan.plannedChanges.reverse();
    assert.equal(verificationDefinitionHash(reorderedPlan, 'VT1'), verificationDefinitionHash(multiple, 'VT1'));

    process.stdout.write('Verification baseline regression passed: version compatibility, strict baselines, code and definition freshness, immutable execution evidence.\n');
    return 0;
  } catch (error) {
    process.stderr.write(`Verification baseline regression failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    return 1;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
