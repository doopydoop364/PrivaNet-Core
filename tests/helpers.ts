import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { Challenge, JobType } from '@privanet/protocol';
import { PROTOCOL_VERSION, SERVICE_VERSION } from '@privanet/protocol';
import { Coordinator } from '@privanet/coordinator/service';
import { SqliteStore } from '@privanet/coordinator/store';
import type { Store } from '@privanet/coordinator/model';
export const heartbeat = (capabilities: JobType[] = ['system.echo.v1']) => ({
  protocolVersion: PROTOCOL_VERSION, daemonVersion: SERVICE_VERSION, capabilities, jobSlots: 1, currentJobs: 0,
});
export function identity() {
  const pair = generateKeyPairSync('ed25519');
  return { publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    proof: (challenge: Challenge) => ({ challengeId: challenge.challengeId, signature: sign(null, Buffer.from(challenge.message), pair.privateKey).toString('hex') }) };
}
export function fixture(store: Store = new SqliteStore(':memory:')) {
  let now = 1000000;
  const core = new Coordinator(store, { staleMs: 100, offlineMs: 500, leaseMs: 50, maxAttempts: 2, sessionMs: 1000, challengeMs: 100 }, () => now);
  const appCredential = core.createApplication({ name: 'test', allowedJobTypes: ['system.echo.v1'] });
  const app = core.authenticateApplication(appCredential.token);
  function enroll(capabilities: JobType[] = ['system.echo.v1']) {
    const key = identity(); const grant = core.createEnrollment({ expiresInMs: 1000, capabilities });
    const challenge = core.beginEnrollment({ token: grant.token, publicKey: key.publicKey, protocolVersion: 1, daemonVersion: '0.1.0', capabilities });
    const session = core.prove(key.proof(challenge), 'enroll');
    return { key, grant, challenge, session };
  }
  return { core, store, app, appCredential, enroll,
    advance(ms: number) { now += ms; }, now: () => now,
    submit: (message = 'hello', key: string = randomUUID()) => core.submit(app, { type: 'system.echo.v1', input: { message }, idempotencyKey: key }) };
}
