import type { ControlledTaskSnapshot } from './index.js';

/** Model stage delivery. Core chooses the next stage; the model never supplies a transition. */
export interface StageSubmission {
  stateToken: string;
  evidence: string;
  items: Array<{ id: string; evidence: string }>;
  verdict: 'ready' | 'needs-input' | 'changes-required';
  reason: string;
}
/** Trusted deployment configuration, never accepted as model tool arguments. */
export interface FixedCheck {
  id: string;
  command: string;
  args: string[];
  timeoutMs: number;
  testId?: string;
}
export interface AutomationOptions { checks?: FixedCheck[]; maxCorrections?: number }
export interface AutomationProgress { stage: string; failures: number; paused: boolean; lastError: string; approvalPending?: boolean; implementationWritten?: boolean }
export interface AutomationDelivery {
  task: ControlledTaskSnapshot;
  progress: AutomationProgress;
  waitingFor: 'model' | 'approval' | 'human' | 'complete';
  context: string | null;
  nextAction: string;
  recovery: { issue: string; pending: import('./operations.js').PendingOperation | null };
  taskDirectory: string;
}
