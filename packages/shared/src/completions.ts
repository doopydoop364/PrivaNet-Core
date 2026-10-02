/**
 * Shell completion scripts for a command-line program, generated from a table of sub-commands and options. They contain no secret and no state and do nothing but suggest words:
 * they never run the program, the Coordinator or the network. Used by `privanet-node completions` and `privanet-admin completions`.
 */
export const SHELLS = ['bash', 'zsh', 'fish', 'powershell'] as const;
export type Shell = (typeof SHELLS)[number];
export type CompletionTree = Record<string, { subs?: string[]; options?: string[] }>;

export function completionScript(shell: Shell, program: string, tree: CompletionTree): string {
  const names = Object.keys(tree); const fn = '_' + program.replaceAll('-', '_');
  const words = (command: string): string => [...(tree[command]?.subs ?? []), ...(tree[command]?.options ?? [])].join(' ');
  switch (shell) {
    case 'bash': return `# bash completion for ${program}: source this file, or save it in /etc/bash_completion.d/
${fn}() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" cmd="\${COMP_WORDS[1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=( $(compgen -W "${names.join(' ')}" -- "$cur") ); return; fi
  case "$cmd" in
${names.map(name => `    ${name}) COMPREPLY=( $(compgen -W "${words(name)}" -- "$cur") ) ;;`).join('\n')}
  esac
}
complete -F ${fn} ${program}
`;
    case 'zsh': return `#compdef ${program}
# zsh completion for ${program}: save as _${program} in a directory on your $fpath
${fn}() {
  if (( CURRENT == 2 )); then compadd ${names.join(' ')}; return; fi
  case "$words[2]" in
${names.map(name => `    ${name}) compadd -- ${words(name)} ;;`).join('\n')}
  esac
}
compdef ${fn} ${program}
`;
    case 'fish': return `# fish completion for ${program}: save as ~/.config/fish/completions/${program}.fish
complete -c ${program} -f
complete -c ${program} -n '__fish_use_subcommand' -a '${names.join(' ')}'
${names.map(name => `complete -c ${program} -n '__fish_seen_subcommand_from ${name}' -a '${words(name)}'`).join('\n')}
`;
    case 'powershell': return `# PowerShell completion for ${program}: add this to your profile ($PROFILE)
Register-ArgumentCompleter -Native -CommandName ${program} -ScriptBlock {
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
