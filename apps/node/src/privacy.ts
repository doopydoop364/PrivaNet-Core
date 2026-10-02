/** What the local panel's privacy page says. It describes the node as built; changing what the node sends means changing this text and its test. */
export const PRIVACY_STATEMENT = {
  title: 'What stays on this machine, and what does not',
  sections: [
    { heading: 'Stays on this machine', items: [
      'Your node\'s private key (identity.json). It is never sent anywhere and cannot be retrieved through this panel.',
      'Your resource limits, schedule, pause, local display name and the capabilities you switched off (policy.json and local-state.json).',
      'The local history on the Activity tab: one point every five minutes for 24 hours, with the budget the node was permitted to offer and numbers measured on this machine.',
      'The recent log list on this page (kept in memory, cleared when the node stops).',
      'Your monthly transfer counter.' ] },
    { heading: 'What the Coordinator sees', items: [
      'Your node ID (a hash of your public key), the capabilities you advertise, the number of job slots, the software and protocol versions.',
      'A coarse resource report with each heartbeat: your contribution level (OFF, MINIMAL, ADAPTIVE or FULL), a pressure state, the memory and CPU budget you are offering right now, the disk and transfer budget, whether you are on battery, and how long until your schedule turns contribution off. These are permitted budgets derived from your limits, not raw measurements of your machine.',
      'Whether you are draining or leaving. The label the Coordinator\'s owner gave your node, and the jobs it sends you and the results you return.' ] },
    { heading: 'What is never sent', items: [
      'Your host name, user name, operating-system details, installed software, files, browsing, or the local display name you set in this panel.',
      'Raw CPU, memory, disk or network readings.',
      'This panel\'s contents. The panel makes no requests to anyone: it talks only to this node, on this machine.' ] },
    { heading: 'What your node identity is', items: [
      'A key pair made on this machine when you enrolled. The Coordinator knows the public half. It identifies this installation, not you: it carries no name or contact detail unless the owner attached a label.' ] },
    { heading: 'Outbound requests this software can make', items: [
      'To the Coordinator you enrolled with (always, over verified TLS).',
      'Jobs you accepted may fetch web pages on an application\'s behalf, under your fetch limits.',
      '"Check for update" contacts GitHub\'s release API once, only when you press it (or run: privanet-node update check). It sends no identifier of yours.' ] },
  ],
} as const;
