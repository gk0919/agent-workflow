import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

export interface PendingOperation { id: string; kind: string; startedAt: string; retryToken?: string }
interface Receipt { result?: unknown; error?: string; retryToken?: string }

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
};

/** Host-only receipts live in ignored runtime storage, outside task and approval baselines.
 * A pending marker survives a crash. It never authorizes retrying an uncertain side effect.
 */
export class ControlOperations {
  replayed = false;
  constructor(readonly directory: string) {}
  get pendingPath(): string { return path.join(this.directory, 'pending.json'); }
  pending(): PendingOperation | null {
    if (!existsSync(this.pendingPath)) return null;
    const pending = JSON.parse(readFileSync(this.pendingPath, 'utf8')) as PendingOperation;
    // A crash between receipt publication and marker removal has a known outcome.
    const receiptFile = path.join(this.directory, `${pending.id}.json`);
    if (existsSync(receiptFile) && (JSON.parse(readFileSync(receiptFile, 'utf8')) as Receipt).retryToken === pending.retryToken) {
      unlinkSync(this.pendingPath); return null;
    }
    return pending;
  }
  run<T>(kind: string, input: unknown, execute: () => T, retryToken?: string): T {
    this.replayed = false;
    const id = createHash('sha256').update(JSON.stringify(canonicalize({ kind, input }))).digest('hex');
    const file = path.join(this.directory, `${id}.json`);
    if (this.pending()) throw new Error('Uncertain operation remains; inspect status/diff and use human recover after reconciliation');
    if (existsSync(file)) {
      const receipt = JSON.parse(readFileSync(file, 'utf8')) as Receipt;
      // A known admission failure can become executable only after the host baseline
      // changes (for example a new human approval). Unknown outcomes never use this path.
      if (!receipt.error || !receipt.retryToken || receipt.retryToken === retryToken) {
        this.replayed = true;
        if (receipt.error) throw new Error(receipt.error);
        return receipt.result as T;
      }
    }
    writeFileSync(this.pendingPath, JSON.stringify({ id, kind, startedAt: new Date().toISOString(), retryToken }), { flag: 'wx' });
    let receipt: Receipt;
    try { receipt = { result: execute() }; }
    catch (error: unknown) { receipt = { error: error instanceof Error ? error.message : String(error) }; }
    if (retryToken) receipt.retryToken = retryToken;
    // Publish before releasing the marker. If persistence fails, keep the unknown outcome.
    this.publish(file, receipt);
    unlinkSync(this.pendingPath);
    if (receipt.error) throw new Error(receipt.error);
    return receipt.result as T;
  }
  private publish(file: string, receipt: Receipt): void {
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(receipt), { flag: 'wx' });
    renameSync(temporary, file);
  }
  recover(): void {
    const pending = this.pending();
    if (!pending) return;
    this.publish(path.join(this.directory, `${pending.id}.json`), { error: 'Interrupted operation inspected by human; do not replay. Submit a new request from the reconciled baseline.' });
    unlinkSync(this.pendingPath);
  }
}
