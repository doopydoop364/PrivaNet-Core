import { z } from 'zod';
/** The snapshot the running node publishes for `privanet-node status` and the support bundle (private file, no secrets, replaced atomically). */
export const STATUS_FILE = 'status.json';
export const STATUS_PUBLISH_MS = 10000;
/** Older than this and the node is considered not running. */
export const STATUS_STALE_MS = 35000;
export const StatusFileSchema = z.strictObject({ version: z.literal(1), publishedAt: z.number().int().min(0), status: z.record(z.string(), z.unknown()) });
export type StatusFile = z.infer<typeof StatusFileSchema>;
