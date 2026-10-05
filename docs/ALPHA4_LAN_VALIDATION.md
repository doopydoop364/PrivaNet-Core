# Alpha.4 real-machine deployment validation

**Not marked completed by this implementation.** Separate processes and automated tests on one host do not prove separate physical-machine routing, firewall rules, mounts, ownership, service-manager behavior or power-loss durability. Record actual date, software versions, addresses, service accounts, storage volume and outcomes without credentials/chunk IDs in a public report.

Topology: Machine A runs the Coordinator behind its normally trusted HTTPS proxy; Machine B runs an enrolled PrivaNode with large storage contribution and the explicit pinned TLS listener; Machine C runs the application SDK and, if authorized, the operator probe. LAN location grants no trust. Use literal stable LAN addresses or explicit DNS and firewall rules. The Coordinator's HTTP listener stays private and never proxies chunk bodies.

Setup B as its service account using the [storage commands](DIRECT_TRANSFER.md#alpha4-storage-operations): set capacity/reserve based on actual free space, generate or provision a valid IP-SAN certificate, set bind/endpoint, enable storage and listener. Keep configured quota within the existing 1 TiB owner-policy ceiling. Restrict key permissions/ownership. A 500 GiB quota and 100 GiB reserve are examples, not a recommendation that they fit every disk.

Create a separate application credential explicitly allowed `storage.chunk.v1` and optionally `system.echo.v1` for compute verification. Use environment/secret-store input, never command-line tokens. On C install the candidate SDK or use the staged distribution's `tools/validate-storage.mjs`; trust the Coordinator normally with `NODE_EXTRA_CA_CERTS` when using a private CA. Do not install the storage leaf as an ambient CA; SDK grants pin it explicitly.

```sh
node tools/validate-storage.mjs roundtrip
node tools/validate-storage.mjs prepare-restart private-restart-state.json
# Gracefully restart B, then A, retaining their complete state.
node tools/validate-storage.mjs verify-restart private-restart-state.json
```

`prepare-restart` keeps one random 8 MiB chunk and writes only its private validation metadata (0600, refuses overwrite). `verify-restart` checks the digest/length and deletes it. The script prints aggregate pass facts and explicitly says Coordinator payload traffic is NOT_MEASURED: a successful SDK roundtrip alone does not prove the no-relay invariant. Delete the private restart-state file after checking the expected counters. If state-file publication fails the script attempts authorized SDK deletion before returning failure. If cleanup itself fails, use application metadata and authorized SDK deletion; do not remove random store files by hand.

| # | Required check | Evidence to record |
| --- | --- | --- |
| 1 | B enrolls normally | Node ID matches owner's approval; restart uses same identity without enrollment token |
| 2 | Compute still works | Scoped application `system.echo.v1` completes through Coordinator and B |
| 3 | Local store healthy | B `storage status`: enabled, READY, health OK, known free bytes |
| 4 | Listener starts | LISTENING, intended bind/port, correct advertised origin |
| 5 | Coordinator sees capacity | Exact endpoint ACCEPTED locally, admin pool contains B and expected reported bytes |
| 6 | Application stores | C SDK `store` of random 8 MiB reaches authoritative STORED |
| 7 | No Coordinator payload relay | Collect bounded-control-body/traffic evidence at A and direct data traffic C↔B; namespace test methodology is in alpha.3 status. Packet totals alone cannot separate metadata/TLS overhead; never log authorization headers/bodies containing secrets |
| 8 | Fetch identical bytes | C length/digest and exact byte comparison pass |
| 9 | Delete through SDK | Metadata disappears only after authenticated node receipt |
| 10 | Counters settle | Stored/reserved/pending and queued receipts return to expected baseline; allow receipt/heartbeat refresh |
| 11 | Node restart retains data | prepare-restart then B restart then verify-restart, same identity/chunks |
| 12 | Coordinator restart retains metadata | prepare-restart then A restart then verify-restart; same Coordinator ID, credential and placement metadata |
| 13 | Listener restart | B graceful restart, LISTENING and fresh ACCEPTED, probe succeeds |
| 14 | Wrong certificate refused | A grant pinned to old identity fails after deliberate B certificate renewal; fresh grant succeeds; never disable TLS verification |
| 15 | Storage disable while active | B disable aborts/refuses operations safely, closes listener and keeps existing committed bytes; enable restores same store |
| 16 | Capacity changes | Increase; reduce above usage; reduce below usage: OVERCOMMITTED and zero new-write room with existing data retained |
| 17 | Owner reserve/external fill | Use a disposable dedicated filesystem and controlled filler file; writes refuse before reserve. Remove filler, restore limits. Never fill the system/root volume for this test |
| 18 | No arbitrary endpoint/node choice | Existing adversarial API tests reject extra selection fields; verify same behavior remotely with a synthetic scoped request |
| 19 | Unauthorized app refused | Credential without allowedServices fails storage with no transferred payload |
| 20 | Older compute nodes work | Enroll/run actual alpha.2 and alpha.3 compute binaries alongside alpha.4 Coordinator, submit permitted echo; preserve their identities on upgrade |

Also stop/restart B with committed data while disabled, test owner pause/drain/schedule/battery on applicable hardware, port occupied, unsafe key and old Coordinator refusal. Restore intended configuration after each test. Record any failed/skipped/manual-only step honestly. No Phase 5 recovery, independent security review, public reachability or hostile-node durability is inferred from these checks.
