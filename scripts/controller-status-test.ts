/* Offline regression test for sync status after a file operation fails. */
import { SecretStorage, TFile } from "obsidian";
import { SyncController } from "../src/SyncController";
import { DEFAULT_SETTINGS, GoogleSyncSettings } from "../src/settings";
import { HttpResponse, HttpSend } from "../src/providers/RemoteProvider";
import { sha256Hex } from "../src/util/hash";

const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;
const response = (status: number, body: string): HttpResponse => ({
  status,
  headers: {},
  text: async () => body,
  arrayBuffer: async () => bytes(body),
});

async function main(): Promise<void> {
  const file = new TFile("note.md");
  const app = {
    secretStorage: new SecretStorage(),
    vault: {
      configDir: ".obsidian",
      getName: () => "test vault",
      getFiles: () => [file],
      adapter: { readBinary: async () => bytes("note") },
    },
  };
  let failUpload = true;
  let created = false;
  const http: HttpSend = async (method, url) => {
    if (url === "https://oauth2.googleapis.com/token") {
      return response(200, JSON.stringify({ access_token: "fake-access", expires_in: 3600 }));
    }
    if (method === "GET" && url.includes("/drive/v3/files?")) {
      const q = new URL(url).searchParams.get("q") ?? "";
      const files = q.includes("mimeType='application/vnd.google-apps.folder'")
        ? [{ id: "folder" }]
        : created ? [{ id: "file", name: "note.md", mimeType: "text/plain", version: "version" }] : [];
      return response(200, JSON.stringify({ files }));
    }
    if (method === "POST" && url.includes("/upload/drive/v3/files?")) {
      if (failUpload) return response(403, "simulated upload failure");
      created = true;
      return response(200, JSON.stringify({ id: "file", version: "version" }));
    }
    throw new Error(`Unexpected fake request: ${method} ${url}`);
  };
  const settings: GoogleSyncSettings = {
    ...DEFAULT_SETTINGS,
    oauthClientId: "fake-client",
    driveEnabled: true,
    driveToken: { enc: false, data: "fake-refresh" },
    lastSyncAt: 123,
    backendLastSync: { drive: 456 },
    syncState: {
      "drive/mirror/Obsidian Sync/test vault": { "note.md": { localHash: await sha256Hex(bytes("note")), remoteVersion: "old-checksum" } },
    },
    e2eeHeaders: {},
  };
  const controller = new SyncController(app as never, settings, async () => {}, http);
  await controller.prepare();
  const failed = await controller.sync();
  if (failed.errors.length !== 1 || failed.errors[0].path !== "note.md") throw new Error("expected the file upload to fail");
  if (settings.lastSyncAt !== 123 || settings.backendLastSync.drive !== 456) throw new Error("failed sync changed the last-success timestamps");

  failUpload = false;
  const succeeded = await controller.sync();
  if (succeeded.errors.length || !succeeded.uploaded.includes("note.md")) throw new Error("expected the retry to succeed");
  if (settings.lastSyncAt === 123 || settings.backendLastSync.drive === 456) throw new Error("successful sync did not update the timestamps");
  if (!settings.syncState["drive/mirror-versioned/Obsidian Sync/test vault"]?.["note.md"]) throw new Error("Drive version tracking must use a fresh baseline");
  console.log("controller status: PASS (failed sync preserves last-success timestamps; successful retry updates them)");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
