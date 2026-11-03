/* Offline tests for device-local credential storage and migration. */
import { SyncController } from "../src/SyncController";
import { DEFAULT_SETTINGS, type GoogleSyncSettings } from "../src/settings";
import type { HttpSend } from "../src/providers/RemoteProvider";

class Secrets {
  readonly values = new Map<string, string>();
  fail = false;
  failAt = 0;
  calls = 0;
  unreadable = false;
  encrypted = true;
  isEncryptionAvailable(): boolean { return this.encrypted; }
  setSecret(id: string, value: string): void {
    this.calls++;
    if (this.fail || this.calls === this.failAt) throw new Error("simulated storage failure");
    this.values.set(id, value);
  }
  getSecret(id: string): string | null { return this.unreadable ? null : this.values.get(id) ?? null; }
}
const response = JSON.stringify({ access_token: "fake-access", refresh_token: "fake-refresh-token", expires_in: 3600 });
const http: HttpSend = async () => ({
  status: 200, headers: {}, text: async () => response,
  arrayBuffer: async () => new TextEncoder().encode(response).buffer,
});
const fresh = (): GoogleSyncSettings => ({
  ...DEFAULT_SETTINGS, driveEnabled: true, oauthClientId: "fake-client", oauthClientSecret: "fake-client-secret",
  syncState: {}, backendLastSync: {}, e2eeHeaders: {}, syncDevices: [],
});

function device(settings: GoogleSyncSettings, secrets?: Secrets) {
  let saved = "";
  let opened = 0;
  const controller = new SyncController({ secretStorage: secrets } as never, settings, async () => { saved = JSON.stringify(settings); }, http,
    { mobile: true, openUrl: () => { opened++; } });
  return { controller, saved: () => saved, opened: () => opened };
}
async function expectFailure(action: () => Promise<unknown>): Promise<string> {
  try { await action(); } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error("Expected secure storage failure");
}

async function main(): Promise<void> {
  const secrets = new Secrets();
  const settings = fresh();
  const first = device(settings, secrets);
  await first.controller.connect("drive");
  await first.controller.completeRedirectLogin({ state: settings.pendingAuth?.state ?? "", code: "fake-code" });
  if (!settings.driveToken || settings.driveToken.kind !== "obsidian") throw new Error("OAuth refresh token was not stored in Obsidian SecretStorage");
  if (secrets.getSecret(settings.driveToken.data) !== "fake-refresh-token") throw new Error("SecretStorage did not receive the refresh token");
  if (first.saved().includes("fake-refresh-token")) throw new Error("Refresh token leaked into plugin data");
  const key = settings.driveToken.data;
  const restarted = device(JSON.parse(first.saved()) as GoogleSyncSettings, secrets);
  await restarted.controller.prepare();
  if (!restarted.controller.ready) throw new Error("Stored credentials did not load after restart");
  await restarted.controller.disconnectDrive();
  if (secrets.getSecret(key)) throw new Error("Disconnect did not clear the stored token");

  const legacySecrets = new Secrets();
  const legacySettings = fresh();
  legacySettings.driveToken = { enc: false, data: "legacy-plaintext-token" };
  const legacy = device(legacySettings, legacySecrets);
  await legacy.controller.prepare();
  if (!legacy.controller.ready || legacySettings.driveToken?.kind !== "obsidian") throw new Error("Legacy token was not migrated");
  if (legacy.saved().includes("legacy-plaintext-token")) throw new Error("Migration retained plaintext in plugin data");

  const failedMigrationSettings = fresh();
  failedMigrationSettings.driveToken = { enc: false, data: "legacy-token-to-retain" };
  const failedMigrationSecrets = new Secrets();
  failedMigrationSecrets.fail = true;
  const failedMigration = device(failedMigrationSettings, failedMigrationSecrets);
  await expectFailure(() => failedMigration.controller.prepare());
  if (failedMigrationSettings.driveToken?.data !== "legacy-token-to-retain" || failedMigration.saved()) throw new Error("Failed migration altered the original credential");

  const failedMultiSettings = fresh();
  failedMultiSettings.gcsToken = { enc: false, data: "legacy-gcs-token" };
  failedMultiSettings.driveToken = { enc: false, data: "legacy-drive-token" };
  const failedMultiSecrets = new Secrets();
  failedMultiSecrets.failAt = 2;
  const failedMulti = device(failedMultiSettings, failedMultiSecrets);
  await expectFailure(() => failedMulti.controller.prepare());
  if (failedMultiSettings.gcsToken?.data !== "legacy-gcs-token" || failedMultiSettings.driveToken?.data !== "legacy-drive-token") throw new Error("Partial migration altered original credentials");
  if ([...failedMultiSecrets.values.values()].some(Boolean)) throw new Error("Partial migration left an unused credential");

  const failedSaveSettings = fresh();
  failedSaveSettings.driveToken = { enc: false, data: "legacy-token-after-save-error" };
  const failedSaveSecrets = new Secrets();
  const failedSave = new SyncController({ secretStorage: failedSaveSecrets } as never, failedSaveSettings, async () => { throw new Error("simulated settings failure"); }, http,
    { mobile: true, openUrl: () => {} });
  await expectFailure(() => failedSave.prepare());
  if (failedSaveSettings.driveToken?.data !== "legacy-token-after-save-error") throw new Error("Failed settings save did not retain the original credential");
  if ([...failedSaveSecrets.values.values()].some(Boolean)) throw new Error("Failed settings save left an unused credential");

  const gcsSettings = fresh();
  gcsSettings.gcsEnabled = true;
  gcsSettings.bucket = "fake-bucket";
  const gcsSecrets = new Secrets();
  const gcs = device(gcsSettings, gcsSecrets);
  await gcs.controller.saveGcsCredentials("fake-id", "fake-hmac-secret");
  if (gcsSettings.gcsSecret?.kind !== "obsidian" || gcs.saved().includes("fake-hmac-secret")) throw new Error("HMAC secret was not protected");
  if (gcsSecrets.getSecret(gcsSettings.gcsSecret.data) !== "fake-hmac-secret") throw new Error("HMAC secret is missing from SecretStorage");

  const previousGcsSecrets = new Secrets();
  previousGcsSecrets.setSecret("old-hmac-reference", "old-hmac-secret");
  const previousGcsSettings = fresh();
  previousGcsSettings.gcsEnabled = true;
  previousGcsSettings.bucket = "fake-bucket";
  previousGcsSettings.accessId = "old-access-id";
  previousGcsSettings.gcsSecret = { enc: false, data: "old-hmac-reference", kind: "obsidian" };
  const failedGcsSave = new SyncController({ secretStorage: previousGcsSecrets } as never, previousGcsSettings, async () => { throw new Error("simulated settings failure"); }, http,
    { mobile: true, openUrl: () => {} });
  await failedGcsSave.prepare();
  await expectFailure(() => failedGcsSave.saveGcsCredentials("new-access-id", "new-hmac-secret"));
  if (previousGcsSettings.gcsSecret?.data !== "old-hmac-reference" || previousGcsSettings.accessId !== "old-access-id" || previousGcsSecrets.getSecret("old-hmac-reference") !== "old-hmac-secret") {
    throw new Error("A failed HMAC save did not retain the previous credential");
  }
  if ([...previousGcsSecrets.values.values()].includes("new-hmac-secret")) throw new Error("A failed HMAC save left a live replacement credential");

  const unavailableSettings = fresh();
  const unavailable = device(unavailableSettings);
  await expectFailure(() => unavailable.controller.connect("drive"));
  if (unavailable.opened() || unavailableSettings.driveToken) throw new Error("Sign-in started without secret storage");

  const unencryptedSecrets = new Secrets();
  unencryptedSecrets.encrypted = false;
  const unencryptedSettings = fresh();
  const unencrypted = device(unencryptedSettings, unencryptedSecrets);
  const warning = await expectFailure(() => unencrypted.controller.connect("drive"));
  const hmacWarning = await expectFailure(() => unencrypted.controller.saveGcsCredentials("fake-id", "fake-secret"));
  if (!warning.includes("encrypted secret store") || !hmacWarning.includes("encrypted secret store")) throw new Error("Missing keychain warning");
  if (unencrypted.opened() || unencryptedSecrets.calls || unencryptedSettings.gcsSecret || unencryptedSettings.pendingAuth) {
    throw new Error("An unencrypted OS keychain accepted credentials or started sign-in");
  }
  const unknownSecrets = new Secrets();
  Object.defineProperty(unknownSecrets, "isEncryptionAvailable", { value: undefined });
  await expectFailure(() => device(fresh(), unknownSecrets).controller.connect("drive"));
  if (unknownSecrets.calls) throw new Error("Unknown encryption status accepted credentials");
  const brokenStatus = new Secrets();
  brokenStatus.isEncryptionAvailable = () => { throw new Error("simulated status failure"); };
  await expectFailure(() => device(fresh(), brokenStatus).controller.connect("drive"));
  if (brokenStatus.calls) throw new Error("A failed encryption check accepted credentials");

  const legacyUnencrypted = fresh();
  legacyUnencrypted.driveToken = { enc: false, data: "legacy-token-to-keep" };
  await expectFailure(() => device(legacyUnencrypted, unencryptedSecrets).controller.prepare());
  if (legacyUnencrypted.driveToken.data !== "legacy-token-to-keep" || unencryptedSecrets.calls) {
    throw new Error("A failed migration changed the legacy token or wrote to unencrypted storage");
  }
  const storedUnencrypted = fresh();
  storedUnencrypted.driveToken = { enc: false, data: "existing-reference", kind: "obsidian" };
  unencryptedSecrets.values.set("existing-reference", "existing-token");
  const stopped = device(storedUnencrypted, unencryptedSecrets);
  await expectFailure(() => stopped.controller.prepare());
  if (stopped.controller.ready) throw new Error("An unencrypted credential was loaded");
  await stopped.controller.disconnectDrive();
  if (unencryptedSecrets.getSecret("existing-reference")) throw new Error("Disconnect could not clear unencrypted storage");

  const changingSecrets = new Secrets();
  const changingSettings = fresh();
  let tokenExchanges = 0;
  const changing = new SyncController({ secretStorage: changingSecrets } as never, changingSettings, async () => {}, async (...args) => {
    tokenExchanges++;
    return http(...args);
  }, { mobile: true, openUrl: () => {} });
  await changing.connect("drive");
  changingSecrets.encrypted = false;
  await expectFailure(() => changing.completeRedirectLogin({ state: changingSettings.pendingAuth?.state ?? "", code: "fake-code" }));
  if (tokenExchanges || changingSecrets.calls || changingSettings.driveToken) throw new Error("Sign-in continued after encryption became unavailable");

  const failingSecrets = new Secrets();
  failingSecrets.fail = true;
  const failedSettings = fresh();
  const failed = device(failedSettings, failingSecrets);
  await failed.controller.connect("drive");
  await expectFailure(() => failed.controller.completeRedirectLogin({ state: failedSettings.pendingAuth?.state ?? "", code: "fake-code" }));
  if (failedSettings.driveToken || failed.saved().includes("fake-refresh-token")) throw new Error("Failed storage fell back to plaintext");

  const unreadableSecrets = new Secrets();
  unreadableSecrets.unreadable = true;
  const unreadableSettings = fresh();
  const unreadable = device(unreadableSettings, unreadableSecrets);
  await unreadable.controller.connect("drive");
  await expectFailure(() => unreadable.controller.completeRedirectLogin({ state: unreadableSettings.pendingAuth?.state ?? "", code: "fake-code" }));
  if ([...unreadableSecrets.values.values()].includes("fake-refresh-token")) throw new Error("Unreadable SecretStorage left a live unreferenced token");

  const oldSecrets = new Secrets();
  oldSecrets.setSecret("old-reference", "old-token");
  const oldSettings = fresh();
  oldSettings.driveToken = { enc: false, data: "old-reference", kind: "obsidian" };
  let saves = 0;
  const failingSave = new SyncController({ secretStorage: oldSecrets } as never, oldSettings, async () => {
    if (++saves === 3) throw new Error("simulated settings failure");
  }, http, { mobile: true, openUrl: () => {} });
  await failingSave.prepare();
  await failingSave.connect("drive");
  await expectFailure(() => failingSave.completeRedirectLogin({ state: oldSettings.pendingAuth?.state ?? "", code: "fake-code" }));
  if (oldSettings.driveToken?.data !== "old-reference" || oldSecrets.getSecret("old-reference") !== "old-token" || !failingSave.ready) {
    throw new Error("A failed save did not retain the previous credential");
  }
  if ([...oldSecrets.values.values()].includes("fake-refresh-token")) throw new Error("A failed save left a live replacement credential");

  const missing = device(JSON.parse(first.saved()) as GoogleSyncSettings, new Secrets());
  await expectFailure(() => missing.controller.prepare());
  console.log("Secret storage: PASS (sign-in, restart, disconnect, migration and unavailable storage)");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
