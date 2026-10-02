import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPrivateFile, isMissing, privateDirectory, readPrivateFile } from '@privanet/shared';

/** The panel's sign-in token: 256 random bits, created once (exclusively, mode 0600) in the node's private state directory. Whoever can read that directory can sign in; nobody else can. */
export const PANEL_TOKEN_FILE = 'panel-token';
export const DEFAULT_PANEL_PORT = 4040;
export async function loadOrCreatePanelToken(stateDir: string): Promise<string> {
  const path = join(await privateDirectory(stateDir), PANEL_TOKEN_FILE);
  try { const existing = (await readPrivateFile(path)).trim(); if (/^[a-f0-9]{64}$/.test(existing)) return existing; } catch (error) { if (!isMissing(error)) throw error; }
  const token = randomBytes(32).toString('hex');
  try { await createPrivateFile(path, token + '\n'); return token; } catch { return (await readPrivateFile(path)).trim(); }
}
export const panelUrl = (port: number): string => `http://127.0.0.1:${port}/`;
