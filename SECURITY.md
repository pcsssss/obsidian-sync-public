# Security Policy

**Development only:** Drive creation, external file-writer races and device
behavior are not fully verified. Credential storage has not been verified in
the target desktop session or on Android. Do not use this fork with a real vault yet.

## Reporting a vulnerability

Please report security issues **privately** via GitHub Security Advisories
(*Security → Report a vulnerability* on this repository) rather than opening a
public issue. You will get a response as soon as possible.

## Security model

- **Bring your own Google Cloud.** Vault data is sent directly to your own
  bucket or Drive using your own credentials, without a shared OAuth app or a
  sync relay. Mobile sign-in uses the redirect page described below.
- **No credential is shipped in the plugin.** The build embeds no client id and
  no client secret: you register your own Google OAuth client and it is stored
  only in this vault's plugin data. Sign-in is the installed-app **PKCE** flow;
  the client secret is sent to Google's token endpoint only because Google
  requires it for "Desktop app" and "Web application" clients, and it is *your*
  secret, never ours. Google Cloud Storage can instead use an HMAC key you create.
- **Mobile sign-in redirect.** By default, Google redirects the browser to the
  upstream author's GitHub Pages site, which passes the authorization code back
  to Obsidian. The code is bound by PKCE to a verifier held on the device, and
  a random `state` ties the callback to the sign-in attempt. The page host can
  see the request; PKCE does not remove the need to trust that host. A copy is
  included in `docs/oauth/` and can be hosted separately, then configured via
  *Redirect page (advanced)*. This fork has not deployed its own redirect page.
- **Release verification.** Upstream's 0.8.1 release matched a local build
  during evaluation. This fork has not yet published or verified any release.
- **Local credentials.** New OAuth refresh tokens and HMAC keys use Obsidian
  SecretStorage; the plugin's `data.json` contains references instead of those
  values. Obsidian can silently store secrets unencrypted when no OS secret
  store is available. The plugin refuses to save or load SecretStorage credentials
  unless Obsidian reports encryption is available. This uses an undocumented
  Obsidian method and fails closed if it is absent; target-device behavior is
  unverified. An isolated Linux test is described [here](docs/obsidian-isolated-linux-test.md).
  Legacy plaintext credentials migrate only when encrypted storage is available;
  otherwise they remain in the original settings. Earlier versions could have
  stored credentials unencrypted in the Obsidian profile, and old backups or
  storage logs may retain them: revoke and reconnect affected credentials and
  review those copies. The OAuth client secret remains in plugin settings, and
  other plugins may access SecretStorage. Interrupted downloads may leave
  plaintext temporary files in the vault configuration directory. Do not share
  or commit plugin data. The default Drive scope is `drive.file`; full Drive
  access is optional. Existing passphrase-encrypted credentials still work.
- **End-to-end content encryption (optional, recommended).** With E2EE enabled,
  files are encrypted on-device before upload, so a credential or backend
  compromise does not expose note content. A forgotten passphrase means the
  content cannot be recovered — the inherent cost of true E2EE. The key is
  derived on each device from your passphrase (PBKDF2-SHA256) and a random salt
  kept in a small plaintext file at the remote folder's root
  (`.gsync-e2ee.json`), so every device derives the same key. That file holds no
  secret: the salt, the work factor, and a fixed string encrypted with the key,
  which lets a device reject a wrong passphrase before it syncs — and makes an
  edited header (say, a weaker work factor) fail to open rather than be trusted.
  The passphrase is asked twice when a folder is first encrypted. E2EE starts
  only on an empty remote folder; a device with E2EE switched off refuses to sync
  with an encrypted folder, and an unlocked device re-checks the folder's header
  before every sync, so it never writes with a key the folder no longer records.

## Supported versions

This is beta software; the latest release receives fixes.
