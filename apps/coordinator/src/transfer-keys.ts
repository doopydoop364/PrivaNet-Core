import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { KeyIdSchema, TICKET_MAX_LIFETIME_MS, TICKET_MAX_SKEW_MS } from '@privanet/protocol';
import type { KeyRotation, TransferKeys } from '@privanet/protocol';
import { privateKeyFromBase64, readPrivateFileUpTo, replacePrivateFile, transferKeyId } from '@privanet/shared';

/**
 * The Coordinator's transfer-signing keyring (Phase 4). A dedicated Ed25519 key, never the administrator secret, a node's key, an application token or the TLS key. It lives in its own
 * private file in the Coordinator's data directory, NOT in the SQLite database, so `npm run backup` (a copy of the database) never carries it, no database dump contains it, and it is never
 * logged, returned by an API or placed in a support bundle. Only public halves leave this module.
 *
 * Lifecycle: created on first use (exclusively, so two processes starting together agree on one key); one CURRENT key signs; `rotate` makes a new key current and keeps the previous one for
 * a bounded overlap (`KEY_OVERLAP_MS`, long enough for every ticket it signed to expire and be verified) after which it is dropped from the file and from what nodes are told. Rotation never
 * invalidates a ticket that is still valid. Losing the file costs at most the tickets issued in the last two minutes (a new key is generated; nodes fetch the new public key when they next
 * connect), which is why it is documented as "back up if you like, but nothing long-lived depends on it".
 */
export const KEYRING_FILE = 'transfer-keys.json';
/** How long a replaced key still verifies: the longest ticket lifetime, twice (a ticket signed just before rotation, verified just before its expiry), plus the allowed clock skew. */
export const KEY_OVERLAP_MS = 2 * TICKET_MAX_LIFETIME_MS + TICKET_MAX_SKEW_MS;
const MAX_KEYS = 4;
const KeyEntrySchema = z.strictObject({ kid: KeyIdSchema, privateKey: z.string().min(40).max(200), publicKey: z.string().length(60), createdAt: z.number().int().min(0), retireAt: z.number().int().min(0).nullable() });
const FileSchema = z.strictObject({ version: z.literal(1), keys: z.array(KeyEntrySchema).min(1).max(MAX_KEYS) });
type KeyEntry = z.infer<typeof KeyEntrySchema>;
/** A fixed code only; never the file's content or a library message. */
export class KeyringError extends Error { constructor(readonly code: 'KEYRING_INVALID' | 'KEYRING_UNSAFE' | 'KEYRING_IO') { super(code); } }

const generate = (now: number): KeyEntry => {
  const pair = generateKeyPairSync('ed25519'); const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return { kid: transferKeyId(publicKey), privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), publicKey, createdAt: now, retireAt: null };
};
/** Validates a loaded file completely: every key must be what it says it is, and exactly one may be current. */
function validate(raw: unknown): KeyEntry[] {
  const parsed = FileSchema.safeParse(raw); if (!parsed.success) throw new KeyringError('KEYRING_INVALID');
  const keys = parsed.data.keys;
  if (keys.filter(key => key.retireAt === null).length !== 1 || new Set(keys.map(key => key.kid)).size !== keys.length) throw new KeyringError('KEYRING_INVALID');
  for (const key of keys) {
    try {
      const derived = createPublicKey(privateKeyFromBase64(key.privateKey)).export({ format: 'der', type: 'spki' }).toString('base64');
      if (derived !== key.publicKey || transferKeyId(key.publicKey) !== key.kid || privateKeyFromBase64(key.privateKey).asymmetricKeyType !== 'ed25519') throw new KeyringError('KEYRING_INVALID');
    } catch (error) { throw error instanceof KeyringError ? error : new KeyringError('KEYRING_INVALID'); }
  }
  return keys;
}
export class TransferKeyring {
  private constructor(private readonly path: string, private keys: KeyEntry[], private readonly now: () => number) {}
  /**
   * Loads the keyring from `directory`, creating it if the file does not exist. A file that exists but is unsafe (a link, not owner-only, not ours) or damaged is a hard error: it is never
   * silently replaced, because a replaced key would hide tampering and a damaged file deserves an operator's decision (the Coordinator then runs without storage, see main.ts).
   */
  static async open(directory: string, now: () => number = Date.now): Promise<TransferKeyring> {
    const path = join(directory, KEYRING_FILE);
    for (let attempt = 0; attempt < 20; attempt++) {
      const existing = await lstat(path).then(() => true, (error: unknown) => { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw new KeyringError('KEYRING_IO'); });
      if (existing) {
        let text: string;
        try { text = await readPrivateFileUpTo(path, 16384); } catch { throw new KeyringError('KEYRING_UNSAFE'); }
        let raw: unknown; try { raw = JSON.parse(text); } catch { throw new KeyringError('KEYRING_INVALID'); }
        const ring = new TransferKeyring(path, validate(raw), now); await ring.prune(); return ring;
      }
      // Create exclusively: write a private temporary file completely, then link it to the final name (atomic; fails if another process won). The loser re-reads the winner's file.
      const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`; const keys = [generate(now())];
      try {
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        try { await file.writeFile(JSON.stringify({ version: 1, keys })); await file.sync(); } finally { await file.close(); }
        try { await link(temporary, path); return new TransferKeyring(path, keys, now); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw new KeyringError('KEYRING_IO'); await delay(5); }
      } catch (error) { if (error instanceof KeyringError) throw error; throw new KeyringError('KEYRING_IO'); }
      finally { await unlink(temporary).catch(() => undefined); }
    }
    throw new KeyringError('KEYRING_IO');
  }
  private persist(keys: KeyEntry[]): Promise<void> { return replacePrivateFile(this.path, JSON.stringify({ version: 1, keys })); }
  private serial: Promise<unknown> = Promise.resolve();
  private current_(): KeyEntry { const key = this.keys.find(candidate => candidate.retireAt === null); if (!key) throw new KeyringError('KEYRING_INVALID'); return key; }
  /** The key that signs now. */
  current(): { kid: string; privateKey: KeyObject; publicKey: string } { const key = this.current_(); return { kid: key.kid, privateKey: privateKeyFromBase64(key.privateKey), publicKey: key.publicKey }; }
  /** The public keys a verifier may trust at `now`: the current key (no end) and any replaced key still inside its overlap. Public halves only. */
  verificationKeys(now: number = this.now()): TransferKeys['keys'] {
    return this.keys.filter(key => key.retireAt === null || key.retireAt > now).map(key => ({ kid: key.kid, publicKey: key.publicKey, notAfter: key.retireAt })).sort((a, b) => (a.notAfter === null ? -1 : b.notAfter === null ? 1 : b.notAfter - a.notAfter));
  }
  /** Drops keys whose overlap has passed (they can no longer verify anything that is still valid). */
  async prune(): Promise<void> {
    const now = this.now(); const kept = this.keys.filter(key => key.retireAt === null || key.retireAt > now);
    if (kept.length !== this.keys.length) { await this.persist(kept); this.keys = kept; }
  }
  /** Makes a new key current. The old one keeps verifying for `KEY_OVERLAP_MS`. Serialized, and the file is replaced atomically before the in-memory ring changes, so a failed write changes nothing. */
  rotate(): Promise<KeyRotation> {
    const run = this.serial.then(async () => {
      const now = this.now(); const previous = this.current_();
      const live = this.keys.filter(key => key.retireAt === null || key.retireAt > now);
      if (live.length >= MAX_KEYS) throw new KeyringError('KEYRING_INVALID'); // four live keys means rotations are being spammed; wait for an overlap to pass
      const fresh = generate(now); const retireAt = now + KEY_OVERLAP_MS;
      const next = [...live.map(key => key.kid === previous.kid ? { ...key, retireAt } : key), fresh];
      await this.persist(next); this.keys = next;
      return { currentKid: fresh.kid, previousKid: previous.kid, previousValidUntil: retireAt };
    });
    this.serial = run.catch(() => undefined); return run;
  }
  get currentKid(): string { return this.current_().kid; }
  get size(): number { return this.keys.length; }
}
