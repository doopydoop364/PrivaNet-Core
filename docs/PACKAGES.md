# Installing the PrivaNet SDK and protocol packages

Applications (PrivaSearch and others) consume PrivaNet through **versioned npm packages**, never by copying files from a release archive or by permanent sibling `file:` links.

| Package | Purpose | Consumers |
| --- | --- | --- |
| `@privanet/sdk` | `PrivaNetClient`: submit typed jobs, poll for validated results, health and capabilities | Applications |
| `@privanet/protocol` | The wire contract: strict Zod schemas, the job-type registry (including `web.fetch.v1`), types, protocol version | Applications that need schemas or types directly (the SDK depends on it) |
| `@privanet/shared` | Bounded HTTPS/loopback transport and identity helpers | Installed automatically as an SDK dependency; not an API for applications |

The Coordinator and PrivaNode (`apps/*`) are **not** consumer packages. They ship in release archives and run as services.

## Registry mechanism

**Public npm**, under the `@privanet` scope. Reasons: this is a public project, it needs no installation token for consumers, and it keeps the package names independent of the GitHub account name (GitHub Packages would require the scope to equal the repository owner, and consumers would need a token even for public packages). The release workflow publishes with provenance through **npm trusted publishing** (GitHub OIDC, no long-lived token), with an optional token fallback (see [Publishing](#publishing)). The packages are licensed under [Apache-2.0](../LICENSE) and each tarball contains the license text.

```bash
npm install @privanet/sdk            # pulls @privanet/protocol and @privanet/shared
npm install @privanet/protocol       # only if you use the schemas or types directly
```

Pre-releases use the `next` dist-tag (`npm install @privanet/sdk@next`); stable releases use `latest`. Every package of a release has the **same version as PrivaNet-Core**, and the internal dependencies are pinned to that exact version, so one `npm install` always yields a matching set.

### Release tarballs (fallback source, always kept)

Until the packages are on the registry, and permanently as a fallback (an air-gapped install, a registry outage, or verifying a download against `SHA256SUMS.txt`), every GitHub release carries the packed tarballs (`privanet-sdk-<version>.tgz`, `privanet-protocol-<version>.tgz`, `privanet-shared-<version>.tgz`) next to the platform archives and `SHA256SUMS.txt`. A consumer may depend on the release-asset URLs:

```json
{ "dependencies": {
  "@privanet/protocol": "https://github.com/doopydoop364/PrivaNet-Core/releases/download/v0.3.0-alpha.3/privanet-protocol-0.3.0-alpha.3.tgz",
  "@privanet/shared": "https://github.com/doopydoop364/PrivaNet-Core/releases/download/v0.3.0-alpha.3/privanet-shared-0.3.0-alpha.3.tgz",
  "@privanet/sdk": "https://github.com/doopydoop364/PrivaNet-Core/releases/download/v0.3.0-alpha.3/privanet-sdk-0.3.0-alpha.3.tgz" } }
```

A local `file:` dependency on a sibling checkout is acceptable for development and integration testing. Neither is the primary distribution: the target is a plain versioned dependency (`"@privanet/sdk": "^0.3.0"`). `0.3.0-alpha.1` tarballs carry no license file; use `0.3.0-alpha.3` or newer.

## Compatibility expectations

- **Wire protocol.** `X-PrivaNet-Protocol: 1` is sent by the SDK and checked by the Coordinator. Within protocol 1 all changes are additive and optional; a genuinely incompatible change bumps the protocol number and fails with HTTP 426 `PROTOCOL_MISMATCH`, with no silent fallback. The SDK surfaces it as an `ApiError` with status 426.
- **Job types.** Ids carry their version (`web.fetch.v1`). A changed contract is a new id, never a silent change. A Coordinator that does not know a type answers 400/403; `GET /v1/capabilities` shows which types have online nodes.
- **Package versions.** Keep `@privanet/sdk` and `@privanet/protocol` on the same version (the SDK pins its own dependencies, so a single install is consistent). An application talking to a Coordinator of a different release should stay within the same major and check the Coordinator's `GET /v1/health` (`serviceVersion`, `protocolVersion`).
- **Pre-releases (`-alpha`, `-beta`)** may change without notice. The first stable guarantee is Phase 11.
- **Node and runtime.** Packages require Node.js 24.4 or newer and are pure JavaScript with type declarations. Only the `.` export is public.

## Publishing

1. Bump the version in every package (they move together) and add the dated `CHANGELOG.md` section. The release-readiness tests fail if they disagree.
2. Merge through a green PR, then tag or dispatch the Release workflow (`workflow_dispatch` with the tag name).
3. The workflow verifies, on Linux, macOS and Windows, lint, typecheck and the whole suite; stages the platform archives; `npm pack`s the three packages onto the release assets; and runs `npm publish --dry-run` for each.
4. The `publish` job then publishes `protocol`, `shared` and `sdk` in dependency order with `--provenance`, using `--tag next` for pre-releases. It skips a version that is already on npm, so a re-run is safe. The GitHub release and its tarballs are created **before and independently of** this job, so an npm problem never blocks or removes a release.
5. The job runs only when the repository **variable** `NPM_PUBLISH` is `true`, so releases stay green until the one-time setup below is done.

### One-time npm setup (by the repository owner; the workflow cannot do this)

Preferred: **trusted publishing**, with no long-lived token stored in GitHub.

1. On npmjs.com create the `privanet` organisation (or otherwise own the `@privanet` scope), public.
2. **Bootstrap.** npm can only attach a trusted publisher to a package that already exists, so the very first version of each of the three packages must be published once by an owner, either by hand from the release tarballs (`npm publish privanet-protocol-<version>.tgz --access public --tag next`, then `shared`, then `sdk`) or by temporarily setting an `NPM_TOKEN` secret (a granular automation token limited to the `@privanet` scope) and `NPM_PUBLISH=true`, then deleting the token afterwards.
3. For each of `@privanet/protocol`, `@privanet/shared` and `@privanet/sdk`, open the package **Settings, Trusted Publisher, GitHub Actions** and register: owner `doopydoop364`, repository `PrivaNet-Core`, workflow filename `release.yml` (no environment). Optionally, then set the package's publishing access to require two-factor authentication and disallow tokens.
4. Set the repository variable `NPM_PUBLISH` to `true` (Settings, Secrets and variables, Actions, Variables). Later releases publish through GitHub's OIDC identity: `npm publish` runs on npm 11.5.1 or newer with `id-token: write`, gets a short-lived credential, and attaches provenance.

Fallback: an `NPM_TOKEN` repository secret (granular, publish-only, scoped to `@privanet`) is used only if it exists. Prefer removing it once trusted publishing works. Nothing else in the design depends on which path is used.

## License

`Apache-2.0`. The repository has the standard `LICENSE` file, every `package.json` declares `"license": "Apache-2.0"`, and each published package tarball and each staged platform archive contains the license text. Third-party dependencies (for example `zod`) keep their own licenses and are not relicensed.

## Verified in CI

`tests/packages.test.ts` packs the three packages, installs the tarballs into a fresh project, checks that only built output ships (no sources, maps or tests), imports the SDK and protocol through their exports, and type-checks a consumer: `submit('web.fetch.v1', …)` compiles, and a field outside the contract is a compile error. It does not publish and does not test against the live registry.
