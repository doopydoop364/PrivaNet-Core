/**
 * The panel's single page. It is served with a strict Content-Security-Policy (only this page's own nonce'd script and style, connections to itself only) and builds every piece of
 * text with `textContent`, never `innerHTML`, so a node name or a log entry can never become markup. State is shown as words ("OK", "WARNING", "FAILED"), not by color alone.
 */
export function renderPage(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PrivaNode control panel</title>
<style nonce="${nonce}">
:root{--bg:#fff;--fg:#1b1f23;--muted:#586069;--line:#d0d7de;--card:#f6f8fa;--accent:#0b5cad}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9da7b3;--line:#30363d;--card:#161b22;--accent:#58a6ff}}
body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:12px 16px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{font-size:18px;margin:0}main{max-width:980px;margin:0 auto;padding:12px 16px 48px}
nav{display:flex;gap:4px;flex-wrap:wrap;margin:8px 0 16px}
button,select,input{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:6px 10px}
button{cursor:pointer}button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}button.danger{border-color:#b42318}
button[aria-pressed=true]{outline:2px solid var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:0 0 12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.k{color:var(--muted);font-size:13px}.badge{display:inline-block;border:1px solid var(--line);border-radius:4px;padding:0 6px;font-size:13px;font-weight:600}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
label{display:block;margin:6px 0}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0}
.inl{display:inline-block;margin-right:6px}.grow{flex:1}.hidden{display:none}.err{border-color:#b42318}.note{color:var(--muted);font-size:13px}
input[type=number]{width:110px}input[type=text]{width:260px}
</style></head><body>
<header><h1>PrivaNode control panel</h1><span id="headline" class="note" role="status"></span><span class="grow"></span><button id="logout" class="hidden">Sign out</button></header>
<main>
<section id="login" class="card hidden"><h2>Sign in</h2>
<p>Run <code>privanet-node panel</code> on this machine (as the node's account) to get a sign-in link. Opening it signs you in here; or paste the panel token:</p>
<div class="row"><input id="token" type="password" autocomplete="off" aria-label="Panel token" maxlength="64"><button id="signin" class="primary">Sign in</button></div><p id="loginmsg" class="note" role="alert"></p></section>
<div id="app" class="hidden">
<nav id="tabs" aria-label="Sections"></nav>
<section id="tab-status"></section><section id="tab-contribute" class="hidden"></section><section id="tab-activity" class="hidden"></section><section id="tab-diag" class="hidden"></section><section id="tab-privacy" class="hidden"></section>
</div></main>
<script nonce="${nonce}">
'use strict';
var csrf = '', features = {}, current = 'status', poll = null, policyDoc = null, dirty = false;
function h(tag, attrs) { var el = document.createElement(tag); if (attrs) for (var k in attrs) { if (k === 'text') el.textContent = attrs[k]; else if (k === 'on') { for (var e in attrs.on) el.addEventListener(e, attrs.on[e]); } else if (attrs[k] === true) el.setAttribute(k, ''); else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, String(attrs[k])); }
  function add(c) { if (c == null || c === false) return; if (Array.isArray(c)) { c.forEach(add); return; } el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c))); }
  for (var i = 2; i < arguments.length; i++) add(arguments[i]); return el; }
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
function $(id) { return document.getElementById(id); }
function api(method, path, body) {
  var init = { method: method, credentials: 'same-origin', headers: {} };
  if (method === 'POST') { init.headers['content-type'] = 'application/json'; init.headers['x-csrf-token'] = csrf; init.body = JSON.stringify(body || {}); }
  return fetch(path, init).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }, function () { return { status: r.status, body: {} }; }); });
}
function bytes(n) { if (n === null || n === undefined) return 'unlimited'; if (n >= 1073741824) return (n / 1073741824).toFixed(n % 1073741824 === 0 ? 0 : 1) + ' GiB'; if (n >= 1048576) return Math.round(n / 1048576) + ' MiB'; return Math.round(n / 1024) + ' KiB'; }
function when(t) { return t ? new Date(t).toLocaleString() : 'never'; }
function ago(t) { if (!t) return 'never'; var s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 90 ? s + 's ago' : Math.round(s / 60) + ' min ago'; }
function kv(k, v) { return h('div', null, h('div', { class: 'k', text: k }), h('div', { text: v == null ? '—' : String(v) })); }

var TABS = [['status', 'Status'], ['contribute', 'Contribute'], ['activity', 'Activity'], ['diag', 'Diagnostics'], ['privacy', 'Privacy & logs']];
function buildTabs() { var nav = clear($('tabs')); TABS.forEach(function (t) { nav.appendChild(h('button', { 'aria-pressed': t[0] === current ? 'true' : 'false', text: t[1], on: { click: function () { show(t[0]); } } })); }); }
function show(name) { current = name; TABS.forEach(function (t) { $('tab-' + t[0]).classList.toggle('hidden', t[0] !== name); }); buildTabs(); refresh(); }

var flash = null;
function toast(el, message, bad) { flash = { text: (bad ? 'WARNING: ' : 'OK: ') + message, bad: !!bad, at: Date.now() }; clear(el); el.appendChild(h('p', { role: 'alert', class: bad ? 'note err' : 'note', text: flash.text })); }
function flashNode() { return flash && Date.now() - flash.at < 12000 ? h('p', { role: 'alert', class: flash.bad ? 'card err' : 'card', text: flash.text }) : null; }
function act(path, body, el, ok) { return api('POST', path, body).then(function (r) { if (r.status === 200) { if (ok) ok(r.body); refresh(); } else toast(el, (r.body.error && r.body.error.code || 'failed') + (r.body.error && r.body.error.issues ? ': ' + r.body.error.issues.join('; ') : ''), true); }); }

function renderStatus(s) {
  var root = clear($('tab-status')); var idle = s.idle; var c = s.contribution; { var fl = flashNode(); if (fl) root.appendChild(fl); }
  var names = [s.node.localName, s.node.coordinatorLabel].filter(Boolean).join(' / ') || '(unnamed)';
  $('headline').textContent = (idle.idle ? 'Idle' : 'Working') + ': ' + idle.summary;
  root.appendChild(h('div', { class: 'card' }, h('h2', { text: idle.idle ? 'Why this node is idle' : 'What this node is doing' }), h('p', { text: idle.summary }),
    h('ul', null, idle.reasons.filter(function (r) { return r.message !== idle.summary; }).map(function (r) { return h('li', null, h('span', { class: 'badge', text: r.severity.toUpperCase() }), ' ' + r.message); }))));
  var pause = c.pause ? ('PAUSED (' + c.pause.kind + (c.pause.until ? ' until ' + when(c.pause.until) : '') + ')') : c.mode;
  root.appendChild(h('div', { class: 'grid' },
    h('div', { class: 'card' }, h('h3', { text: 'This node' }), kv('Local name (this machine only)', s.node.localName), kv('Coordinator\\'s label for it', s.node.coordinatorLabel), kv('Node ID (abbreviated)', s.node.id), kv('Software / protocol', s.node.version + ' / ' + s.node.protocolVersion), kv('Uptime', Math.round(s.node.uptimeMs / 60000) + ' min')),
    h('div', { class: 'card' }, h('h3', { text: 'Coordinator' }), kv('Host', s.coordinator.host), kv('Connection', s.connection.state.toUpperCase()), kv('Last contact', ago(s.connection.lastContactAt)), kv('Version / protocol', (s.coordinator.serviceVersion || '?') + ' / ' + (s.coordinator.protocolVersion || '?')), kv('Compatibility', s.coordinator.compatibility.state + ': ' + s.coordinator.compatibility.message)),
    h('div', { class: 'card' }, h('h3', { text: 'Contribution' }), kv('Mode', pause), kv('Schedule says', c.scheduleLevel), kv('Preset', c.preset), kv('Pressure', c.pressure), kv('Policy in force', c.policySource ? c.policySource.kind : 'defaults'),
      kv('Jobs', s.jobs.active.length + ' running; ' + s.jobs.slots.effective + ' slot(s)'), kv('Counters', 'completed ' + s.jobs.counters.completed + ', failed ' + s.jobs.counters.failed + ', preempted ' + s.jobs.counters.preempted))));
  c.problems.forEach(function (p) { root.appendChild(h('div', { class: 'card err' }, h('strong', { text: 'PROBLEM ' + p.code }), h('div', { text: p.issues.join('; ') }))); });
  if (c.restartRequired.length) root.appendChild(h('div', { class: 'card' }, 'Restart needed for: ' + c.restartRequired.join(', ')));
  var msg = h('div', { id: 'statusmsg' });
  var row = h('div', { class: 'row' }, h('span', { class: 'k', text: 'Pause:' }));
  [['15m', '15 minutes'], ['1h', '1 hour'], ['tomorrow', 'Until tomorrow'], ['reboot', 'Until reboot'], ['indefinite', 'Indefinitely']].forEach(function (p) { row.appendChild(h('button', { text: p[1], on: { click: function () { act('/api/pause', { kind: p[0] }, msg, function () { toast(msg, 'Paused.'); }); } } })); });
  row.appendChild(h('button', { class: 'primary', text: 'Resume', on: { click: function () { act('/api/resume', {}, msg, function () { toast(msg, 'Resumed.'); }); } } }));
  var row2 = h('div', { class: 'row' }, h('span', { class: 'k', text: 'Node:' }),
    h('button', { class: 'danger', text: 'Drain and stop', on: { click: function () { if (confirm('Stop accepting new work, finish or hand back running jobs, and stop the node?')) act('/api/drain', { confirm: true }, msg, function (b) { toast(msg, b.message); }); } } }),
    h('button', { text: 'Restart', on: { click: function () { if (confirm('Drain and restart the node? Under a service manager it comes back by itself; run by hand it only stops.')) act('/api/restart', { confirm: true }, msg, function (b) { toast(msg, b.message); }); } } }));
  root.appendChild(h('div', { class: 'card' }, h('h3', { text: 'Actions' }), row, row2, msg, h('p', { class: 'note', text: 'A pause is not a revocation: the node stays enrolled and keeps its identity. A timed pause ends by itself, even across a restart of the node.' })));
}

var FIELDS = [
  ['maxCpuPercent', 'Most CPU to contribute (%)', 'int', 0, 100], ['reserveCpuPercent', 'CPU always left to you (%)', 'int', 0, 100],
  ['maxMemoryBytes', 'Most memory to contribute (GiB)', 'gib', 0, 1024], ['reserveMemoryBytes', 'Free memory always left to you (GiB)', 'gib', 0, 1024], ['safetyMarginBytes', 'Safety margin (GiB)', 'gib', 0, 1024],
  ['maxDiskBytes', 'Scratch disk to use (GiB)', 'gib', 0, 1024], ['reserveDiskBytes', 'Free disk always left to you (GiB)', 'gib', 0, 1024],
  ['maxBandwidthBytesPerSec', 'Bandwidth ceiling (MiB/s, blank = unlimited)', 'mibnull', 0, 100000], ['monthlyTransferBytes', 'Monthly transfer allowance (GiB, blank = unlimited)', 'gibnull', 0, 100000]
];
var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function toUi(kind, v) { if (kind === 'int') return v; if (kind === 'gib' || kind === 'gibnull') return v === null ? '' : +(v / 1073741824).toFixed(3); if (kind === 'mibnull') return v === null ? '' : +(v / 1048576).toFixed(3); return v; }
function fromUi(kind, text) { if (kind === 'int') return parseInt(text, 10); if (text === '' && kind.indexOf('null') >= 0) return null; var n = parseFloat(text); if (!isFinite(n)) return NaN; return Math.round(n * (kind.indexOf('mib') === 0 ? 1048576 : 1073741824)); }
function renderContribute(d) {
  if (dirty) return; policyDoc = d; var root = clear($('tab-contribute')); var msg = h('div'); var p = d.policy; { var fl = flashNode(); if (fl) root.appendChild(fl); }
  if (!p) { root.appendChild(h('p', { text: 'The policy is not available yet.' })); return; }
  root.appendChild(h('div', { class: 'card' }, h('h3', { text: 'Contribution preset' }), h('p', { class: 'note', text: 'Presets change the limits below; your schedule and per-capability limits are kept. Changing any single value switches to Custom.' }),
    h('div', { class: 'row' }, d.presets.map(function (pr) { return h('button', { 'aria-pressed': d.preset === pr.id ? 'true' : 'false', title: pr.summary, text: pr.label, on: { click: function () { act('/api/policy', { preset: pr.id }, msg, function (b) { toast(msg, 'Preset applied.'); dirty = false; }); } } }); }).concat([h('button', { 'aria-pressed': d.preset === 'custom' ? 'true' : 'false', disabled: true, text: 'Custom' })])),
    h('p', { class: 'note', text: d.source ? 'Policy in force: ' + (d.source.kind === 'saved' ? 'saved from this panel/CLI' : d.source.kind === 'env-file' ? 'the installer\\'s policy file (read only)' : 'conservative defaults') + '.' : '' })));
  var inputs = {}; var form = h('div', { class: 'card' }, h('h3', { text: 'Resource limits' }), h('p', { class: 'note', text: 'Your limits are absolute: the Coordinator can never raise them.' }));
  FIELDS.forEach(function (f) { var input = h('input', { type: 'number', step: 'any', value: String(toUi(f[2], p[f[0]])), 'aria-label': f[1], on: { input: function () { dirty = true; } } }); inputs[f[0]] = [input, f[2]]; form.appendChild(h('label', null, f[1] + ' ', input)); });
  var selects = {};
  [['defaultLevel', 'Mode when no schedule rule applies', ['OFF', 'MINIMAL', 'ADAPTIVE', 'FULL']], ['maxDiskIo', 'Disk-I/O class', ['none', 'low', 'medium', 'high']], ['onBattery', 'On battery', ['normal', 'reduce', 'disable']]].forEach(function (s) {
    var sel = h('select', { 'aria-label': s[1], on: { change: function () { dirty = true; } } }, s[2].map(function (o) { return h('option', { value: o, text: o, selected: p[s[0]] === o }); })); selects[s[0]] = sel; form.appendChild(h('label', null, s[1] + ' ', sel)); });
  var slotInput = h('input', { type: 'number', min: '1', max: String(d.jobSlots.max), step: '1', value: String(d.jobSlots.saved === null ? d.jobSlots.value : d.jobSlots.saved), 'aria-label': 'Jobs at once', disabled: !d.jobSlots.editable, on: { input: function () { dirty = true; } } });
  form.appendChild(h('div', { class: 'row' }, h('label', null, 'Jobs at once (running now: ' + d.jobSlots.value + ') ', slotInput),
    d.jobSlots.editable ? h('button', { text: 'Save job slots', on: { click: function () { var n = parseInt(slotInput.value, 10); if (!(n >= 1 && n <= d.jobSlots.max)) { toast(msg, 'Choose 1 to ' + d.jobSlots.max + '.', true); return; } act('/api/jobslots', { slots: n }, msg, function (b) { dirty = false; toast(msg, 'Saved. It applies the next time the node starts' + (b.restartRequired.length ? ' (restart needed for: ' + b.restartRequired.join(', ') + ').' : '.')); }); } } }) : null));
  form.appendChild(h('p', { class: 'note', text: d.jobSlots.note }));
  var rules = JSON.parse(JSON.stringify(p.schedule)); var sched = h('div', { class: 'card' }); 
  function drawSchedule() { clear(sched); sched.appendChild(h('h3', { text: 'Weekly schedule' })); sched.appendChild(h('p', { class: 'note', text: 'Rules are checked in order; the first match wins. A rule whose end is before its start wraps past midnight. Times are this machine\\'s local time.' }));
    rules.forEach(function (r, i) { var days = h('span'); DAYS.forEach(function (name, di) { var cb = h('input', { type: 'checkbox', checked: r.days.indexOf(di) >= 0, 'aria-label': name, on: { change: function () { dirty = true; r.days = r.days.filter(function (x) { return x !== di; }); if (cb.checked) r.days.push(di); r.days.sort(); } } }); days.appendChild(h('label', { class: 'inl' }, cb, name)); });
      var from = h('input', { type: 'time', value: r.from, 'aria-label': 'From', on: { change: function () { dirty = true; r.from = from.value; } } }); var to = h('input', { type: 'time', value: r.to, 'aria-label': 'To', on: { change: function () { dirty = true; r.to = to.value; } } });
      var lvl = h('select', { 'aria-label': 'Level', on: { change: function () { dirty = true; r.level = lvl.value; } } }, ['FULL', 'ADAPTIVE', 'MINIMAL', 'OFF'].map(function (o) { return h('option', { value: o, text: o, selected: r.level === o }); }));
      sched.appendChild(h('div', { class: 'row' }, days, ' from ', from, ' to ', to, ' ', lvl, h('button', { text: 'Remove', on: { click: function () { dirty = true; rules.splice(i, 1); drawSchedule(); } } }))); });
    sched.appendChild(h('button', { text: 'Add a rule', on: { click: function () { dirty = true; rules.push({ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00', level: 'OFF' }); drawSchedule(); } } })); }
  drawSchedule();
  var save = h('button', { class: 'primary', text: 'Save changes', on: { click: function () {
    var next = JSON.parse(JSON.stringify(p)); var bad = null;
    for (var k in inputs) { var v = fromUi(inputs[k][1], inputs[k][0].value); if (v !== null && (typeof v !== 'number' || isNaN(v))) bad = k; next[k] = v; }
    for (var s in selects) next[s] = selects[s].value; next.schedule = rules;
    if (bad) { toast(msg, 'Check the value for ' + bad + '.', true); return; }
    act('/api/policy', { policy: next }, msg, function (b) { dirty = false; toast(msg, 'Saved and applied.' + (b.findings.length ? ' ' + b.findings.map(function (x) { return x.severity.toUpperCase() + ': ' + x.message; }).join(' ') : '') + (b.restartRequired.length ? ' Restart needed for: ' + b.restartRequired.join(', ') : '')); }); } } });
  var reset = h('button', { text: 'Discard unsaved changes', on: { click: function () { dirty = false; refresh(); } } });
  var undo = h('button', { text: 'Forget saved policy (use the installer\\'s)', on: { click: function () { if (confirm('Remove the policy saved from this panel?')) act('/api/policy', { reset: true }, msg, function () { dirty = false; toast(msg, 'Saved policy removed.'); }); } } });
  var caps = h('div', { class: 'card' }, h('h3', { text: 'Capabilities' }), h('p', { class: 'note', text: 'Only capabilities this node enrolled with can be switched. A switched-off capability is not advertised, so the Coordinator stops sending that kind of job.' }));
  var name = h('div', { class: 'card' }, h('h3', { text: 'Local name' }), h('p', { class: 'note', text: 'Shown only on this machine. The Coordinator\\'s label and the cryptographic node ID are separate.' }));
  var nameInput = h('input', { type: 'text', maxlength: '64', 'aria-label': 'Local name', placeholder: 'for example, My laptop' }); name.appendChild(h('div', { class: 'row' }, nameInput, h('button', { text: 'Save name', on: { click: function () { act('/api/name', { name: nameInput.value.trim() === '' ? null : nameInput.value.trim() }, msg, function () { toast(msg, 'Name saved.'); }); } } })));
  root.appendChild(form); root.appendChild(sched); root.appendChild(h('div', { class: 'row' }, save, reset, undo)); root.appendChild(msg); root.appendChild(caps); root.appendChild(name);
  d.findings.forEach(function (f) { root.appendChild(h('p', { class: 'note', text: f.severity.toUpperCase() + ': ' + f.message })); });
  api('GET', '/api/status').then(function (r) { if (r.status !== 200) return; nameInput.value = r.body.node.localName || ''; r.body.capabilities.forEach(function (c) { var cb = h('input', { type: 'checkbox', checked: c.enabled, on: { change: function () { var off = []; caps.querySelectorAll('input[type=checkbox]').forEach(function (x) { if (!x.checked) off.push(x.getAttribute('data-id')); }); act('/api/capabilities', { disabled: off }, msg, function () { toast(msg, 'Capabilities updated.'); }); } } }); cb.setAttribute('data-id', c.id); caps.appendChild(h('label', null, cb, ' ' + c.id)); }); });
}

function renderActivity(jobs, hist) {
  var root = clear($('tab-activity')); root.appendChild(h('div', { class: 'card' }, h('h3', { text: 'Running jobs' }), jobs.active.length === 0 ? h('p', { text: 'No jobs are running.' }) :
    h('table', null, h('tr', null, ['Type', 'Started', 'Expected', 'Preemptible', 'Checkpointable', 'Estimate'].map(function (x) { return h('th', { text: x }); })), jobs.active.map(function (j) { return h('tr', null, [j.type, when(j.startedAt), j.expectedDurationMs ? Math.round(j.expectedDurationMs / 1000) + ' s' : 'not declared', j.preemptible ? 'yes' : 'no', j.checkpointable ? 'yes' : 'no', 'CPU ' + j.estimate.cpu + ', ' + bytes(j.estimate.memoryBytes) + ' memory'].map(function (x) { return h('td', { text: x }); })); })),
    h('p', { class: 'note', text: jobs.note + ' Totals since the node started: completed ' + jobs.counters.completed + ', failed ' + jobs.counters.failed + ', preempted ' + jobs.counters.preempted + ', handed back at shutdown ' + jobs.counters.handedBackOnShutdown + ', lease lost ' + jobs.counters.leaseLost + '.' })));
  var pts = hist.points; var card = h('div', { class: 'card' }, h('h3', { text: 'Resource history (last 24 hours, every 5 minutes)' }), h('p', { class: 'note', text: hist.note }));
  if (pts.length === 0) card.appendChild(h('p', { text: 'No history yet.' })); else {
    var last = pts.slice(-12).reverse(); card.appendChild(h('table', null, h('tr', null, ['Time', 'Mode', 'Pressure', 'Permitted memory', 'Permitted CPU', 'Your CPU (measured)', 'Jobs', 'Transfer left'].map(function (x) { return h('th', { text: x }); })),
      last.map(function (p) { return h('tr', null, [when(p.t), p.contribution, p.pressure, bytes(p.permittedMemoryBytes), p.permittedCpuPercent + '%', p.measuredOwnerCpuPercent + '%', p.activeJobs, p.transferRemainingBytes === undefined ? '—' : bytes(p.transferRemainingBytes)].map(function (x) { return h('td', { text: String(x) }); })); }))); }
  root.appendChild(card);
}

var diagMsg = null;
function renderDiag() {
  var root = clear($('tab-diag')); var out = h('div'); var msg = h('div');
  root.appendChild(h('div', { class: 'card' }, h('h3', { text: 'Run the doctor' }), h('p', { class: 'note', text: 'Checks configuration, the state directory, identity, DNS, TCP, TLS trust and name, the Coordinator\\'s health and protocol, and enrollment. It changes nothing and prints no secret.' }),
    h('button', { class: 'primary', text: 'Run doctor', on: { click: function () { clear(out).appendChild(h('p', { text: 'Running…', role: 'status' })); api('POST', '/api/doctor', {}).then(function (r) { clear(out); if (r.status !== 200) { toast(out, 'The doctor could not run (' + (r.body.error && r.body.error.code) + ').', true); return; }
      out.appendChild(h('p', { text: r.body.ok ? 'No problems found.' : 'Problems found: fix the first FAILED line and run it again.' }));
      out.appendChild(h('table', null, r.body.stages.map(function (s) { return h('tr', null, h('td', { text: s.status === 'OK' ? '[OK]' : s.status === 'FAILED' ? '[FAILED]' : s.status === 'WARN' ? '[WARNING]' : '[' + s.status + ']' }), h('td', { text: s.label }), h('td', null, s.detail, s.advice ? h('div', { class: 'note', text: 'Next: ' + s.advice }) : null)); }))); }); } } }), out));
  if (features.supportBundle) root.appendChild(h('div', { class: 'card' }, h('h3', { text: 'Support bundle' }), h('p', { class: 'note', text: 'A file you can attach to a bug report: version, platform, sanitized configuration and policy, the doctor\\'s output and recent log events. Private keys, tokens, authorization headers and secrets are removed or never included.' }),
    h('button', { text: 'Create support bundle', on: { click: function () { api('POST', '/api/support-bundle', {}).then(function (r) { if (r.status !== 200) { toast(msg, 'Could not create the bundle.', true); return; } var blob = new Blob([JSON.stringify(r.body, null, 2)], { type: 'application/json' }); var a = h('a', { href: URL.createObjectURL(blob), download: 'privanet-support-bundle.json' }); document.body.appendChild(a); a.click(); document.body.removeChild(a); toast(msg, 'Bundle downloaded. Read it before you share it.'); }); } } }), msg));
  if (features.updateCheck) { var upd = h('div'); root.appendChild(h('div', { class: 'card' }, h('h3', { text: 'Updates' }), h('p', { class: 'note', text: 'Pressing the button asks GitHub\\'s release API for the latest release (once, only now). Nothing is downloaded or installed; the page tells you how to upgrade.' }),
    h('button', { text: 'Check for update', on: { click: function () { api('POST', '/api/update/check', {}).then(function (r) { clear(upd); if (r.status !== 200) { toast(upd, 'The check failed (' + (r.body.error && r.body.error.code) + ').', true); return; } upd.appendChild(h('p', { text: r.body.message })); if (r.body.releaseUrl) upd.appendChild(h('p', null, 'Release notes: ', h('code', { text: r.body.releaseUrl }))); if (r.body.upgrade) upd.appendChild(h('p', { class: 'note', text: r.body.upgrade })); }); } } }), upd)); }
}

function renderPrivacy(p, logs) {
  var root = clear($('tab-privacy')); root.appendChild(h('h2', { text: p.title }));
  p.sections.forEach(function (s) { root.appendChild(h('div', { class: 'card' }, h('h3', { text: s.heading }), h('ul', null, s.items.map(function (i) { return h('li', { text: i }); })))); });
  root.appendChild(h('div', { class: 'card' }, h('h3', { text: 'Recent node events (newest last)' }), logs.entries.length === 0 ? h('p', { text: 'None yet.' }) : h('table', null, logs.entries.map(function (e) { return h('tr', null, h('td', { text: new Date(e.at).toLocaleTimeString() }), h('td', { text: e.event }), h('td', { text: [e.code, e.reason].filter(Boolean).join(' ') })); }))));
}

function refresh() {
  if (current === 'status') api('GET', '/api/status').then(function (r) { if (r.status === 401) return needLogin(); if (r.status === 200) renderStatus(r.body); });
  else if (current === 'contribute') api('GET', '/api/policy').then(function (r) { if (r.status === 401) return needLogin(); if (r.status === 200) renderContribute(r.body); });
  else if (current === 'activity') Promise.all([api('GET', '/api/jobs'), api('GET', '/api/history')]).then(function (rs) { if (rs[0].status === 200 && rs[1].status === 200) renderActivity(rs[0].body, rs[1].body); });
  else if (current === 'diag') { if (!$('tab-diag').firstChild) renderDiag(); }
  else if (current === 'privacy') Promise.all([api('GET', '/api/privacy'), api('GET', '/api/logs')]).then(function (rs) { if (rs[0].status === 200 && rs[1].status === 200) renderPrivacy(rs[0].body, rs[1].body); });
}
function needLogin() { $('app').classList.add('hidden'); $('login').classList.remove('hidden'); $('logout').classList.add('hidden'); if (poll) { clearInterval(poll); poll = null; } }
function start() { api('GET', '/api/session').then(function (r) { if (r.status !== 200) return needLogin(); csrf = r.body.csrf; features = r.body.features || {}; $('login').classList.add('hidden'); $('app').classList.remove('hidden'); $('logout').classList.remove('hidden'); buildTabs(); show(current); if (!poll) poll = setInterval(function () { if (current === 'status' || current === 'activity') refresh(); }, 5000); }); }
function signIn(token) { return api('POST', '/api/login', { token: token }).then(function (r) { if (r.status === 200) { history.replaceState(null, '', '/'); start(); } else $('loginmsg').textContent = 'WARNING: sign-in refused' + (r.status === 429 ? ' (too many attempts; wait a minute)' : '') + '.'; }); }
$('signin').addEventListener('click', function () { signIn($('token').value.trim()); });
$('logout').addEventListener('click', function () { api('POST', '/api/logout', {}).then(function () { needLogin(); }); });
var fragment = location.hash.replace(/^#/, '');
if (/^[a-f0-9]{64}$/.test(fragment)) signIn(fragment); else start();
</script></body></html>`;
}
