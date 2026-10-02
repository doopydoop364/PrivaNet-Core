import { PRESET_IDS } from './presets.js';

/**
 * Shell completion scripts for `privanet-node`. They are generated from the tables below, contain no secret and no state, and do nothing but suggest command names, sub-commands and
 * option names: they never call the node, the Coordinator or the network. Print one and load it the way your shell loads completions (docs/NODE_CONTROL_PANEL.md).
 */
export const SHELLS = ['bash', 'zsh', 'fish', 'powershell'] as const;
export type Shell = (typeof SHELLS)[number];
export const COMPLETION_TREE: Record<string, { subs?: string[]; options?: string[] }> = {
  status: { options: ['--json', '--state-dir'] }, pause: { subs: ['15m', '1h', 'tomorrow', 'reboot', 'indefinite'], options: ['--state-dir'] }, resume: { options: ['--state-dir'] },
  config: { subs: ['check'], options: ['--json', '--state-dir'] }, policy: { subs: ['show', 'export', 'import', 'reset', 'preset', ...PRESET_IDS], options: ['--json', '--state-dir', '--force'] },
  name: { subs: ['show', 'set', 'clear'], options: ['--state-dir'] }, capability: { subs: ['enable', 'disable'], options: ['--state-dir'] }, panel: { options: ['--url-only', '--state-dir'] },
  'support-bundle': { options: ['--no-network', '--log-file', '--state-dir'] }, update: { subs: ['check'], options: ['--json'] }, completions: { subs: [...SHELLS] },
  doctor: { options: ['--coordinator', '--json', '--state-dir', '--timeout', '--no-legend', '--allow-insecure-loopback'] },
  // Only the ways of giving a secret that keep it off the command line are suggested (--invite and --token exist for compatibility but are not completed).
  enroll: { options: ['--coordinator', '--capabilities', '--invite-stdin', '--invite-file', '--token-stdin', '--token-file', '--name', '--wait', '--state-dir', '--allow-insecure-loopback'] },
  join: { options: ['--coordinator', '--capabilities', '--name', '--wait', '--state-dir', '--allow-insecure-loopback'] },
};
const names = Object.keys(COMPLETION_TREE);
const words = (command: string): string => [...(COMPLETION_TREE[command]?.subs ?? []), ...(COMPLETION_TREE[command]?.options ?? [])].join(' ');

export function completionScript(shell: Shell): string {
  switch (shell) {
    case 'bash': return `# bash completion for privanet-node: source this file, or save it in /etc/bash_completion.d/
_privanet_node() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" cmd="\${COMP_WORDS[1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=( $(compgen -W "${names.join(' ')}" -- "$cur") ); return; fi
  case "$cmd" in
${names.map(name => `    ${name}) COMPREPLY=( $(compgen -W "${words(name)}" -- "$cur") ) ;;`).join('\n')}
  esac
}
complete -F _privanet_node privanet-node
`;
    case 'zsh': return `#compdef privanet-node
# zsh completion for privanet-node: save as _privanet-node in a directory on your $fpath
_privanet_node() {
  if (( CURRENT == 2 )); then compadd ${names.join(' ')}; return; fi
  case "$words[2]" in
${names.map(name => `    ${name}) compadd -- ${words(name)} ;;`).join('\n')}
  esac
}
compdef _privanet_node privanet-node
`;
    case 'fish': return `# fish completion for privanet-node: save as ~/.config/fish/completions/privanet-node.fish
complete -c privanet-node -f
complete -c privanet-node -n '__fish_use_subcommand' -a '${names.join(' ')}'
${names.map(name => `complete -c privanet-node -n '__fish_seen_subcommand_from ${name}' -a '${words(name)}'`).join('\n')}
`;
    case 'powershell': return `# PowerShell completion for privanet-node: add this to your profile ($PROFILE)
Register-ArgumentCompleter -Native -CommandName privanet-node -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tree = @{
${names.map(name => `    '${name}' = '${words(name)}'`).join('\n')}
  }
  $elements = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })
  if ($elements.Count -le 1 -or ($elements.Count -eq 2 -and $wordToComplete -ne '')) { $candidates = $tree.Keys | Sort-Object }
  elseif ($tree.ContainsKey($elements[1])) { $candidates = $tree[$elements[1]] -split ' ' }
  else { $candidates = @() }
  $candidates | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`;
  }
}
