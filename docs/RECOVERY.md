# Reinstall, recovery and revocation

Status: implemented (`0.3.5`); part of [Phase 3.5](../ROADMAP.md#phase-35--remote-node-onboarding--contributor-experience--implemented). This page is for contributors and for the owner who invited them.

The one fact everything below follows from: **a node's identity is a private key (`identity.json` in its state directory) that never leaves its machine, and the Coordinator knows only the matching public key.** One key is one node. A key that is copied to a second machine is two machines acting as one node: neither the Coordinator nor the owner can tell them apart, and revoking one revokes both. So the rules are: never copy an identity from a machine that is still in use, and treat a lost or exposed key as a reason to revoke, not to restore.

| Situation | Contributor does | Owner does |
| --- | --- | --- |
| [Reinstall or upgrade, same machine, nothing wrong](#reinstall-or-upgrade-on-the-same-machine) | run the installer with `--upgrade`; the identity is kept | nothing |
| [Reinstall and start over with a new identity](#reinstall-with-a-new-identity) | `--new-identity --yes` and a fresh invite | issue an invite; revoke the old node |
| [Replacing a machine](#replacing-a-machine) | install on the new one with an invite; wipe or uninstall the old | issue an invite; revoke the old node |
| [Lost, stolen or discarded machine](#lost-stolen-or-compromised) | tell the owner | `privanet-admin nodes revoke` |
| [Compromised identity or machine](#lost-stolen-or-compromised) | stop the node, tell the owner | revoke at once; investigate the machine |
| [A node the owner revoked](#a-revoked-node-coming-back) | new identity and a new invite | issue an invite if they still want it |
| [An invite or approval that expired, was used or was lost](#invites-and-approvals-that-did-not-work) | ask for another | `invite create` again; `invite revoke` the lost one |
| [Moving the state to another disk or machine](#moving-state) | see below | revoke the old node if the old copy still exists |
| [Uninstalling](#uninstalling) | `--uninstall` (or `-Uninstall`) | optionally revoke the node |

## Reinstall or upgrade on the same machine

Program files can be replaced at any time without touching the identity:

```sh
sh install-node.sh --upgrade                                    # Linux (same --coordinator as before is fine to repeat)
powershell -File .\install-node.ps1 -Upgrade -Coordinator ...   # Windows
```

The node keeps its identity, its enrollment record and its Coordinator, restarts, and signs in with **no invite**. `--repair` and `--reinstall` are the same operation under another name (they re-copy the program and rewrite the non-secret configuration, for example after a damaged installation). The installer will not touch an existing installation without one of these options, so running the original command again by mistake is refused rather than destructive.

If it does not sign in afterwards, run `privanet-node doctor --coordinator https://...` (see [ONBOARDING.md](ONBOARDING.md#diagnosing-a-node-privanet-node-doctor)); it names the first stage that fails.

## Reinstall with a new identity

Use this when the old identity should not be trusted any more, or the state directory is damaged and cannot be repaired:

```sh
sh install-node.sh --new-identity --yes --coordinator https://node.example.com --invite-file invite.txt
```

The old state is **moved aside** (`/var/lib/privanet-node.old-<date>` on Linux, `...\state.old-<date>` on Windows), never deleted, and the installer prints where. It enrolls a fresh key with the new invite. The old node still exists at the Coordinator until the owner revokes it: tell the owner which node it was (`privanet-admin nodes list` shows names and last-seen), and have them run `privanet-admin nodes revoke NODE`. Delete the set-aside directory once the old node is revoked; it holds a private key.

## Replacing a machine

1. The owner issues an invite (or you use `--join`).
2. Install on the **new** machine. It gets its own identity.
3. On the old machine, uninstall with `--uninstall --purge` if you still have it; this deletes its key.
4. The owner revokes the old node (`privanet-admin nodes revoke OLDNODE`). Until then both are valid nodes; this is only a problem if the old machine is not yours any more.

The owner can rename nodes (`privanet-admin nodes rename NODE "Anna - new laptop"`) to keep the registry readable. Do not copy `identity.json` from the old machine to the new one; the section [Moving state](#moving-state) explains the one safe exception.

## Lost, stolen or compromised

Whoever holds the private key can be that node: it can sign in and take jobs of the kinds the node was enrolled for. It cannot do more than those typed handlers (there is no shell, no arbitrary code, no tunnel), and it cannot enroll others or reach the admin API. Still, treat it as an incident:

```sh
sudo privanet-admin nodes revoke NODE        # the owner, on the Coordinator host; takes effect immediately
```

Revocation deletes the node's sessions, refuses every later request and hands its leased jobs back to the queue; it is checked on every request, so a stolen key stops working at once, and it cannot be undone (a revoked key stays revoked). If the machine is only suspected to be compromised, revoke first and ask questions after: a new invite costs a minute. A contributor who notices their own machine is compromised should stop the service (`sudo systemctl disable --now privanet-node`, or `Stop-ScheduledTask`/`Disable-ScheduledTask` on Windows) and tell the owner. Results the node returned before revocation were validated by the owner's application as always; PrivaNet does not yet verify node results (that is [Phase 10](../ROADMAP.md)), so an application should not treat any single node as authoritative.

## A revoked node coming back

A revoked identity cannot be re-enrolled, with a token, an invite or an approval: the Coordinator still knows the key. The contributor needs a **new identity**: `--new-identity --yes` with a new invite, or uninstall with `--purge` and install again. The owner decides whether to issue one.

## Invites and approvals that did not work

| What happened | What it means | What to do |
| --- | --- | --- |
| "That invite code was refused" | it is wrong, already used, expired, revoked or locked; the answer is deliberately the same for all of them | ask the owner for a new code; they can see the state with `privanet-admin invite list --all` |
| Several wrong tries, then refusals | an invite locks after 5 wrong guesses; an address is paused for a minute after 5 refused attempts | wait a minute, and use a new invite if it is locked |
| A request was denied or expired | the owner declined, or did not answer in 10 minutes | run `join` again (a new request); `join` resumes a still-pending one on its own |
| The owner approved, and nothing happens | the machine polls every few seconds and finishes by itself | leave it running; if it gave up, run `join` again and it resumes |
| An invite was sent to the wrong person | it is a bearer introduction until redeemed | `privanet-admin invite revoke INVITE_ID` |
| An invite was typed on a shared screen or chat | same | revoke it and issue another (they cost nothing) |

Neither an invite nor an approval can be redeemed twice. A node that is already enrolled and healthy treats a second invite as already done and leaves it unspent.

## Moving state

Moving the state directory to another path or disk **on the same machine** is fine: stop the node, move the directory (keep its mode `0700` and its owner), set `PRIVANODE_STATE_DIR`, start the node.

Moving it to **another machine** is not supported as a feature, because two copies of one key cannot be told apart. The only safe form is a true move: stop the old node, copy the directory to the new machine, **destroy the old copy** before starting the new one, and accept that if you got this wrong the owner cannot know. When in doubt, use [Replacing a machine](#replacing-a-machine) instead, which is as quick and has no such risk. Never take an identity from a machine that is still running, and never ask a contributor to.

## Uninstalling

```sh
sh install-node.sh --uninstall            # stops and removes the service and the program; keeps the identity and state
sh install-node.sh --uninstall --purge    # also deletes the identity and state (the key is gone for good)
```

```powershell
powershell -File .\install-node.ps1 -Uninstall          # or -Uninstall -Purge
```

Uninstalling does not tell the Coordinator. The node simply stops signing in and shows as offline; to withdraw it entirely the owner revokes it. With `--purge` the key no longer exists, which is the strongest way for a contributor to leave: say so to the owner so the node can be revoked rather than left registered.

## For the owner: the registry

```sh
sudo privanet-admin nodes list                  # names, status, last seen, capabilities
sudo privanet-admin nodes show NODE
sudo privanet-admin nodes rename NODE "Anna - laptop"
sudo privanet-admin nodes revoke NODE
sudo privanet-admin invite list --all           # which invites were used, by which node, which are locked
sudo privanet-admin requests list --all
```

Keep each node's name meaningful (who and which machine): during an incident, a clear name is what lets you revoke the right one. Used and expired invites, tokens and requests stay in the list for 30 days past expiry, so "who joined with what, and when" can still be answered.
