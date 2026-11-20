import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { errorMessage } from '../types/guards.js';
import { inspectSpecChange, parseCapabilitySpec, readSpecBaseline, specContentHash } from './spec-change.js';
import type { SpecChange, SpecInspection } from './spec-change.js';
import { readManifestModel } from './task-lifecycle.js';
import { publishCheckpoint, requirePublishedTask } from './task-checkpoint.js';
import { readTaskFile, replaceFileAtomically, taskPath, withManifestLock } from './task-files.js';

const HELP = 'Usage: agent-workflow spec <init|refresh|inspect> --task <id> [--baseline <workspace-relative.json>] [--capability <new-id>] [--expected-revision N] [--format json|pretty]';

/** A human-facing projection of a computed report, never a persisted ready flag. */
const format = (report: SpecInspection): string => {
  if (!report.enabled) return 'Spec change contract: not enabled (legacy workflow)';
  return [
    `specChangeHash: ${report.specChangeHash ?? '(invalid)'}`,
    ...report.errors.map(error => `ERROR: ${error}`),
    ...report.artifacts.map(artifact => `${artifact.id}: ${artifact.status}${artifact.dependsOn.length ? ` <- ${artifact.dependsOn.join(', ')}` : ''}${artifact.issues.length ? `\n  ${artifact.issues.join('\n  ')}` : ''}`),
    ...report.impacts.map(impact => [
      `${impact.operation.toUpperCase()} ${impact.capability}/${impact.requirementId}: ${impact.reason}`,
      `AC: ${impact.acceptanceIds.join(', ')} | VT: ${impact.verificationIds.join(', ')}`,
      `BEFORE: ${JSON.stringify(impact.before)}`, `AFTER: ${JSON.stringify(impact.after)}`,
    ].join('\n')),
  ].join('\n');
};

export const main = (args = process.argv.slice(2)): number => {
  if (args.includes('--help')) { process.stdout.write(`${HELP}\n`); return 0; }
  try {
    const action = args[0];
    if (!['init', 'refresh', 'inspect'].includes(action ?? '')) throw new Error(HELP);
    const flags = new Map<string, string[]>();
    for (let index = 1; index < args.length; index += 2) {
      const key = args[index]!;
      const value = args[index + 1];
      const allowed = action === 'init' ? ['--task', '--baseline', '--capability', '--expected-revision']
        : action === 'refresh' ? ['--task', '--expected-revision'] : ['--task', '--format'];
      if (!allowed.includes(key) || !value || value.startsWith('--')) throw new Error(HELP);
      if (flags.has(key) && !['--baseline', '--capability'].includes(key)) throw new Error(`Duplicate argument: ${key}`);
      flags.set(key, [...flags.get(key) ?? [], value]);
    }
    const taskId = flags.get('--task')?.[0];
    if (!taskId) throw new Error(HELP);
    const directory = taskPath(taskId);
    const manifest = readManifestModel(readTaskFile(directory, 'manifest.md'));
    if (action === 'inspect') {
      const output = flags.get('--format')?.[0] ?? 'pretty';
      if (!['json', 'pretty'].includes(output)) throw new Error('format must be json or pretty');
      const report = inspectSpecChange(directory, { checkSources: manifest.status !== 'complete' });
      process.stdout.write(`${output === 'json' ? JSON.stringify(report, null, 2) : format(report)}\n`);
      return report.errors.length || report.artifacts.some(artifact => artifact.status === 'blocked') ? 1 : 0;
    }
    // Capturing a source is an authoring operation, never a way to revise an approved implementation.
    const planning = manifest.stages.findIndex(stage => stage.name === 'Plan');
    if (planning < 0 || manifest.stages.findIndex(stage => stage.name === manifest.currentStage) > planning || manifest.status !== 'in_progress') {
      throw new Error('Capture requires an in-progress task before or at Plan; reopen Spec/Plan to revise approved scope');
    }
    const expected = flags.get('--expected-revision')?.[0];
    if (!expected || !/^[1-9][0-9]*$/.test(expected)) throw new Error('Explicit --expected-revision is required');
    const result = withManifestLock(path.join(directory, 'manifest.md'), () => {
      const previous = requirePublishedTask(directory, true);
      if (!previous || previous.revision !== Number(expected)) throw new Error('Checkpoint revision mismatch');
      let change: SpecChange;
      if (action === 'refresh') {
        const inspected = inspectSpecChange(directory, { checkSources: false });
        if (!inspected.enabled || inspected.errors.length) throw new Error(inspected.errors.join('; ') || 'No spec-change.json to refresh');
        change = JSON.parse(readTaskFile(directory, 'spec-change.json')) as SpecChange;
        for (const capability of change.capabilities) {
          if (!capability.baseline) continue;
          const content = readSpecBaseline(capability.baseline.path);
          if (parseCapabilitySpec(content).capability !== capability.id) throw new Error('Refreshed baseline capability mismatch');
          capability.baseline = { path: capability.baseline.path, content, hash: specContentHash(content) };
        }
      } else {
        if (existsSync(path.join(directory, 'spec-change.json'))) throw new Error('spec-change.json already exists; use refresh for reviewed baseline updates');
        const capabilities: SpecChange['capabilities'] = [];
        for (const source of flags.get('--baseline') ?? []) {
          const content = readSpecBaseline(source);
          capabilities.push({ id: parseCapabilitySpec(content).capability, baseline: { path: source, content, hash: specContentHash(content) }, changes: [] });
        }
        for (const id of flags.get('--capability') ?? []) {
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error('Invalid new capability ID');
          capabilities.push({ id, baseline: null, changes: [] });
        }
        if (!capabilities.length || capabilities.length > 30 || new Set(capabilities.map(capability => capability.id)).size !== capabilities.length) throw new Error('Provide 1-30 distinct baselines/new capabilities');
        change = { schemaVersion: 1, taskId, capabilities };
      }
      const content = `${JSON.stringify(change, null, 2)}\n`;
      if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error('Spec change exceeds task artifact limit');
      const candidate = inspectSpecChange(directory, { content });
      if (candidate.errors.length) throw new Error(candidate.errors.join('; '));
      replaceFileAtomically(path.join(directory, 'spec-change.json'), content);
      const checkpoint = publishCheckpoint(directory, { previous, reason: `Spec ${action}: baseline capture requires review before implementation` });
      return { taskId, revision: checkpoint.revision, specChangeHash: specContentHash(content) };
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) { process.stderr.write(`Spec: ${errorMessage(error)}\n`); return 1; }
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
