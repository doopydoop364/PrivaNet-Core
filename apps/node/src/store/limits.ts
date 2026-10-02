import { STORAGE_MAX_CHUNK_BYTES } from '@privanet/protocol';

/**
 * The chunk store's fixed limits, in one place. A chunk is at most 8 MiB: large enough that an application can move real data in few operations, small enough that one chunk is
 * cheap to hash, to hold in a bounded buffer, to re-send after an interruption (resume is chunk restart, see docs/PHASE4_DESIGN.md) and to refuse when it does not fit. Raising it
 * is a deliberate, versioned decision, never a configuration knob. The value is the protocol's `STORAGE_MAX_CHUNK_BYTES`, so the store, the Coordinator's placement and the wire schemas cannot disagree. There is no compression, no range read or write and no multipart object in Core.
 */
export const MAX_CHUNK_BYTES = STORAGE_MAX_CHUNK_BYTES;
/** Puts allowed at once on one store (each reserves its declared size against the quota while it runs). */
export const MAX_IN_FLIGHT_PUTS = 8;
/** An unfinished partial file older than this is debris from a crash and is removed at start-up (and by `sweepIncoming`). Recent ones are left alone. */
export const DEFAULT_STALE_INCOMING_MS = 10 * 60 * 1000;
