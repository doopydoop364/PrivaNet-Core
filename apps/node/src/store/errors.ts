/**
 * The store's fixed error vocabulary. A caller never sees a filesystem error message, a host path or an exception string: only one of these codes (which is also what an
 * application will later receive over the wire), so nothing about the machine leaks and every failure is something a caller can act on.
 */
export const STORE_ERROR_CODES = [
  'INVALID_ID', 'INVALID_SIZE', 'TOO_LARGE', 'SIZE_MISMATCH', 'INTEGRITY', 'NOT_FOUND', 'STORAGE_FULL', 'UNAVAILABLE', 'BUSY', 'STORE_UNSAFE', 'ABORTED', 'IO',
] as const;
export type StoreErrorCode = (typeof STORE_ERROR_CODES)[number];
export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode, /** Why a put was refused as UNAVAILABLE (disabled, paused, ...). Always one of the gate's fixed words. */ readonly reason?: string) { super(code); this.name = 'StoreError'; }
}
export const isStoreError = (error: unknown, code?: StoreErrorCode): error is StoreError => error instanceof StoreError && (code === undefined || error.code === code);
