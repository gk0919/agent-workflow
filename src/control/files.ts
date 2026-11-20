import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ControlledSearch { query: string; path?: string; extensions?: string[]; maxResults?: number }
export interface SearchResult { matches: Array<{ path: string; line: number; text: string }>; scannedFiles: number; truncated: boolean }
export interface ControlledChange { path: string; beforeHash: string | null; content: string | null }
export const contentHash = (content: Buffer | string): string => createHash('sha256').update(content).digest('hex');
const MAX_BYTES = 4 * 1024 * 1024;

/** File capabilities deliberately exclude shell, Git writes and workflow/deployment metadata. */
export class ControlledFiles {
  readonly root: string;
  constructor(root: string) { this.root = realpathSync(root); }

  resolve(relative: string, write = false): string {
    if (!relative || relative.includes('\\') || relative.includes(':') || path.isAbsolute(relative) ||
        relative.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$|[\x00-\x1f]/.test(part) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error('Expected a canonical workspace-relative path');
    const parts = relative.split('/');
    if (write && parts.some((part) => ['.git', '.agent-workflow', '.agents', 'node_modules', 'agents.md'].includes(part.toLowerCase()))) {
      throw new Error('Workflow, repository and deployment metadata are protected');
    }
    let target = this.root;
    for (const [index, part] of parts.entries()) {
      target = path.join(target, part);
      if (!existsSync(target)) {
        // Do not create parent directories or traverse dangling links.
        try { lstatSync(target); throw new Error('Dangling link is not allowed'); }
        catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (index !== parts.length - 1) throw new Error('Parent directory must exist');
        continue;
      }
      const stats = lstatSync(target);
      if (stats.isSymbolicLink() || realpathSync(target) !== target) throw new Error('Links and redirected paths are not allowed');
      if (index < parts.length - 1 && !stats.isDirectory()) throw new Error('Parent is not a directory');
      if (write && index === parts.length - 1 && (!stats.isFile() || stats.nlink !== 1)) throw new Error('Expected an unlinked regular file');
    }
    return target;
  }

  read(relative: string): { path: string; hash: string; content: string } {
    const target = this.resolve(relative);
    if (!lstatSync(target).isFile() || lstatSync(target).size > MAX_BYTES) throw new Error('Expected a bounded text file');
    const bytes = readFileSync(target);
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (content.includes('\0')) throw new Error('Binary files are unsupported');
    return { path: relative, hash: contentHash(bytes), content };
  }

  list(relative?: string): string[] {
    const target = relative ? this.resolve(relative) : this.root;
    return readdirSync(target, { withFileTypes: true }).slice(0, 1000)
      .filter((entry) => !entry.isSymbolicLink()).map((entry) => entry.name + (entry.isDirectory() ? '/' : ''));
  }

  /** Literal search only. Fixed traversal/output budgets keep repository scans bounded. */
  search(input: ControlledSearch): SearchResult {
    const limit = input.maxResults ?? 100;
    if (!input.query || input.query.length > 256 || input.query.includes('\n') ||
        !Number.isInteger(limit) || limit < 1 || limit > 200 ||
        input.extensions?.some((value) => !/^[a-z0-9]+$/i.test(value))) throw new Error('Expected a literal query, extensions without dots and maxResults 1–200');
    const start = input.path ? this.resolve(input.path) : this.root;
    const result: SearchResult = { matches: [], scannedFiles: 0, truncated: false };
    const excluded = new Set(['.git', 'node_modules', '.agent-workflow', 'dist', 'build', 'coverage']);
    let visited = 0, bytes = 0;
    const visit = (target: string): void => {
      if (++visited > 10_000) { result.truncated = true; return; }
      const stats = lstatSync(target);
      if (stats.isSymbolicLink()) return;
      if (stats.isDirectory()) {
        for (const name of readdirSync(target).sort()) {
          if (!excluded.has(name.toLowerCase())) visit(path.join(target, name));
          if (result.truncated) break;
        }
        return;
      }
      if (!stats.isFile() || stats.size > MAX_BYTES ||
          (input.extensions?.length && !input.extensions.includes(path.extname(target).slice(1)))) return;
      bytes += stats.size;
      if (bytes > 32 * 1024 * 1024) { result.truncated = true; return; }
      result.scannedFiles++;
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(target)); }
      catch (error) { if (error instanceof TypeError) return; throw error; }
      if (content.includes('\0')) return;
      const relative = path.relative(this.root, target).split(path.sep).join('/');
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        if (!line.includes(input.query)) continue;
        if (result.matches.length === limit) { result.truncated = true; return; }
        result.matches.push({ path: relative, line: index + 1, text: line.slice(Math.max(0, line.indexOf(input.query) - 128), Math.max(0, line.indexOf(input.query) - 128) + 512) });
      }
    };
    visit(start);
    return result;
  }

  baseline(relative: string): string | null {
    const target = this.resolve(relative, true);
    return existsSync(target) ? this.read(relative).hash : null;
  }

  apply(changes: readonly ControlledChange[]): string[] {
    if (!changes.length || changes.length > 100 || new Set(changes.map((change) => change.path.toLowerCase())).size !== changes.length) throw new Error('Expected 1–100 distinct file changes');
    for (const change of changes) {
      if (this.baseline(change.path) !== change.beforeHash) throw new Error(`File baseline changed: ${change.path}`);
      if (change.content !== null && (Buffer.byteLength(change.content) > MAX_BYTES || change.content.includes('\0'))) throw new Error('Expected bounded text content');
      if (change.beforeHash === null && change.content === null) throw new Error('Cannot delete an absent file');
    }
    const applied: string[] = [];
    try {
      for (const change of changes) {
        const target = this.resolve(change.path, true);
        if (change.content === null) unlinkSync(target);
        else {
          const temporary = `${target}.${randomUUID()}.tmp`;
          try {
            writeFileSync(temporary, change.content, { encoding: 'utf8', flag: 'wx', ...(existsSync(target) ? { mode: lstatSync(target).mode } : {}) });
            renameSync(temporary, target);
          } finally { if (existsSync(temporary)) unlinkSync(temporary); }
        }
        applied.push(change.path);
      }
    } catch (error: unknown) {
      throw new Error(`Write failed; already applied: ${applied.join(', ') || 'none'}`, { cause: error });
    }
    return applied;
  }

  /** Cross-session writer exclusion; external editors remain outside this process's trust boundary. */
  lock<T>(callback: () => T): T {
    // Keep the writer lock outside repository fingerprints, including hosts that track config.
    const lockPath = path.join(os.tmpdir(), `agent-workflow-control-${contentHash(this.root)}.lock`);
    const descriptor = openSync(lockPath, 'wx');
    try { return callback(); }
    finally { closeSync(descriptor); unlinkSync(lockPath); }
  }
}
