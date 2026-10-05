import { PRESET_IDS } from './presets.js';
import { SHELLS, completionScript as generate } from '@privanet/shared';
import type { CompletionTree, Shell } from '@privanet/shared';

/** Shell completion for `privanet-node` (the generator is shared with `privanet-admin`; see packages/shared/src/completions.ts). */
export { SHELLS };
export type { Shell };
export const COMPLETION_TREE: CompletionTree = {
  status: { options: ['--json', '--state-dir'] }, pause: { subs: ['15m', '1h', 'tomorrow', 'reboot', 'indefinite'], options: ['--state-dir'] }, resume: { options: ['--state-dir'] },
  config: { subs: ['check'], options: ['--json', '--state-dir'] }, policy: { subs: ['show', 'export', 'import', 'reset', 'preset', ...PRESET_IDS], options: ['--json', '--state-dir', '--force'] },
  name: { subs: ['show', 'set', 'clear'], options: ['--state-dir'] }, capability: { subs: ['enable', 'disable'], options: ['--state-dir'] }, storage: { subs: ['status', 'enable', 'disable', 'capacity', 'reserve', 'transfer', 'cert', 'endpoint', 'bind', 'port', 'generate'], options: ['--json', '--state-dir', '--allow-reserve-reduction', '--ip', '--renew'] }, settings: { subs: ['show'], options: ['--json', '--state-dir'] }, slots: { subs: ['show', 'set', 'clear'], options: ['--json', '--state-dir'] }, panel: { options: ['--url-only', '--state-dir'] },
  'support-bundle': { options: ['--no-network', '--log-file', '--state-dir'] }, update: { subs: ['check'], options: ['--json'] }, completions: { subs: [...SHELLS] },
  doctor: { options: ['--coordinator', '--json', '--state-dir', '--timeout', '--no-legend', '--allow-insecure-loopback'] },
  // Only the ways of giving a secret that keep it off the command line are suggested (--invite and --token exist for compatibility but are not completed).
  enroll: { options: ['--coordinator', '--capabilities', '--invite-stdin', '--invite-file', '--token-stdin', '--token-file', '--name', '--wait', '--state-dir', '--allow-insecure-loopback'] },
  join: { options: ['--coordinator', '--capabilities', '--name', '--wait', '--state-dir', '--allow-insecure-loopback'] },
};
export const completionScript = (shell: Shell): string => generate(shell, 'privanet-node', COMPLETION_TREE);
