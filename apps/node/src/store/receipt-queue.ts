import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { TransferReceiptSchema } from '@privanet/protocol';
import type { TransferReceipt } from '@privanet/protocol';
import { createPrivateFile, isMissing, privateDirectory, readPrivateFileUpTo, replacePrivateFile } from '@privanet/shared';

export const RECEIPT_FILE = 'transfer-receipts.json';
export const RECEIPT_LIMIT = 4096;
const RecordSchema = z.strictObject({ receipt: TransferReceiptSchema, state: z.enum(['PREPARED', 'COMPLETED', 'FAILED']), failure: z.enum(['ABORTED', 'TIMEOUT', 'INTEGRITY', 'SIZE_MISMATCH', 'STORAGE_FULL', 'UNAVAILABLE', 'IO']).nullable() });
type Record = z.infer<typeof RecordSchema>;
const Schema = z.strictObject({ version: z.literal(1), records: z.array(RecordSchema).max(RECEIPT_LIMIT), checksum: z.string().regex(/^[a-f0-9]{64}$/) });
const checksum = (records: Record[]) => createHash('sha256').update(JSON.stringify(records)).digest('hex');
export class ReceiptQueueError extends Error { constructor(readonly code: 'RECEIPT_STATE_INVALID' | 'RECEIPT_STATE_IO' | 'RECEIPT_QUEUE_FULL') { super(code); } }

/** A write-ahead intent closes the crash window between local commit and receipt creation. */
export class ReceiptQueue {
  private records = new Map<string, Record>(); private tail: Promise<void> = Promise.resolve(); private poisoned = false;
  private constructor(private readonly dir: string) {}
  static async open(stateDir: string): Promise<ReceiptQueue> {
    const dir = await privateDirectory(stateDir); const queue = new ReceiptQueue(dir); const file = join(dir, RECEIPT_FILE);
    let text: string;
    try { text = await readPrivateFileUpTo(file, 4 * 1024 * 1024); }
    catch (error) {
      if (!isMissing(error)) throw new ReceiptQueueError('RECEIPT_STATE_INVALID');
      try { await createPrivateFile(file, JSON.stringify({ version: 1, records: [], checksum: checksum([]) })); await queue.syncDirectory(); }
      catch (e) { if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw new ReceiptQueueError('RECEIPT_STATE_IO'); }
      text = await readPrivateFileUpTo(file, 4 * 1024 * 1024);
    }
    try {
      const value = Schema.parse(JSON.parse(text));
      if (value.checksum !== checksum(value.records) || new Set(value.records.map(r => r.receipt.transferId)).size !== value.records.length) throw new Error();
      queue.records = new Map(value.records.map(r => [r.receipt.transferId, r]));
    } catch { throw new ReceiptQueueError('RECEIPT_STATE_INVALID'); }
    return queue;
  }
  get size(): number { return this.records.size; }
  snapshot(): Record[] { return [...this.records.values()].map(record => structuredClone(record)); }
  private mutate(fn: () => void): Promise<void> {
    const run = this.tail.then(async () => {
      if (this.poisoned) throw new ReceiptQueueError('RECEIPT_STATE_IO');
      fn(); const records = [...this.records.values()];
      try { await replacePrivateFile(join(this.dir, RECEIPT_FILE), JSON.stringify({ version: 1, records, checksum: checksum(records) })); await this.syncDirectory(); }
      catch { this.poisoned = true; throw new ReceiptQueueError('RECEIPT_STATE_IO'); }
    });
    this.tail = run.catch(() => undefined); return run;
  }
  private async syncDirectory(): Promise<void> { if (process.platform !== 'win32') { const handle = await open(this.dir, 'r'); try { await handle.sync(); } finally { await handle.close(); } } }
  prepare(receipt: TransferReceipt): Promise<void> {
    const parsed = TransferReceiptSchema.parse(receipt);
    return this.mutate(() => {
      if (this.records.has(parsed.transferId)) throw new ReceiptQueueError('RECEIPT_STATE_INVALID');
      if (this.records.size >= RECEIPT_LIMIT) throw new ReceiptQueueError('RECEIPT_QUEUE_FULL');
      this.records.set(parsed.transferId, { receipt: parsed, state: 'PREPARED', failure: null });
    });
  }
  complete(id: string, completedAt: number): Promise<void> { return this.mutate(() => {
    const record = this.records.get(id); if (!record || record.state === 'FAILED' || !Number.isSafeInteger(completedAt) || completedAt < 0) throw new ReceiptQueueError('RECEIPT_STATE_INVALID');
    if (record.state === 'COMPLETED') return;
    record.state = 'COMPLETED'; record.receipt.completedAt = completedAt;
  }); }
  fail(id: string, reason: NonNullable<Record['failure']>): Promise<void> { return this.mutate(() => {
    const record = this.records.get(id); if (!record || record.state === 'COMPLETED') return; record.state = 'FAILED'; record.failure = reason;
  }); }
  acknowledge(id: string): Promise<void> { return this.mutate(() => { this.records.delete(id); }); }
  async flush(): Promise<void> { await this.tail; }
}

/** Read-only validation: absent state is normal before the first transfer; corruption never resets it. */
export async function inspectReceiptState(stateDir: string): Promise<void> {
  try { const value = Schema.parse(JSON.parse(await readPrivateFileUpTo(join(stateDir, RECEIPT_FILE), 4 * 1024 * 1024)));
    if (value.checksum !== checksum(value.records) || new Set(value.records.map(r => r.receipt.transferId)).size !== value.records.length) throw new Error();
  } catch (error) { if (!isMissing(error)) throw new ReceiptQueueError('RECEIPT_STATE_INVALID'); }
}
