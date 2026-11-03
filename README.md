# Obsidian Sync

> **Development only: do not use this plugin with a real vault.** Offline
> tests cannot establish that Drive preconditions or Android file operations
> behave safely. Duplicate creation and external file-writer races remain.
> Token storage has not yet been verified in the target desktop session or on Android.

This project starts from [Google Sync for Obsidian](https://github.com/sertacyildiz/obsidian-google-sync),
version [0.8.1](https://github.com/sertacyildiz/obsidian-google-sync/tree/0.8.1)
(commit `8169d3a7b5e5cf65400b3f7344d03e1b0040a85d`). It is a source snapshot
in this repository, not a GitHub fork with shared commit history. Upstream's
copyright and MIT license are retained in [LICENSE](LICENSE).

The goal is to sync vault files between the official Obsidian apps on Linux and
Android using a Google Drive account. The imported plugin also supports Google
Cloud Storage. Mobile sign-in currently defaults to an upstream-hosted static
redirect page; it can be configured to use a separately hosted page instead.
A self-hosted mobile redirect page is not deployed by this repository.

For ordinary updates, a newer remote note or attachment should replace the
unchanged older local copy automatically. When both copies have changed, both
versions must be preserved. Saving a refresh token should not require a separate
passphrase on each launch.

## Development

Install Node.js and the locked dependencies:

```sh
npm ci
```

Run the final verification (type-check, build, and offline tests):

```sh
npm run verify
```

The tests use fake vaults and storage, not a Google account. In particular,
`scripts/concurrency-test.ts` simulates concurrent edits and interrupted syncs.
Passing offline tests is not a production-readiness check.

## Updates

The personal fork has its own plugin ID, `personal-google-sync`, so Obsidian
will not update it from upstream's community plugin listing. GitHub releases
contain only `main.js`, `manifest.json`, and `styles.css`; no vault settings or
credentials are included. Install and update the fork with BRAT. Google sign-in
is configured separately on each device.

Keep BRAT's automatic updates off for now, and update manually only when no sync
is running: the plugin does not yet wait for an in-progress sync on reload. An
older release can restore the code, not undo changes to notes or sync state.
The fork still shares its mobile OAuth callback with upstream, so do not enable
both plugins in the same vault. Android setup has not yet been tested.

## Current limitations

- Existing Drive files use version-checked v2 writes and trash requests. A live
  probe passed against synthetic files on one account, but an Obsidian-to-Drive
  sync has not been tested. Drive may advance file versions without an explicit
  content edit, causing a safe retry or extra conflict copy.
- Drive allows duplicate file and folder names: concurrent creation is not
  atomic and can pause syncing until duplicates are resolved. Local binary
  replacement uses a recoverable backup, but Android rename/copy behavior and
  races with external file writers are not verified. Interrupted attachment
  operations can require manual recovery.
- GCS remains outside the Drive safety work: concurrent updates to an existing
  GCS object are not conditional.
- Refresh tokens are stored through Obsidian SecretStorage without a separate
  plugin passphrase only when Obsidian reports an encrypted OS secret store.
  This check uses an undocumented Obsidian method and fails closed if absent;
  see [SECURITY.md](SECURITY.md).
- A headless Linux Obsidian instance was tested with disposable vaults, a private
  keyring, and a simulated remote; see [the test notes](docs/obsidian-isolated-linux-test.md).
  Android and the target desktop session remain untested. An external Google
  OAuth app in Testing generally issues Drive refresh tokens that expire after
  seven days, requiring reconnection.
- Independent, versioned backups are necessary; synchronization is not backup.
  Old attachments may be moved to the vault's `.trash`; a terminated sync may
  also leave plaintext temporary files in the vault configuration directory.
