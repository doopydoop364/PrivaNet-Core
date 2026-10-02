import { z } from 'zod';
import { SERVICE_VERSION } from '@privanet/protocol';
import { compareVersions } from './status.js';

/**
 * "Is there a newer release?", asked only when the owner asks (`privanet-node update check`, or the button in the panel): one HTTPS request to a fixed GitHub release address, no redirects,
 * a small bounded answer, validated, and nothing sent about this node (no identity, no version beyond the User-Agent product token). Nothing is downloaded or installed: the answer is
 * a message and the way to upgrade with the installer (which verifies what it downloads). The node never updates itself, so an owner is never surprised by new code running.
 */
export const RELEASES_API = 'https://api.github.com/repos/doopydoop364/PrivaNet-Core/releases/latest';
export const RELEASES_PAGE_PREFIX = 'https://github.com/doopydoop364/PrivaNet-Core/releases/';
const MAX_BYTES = 262144;
const Release = z.object({ tag_name: z.string().regex(/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/).max(64), html_url: z.string().max(300), prerelease: z.boolean().optional(), draft: z.boolean().optional() });

export type UpdateState = 'up-to-date' | 'update-available' | 'ahead-of-release' | 'failed';
export interface UpdateResult { state: UpdateState; current: string; latest: string | null; releaseUrl: string | null; message: string; howToUpgrade: string | null }
export interface UpdateCheckOptions { currentVersion?: string; fetchImpl?: typeof fetch; timeoutMs?: number }

const HOW = 'Download install-node.sh (or install-node.ps1) from that release page, verify it against SHA256SUMS.txt as docs/INSTALLER.md describes, and run it: it keeps this node\'s identity and settings. Nothing was downloaded now.';
export async function checkForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateResult> {
  const current = options.currentVersion ?? SERVICE_VERSION; const fetchImpl = options.fetchImpl ?? fetch;
  const fail = (why: string): UpdateResult => ({ state: 'failed', current, latest: null, releaseUrl: null, message: `Could not check for updates (${why}). Your node is unaffected.`, howToUpgrade: null });
  let response: Response;
  try {
    response = await fetchImpl(RELEASES_API, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 8000), headers: { accept: 'application/vnd.github+json', 'user-agent': `privanet-node/${current}` } });
  } catch { return fail('the release server could not be reached'); }
  if (!response.ok) return fail(`the release server answered ${response.status}`);
  const length = Number(response.headers.get('content-length') ?? 0); if (length > MAX_BYTES) return fail('the answer was too large');
  let text: string; try { text = await response.text(); } catch { return fail('the answer could not be read'); }
  if (text.length > MAX_BYTES) return fail('the answer was too large');
  let release: z.infer<typeof Release>; try { release = Release.parse(JSON.parse(text)); } catch { return fail('the answer was not in the expected form'); }
  if (release.draft || release.prerelease) return fail('the latest release is not a final release');
  if (!release.html_url.startsWith(RELEASES_PAGE_PREFIX) || /[\s"'<>]/.test(release.html_url)) return fail('the release address was not the project\'s');
  const latest = release.tag_name.slice(1); const order = compareVersions(latest, current);
  if (order > 0) return { state: 'update-available', current, latest, releaseUrl: release.html_url, message: `PrivaNet ${latest} is available (this node runs ${current}). Read the release notes before you upgrade.`, howToUpgrade: HOW };
  if (order === 0) return { state: 'up-to-date', current, latest, releaseUrl: release.html_url, message: `This node is up to date (${current}).`, howToUpgrade: null };
  return { state: 'ahead-of-release', current, latest, releaseUrl: release.html_url, message: `This node (${current}) is newer than the latest published release (${latest}): probably a build from source or a pre-release.`, howToUpgrade: null };
}
