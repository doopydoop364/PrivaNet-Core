import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReceiptQueue, RECEIPT_FILE, ReceiptQueueError } from '@privanet/node/store/receipt-queue';
const evidence = () => ({ transferId: 'ab'.repeat(16), applicationId: randomUUID(), nodeId: `node_${'cd'.repeat(32)}`, operation: 'put' as const, chunkId: `chk_${'ef'.repeat(32)}`, sha256: 'ef'.repeat(32), bytes: 1024, completedAt: Date.now() });
async function directory(t: test.TestContext) { const dir = await mkdtemp(join(tmpdir(), 'privanet-receipts-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
test('receipt write-ahead preparation, completion and acknowledgement survive reopen; completion is immutable/idempotent', async t => {
  const dir = await directory(t); let queue = await ReceiptQueue.open(dir); const receipt = evidence();
  await queue.prepare(receipt); queue = await ReceiptQueue.open(dir); assert.equal(queue.snapshot()[0]?.state, 'PREPARED');
  await queue.complete(receipt.transferId, receipt.completedAt + 5); await queue.complete(receipt.transferId, receipt.completedAt + 500); await queue.fail(receipt.transferId, 'IO');
  queue = await ReceiptQueue.open(dir); assert.equal(queue.snapshot()[0]?.state, 'COMPLETED'); assert.equal(queue.snapshot()[0]?.receipt.completedAt, receipt.completedAt + 5);
  await queue.acknowledge(receipt.transferId); await queue.acknowledge(receipt.transferId); assert.equal((await ReceiptQueue.open(dir)).size, 0);
});
test('receipt checksum/JSON corruption is refused without rewriting the security state', async t => {
  for (const value of ['{broken', '{"version":1,"records":[],"checksum":"' + '00'.repeat(32) + '"}']) {
    const dir = await directory(t); const file = join(dir, RECEIPT_FILE); await writeFile(file, value, { mode: 0o600 });
    await assert.rejects(ReceiptQueue.open(dir), e => e instanceof ReceiptQueueError && e.code === 'RECEIPT_STATE_INVALID'); assert.equal(await readFile(file, 'utf8'), value);
  }
});
test('receipt state does not follow links', { skip: process.platform === 'win32' }, async t => {
  const dir = await directory(t); const target = join(dir, 'outside'); await writeFile(target, 'untouched', { mode: 0o600 }); await symlink(target, join(dir, RECEIPT_FILE));
  await assert.rejects(ReceiptQueue.open(dir)); assert.equal(await readFile(target, 'utf8'), 'untouched');
});
test('a failed receipt cannot become completed and duplicate preparation cannot replace evidence', async t => {
  const queue = await ReceiptQueue.open(await directory(t)); const receipt = evidence(); await queue.prepare(receipt);
  await assert.rejects(queue.prepare({ ...receipt, bytes: 2 })); await queue.fail(receipt.transferId, 'ABORTED'); await assert.rejects(queue.complete(receipt.transferId, Date.now()));
  assert.equal(queue.snapshot()[0]?.receipt.bytes, 1024); assert.equal(queue.snapshot()[0]?.state, 'FAILED');
});
