/**
 * The operator dashboard's single page: the same rules as the node panel's (strict nonce CSP, every piece of text set with `textContent` so a node name or a label can never become
 * markup, state shown as words and not by colour alone). It holds no secret: the administrator credential stays in the server process.
 */
export function renderAdminPage(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PrivaNet operator dashboard</title>
<style nonce="${nonce}">
:root{--bg:#fff;--fg:#1b1f23;--muted:#586069;--line:#d0d7de;--card:#f6f8fa;--accent:#0b5cad}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9da7b3;--line:#30363d;--card:#161b22;--accent:#58a6ff}}
body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:12px 16px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{font-size:18px;margin:0}main{max-width:1100px;margin:0 auto;padding:12px 16px 48px}
nav{display:flex;gap:4px;flex-wrap:wrap;margin:8px 0 16px}
button,select,input{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:6px 10px}
button{cursor:pointer}button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}button.danger{border-color:#b42318}
button[aria-pressed=true]{outline:2px solid var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:0 0 12px}
.k{color:var(--muted);font-size:13px}.badge{display:inline-block;border:1px solid var(--line);border-radius:4px;padding:0 6px;font-size:13px;font-weight:600}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
label{display:inline-block;margin:4px 12px 4px 0}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0}
.grow{flex:1}.hidden{display:none}.err{border-color:#b42318}.note{color:var(--muted);font-size:13px}
input[type=text],input[type=password]{width:260px}input[type=number]{width:90px}code{word-break:break-all}.code{font-size:22px;letter-spacing:2px;font-weight:700}
</style></head><body>
<header><h1>PrivaNet operator dashboard</h1><span id="headline" class="note" role="status"></span><span class="grow"></span><button id="logout" class="hidden">Sign out</button></header>
<main>
<section id="login" class="card hidden"><h2>Sign in</h2>
<p>Run <code>privanet-admin ui</code> in a terminal: it prints a sign-in link. Opening it signs you in here; or paste the sign-in token it printed:</p>
<div class="row"><input id="token" type="password" autocomplete="off" aria-label="Sign-in token" maxlength="64"><button id="signin" class="primary">Sign in</button></div><p id="loginmsg" class="note" role="alert"></p></section>
<div id="app" class="hidden"><div id="flash"></div><div id="banner"></div><nav id="tabs" aria-label="Sections"></nav><section id="body"></section></div>
</main>
<script nonce="${nonce}">
'use strict';
var csrf = '', current = 'nodes', poll = null, data = null, flash = null, created = null, busy = false;
function h(tag, attrs) { var el = document.createElement(tag); if (attrs) for (var k in attrs) { if (k === 'text') el.textContent = attrs[k]; else if (k === 'on') { for (var e in attrs.on) el.addEventListener(e, attrs.on[e]); } else if (attrs[k] === true) el.setAttribute(k, ''); else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k]); }
  function add(c) { if (c == null || c === false) return; if (Array.isArray(c)) { c.forEach(add); return; } el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c))); }
  for (var i = 2; i < arguments.length; i++) add(arguments[i]); return el; }
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
function $(id) { return document.getElementById(id); }
function api(method, path, body) {
  var init = { method: method, credentials: 'same-origin', headers: {} };
  if (method === 'POST') { init.headers['content-type'] = 'application/json'; init.headers['x-csrf-token'] = csrf; init.body = JSON.stringify(body || {}); }
  return fetch(path, init).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }, function () { return { status: r.status, body: {} }; }); });
}
function when(t) { return t ? new Date(t).toLocaleString() : 'never'; }
function ago(ms) { if (ms === null || ms === undefined) return 'never'; var s = Math.round(ms / 1000); return s < 90 ? s + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; }
function note(message, bad) { flash = { text: (bad ? 'WARNING: ' : 'OK: ') + message, bad: !!bad, at: Date.now() }; draw(); }
function act(path, body, ok) { return api('POST', path, body).then(function (r) { if (r.status === 200) { if (ok) ok(r.body); else note('Done.'); load(); } else note('The Coordinator or this dashboard refused it (' + (r.body.error && r.body.error.code || r.status) + ').', true); }); }
function caps(selected, group) { var boxes = []; var box = h('span'); data.capabilities.forEach(function (c) { var cb = h('input', { type: 'checkbox', checked: selected.indexOf(c) >= 0, 'aria-label': c }); cb.setAttribute('data-cap', c); boxes.push(cb); box.appendChild(h('label', null, cb, ' ' + c)); }); box.chosen = function () { return boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.getAttribute('data-cap'); }); }; return box; }

var TABS = [['nodes', 'Nodes'], ['requests', 'Join requests'], ['invites', 'Invites']];
function tabs() { var nav = clear($('tabs')); TABS.forEach(function (t) { var n = data && data[t[0]] ? (t[0] === 'requests' ? data.requests.filter(function (x) { return x.status === 'PENDING'; }).length : 0) : 0; nav.appendChild(h('button', { 'aria-pressed': t[0] === current ? 'true' : 'false', text: t[1] + (n ? ' (' + n + ' waiting)' : ''), on: { click: function () { current = t[0]; draw(); } } })); }); }

function nodesView() {
  var root = h('div'); if (!data.nodes) return h('p', { text: 'The node list could not be loaded.' });
  var shown = data.nodes; var counts = {}; shown.forEach(function (n) { counts[n.status] = (counts[n.status] || 0) + 1; });
  root.appendChild(h('p', { class: 'note', text: shown.length + ' node(s)' + (shown.length ? ': ' + Object.keys(counts).map(function (k) { return counts[k] + ' ' + k.toLowerCase().replace('_', ' '); }).join(', ') : '') + '. Everything here is what the Coordinator has stored; what a node says about its own resources is self-reported and not verified.' }));
  shown.forEach(function (n) {
    var rename = h('input', { type: 'text', maxlength: '64', 'aria-label': 'Name for ' + n.nodeId, value: n.name || '', placeholder: 'name' });
    root.appendChild(h('div', { class: 'card' + (n.status === 'REVOKED' ? ' err' : '') },
      h('div', { class: 'row' }, h('strong', { text: n.name || '(unnamed)' }), h('span', { class: 'badge', text: n.status }), h('span', { text: n.state })),
      h('div', { class: 'k', text: 'Node ID' }), h('code', { text: n.nodeId }),
      h('table', null,
        h('tr', null, h('th', { text: 'Last heard from' }), h('td', { text: n.lastSeenAt ? when(n.lastSeenAt) + ' (' + ago(n.ageMs) + ')' : 'never' })),
        h('tr', null, h('th', { text: 'Enrolled' }), h('td', { text: when(n.enrolledAt) })), n.revokedAt ? h('tr', null, h('th', { text: 'Revoked' }), h('td', { text: when(n.revokedAt) })) : null,
        h('tr', null, h('th', { text: 'May do' }), h('td', { text: n.capabilities.join(', ') || '(nothing)' })),
        h('tr', null, h('th', { text: 'Jobs' }), h('td', { text: n.jobs.running + ' running of ' + n.jobs.slots + ' slot(s)' })),
        h('tr', null, h('th', { text: 'Software' }), h('td', { text: n.version.state.toUpperCase().replace('-', ' ') + ': ' + n.version.text })),
        n.reported ? h('tr', null, h('th', { text: 'Reports (self-reported)' }), h('td', { text: 'mode ' + n.reported.contribution + ', pressure ' + n.reported.pressure + ', power ' + n.reported.power + ', offering up to ' + Math.round(n.reported.memoryBudgetBytes / 1048576) + ' MiB and ' + n.reported.cpuBudgetPercent + '% CPU' })) : null),
      h('div', { class: 'row' }, rename, h('button', { text: 'Save name', on: { click: function () { var v = rename.value.trim(); act('/api/nodes/rename', { nodeId: n.nodeId, name: v === '' ? null : v }); } } }),
        n.status === 'REVOKED' ? null : h('button', { class: 'danger', text: 'Revoke', on: { click: function () { if (confirm('Revoke this node? It can never sign in again (enroll a new one instead) and its running jobs are handed back.')) act('/api/nodes/revoke', { nodeId: n.nodeId, confirm: true }); } } }))));
  });
  if (shown.length === 0) root.appendChild(h('p', { text: 'No nodes are enrolled yet. Create an invite, or have a contributor run privanet-node join and approve it under Join requests.' }));
  return root;
}
function requestsView() {
  var root = h('div'); if (!data.requests) return h('p', { text: 'The requests could not be loaded.' });
  var shown = data.requests.filter(function (r) { return r.status === 'PENDING' || r.status === 'APPROVED'; });
  root.appendChild(h('p', { class: 'note', text: 'A request shows the node ID the machine will have. Compare it with what that machine printed, by another channel, before you approve. Approving decides exactly what the node may do: the capabilities you tick, not what it asked for.' }));
  if (shown.length === 0) root.appendChild(h('p', { text: 'No requests are waiting.' }));
  shown.forEach(function (r) {
    var picker = caps(r.requestedCapabilities, 'a'); var label = h('input', { type: 'text', maxlength: '64', 'aria-label': 'Name for this node', placeholder: 'name (optional)', value: r.deviceName || '' });
    root.appendChild(h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'code', text: r.code }), h('span', { class: 'badge', text: r.status })),
      h('div', { class: 'k', text: 'Node ID it will have' }), h('code', { text: r.nodeId }),
      h('p', { class: 'note', text: 'Device name hint: ' + (r.deviceName || '—') + '. Asked for: ' + (r.requestedCapabilities.join(', ') || '—') + '. Software ' + r.daemonVersion + '. From ' + r.source + '. Expires ' + when(r.expiresAt) + '.' }),
      r.status === 'PENDING' ? h('div', null, h('div', { class: 'row' }, h('span', { class: 'k', text: 'Allow:' }), picker, label),
        h('div', { class: 'row' }, h('button', { class: 'primary', text: 'Approve', on: { click: function () { var c = picker.chosen(); if (c.length === 0 && !confirm('Approve with no capabilities? The node could not run anything.')) return; var body = { code: r.code, capabilities: c }; if (label.value.trim()) body.label = label.value.trim(); act('/api/requests/approve', body, function () { note('Approved. The machine finishes enrolling by itself within a few seconds.'); }); } } }),
          h('button', { text: 'Deny', on: { click: function () { act('/api/requests/deny', { code: r.code }); } } }))) : h('div', { class: 'row' }, h('span', { text: 'Approved: waiting for the machine to finish.' }), h('button', { text: 'Withdraw', on: { click: function () { act('/api/requests/deny', { code: r.code }); } } }))));
  });
  return root;
}
function invitesView() {
  var root = h('div'); if (!data.invites) return h('p', { text: 'The invites could not be loaded.' });
  var picker = caps(['system.echo.v1'].filter(function (c) { return data.capabilities.indexOf(c) >= 0; }), 'i'); var minutes = h('input', { type: 'number', min: '1', max: '60', value: '10', 'aria-label': 'Minutes valid' }); var label = h('input', { type: 'text', maxlength: '64', 'aria-label': 'Name for the node', placeholder: 'name for the node (optional)' });
  root.appendChild(h('div', { class: 'card' }, h('h3', { text: 'Create an invite' }), h('p', { class: 'note', text: 'A short code for one contributor: it works once, for at most an hour, and limits what the node may do. Give it to them privately.' }),
    h('div', { class: 'row' }, h('span', { class: 'k', text: 'Allow:' }), picker), h('div', { class: 'row' }, 'Valid for ', minutes, ' minutes ', label,
      h('button', { class: 'primary', text: 'Create invite', on: { click: function () { var body = { minutes: parseInt(minutes.value, 10), capabilities: picker.chosen() }; if (label.value.trim()) body.label = label.value.trim(); if (!(body.minutes >= 1 && body.minutes <= 60)) { note('Choose 1 to 60 minutes.', true); return; } act('/api/invites/create', body, function (b) { created = b; note('Invite created. It is shown once, below.'); }); } } }))));
  if (created) root.appendChild(h('div', { class: 'card' }, h('h3', { text: 'New invite: shown only now' }), h('div', { class: 'code', text: created.invite.code }),
    h('p', { class: 'note', text: 'Valid until ' + when(created.invite.expiresAt) + '; allows ' + (created.invite.capabilities.join(', ') || 'nothing') + '. The Coordinator keeps no copy of the code. On the contributor\\'s machine:' }), h('code', { text: created.enroll + '   (then type or paste the code)' }),
    h('div', { class: 'row' }, h('button', { text: 'Hide this code', on: { click: function () { created = null; draw(); } } }))));
  var shown = data.invites.filter(function (i) { return i.status === 'ACTIVE' || i.status === 'LOCKED'; });
  root.appendChild(h('div', { class: 'card' }, h('h3', { text: 'Active invites' }), shown.length === 0 ? h('p', { text: 'None.' }) : h('table', null, h('tr', null, ['ID', 'Status', 'Expires', 'May do', 'Name', 'Wrong guesses', ''].map(function (x) { return h('th', { text: x }); })),
    shown.map(function (i) { return h('tr', null, [i.id, i.status, when(i.expiresAt), i.capabilities.join(', ') || '—', i.label || '—', String(i.failedAttempts)].map(function (x) { return h('td', { text: x }); }).concat([h('td', null, h('button', { text: 'Revoke', on: { click: function () { act('/api/invites/revoke', { id: i.id }); } } }))])); }))));
  return root;
}
function draw() {
  if (!data) return; var c = data.coordinator; tabs();
  $('headline').textContent = c.reachable ? 'Coordinator ' + c.serviceVersion + ' (protocol ' + c.protocolVersion + ') at ' + c.origin : 'Coordinator not reachable at ' + c.origin;
  var banner = clear($('banner')); if (!c.reachable) banner.appendChild(h('p', { class: 'card err', role: 'alert', text: 'WARNING: the Coordinator is not reachable from this dashboard. Check that it is running and that PRIVANET_COORDINATOR_URL is right.' }));
  if (c.adminCredential === 'refused') banner.appendChild(h('p', { class: 'card err', role: 'alert', text: 'WARNING: the Coordinator refused the administrator credential this dashboard was started with.' }));
  if (c.reachable && c.protocolVersion !== data.dashboardProtocol) banner.appendChild(h('p', { class: 'card err', role: 'alert', text: 'WARNING: this dashboard speaks protocol ' + data.dashboardProtocol + ' and the Coordinator speaks ' + c.protocolVersion + '.' }));
  var f = clear($('flash')); if (flash && Date.now() - flash.at < 12000) f.appendChild(h('p', { role: 'alert', class: 'card' + (flash.bad ? ' err' : ''), text: flash.text }));
  var body = clear($('body')); body.appendChild(current === 'nodes' ? nodesView() : current === 'requests' ? requestsView() : invitesView());
}
var typing = function () { var a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'SELECT'); };
function load() { if (busy) return Promise.resolve(); busy = true; return api('GET', '/api/overview').then(function (r) { busy = false; if (r.status === 401) return needLogin(); if (r.status === 200) { data = r.body; draw(); } }, function () { busy = false; }); }
function needLogin() { $('app').classList.add('hidden'); $('login').classList.remove('hidden'); $('logout').classList.add('hidden'); if (poll) { clearInterval(poll); poll = null; } }
function start() { api('GET', '/api/session').then(function (r) { if (r.status !== 200) return needLogin(); csrf = r.body.csrf; $('login').classList.add('hidden'); $('app').classList.remove('hidden'); $('logout').classList.remove('hidden'); load(); if (!poll) poll = setInterval(function () { if (!typing()) load(); }, 10000); }); }
function signIn(token) { return api('POST', '/api/login', { token: token }).then(function (r) { if (r.status === 200) { history.replaceState(null, '', '/'); start(); } else $('loginmsg').textContent = 'WARNING: sign-in refused' + (r.status === 429 ? ' (too many attempts; wait a minute)' : '') + '.'; }); }
$('signin').addEventListener('click', function () { signIn($('token').value.trim()); });
$('logout').addEventListener('click', function () { api('POST', '/api/logout', {}).then(function () { needLogin(); }); });
var fragment = location.hash.replace(/^#/, '');
if (/^[a-f0-9]{64}$/.test(fragment)) signIn(fragment); else start();
</script></body></html>`;
}
