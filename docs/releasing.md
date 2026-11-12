# Signing, notarization and updates

UVE uses Developer ID signing and Apple notarization for macOS releases. The app and DMG receive separate notarization tickets, including stapled tickets for offline installation. Signing, notarization, or Gatekeeper failure stops packaging.

The current distribution choice is **public GitHub releases**: the repository and its releases are public, so anyone can download an installer without an account. **Settings → App updates** opens the releases page in the browser. These are manual installer updates: download the DMG, quit Blackout after saving, and replace the application in Applications. Projects and the existing application profile live outside the bundle. No GitHub token or other credential is embedded in the app or its release configuration.

## Build a signed release

Prepare a version with `npm run release -- patch` (or an explicit higher stable version). Add `--dry-run` to preview. This updates the root, desktop, CLI, web and lockfile together; it does not commit, tag, push, or publish anything. A failed lockfile refresh restores the prior version files.

Set release configuration in your local shell or CI secret store:

- `CUTROOM_RELEASE=1`
- `CUTROOM_SIGN_IDENTITY`: the Developer ID Application identity or its SHA-1 fingerprint
- `APPLE_TEAM_ID`: the ten-character Apple developer team
- `CUTROOM_NOTARY_PROFILE`: the name of an existing `notarytool` Keychain profile
- Alternatively, `APPLE_ID` and `APPLE_PASSWORD` (an app-specific password) can replace that profile. Keep credentials out of files and chat.
- Optional `CUTROOM_SIGN_KEYCHAIN` and `CUTROOM_NOTARY_KEYCHAIN`: explicit Keychain paths; omit for the normal search list/iCloud Keychain.
- For the releases page that Settings opens, `CUTROOM_PRIVATE_DOWNLOAD_URL=https://github.com/OWNER/REPOSITORY/releases/latest` (the variable keeps its original name). Only credential-free GitHub releases page URLs are accepted.
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
node scripts/verify-standalone-bundle.mjs apps/desktop/out/Blackout-darwin-arm64/Blackout.app arm64 --output .context/bundle-verification.json
node scripts/verify-macos-release.mjs --app apps/desktop/out/Blackout-darwin-arm64/Blackout.app --zip apps/desktop/out/make/zip/darwin/arm64/Blackout-darwin-arm64-VERSION.zip --dmg apps/desktop/out/make/Blackout-arm64.dmg --team YOURTEAMID --output .context/release-verification.json
```

The first checks bundled native dependencies, local speech/speaker models, web assets, compiler modules and the bundled CLI with a system-only PATH. The second extracts a private snapshot of the ZIP and mounts a private snapshot of the DMG read-only, verifies actual bundle versions and code-signature hashes agree, checks the expected Developer ID team, hardened runtime, stapled tickets and Gatekeeper acceptance, then records SHA-256 and sizes. It rejects unsafe ZIP paths/symlinks and changing artifacts.

## Publish a release

The repository is public, and so is everything attached to a published release. Upload the verified DMG, ZIP, checksums and release notes to a draft GitHub release; compare uploaded asset sizes/digests with the local verification report before publishing that release. Before publishing, read the notes and asset list once more: nothing in them may carry a credential, a Keychain profile name, a signing identity file, or a user's project media.

The current releases page is `https://github.com/TheRealPress1/ULTIMATE-VIDEO-EDITO/releases/latest`. The **Open releases page** button in Settings only opens it; it does not check for or install an update. Automatic in-app updating needs an update feed (below), which the current release does not configure. Never bake a personal access token or any other credential into a release: public assets need none, and anything in the bundle can be read by everyone who downloads it.

## Optional automatic update hosting

When an appropriate host is available, build with `CUTROOM_UPDATE_FEED_URL` pointing to its public HTTPS feed and `CUTROOM_UPDATE_FEED_TYPE=default` (version-aware endpoint) or `json` (static Squirrel manifest). Feed URLs may contain `{platform}` and `{arch}` path placeholders, and must not contain credentials, query parameters or fragments. This optional feed is not activated in the current release.

Generate metadata only from a signed, stapled ZIP:

```sh
node scripts/prepare-release-manifest.mjs path/to/Blackout.zip https://releases.example.com/uve/ releases.json arm64 --team YOURTEAMID --static-dir release-site
```

The generator reads the version and architecture from the verified archive, streams its checksum, preserves prior releases and other architectures, and rejects an older version or replacing an existing version with different bytes. Static manifests appear at `release-site/darwin/arm64/RELEASES.json` (and x64 when present). Upload ZIPs first and replace feed metadata last.

For the dynamic alternative, serve the retained manifest behind an HTTPS reverse proxy:

```sh
CUTROOM_RELEASE_MANIFEST=/absolute/path/releases.json node scripts/update-feed.mjs
```

`/updates` accepts exactly one `version`, `platform` and `arch`, returns the latest newer matching release or HTTP 204, rejects malformed requests with 400, and reports broken hosting metadata with retryable 503. It never queries an upstream Diffusion Studio updater.

For configured automatic updates, **Check & download update** verifies the installed signature and team, then uses Electron's signed update mechanism. **Save and restart to install** waits for durable project saves and refuses an active export. It cannot start twice while Electron is shutting down. A staged Electron update can also apply on a later normal app launch. See [Electron's update protocol](https://www.electronjs.org/docs/latest/tutorial/updates) and [autoUpdater requirements](https://www.electronjs.org/docs/latest/api/auto-updater/).

## CI and installation acceptance

The manual **Build signed macOS release** workflow imports a Developer ID P12 into a temporary Keychain, runs checks, builds/signs/notarizes the app and DMG, verifies the exact artifacts and uploads them as workflow artifacts. It does not publish a release or mutate update feeds. Required secrets and optional feed/releases-page inputs are declared in `.github/workflows/build-macos-release.yml`. It runs only when started by hand, so in the public repository the signing secrets never reach a fork's pull request; keep them in repository secrets, never in the workflow file or a commit. It requires an Apple Silicon macOS runner and cleans up the temporary Keychain.

The workflow is provided in the source tree; cloud builds require configuring its repository secrets. Releases so far were built locally with the existing macOS Keychain profile. A GitHub release carries installer artifacts only; publishing one does not activate cloud builds.

For same-machine release QA, launch the packaged executable with `--user-data-dir=/absolute/separate/profile`. The profile must not overlap the normal Blackout data directory. An alternate profile has separate recents, storage, logs and caches; it skips global protocol/CLI/agent registration changes and uses a separate loopback MCP port. Its `profile-session.json` records the test instance and endpoint. Use disposable project copies for editing/export checks.

A fresh profile proves storage isolation and bundled dependencies on this machine. It is not a clean-Mac test. Final clean-machine acceptance still requires a second Mac/user environment without the development checkout, Homebrew or Node: download the DMG from the public releases page, drag the app into Applications, launch under Gatekeeper without bypasses, import/edit/caption/export a disposable project, relaunch it and verify the output. Keep that result separate from same-machine QA.

## Export timing and color

macOS MP4/MOV exports using AAC first stream an internal lossless PCM MOV into a temporary file. The bundled FFmpeg build copies the video stream and encodes AAC with explicit encoder-delay/edit-list metadata, then atomically replaces the destination. Canceling or failing finalization preserves the previous export. This avoids guessing a platform-specific priming offset. The intermediate file can be larger than the final MP4, so exports need temporary disk space.

The renderer remains an SDR canvas pipeline. Tagged SDR fixtures and timing markers are used in acceptance checks; this is not an HDR or wide-gamut mastering guarantee. Native finalization preserves the existing video packets rather than applying another video encode. See [Apple's AAC delay explanation](https://developer.apple.com/documentation/quicktime-file-format/background_aac_encoding).
