# CI, caches, and downloadable artifacts

> [简体中文](zh-CN/ci.md) | **English**

This page describes the desktop and Android GitHub Actions pipelines. Windows and Linux releases are unsigned; Android requires a persistent release certificate. None of these artifacts, by themselves, prove that a package was launched on its target hardware.

## Workflows

| Workflow        | File                                      | Trigger                                          | Result                                                                               |
| --------------- | ----------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| CI              | `.github/workflows/ci.yml`                | pull requests, pushes to `main`, manual dispatch | quality gates plus unsigned package artifacts                                        |
| Build artifacts | `.github/workflows/package-artifacts.yml` | manual dispatch only                             | unsigned Windows/Linux packages and an Android debug APK; Actions artifacts only     |
| YAQMC release   | `.github/workflows/electron-release.yml`  | `v*` tags, manual dispatch                       | official stable/beta/nightly Releases; manual branch runs create source-build drafts |

The removed legacy desktop workflow is not a supported build path. CI package artifacts are retained for 14 days.

## Manual artifact builds

After pushing a commit, open **Actions → Build artifacts → Run workflow**, select the branch and
`all`, `windows`, `linux`, or `android`, then start the workflow. Download the packages from the
completed run's **Artifacts** section; they are retained for 14 days. Pushes do not automatically
run this dedicated workflow, and it never creates or publishes a GitHub Release.

Desktop builds reuse the existing x64/arm64 matrix and package scripts. `ci` uses ThinLTO with
eight codegen units; `production` uses Fat LTO with one codegen unit. Windows artifacts contain
an installer and portable EXE; Linux artifacts contain AppImage, deb, rpm, and tar.gz packages.
Android builds its separate renderer and a debug-signed test APK for arm64-v8a and x86_64 without
requiring release signing secrets. A debug APK cannot replace an APK signed with another key.

## Gates and package matrix

Every CI run performs frontend formatting, documentation, lint, TypeScript,
Vitest and script checks; builds the Electron host on Linux and Windows; runs
Rust fmt, clippy and workspace tests; validates contracts; checks the
unconditional public `qm-api-rs` git pin; tests provider-readiness and provenance
validators with synthetic fixtures; and scans for secrets on Linux and Windows. Cargo fetches the exact public revision directly with
`CARGO_NET_GIT_FETCH_WITH_CLI=true`.

- Pull requests package Windows x64 and Linux x64.
- Pushes to `main` package Windows x64/arm64 and Linux x64/arm64.
- Manual runs select `windows`, `linux`, or `all`, and `ci` or `production` optimization.
- Windows arm64 is cross-compiled on `windows-2025`. Linux arm64 uses `ubuntu-22.04-arm`.
- Windows i686 is not built or published.

Superseded pull-request runs are cancelled. Pushes to `main`, tag builds, and manual packaging runs are not cancelled mid-flight.

## Build and packaging flow

`frontend-build` uploads `yaqmc-frontend-dist-<sha>`. Each package job downloads that exact artifact, compiles `yaqmc-core` for its Rust target, stages the Core executable, builds Electron Main/preload code, and invokes electron-builder with publishing disabled.

Windows produces an NSIS installer and portable executable. Linux produces AppImage, `.deb`, `.rpm`, and `.tar.gz`. Package jobs install Electron packaging tools on Linux; retired Linux web-runtime packages are not host dependencies.

The Android release job builds its own `dist-android` renderer, compiles the shared Rust Core for `arm64-v8a`, synchronizes Capacitor, and assembles a minified release APK with JDK 21, SDK 36, and NDK 28.2.13676358. Android does not reuse the desktop renderer artifact because its host feature boundary is different.

Do not upload or reuse `node_modules` between jobs.

## Windows release signing

The approved release policy publishes unsigned Windows installers and portable EXEs.
No Windows certificate secrets are required. The workflow disables certificate discovery
and checks that both EXEs have `NotSigned` status before upload. Unsigned packaging
disables updater publisher-signature verification; only download from the official
YAQMC release. SHA-256 checksums detect corruption but do not independently authenticate
the publisher. Windows may show an unknown-publisher or SmartScreen warning.

An explicit local `--require-signing true` build still uses the separate fail-closed
`electron-builder.release.yml` configuration; it is not the current release workflow policy.

## Android release signing

To create a new key on Windows, run `pwsh -File scripts/new-android-release-key.ps1 -Destination <PRIVATE_DIRECTORY_OUTSIDE_REPO>` with `keytool` installed. The script refuses existing destinations, restricts directory permissions, and writes five secret-value files plus a PKCS12 keystore and public certificate. Upload each text file's content under its filename without `.txt` in repository **Settings → Environments → release-signing → Environment secrets**, not Dependabot secrets or Actions variables. Keep an encrypted offline backup. Never commit these files. New keys cannot directly update installations signed with an unrelated old key.

The Android package job uses the same protected `release-signing` environment and requires:

- `ANDROID_RELEASE_KEYSTORE_BASE64`: the persistent release keystore encoded as Base64;
- `ANDROID_RELEASE_KEY_ALIAS`: the release key alias;
- `ANDROID_RELEASE_STORE_PASSWORD`: the keystore password;
- `ANDROID_RELEASE_KEY_PASSWORD`: the key password.
- `ANDROID_RELEASE_CERT_SHA256`: the expected SHA-256 digest of the release signing certificate.

The workflow decodes the keystore only into the runner's temporary directory, limits its permissions, and removes it before artifact upload. Missing signing data fails closed. After Gradle assembly, Android Build Tools `apksigner verify --print-certs` checks the APK and compares its certificate digest to the protected expected value; `sha256sum --check` then verifies the staged checksum. Keep the same signing key for every upgrade of `org.yaqmc.android`; losing it prevents users from installing an update over the existing app.

## Optimization and caches

Normal CI packages override the release profile with ThinLTO and eight codegen units:

```text
CARGO_PROFILE_RELEASE_LTO=thin
CARGO_PROFILE_RELEASE_CODEGEN_UNITS=8
```

Manual `production` runs and the release workflow use Fat LTO and one codegen
unit. Every package artifact contains a unique
`build-info-<os>-<arch>.json` recording the effective profile, LTO mode,
codegen units, Rust target, Node version, Electron version, and Git identity.
The release assembler requires that identity to match the corresponding-source
commit before flattening assets.

Cargo caches are keyed by OS, Rust target, toolchain class, `Cargo.lock`, and profile class. Pull requests may restore caches but only `main` pushes, tags, and manual runs save them. Restored caches are untrusted inputs; a cold-cache build must still succeed.

## Artifact and release names

CI uploads `YAQMC-electron-<os>-<arch>-<sha>` from the corresponding `release-electron` directory. Architectures use electron-builder labels `x64` and `arm64`.

Linux x64 package jobs also upload
`YAQMC-linux-x64-tester-<sha>`. This separate flat artifact contains the exact
AppImage, immutable build identity, checksums, current testing/acceptance
instructions, collector, and verifier. CI runs the verifier's identity-only
gate before upload; it is not mixed into draft release assets.

The release workflow requires successful exact-commit CI on `main`, Required reviewers
on the `release-signing` environment, and an explicit `private_gates_confirmed` attestation
after the maintainer runs the local private release gates. Tagged publication is performed
through `workflow_dispatch` with that confirmation; a direct tag push is blocked. Pin and
Android signing checks also run before packaging.
It checks out the exact dependency revisions,
builds revision-bound YAQMC, `qm-api-rs`, and AMLL source archives, and writes
`CORRESPONDING-SOURCE-MANIFEST.json`. Assembly verifies those archive hashes,
flattens package assets, validates the Android build identity against the same Git commit,
writes platform checksums plus commit-based `RELEASE-NOTES.md`, and retains x64
compatibility feeds `latest.yml` / `latest-linux.yml` alongside the architecture-specific
Windows updater metadata. Version-tag builds are published only through the protected
manual release workflow after local-gate confirmation: stable versions become latest;
prereleases are marked prerelease and never latest.
Manual runs on an exact version tag retain that tag and stay drafts unless `publish`
is enabled. Manual branch runs use `electron-draft-<run-id>` and always remain drafts.
Rerunning a release never overwrites an existing Release or its assets; publish an
existing draft after review, or use a new version for changed content.

Signing configuration is checked before toolchain installation and frontend builds;
missing secrets are reported by name, never by value. Tagged releases require the
complete Windows and Linux x64/arm64 matrix, both Windows setup and portable EXEs,
all four Linux formats, x64 updater feeds, and the arm64-v8a Android APK. Manual
Windows/Linux rehearsals may limit desktop targets but still include Android.
Do not create a stable tag until signing credentials are configured. Old releases
and tags are removed separately after checking their exact names; CI does not delete
release history automatically.

The packaged renderer uses the AGPL-licensed AMLL packages. Assembly verifies their exact package version,
license, revision, source entry points, archive hash, and the requirements in
[the corresponding-source policy](../CORRESPONDING_SOURCE_POLICY.md).

## Publish a beta or nightly

Use **YAQMC release** for updater-visible prereleases. The push CI and **Build
artifacts** are development candidates: even their `production` packages have
source-build identity. Copying those packages to a Release does not turn them
into official self-updating builds.

1. Configure **Settings → Environments → release-signing → Required reviewers**
   and the five Android signing secrets above. A reviewer must validate the exact
   commit locally before approving. See [release requirements](release/README.md).
2. Change the root `package.json` version, for example to `0.1.2-beta.1`, and run:

   ```sh
   npm run sync-version
   npm install --package-lock-only --ignore-scripts
   cargo update --workspace
   node scripts/sync-version.mjs --check
   ```

   Review the lockfile diff; keep unrelated dependency pins unchanged. Commit
   the version changes and push `main`. Wait for **CI on that exact SHA** to finish
   successfully. A failed or still-running latest CI blocks the release.

3. On that clean commit, with private reports present locally, run:

   ```sh
   npm run release:check:local -- --commit <FULL_SHA> --tag v0.1.2-beta.1
   ```

   A blocked gate remains a blocker; do not fabricate evidence or approve it.

4. Create `v0.1.2-beta.1` at that exact commit and push only that tag. In Actions,
   verify the deployment SHA and approve `release-signing` after the local
   command passes. Tag pushes publish automatically after all builds and
   assembly succeed. The Release overview is generated from commits.

For nightly builds use `0.1.2-nightly.1`, incrementing the serial for every
release. The unified desktop/Android pipeline supports `alpha.n`, `beta.n`,
`nightly.n` and `rc.n`, where `n` is 0–999; date serials such as
`nightly.20261028` exceed Android's version-code bounds. SemVer orders these
channels alphabetically, so `nightly.1` is newer than `beta.999` at the same
base version. Do not expect a switch back to beta at that base to update clients.
Use `0.1.2` for the corresponding stable release.

To build a draft on an existing version tag manually, select that tag under
**Run workflow**, keep `targets=all` and `publish=false`. Enable `publish` only
when ready for publication. Branch runs always remain source-build drafts.
Never retag a published version or overwrite its assets; increment the version
even when only the commit changed. Existing releases remain unchanged.

## Build-accepted versus runtime-tested

A green package job proves compilation, package assembly, metadata generation, and artifact upload. It does not prove startup, overlay behavior, OAuth, keyring continuity, media integration, updater behavior, or native execution on every OS/CPU. Those require separate hardware acceptance evidence.

## Local commands

```powershell
npm run ci:frontend-build
npm run ci:test-scripts
npm run ci:package-metadata
npm run provider:enforce
npm run provenance:enforce
npm run package -w @yaqmc/desktop -- --publish never
```
