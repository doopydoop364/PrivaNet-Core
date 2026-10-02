import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import type { z } from 'zod';

/**
 * The wire schemas of an earlier release, taken verbatim from git and compiled on the spot, so a test can parse what THIS Coordinator sends with what THAT release's nodes and tools would parse
 * it with (they are strict objects: one unexpected field and an old node cannot sign in), and can play an old Coordinator's strict heartbeat check. Nothing here is a hand-written copy that could drift.
 * `ALPHA1` is the merge commit of 0.4.0-alpha.1 (PR #37), pinned by hash because that release was never tagged; its protocol file is v0.3.6's apart from the version string.
 */
export const ALPHA1 = '1171c475192b7e19562bba3d29a50f0a61de8f89';
const root = fileURLToPath(new URL('../../', import.meta.url));
export type OldProtocol = Record<string, z.ZodType<unknown>>;
export async function oldProtocol(ref: string): Promise<OldProtocol | undefined> {
  let source: string;
  try { source = execFileSync('git', ['show', `${ref}:packages/protocol/src/index.ts`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024 }); }
  catch { if (process.env.PRIVANET_REQUIRE_COMPAT_TAG === '1') throw new Error(`the base revision ${ref} is required (fetch with full history and tags)`); return undefined; }
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const directory = join(root, 'node_modules', '.privanet-compat'); mkdirSync(directory, { recursive: true });
  const file = join(directory, `protocol-${ref.slice(0, 12)}.mjs`); writeFileSync(file, js);
  return await import(pathToFileURL(file).href) as OldProtocol;
}
