import type { PluginPermission } from '../contracts/plugin.js';
import type {
  WorkflowDefinition,
  WorkflowExecutionMode,
} from '../contracts/execution.js';

const SAFE_READONLY_PERMISSIONS = new Set<PluginPermission>([
  'artifact:read',
  'workspace:read',
]);

const serialPolicyFindings = (definition: WorkflowDefinition): string[] => {
  const findings: string[] = [];
  if (definition.limits.maxExternalWrites !== 0) {
    findings.push('Phase 1 要求 limits.maxExternalWrites 为 0');
  }
  for (const node of definition.nodes) {
    if (
      node.type === 'integrator' ||
      node.type === 'map' ||
      node.type === 'parallel' ||
      node.type === 'reduce'
    ) {
      findings.push(`节点 ${node.id}：Phase 1 不支持 ${node.type} 节点`);
      continue;
    }
    if (node.type !== 'agent') {
      continue;
    }
    if (node.workspace?.mode === 'exclusive-worktree') {
      findings.push(`节点 ${node.id}：Phase 1 不支持可写或独占 Worktree`);
    }
    if (node.workspace?.repository) {
      findings.push(`节点 ${node.id}：Phase 1 尚未开放 repository binding`);
    }
    const unsafePermissions = (node.permissions ?? [])
      .filter((permission) => !SAFE_READONLY_PERMISSIONS.has(permission))
      .sort();
    if (unsafePermissions.length > 0) {
      findings.push(`节点 ${node.id}：Phase 1 不允许权限 ${unsafePermissions.join(', ')}`);
    }
  }
  return findings.sort();
};

const parallelReadonlyPolicyFindings = (definition: WorkflowDefinition): string[] => {
  const findings: string[] = [];
  if (definition.limits.maxExternalWrites !== 0) {
    findings.push('Phase 2 要求 limits.maxExternalWrites 为 0');
  }
  for (const node of definition.nodes) {
    if (node.type === 'integrator') {
      findings.push(`节点 ${node.id}：Phase 2 不支持 integrator 节点`);
      continue;
    }
    if (node.type !== 'agent' && node.type !== 'map') {
      continue;
    }
    if (node.workspace?.mode === 'exclusive-worktree') {
      findings.push(`节点 ${node.id}：Phase 2 只允许共享只读 Workspace`);
    }
    if (node.workspace?.repository) {
      findings.push(`节点 ${node.id}：Phase 2 尚未开放 repository binding`);
    }
    const unsafePermissions = (node.permissions ?? [])
      .filter((permission) => !SAFE_READONLY_PERMISSIONS.has(permission))
      .sort();
    if (unsafePermissions.length > 0) {
      findings.push(`节点 ${node.id}：Phase 2 不允许权限 ${unsafePermissions.join(', ')}`);
    }
  }
  return findings.sort();
};

const writablePolicyFindings = (definition: WorkflowDefinition): string[] => {
  const findings: string[] = [];
  for (const node of definition.nodes) {
    if (node.type !== 'agent' && node.type !== 'map') {
      continue;
    }
    if (!node.effect) {
      if (node.workspace?.mode === 'exclusive-worktree' || node.workspace?.repository) {
        findings.push(`节点 ${node.id}：无 effect 的节点只能使用共享只读 Workspace`);
      }
      const unsafePermissions = (node.permissions ?? [])
        .filter((permission) => !SAFE_READONLY_PERMISSIONS.has(permission))
        .sort();
      if (unsafePermissions.length > 0) {
        findings.push(`节点 ${node.id}：无 effect 时不允许权限 ${unsafePermissions.join(', ')}`);
      }
      continue;
    }
    if (node.failurePolicy === 'isolate') {
      findings.push(`节点 ${node.id}：写入 effect 不允许 failurePolicy isolate`);
    }
    if (
      node.effect.kind === 'external-write' &&
      (node.workspace?.mode === 'exclusive-worktree' || node.workspace?.repository)
    ) {
      findings.push(`节点 ${node.id}：external-write 不能声明 repository Workspace`);
    }
  }
  return findings.sort();
};

/** Applies the existing phase policy before a dynamic preview can be approved. */
export const executionModePolicyFindings = (
  definition: WorkflowDefinition,
  executionMode: WorkflowExecutionMode,
): string[] => {
  switch (executionMode) {
    case 'serial':
      return serialPolicyFindings(definition);
    case 'parallel-readonly':
      return parallelReadonlyPolicyFindings(definition);
    case 'writable-worktree':
      return writablePolicyFindings(definition);
  }
};
