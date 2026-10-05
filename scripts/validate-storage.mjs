// Explicit application-side LAN smoke validation. All chunk operations use @privanet/sdk.
// No node/endpoint selection, no admin token, no upload endpoint and no Coordinator payload relay.
import { randomBytes, createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { readPrivateFileUpTo } from '@privanet/shared';
import { PrivaNetClient } from '@privanet/sdk';
const [stage = 'roundtrip', stateFile] = process.argv.slice(2);
if (!['roundtrip', 'prepare-restart', 'verify-restart'].includes(stage) || (stage !== 'roundtrip' && !stateFile) || process.argv.length > (stage === 'roundtrip' ? 3 : 4)) throw new Error('Usage: validate-storage.mjs roundtrip | prepare-restart STATE_FILE | verify-restart STATE_FILE');
const token = process.env.PRIVANET_APP_TOKEN; const url = process.env.PRIVANET_COORDINATOR_URL;
if (!token || !url) throw new Error('Set the application token and trusted Coordinator URL in the environment. Never supply credentials as arguments.');
const client = new PrivaNetClient({ url, token, allowInsecureLoopback: process.env.PRIVANODE_ALLOW_INSECURE_LOOPBACK === 'true' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  if (stage === 'verify-restart') {
    const text = await readPrivateFileUpTo(stateFile, 1024);
    if (text.length > 1024) throw new Error('Invalid validation state');
    const state = JSON.parse(text);
    if (state.version !== 1 || !/^chk_[a-f0-9]{64}$/.test(state.chunkId) || !/^[a-f0-9]{64}$/.test(state.sha256) || state.size !== 8388608) throw new Error('Invalid validation state');
    const bytes = await client.fetch(state.chunkId); if (bytes.length !== state.size || hash(bytes) !== state.sha256) throw new Error('Restart integrity mismatch');
    await client.delete(state.chunkId);
    console.log(JSON.stringify({ stage, restartRetention: true, identicalBytes: true, deleted: true, topology: 'operator-supplied', coordinatorPayloadMeasurement: 'NOT_MEASURED' }));
  } else {
    const bytes = randomBytes(8 * 1024 * 1024); const sha256 = hash(bytes); const chunkId = await client.store(bytes);
    let retained = false;
    try {
      const fetched = await client.fetch(chunkId); if (!bytes.equals(fetched)) throw new Error('Roundtrip integrity mismatch');
      if (stage === 'prepare-restart') {
        const file = await open(stateFile, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ version: 1, chunkId, sha256, size: bytes.length }) + '\n'); await file.sync(); }
        finally { await file.close(); }
        retained = true;
        console.log(JSON.stringify({ stage, identicalBytes: true, retainedForRestart: true, stateFileWritten: true, coordinatorPayloadMeasurement: 'NOT_MEASURED' }));
      }
    } finally { if (!retained) await client.delete(chunkId); }
    if (stage === 'roundtrip') console.log(JSON.stringify({ stage, store: true, identicalBytes: true, delete: true, payloadBytes: bytes.length * 2, coordinatorPayloadMeasurement: 'NOT_MEASURED' }));
  }
} catch (error) { console.error(JSON.stringify({ stage, code: error && typeof error === 'object' && 'code' in error && /^[A-Z_]{1,64}$/.test(String(error.code)) ? error.code : 'VALIDATION_FAILED' })); process.exitCode = 1; }
