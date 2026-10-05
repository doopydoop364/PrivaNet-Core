# Alpha.3 / alpha.3.1 to alpha.4 upgrade and rollback

Release candidate **0.4.0-alpha.4**, protocol **1**. Includes the alpha.3.1 robots diagnostics, conservative robots-429 handling and roundup health forwarding. The same procedure applies from alpha.3 and alpha.3.1. No new database migration, chunk-store layout, policy-wrapper, enrollment, replay or receipt format. Existing identities, application credentials and committed chunks remain in place. New local status fields are intentional; scripts must replace `networkAccessible` boolean assumptions with explicit listener/advertisement/reachability fields. The deprecated field is null. Legacy strict storage control-plane summaries remain unchanged unless the caller explicitly asks for details.

## Upgrade

1. Read the alpha.4 changelog and [validation limitations](ALPHA4_IMPLEMENTATION_STATUS.md). Verify the candidate's checksums and source. Release artifacts require Node 24.4+; optional LAN certificate generation requires OpenSSL.
2. Back up the Coordinator SQLite database using its normal online backup tool, and separately protect `transfer-keys.json`, service configuration and administrator secret. Before backing up a node's complete state, gracefully stop it; include its identity, enrollment binding, `policy.json`, local choices, **entire store**, monthly meter, replay/receipt state and TLS keys. Use restrictive backup permissions. Never clear replay or receipt state to fix an upgrade.
3. Keep the old program directory. Unpack the alpha.4 archive next to it and switch only the program link. Restart the Coordinator and check `/v1/health` reports `serviceVersion: 0.4.0-alpha.4`, `protocolVersion: 1`, and the previous Coordinator ID.
4. Upgrade node program files using the verified alpha.4 installer with `--upgrade` (no invite/token), or switch its existing `current` program link. Keep the existing state directory and service environment. Restart the node. No re-enrollment is required.
5. Run `storage status --json`, `settings --json`, `config check --json` as the service account with the right state directory/environment. Confirm store health, LISTENING (if opted in), ACCEPTED for the exact advertised identity, and reachability UNKNOWN until tested.
6. Run `privanet-admin storage status --json` and `storage probe NODE --json` from the intended application/operator machine. Run the SDK smoke script and follow the [deployment checklist](ALPHA4_LAN_VALIDATION.md). Confirm compute still works.

Storage remains opt-in and presets do not enable it. A configuration error in the optional transfer listener is reported without stopping compute. Existing certificate files continue working; changing certificate bytes at the same paths requires restarting the node. Generated renewal uses new paths and the running daemon applies them live, registers the new identity and requires new grants.

## Rollback

Stop node transfer activity and gracefully stop the node; retain a fresh complete state backup before changing anything. Stop the Coordinator if rolling it back. Switch program links back to your previous alpha.3 or alpha.3.1 release and start with the same configuration and state. **Alpha.4 adds no migration**, so its database, store, identities, policy, meter, replay and receipt formats are alpha.3-readable. The upgrade regression and legacy-schema tests cover specific compatibility properties; rehearse rollback on your own hardware.

If certificates were renewed, alpha.3 uses the currently saved valid certificate/key paths and registers that identity; existing old-pin grants need replacement. To deliberately restore an old key/path use your previous policy backup and retained certificate directory, verify validity, and restart. Never blindly restore an old replay/receipt snapshot over newer completed activity: that can undo replay protection or lose reconciliation. A full historical state restore is a recovery decision and can lose post-backup work. Do not downgrade farther than alpha.3 without the older release's required pre-migration database backup.

No production service was changed by preparing this candidate; no package publication, GitHub release or main merge is authorized here.
