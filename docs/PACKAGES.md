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

**Status: published.** `@privanet/protocol`, `@privanet/shared` and `@privanet/sdk` are on the public registry at `0.3.0-alpha.6` (the first release published through trusted publishing; `0.3.0-alpha.5` was the manual bootstrap), with trusted publishing configured for future releases. **npm is the primary way to consume them.**

```bash
npm install @privanet/sdk@next       # a pre-release: pulls @privanet/protocol and @privanet/shared at the same version
npm install @privanet/protocol@next  # only if you use the schemas or types directly
```

While PrivaNet-Core is pre-1.0, pin the exact version in your application (`"@privanet/sdk": "0.3.0-alpha.6"`, no caret) so a pre-release never moves under you, and upgrade deliberately. Pre-releases use the `next` dist-tag; stable releases will use `latest`. (npm set `latest` to the first bootstrap version too; until a stable release exists, always ask for `@next` or an exact version.) Every package of a release has the **same version as PrivaNet-Core**, and the internal dependencies are pinned to that exact version, so one `npm install` always yields a matching set. `@privanet/shared` is an internal dependency of the SDK: an application that never imports it should not list it, and npm installs it transitively.

An application must **not** keep sibling `file:` links or GitHub release-asset URLs as its permanent dependency. A local `file:` link to a checkout is fine while developing against an unreleased Core change; it must not be committed to a released application.

To check what the registry actually serves, without touching your project, run `npm run smoke:registry` in this repository (see [Verified in CI](#verified-in-ci)).

### What is not an npm package

The **Coordinator and PrivaNode are not consumer packages.** They come from the platform release archives (`privanet-<version>-linux|macos|windows`) and run as services (see [FIRST_DEPLOYMENT.md](FIRST_DEPLOYMENT.md)). An application needs only the SDK; it talks to a Coordinator over HTTPS.

### Release tarballs (fallback, always kept)

Every GitHub release also carries the packed tarballs (`privanet-sdk-<version>.tgz`, `privanet-protocol-<version>.tgz`, `privanet-shared-<version>.tgz`) next to the platform archives and `SHA256SUMS.txt`. They are a **fallback and verifiable artifact**, not the install path: use them for an air-gapped install, during a registry outage, or to verify a download against `SHA256SUMS.txt`. Install them by file path or release-asset URL (`npm install ./privanet-sdk-0.3.0-alpha.6.tgz ./privanet-protocol-0.3.0-alpha.6.tgz ./privanet-shared-0.3.0-alpha.6.tgz`). `0.3.0-alpha.1` tarballs carry no license file; use `0.3.0-alpha.5` or newer.

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
5. After a publish, the `registry-smoke` job installs the new version from the registry into a clean project and imports it. The `publish` job runs only when the repository **variable** `NPM_PUBLISH` is `true`, so releases stay green until the one-time setup below is done.

### One-time npm setup (by the repository owner; the workflow cannot do this)

Preferred: **trusted publishing**, with no long-lived token stored in GitHub.

1. On npmjs.com create the `privanet` organisation (or otherwise own the `@privanet` scope), public.
2. **Bootstrap (done for `0.3.0-alpha.5`).** npm can only attach a trusted publisher to a package that already exists, so the very first version of each of the three packages must be published once by an owner, either by hand from the release tarballs (`npm publish privanet-protocol-<version>.tgz --access public --tag next`, then `shared`, then `sdk`) or by temporarily setting an `NPM_TOKEN` secret (a granular automation token limited to the `@privanet` scope) and `NPM_PUBLISH=true`, then deleting the token afterwards.
3. For each of `@privanet/protocol`, `@privanet/shared` and `@privanet/sdk`, open the package **Settings, Trusted Publisher, GitHub Actions** and register: owner `doopydoop364`, repository `PrivaNet-Core`, workflow filename `release.yml` (no environment). Optionally, then set the package's publishing access to require two-factor authentication and disallow tokens.
4. Set the repository variable `NPM_PUBLISH` to `true` (Settings, Secrets and variables, Actions, Variables). Until it is set the `publish` and `registry-smoke` jobs are skipped and a release publishes nothing to npm. Later releases publish through GitHub's OIDC identity: `npm publish` runs on npm 11.5.1 or newer with `id-token: write`, gets a short-lived credential, and attaches provenance.

Fallback: an `NPM_TOKEN` repository secret (granular, publish-only, scoped to `@privanet`) is used only if it exists. Prefer removing it once trusted publishing works. Nothing else in the design depends on which path is used.

## License

`Apache-2.0`. The repository has the standard `LICENSE` file, every `package.json` declares `"license": "Apache-2.0"`, and each published package tarball and each staged platform archive contains the license text. Third-party dependencies (for example `zod`) keep their own licenses and are not relicensed.

## Verified in CI

`tests/packages.test.ts` packs the three packages, installs the tarballs into a fresh project, checks that only built output ships (no sources, maps or tests), imports the SDK and protocol through their exports, and type-checks a consumer: `submit('web.fetch.v1', …)` compiles, and a field outside the contract is a compile error. It also checks the shape of the publish job (OIDC, provenance, dependency order, `next` for pre-releases, idempotent re-runs, opt-in). It does not publish and does not touch the live registry, so the ordinary suite never depends on the network.

`scripts/registry-smoke.mjs` (`npm run smoke:registry [version] [tag]`) is the live-registry check. In a clean temporary project it confirms the three packages exist at the expected version and the dist-tag points at it, runs `npm install @privanet/sdk@<tag>`, verifies that protocol, shared and sdk all resolve to exactly that one version, and imports them (builds a `PrivaNetClient`, validates against a protocol schema). The Release workflow runs it after each publish; run it by hand at any time.
