import { existsSync } from 'node:fs';
import { readTaskFile } from '../core/task-files.js';
import path from 'node:path';
import { parseTaskPlan, validateTaskPlan } from '../core/task-plan.js';
import { validateVerificationContract } from '../core/verification-contract.js';
import { taskPlanHash } from '../core/task-checkpoint.js';

export const authoredArtifacts = ['intake.md', 'prd.md', 'spec.md', 'plan.md', 'changes.md', 'review.md', 'verify.md', 'verification.json', 'spec-change.json'];
export interface AuthoredArtifact { file: string; content: string }

/** Evidence/progress may evolve; changing an approved definition must go through replanning. */
export function assertApprovedArtifacts(directory: string, stage: string, approvedHash: string | undefined, artifacts: AuthoredArtifact[]): void {
  if (approvedHash && !['Spec', 'Plan'].includes(stage) &&
      taskPlanHash(directory, new Map(artifacts.map(item => [item.file, item.content]))) !== approvedHash) {
    throw new Error('Approved plan definitions cannot change in this stage. Keep Artifact/Done When unchanged and submit delivery evidence; to revise scope, submit changes-required with existing evidence to reopen Plan before editing. No documents were written; /workflow approve is not the recovery action.');
  }
}

/** Validate the entire candidate batch before touching the published task. */
export function validateArtifactBatch(directory: string, taskId: string, artifacts: AuthoredArtifact[], stages: string[]): void {
  if (!artifacts.length || artifacts.length > authoredArtifacts.length || new Set(artifacts.map(item => item.file)).size !== artifacts.length) throw new Error('Expected distinct authored artifacts');
  const candidate = new Map(artifacts.map(item => [item.file, item.content]));
  for (const { file, content } of artifacts) {
    if (!authoredArtifacts.includes(file)) throw new Error('Artifact is not a model-authored workflow document');
    if (typeof content !== 'string' || Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error('Invalid artifact content');
  }
  const read = (file: string): string | undefined => candidate.get(file) ?? (existsSync(path.join(directory, file)) ? readTaskFile(directory, file) : undefined);
  const contractText = read('verification.json');
  const contract = contractText === undefined ? undefined : JSON.parse(contractText);
  if (candidate.has('verification.json')) {
    const errors = validateVerificationContract(contract, { expectedTaskId: taskId });
    if (errors.length) throw new Error(errors.join('; '));
    if (!['planned', 'implemented'].includes(contract.contractStatus) || contract.testPoints.some((point: { status: string; evidence: unknown[]; executedAgainst?: unknown }) => point.status !== 'planned' || point.evidence.length || point.executedAgainst !== undefined)) {
      throw new Error('Model-authored verification contracts may contain definitions only, never verification results');
    }
  }
  const planText = read('plan.md');
  if (planText !== undefined) {
    const errors = validateTaskPlan(parseTaskPlan(planText, taskId), { stages, contract });
    if (errors.length) throw new Error(errors.join('; '));
  }
  const delta = read('spec-change.json');
  if (candidate.has('spec-change.json')) {
    const parsed = JSON.parse(delta!);
    if (parsed.taskId !== taskId || parsed.schemaVersion !== 1 || !Array.isArray(parsed.capabilities)) throw new Error('Invalid spec-change identity');
  }
  const spec = read('spec.md');
  if (spec !== undefined && (candidate.has('spec.md') || candidate.has('verification.json'))) {
    const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(spec)?.[1];
    if (!header) throw new Error('spec.md requires frontmatter');
    const version = /^contract_version:\s*(\S+)/m.exec(header)?.[1];
    if (version && (!contract || String(contract.schemaVersion) !== version)) throw new Error('spec contract_version requires matching verification.json in candidate task');
    if (/^task_id:\s*(.+)$/m.exec(header)?.[1]?.trim() !== taskId) throw new Error('spec task_id mismatch');
  }
}
