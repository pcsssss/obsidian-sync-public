# Isolated Linux Obsidian test

Development evidence only; this is not approval to use a real vault.

A headless Obsidian 1.13.7 instance, launched with Electron 43.6.0, used separate
profiles and disposable synthetic vaults under `.local/`. External name
resolution was blocked. No existing Obsidian vault, Google credentials, or live
Drive files were used.

- The plugin loaded, and **Sync now** with no connected backend reported that
  nothing was configured. Drive and Cloud Storage advanced settings initially
  collided; after giving their pages distinct names, each opened the right page.
- With the session D-Bus disabled, Obsidian reported that its secret store was
  unencrypted. Before the guard was added, a synthetic HMAC secret appeared as
  literal bytes in the isolated profile's local storage. With the guard, the
  plugin warned, did not load the existing credential for syncing, and refused
  a replacement without changing the old reference. The rejected synthetic
  value was not found in profile or vault files.
- With a private D-Bus and a newly created, manually unlocked GNOME keyring,
  Obsidian reported `gnome_libsecret` and encryption available. The plugin saved
  a synthetic HMAC credential as a reference and loaded it after an Obsidian
  restart, with no additional plugin passphrase. A literal-byte scan of the
  disposable profile and vault did not find that synthetic value. This scan is
  not a cryptographic audit, and the test does not establish how the user's
  normal desktop session unlocks its keyring.
- In the same isolated app, a synthetic in-memory remote exercised the real
  Obsidian vault adapter: initial note and attachment upload, ordinary remote
  updates of both without conflict copies, and a local edit made during a note
  download. The racing sync reported an error rather than overwriting the edit;
  the next sync preserved both note versions as a conflict.

No plugin-to-Drive OAuth or live sync, Android behavior, external-writer race,
crash/power-loss recovery, or independent security review was tested here.
The guard relies on an undocumented Obsidian encryption-status method; it must
be checked against future Obsidian versions and on Android.
