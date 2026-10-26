# Signing, notarization and updates

UVE uses Developer ID signing and Apple notarization for macOS releases. The app and DMG receive separate notarization tickets, including stapled tickets for offline installation. Signing, notarization, or Gatekeeper failure stops packaging.

The current distribution choice is **private GitHub releases**. The app opens the private downloads page in the browser, using the owner's GitHub session. These are manual installer updates: download the DMG, quit Cutroom after saving, and replace the application in Applications. Projects and the existing application profile live outside the bundle. No GitHub token is embedded in the app and no private credential is passed to a public update feed.

## Build a signed release

Prepare a version with `npm run release -- patch` (or an explicit higher stable version). Add `--dry-run` to preview. This updates the root, desktop, CLI, web and lockfile together; it does not commit, tag, push, or publish anything. A failed lockfile refresh restores the prior version files.

Set release configuration in your local shell or CI secret store:

- `CUTROOM_RELEASE=1`
- `CUTROOM_SIGN_IDENTITY`: the Developer ID Application identity or its SHA-1 fingerprint
- `APPLE_TEAM_ID`: the ten-character Apple developer team
- `CUTROOM_NOTARY_PROFILE`: the name of an existing `notarytool` Keychain profile
- Alternatively, `APPLE_ID` and `APPLE_PASSWORD` (an app-specific password) can replace that profile. Keep credentials out of files and chat.
- Optional `CUTROOM_SIGN_KEYCHAIN` and `CUTROOM_NOTARY_KEYCHAIN`: explicit Keychain paths; omit for the normal search list/iCloud Keychain.
- For private downloads, `CUTROOM_PRIVATE_DOWNLOAD_URL=https://github.com/OWNER/REPOSITORY/releases/latest`. Only credential-free GitHub releases page URLs are accepted.
- Optional `UVE_INSTAGRAM_AUTH_URL`: the HTTPS origin of the deployed Instagram authorization service. Its Meta app secret stays on that server.

Run:

```sh
npm run setup:speech
node apps/desktop/scripts/build-audio-tools.mjs
npm run check
npm test
npm run make
```

Building audio tools first enables the native timing/loudness tests on a fresh machine. Native tools must match the packaging architecture. The minimum supported macOS version is 13.0. Local development builds use `SKIP_SIGN=1 npm run make` without `CUTROOM_RELEASE`; they do not enable automatic updates.

Release settings are validated both during the build and at Forge's packaging entry point. Invoking Forge directly cannot package stale configuration left from a different release. The bundled configuration contains only the team identifier, signed-release flag, optional download/feed addresses and Instagram authorization origin. It contains no Apple credentials.

## Verify the exact artifacts

After packaging, run both checks (use the actual version in the ZIP filename):

```sh
node scripts/verify-standalone-bundle.mjs apps/desktop/out/Cutroom-darwin-arm64/Cutroom.app arm64 --output .context/bundle-verification.json
node scripts/verify-macos-release.mjs --app apps/desktop/out/Cutroom-darwin-arm64/Cutroom.app --zip apps/desktop/out/make/zip/darwin/arm64/Cutroom-darwin-arm64-VERSION.zip --dmg apps/desktop/out/make/Cutroom-arm64.dmg --team YOURTEAMID --output .context/release-verification.json
```

The first checks bundled native dependencies, local speech/speaker models, web assets, compiler modules and the bundled CLI with a system-only PATH. The second extracts a private snapshot of the ZIP and mounts a private snapshot of the DMG read-only, verifies actual bundle versions and code-signature hashes agree, checks the expected Developer ID team, hardened runtime, stapled tickets and Gatekeeper acceptance, then records SHA-256 and sizes. It rejects unsafe ZIP paths/symlinks and changing artifacts.

## Publish privately

Keep the repository private. Upload the verified DMG, ZIP, checksums and release notes to a draft GitHub release; compare uploaded asset sizes/digests with the local verification report before publishing that release. A private repository's collaborators can access its releases, so retain only the intended accounts. Publishing a private release does not make the repository or installers public.

The current private downloads page is `https://github.com/TheRealPress1/ULTIMATE-VIDEO-EDITO/releases/latest`. Its **Open private downloads** button does not claim to check for or install an update automatically. Private in-app updating needs an authenticated service and short-lived download authorization; a private GitHub asset URL alone is not an anonymous Squirrel feed. Do not bake a personal access token into a release.

## Optional automatic update hosting

When an appropriate host is available, build with `CUTROOM_UPDATE_FEED_URL` pointing to its public HTTPS feed and `CUTROOM_UPDATE_FEED_TYPE=default` (version-aware endpoint) or `json` (static Squirrel manifest). Feed URLs may contain `{platform}` and `{arch}` path placeholders, and must not contain credentials, query parameters or fragments. This optional public-host path is not activated in the private release.

Generate metadata only from a signed, stapled ZIP:

```sh
node scripts/prepare-release-manifest.mjs path/to/Cutroom.zip https://releases.example.com/uve/ releases.json arm64 --team YOURTEAMID --static-dir release-site
```

The generator reads the version and architecture from the verified archive, streams its checksum, preserves prior releases and other architectures, and rejects an older version or replacing an existing version with different bytes. Static manifests appear at `release-site/darwin/arm64/RELEASES.json` (and x64 when present). Upload ZIPs first and replace feed metadata last.

For the dynamic alternative, serve the retained manifest behind an HTTPS reverse proxy:

```sh
CUTROOM_RELEASE_MANIFEST=/absolute/path/releases.json node scripts/update-feed.mjs
```

`/updates` accepts exactly one `version`, `platform` and `arch`, returns the latest newer matching release or HTTP 204, rejects malformed requests with 400, and reports broken hosting metadata with retryable 503. It never queries an upstream Diffusion Studio updater.

For configured automatic updates, **Check & download update** verifies the installed signature and team, then uses Electron's signed update mechanism. **Save and restart to install** waits for durable project saves and refuses an active export. It cannot start twice while Electron is shutting down. A staged Electron update can also apply on a later normal app launch. See [Electron's update protocol](https://www.electronjs.org/docs/latest/tutorial/updates) and [autoUpdater requirements](https://www.electronjs.org/docs/latest/api/auto-updater/).

## CI and installation acceptance

The manual **Build signed macOS release** workflow imports a Developer ID P12 into a temporary Keychain, runs checks, builds/signs/notarizes the app and DMG, verifies the exact artifacts and uploads private workflow artifacts. It does not publish a release or mutate update feeds. Required secrets and optional feed/private-download inputs are declared in `.github/workflows/build-macos-release.yml`. It requires an Apple Silicon macOS runner and cleans up the temporary Keychain.

The workflow is provided in the source tree; cloud builds require pushing that source and configuring its repository secrets. The first private release was built locally with the existing macOS Keychain profile. Its GitHub release contains installer artifacts; publishing it does not upload the development source or activate cloud builds.

For same-machine release QA, launch the packaged executable with `--user-data-dir=/absolute/separate/profile`. The profile must not overlap the normal Cutroom data directory. An alternate profile has separate recents, storage, logs and caches; it skips global protocol/CLI/agent registration changes and uses a separate loopback MCP port. Its `profile-session.json` records the test instance and endpoint. Use disposable project copies for editing/export checks.

A fresh profile proves storage isolation and bundled dependencies on this machine. It is not a clean-Mac test. Final clean-machine acceptance still requires a second Mac/user environment without the development checkout, Homebrew or Node: download the private DMG through GitHub, drag the app into Applications, launch under Gatekeeper without bypasses, import/edit/caption/export a disposable project, relaunch it and verify the output. Keep that result separate from same-machine QA.

## Export timing and color

macOS MP4/MOV exports using AAC first stream an internal lossless PCM MOV into a temporary file. The bundled FFmpeg build copies the video stream and encodes AAC with explicit encoder-delay/edit-list metadata, then atomically replaces the destination. Canceling or failing finalization preserves the previous export. This avoids guessing a platform-specific priming offset. The intermediate file can be larger than the final MP4, so exports need temporary disk space.

The renderer remains an SDR canvas pipeline. Tagged SDR fixtures and timing markers are used in acceptance checks; this is not an HDR or wide-gamut mastering guarantee. Native finalization preserves the existing video packets rather than applying another video encode. See [Apple's AAC delay explanation](https://developer.apple.com/documentation/quicktime-file-format/background_aac_encoding).
