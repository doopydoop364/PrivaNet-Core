# PrivaNet Core 0.4.0-alpha.4 (release candidate)

Includes all alpha.3.1 crawler diagnostics and roundup forwarding fixes, plus Phase 4 storage operational hardening. Protocol remains 1; no state migration or re-enrollment.

- Explicit store/listener/Coordinator advertisement states; remote reachability stays UNKNOWN until explicitly tested.
- Actionable storage/TLS/key/bind/replay/receipt diagnostics; optional storage startup failure no longer prevents compute.
- Policy source/override reporting and safe capacity/reserve/transfer controls with private backups and explicit reserve-reduction confirmation.
- P-256 IP-SAN certificate generation/renewal and a ticket-free operator TLS probe using exact registered identity.
- Capacity planning/overcommit reporting, retained chunks across disable/re-enable or capacity reduction, and negotiated aggregate pool details.
- Private-file/backup hardening, lifecycle failure handling and alpha.3/alpha.3.1 upgrade regressions.

Review [validation report](ALPHA4_RELEASE_REPORT.md), [upgrade and rollback](ALPHA4_UPGRADE.md) and [real-machine checklist](ALPHA4_LAN_VALIDATION.md). The full suite has two confirmed environment-dependent failures; LAN/proxy/privileged isolation and actual hardware validation remain outstanding. Not independently security-reviewed. Phase 5 replication/repair remain deferred.

This candidate has not been published or deployed.
