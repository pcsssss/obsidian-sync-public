/* Offline tests for Drive's conditional update path. */
import { DriveProvider } from "../src/providers/drive/DriveProvider";
import { PreconditionFailed, type HttpResponse, type HttpSend } from "../src/providers/RemoteProvider";

const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;
const reply = (status: number, body: object): HttpResponse => {
  const text = JSON.stringify(body);
  return { status, headers: {}, text: async () => text, arrayBuffer: async () => bytes(text) };
};

class FakeDrive {
  version = "v1";
  tag = '"etag-1"';
  exists = true;
  omitTag = false;
  omitVersion = false;
  omitMetadataVersion = false;
  changeBeforeMetadata = false;
  changeBeforeWrite = false;
  duplicate = false;
  omitId = false;
  updates = 0;
  deletes = 0;
  reads = 0;
  readonly http: HttpSend = async (method, url, headers, body) => {
    const path = new URL(url).pathname;
    if (method === "GET" && path === "/drive/v3/files") {
      const files = this.exists ? [{ id: this.omitId ? "" : "file-id", version: this.omitVersion ? "" : this.version }] : [];
      if (this.duplicate) files.push({ id: "other-id", version: this.version });
      return reply(200, { files });
    }
    if (method === "GET" && path === "/drive/v2/files/file-id") {
      this.reads++;
      if (this.changeBeforeMetadata) this.version = "v2";
      return reply(200, { etag: this.omitTag ? undefined : this.tag, version: this.omitMetadataVersion ? undefined : this.version });
    }
    if (method === "PUT" && path === "/upload/drive/v2/files/file-id") {
      if (this.changeBeforeWrite) this.tag = '"etag-2"';
      if (headers["if-match"] !== this.tag) return reply(412, {});
      this.updates++;
      this.version = "v2";
      return reply(200, { id: "file-id", version: this.version });
    }
    if (method === "PATCH" && path === "/drive/v2/files/file-id") {
      if (this.changeBeforeWrite) this.tag = '"etag-2"';
      if (headers["if-match"] !== this.tag) return reply(412, {});
      if (!body || JSON.parse(new TextDecoder().decode(body)).labels?.trashed !== true) throw new Error("Expected a recoverable trash request");
      this.deletes++;
      this.exists = false;
      return reply(200, { id: "file-id" });
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  provider(): DriveProvider { return new DriveProvider({ appFolderName: "" }, async () => "fake-token", this.http); }
}

async function expectRejected(op: () => Promise<unknown>): Promise<void> {
  try { await op(); } catch (e) { if (e instanceof PreconditionFailed) return; throw e; }
  throw new Error("Expected a precondition failure");
}

async function main(): Promise<void> {
  {
    const drive = new FakeDrive();
    const result = await drive.provider().put("note.md", bytes("edit"), undefined, { ifVersion: "v1", ifId: "file-id" });
    if (result.version !== "v2" || drive.updates !== 1) throw new Error("Matching version should update exactly once");
  }
  {
    const drive = new FakeDrive();
    const message = await drive.provider().put("note.md", bytes("edit")).then(() => "", (e: Error) => e.message);
    if (!message.includes("observed version") || drive.updates) throw new Error("Unguarded updates must be rejected");
  }
  {
    const drive = new FakeDrive();
    const message = await drive.provider().put("note.md", bytes("edit"), undefined, { ifVersion: "v1" }).then(() => "", (e: Error) => e.message);
    if (!message.includes("observed ID") || drive.updates) throw new Error("An update without an observed ID must be refused");
  }
  {
    const drive = new FakeDrive();
    await expectRejected(() => drive.provider().put("note.md", bytes("edit"), undefined, { ifVersion: "old", ifId: "file-id" }));
    if (drive.updates || drive.reads) throw new Error("Stale listed version must not reach the update");
  }
  {
    const drive = new FakeDrive();
    await expectRejected(() => drive.provider().put("note.md", bytes("edit"), undefined, { ifVersion: "v1", ifId: "different-file" }));
    if (drive.updates) throw new Error("A replacement file with the same checksum must not be overwritten");
  }
  {
    const drive = new FakeDrive();
    drive.changeBeforeMetadata = true;
    await expectRejected(() => drive.provider().put("note.md", bytes("edit"), undefined, { ifVersion: "v1", ifId: "file-id" }));
    if (drive.updates) throw new Error("Changed metadata must not be overwritten");
  }
  {
    const drive = new FakeDrive();
    drive.changeBeforeWrite = true;
    await expectRejected(() => drive.provider().put("note.md", bytes("edit"), undefined, { ifVersion: "v1", ifId: "file-id" }));
    if (drive.updates) throw new Error("A rejected If-Match must not update the file");
  }
  {
    const drive = new FakeDrive();
    drive.omitTag = true;
    await expectRejected(() => drive.provider().put("note.md", bytes("edit"), undefined, { ifVersion: "v1", ifId: "file-id" }));
    if (drive.updates) throw new Error("Missing ETag must fail closed");
  }
  {
    const drive = new FakeDrive();
    drive.omitMetadataVersion = true;
    await expectRejected(() => drive.provider().put("note.md", bytes("edit"), undefined, { ifVersion: "v1", ifId: "file-id" }));
    if (drive.updates) throw new Error("Missing metadata version must fail closed");
  }
  {
    const drive = new FakeDrive();
    drive.exists = false;
    await expectRejected(() => drive.provider().put("note.md", bytes("edit"), undefined, { ifVersion: "v1", ifId: "file-id" }));
    if (drive.updates) throw new Error("A vanished file must not be recreated as an update");
  }
  {
    const drive = new FakeDrive();
    await expectRejected(() => drive.provider().put("note.md", bytes("edit"), undefined, { ifAbsent: true }));
    if (drive.updates) throw new Error("Create-only must not overwrite an existing file");
  }
  {
    const drive = new FakeDrive();
    drive.duplicate = true;
    const message = await drive.provider().put("note.md", bytes("edit"), undefined, { ifVersion: "v1", ifId: "file-id" }).then(() => "", (e: Error) => e.message);
    if (!message.toLowerCase().includes("duplicate") || drive.updates) throw new Error("Duplicate Drive files must stop updates");
  }
  {
    const http: HttpSend = async () => reply(200, { files: [
      { id: "one", name: "note.md", mimeType: "text/plain", version: "v1" },
      { id: "two", name: "note.md", mimeType: "text/plain", version: "v2" },
    ] });
    const message = await new DriveProvider({ appFolderName: "" }, async () => "fake-token", http).list().then(() => "", (e: Error) => e.message);
    if (!message.toLowerCase().includes("duplicate")) throw new Error("A listing with duplicate paths must be rejected");
  }
  {
    const http: HttpSend = async () => reply(200, { files: [{ id: "one" }, { id: "two" }] });
    const message = await new DriveProvider({ appFolderName: "root" }, async () => "fake-token", http).list().then(() => "", (e: Error) => e.message);
    if (!message.toLowerCase().includes("duplicate")) throw new Error("Duplicate sync-root folders must be rejected");
  }
  {
    const drive = new FakeDrive();
    drive.omitId = true;
    const message = await drive.provider().put("note.md", bytes("edit"), undefined, { ifAbsent: true }).then(() => "", (e: Error) => e.message);
    if (!message.toLowerCase().includes("id")) throw new Error("A found file without an ID must not be treated as absent");
  }
  {
    const drive = new FakeDrive();
    drive.omitVersion = true;
    const message = await drive.provider().head("note.md").then(() => "", (e: Error) => e.message);
    if (!message.toLowerCase().includes("version")) throw new Error("A file without a version must not be used");
  }
  {
    const http: HttpSend = async () => reply(200, { files: [{}] });
    const message = await new DriveProvider({ appFolderName: "root" }, async () => "fake-token", http).list().then(() => "", (e: Error) => e.message);
    if (!message.toLowerCase().includes("id")) throw new Error("A found folder without an ID must not be recreated");
  }
  {
    let lookups = 0;
    let writes = 0;
    const http: HttpSend = async (method, url) => {
      const path = new URL(url).pathname;
      if (method === "GET" && path === "/drive/v3/files") return reply(200, { files: ++lookups === 1 ? [] : [{ id: "created" }, { id: "concurrent" }] });
      if (method === "POST" && path === "/drive/v3/files") { writes++; return reply(200, { id: "created" }); }
      throw new Error(`Unexpected request: ${method} ${path}`);
    };
    const message = await new DriveProvider({ appFolderName: "root" }, async () => "fake-token", http).list().then(() => "", (e: Error) => e.message);
    if (!message.toLowerCase().includes("duplicate") || writes !== 1) throw new Error("Concurrent sync-root creation must stop before using either root");
  }
  {
    const http: HttpSend = async () => reply(200, { files: [{ name: "notes", mimeType: "application/vnd.google-apps.folder" }] });
    const message = await new DriveProvider({ appFolderName: "" }, async () => "fake-token", http).list().then(() => "", (e: Error) => e.message);
    if (!message.toLowerCase().includes("id")) throw new Error("A listed folder without an ID must not be skipped");
  }
  {
    let lookups = 0;
    let creates = 0;
    const http: HttpSend = async (method, url) => {
      const path = new URL(url).pathname;
      if (method === "GET" && path === "/drive/v3/files") {
        return reply(200, { files: ++lookups === 1 ? [] : [{ id: "created" }, { id: "concurrent" }] });
      }
      if (method === "POST" && path === "/upload/drive/v3/files") {
        creates++;
        return reply(200, { id: "created", version: "v1" });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    };
    const message = await new DriveProvider({ appFolderName: "" }, async () => "fake-token", http)
      .put("note.md", bytes("edit"), undefined, { ifAbsent: true }).then(() => "", (e: Error) => e.message);
    if (!message.toLowerCase().includes("duplicate") || creates !== 1) throw new Error("Concurrent duplicate creation must be reported");
  }
  {
    const entries: { id: string; name: string; mimeType: string; version: string; content: string }[] = [];
    let initialReads = 0;
    let creates = 0;
    let releaseReads: () => void = () => {};
    let releaseCreates: () => void = () => {};
    const readsReady = new Promise<void>((resolve) => { releaseReads = resolve; });
    const createsReady = new Promise<void>((resolve) => { releaseCreates = resolve; });
    const http: HttpSend = async (method, url, _headers, body) => {
      const u = new URL(url);
      if (method === "GET" && u.pathname === "/drive/v3/files") {
        const snapshot = entries.map(({ content: _content, ...entry }) => entry);
        if (u.searchParams.has("orderBy") && !entries.length) {
          if (++initialReads === 2) releaseReads();
          await readsReady;
        }
        return reply(200, { files: snapshot });
      }
      if (method === "POST" && u.pathname === "/upload/drive/v3/files") {
        const text = new TextDecoder().decode(body);
        const content = text.includes("phone-content") ? "phone-content" : "laptop-content";
        const entry = { id: `id-${++creates}`, name: "new.md", mimeType: "text/plain", version: "1", content };
        entries.push(entry);
        if (creates === 2) releaseCreates();
        await createsReady;
        return reply(200, { id: entry.id, version: entry.version });
      }
      throw new Error(`Unexpected request: ${method} ${u.pathname}`);
    };
    const provider = () => new DriveProvider({ appFolderName: "" }, async () => "fake-token", http);
    const outcomes = await Promise.allSettled([
      provider().put("new.md", bytes("phone-content"), undefined, { ifAbsent: true }),
      provider().put("new.md", bytes("laptop-content"), undefined, { ifAbsent: true }),
    ]);
    if (outcomes.some((outcome) => outcome.status !== "rejected") || entries.length !== 2 ||
        !entries.some((entry) => entry.content === "phone-content") || !entries.some((entry) => entry.content === "laptop-content")) {
      throw new Error("Simultaneous creates must stop and leave both Drive copies intact");
    }
    const message = await provider().list().then(() => "", (e: Error) => e.message);
    if (!message.toLowerCase().includes("duplicate")) throw new Error("Later syncs must stop on duplicate creates");
  }
  {
    const http: HttpSend = async (_method, url) => new URL(url).searchParams.has("pageToken")
      ? reply(200, { files: [{ id: "two", name: "note.md", mimeType: "text/plain", version: "v2" }] })
      : reply(200, { files: [{ id: "one", name: "note.md", mimeType: "text/plain", version: "v1" }], nextPageToken: "next" });
    const message = await new DriveProvider({ appFolderName: "" }, async () => "fake-token", http).list().then(() => "", (e: Error) => e.message);
    if (!message.toLowerCase().includes("duplicate")) throw new Error("Duplicates across listing pages must be rejected");
  }
  {
    const drive = new FakeDrive();
    await drive.provider().delete("note.md", { ifVersion: "v1", ifId: "file-id" });
    if (drive.deletes !== 1 || drive.exists) throw new Error("Matching deletion should trash exactly once");
  }
  {
    const drive = new FakeDrive();
    const message = await drive.provider().delete("note.md").then(() => "", (e: Error) => e.message);
    if (!message || drive.deletes) throw new Error("A deletion without an observed version and ID must be refused");
  }
  {
    const drive = new FakeDrive();
    await expectRejected(() => drive.provider().delete("note.md", { ifVersion: "old", ifId: "file-id" }));
    if (drive.deletes || drive.reads) throw new Error("A stale version must not reach the trash request");
  }
  {
    const drive = new FakeDrive();
    await expectRejected(() => drive.provider().delete("note.md", { ifVersion: "v1", ifId: "different-file" }));
    if (drive.deletes) throw new Error("A replacement file must not be trashed");
  }
  {
    const drive = new FakeDrive();
    drive.changeBeforeMetadata = true;
    await expectRejected(() => drive.provider().delete("note.md", { ifVersion: "v1", ifId: "file-id" }));
    if (drive.deletes) throw new Error("Changed metadata must not be trashed");
  }
  {
    const drive = new FakeDrive();
    drive.changeBeforeWrite = true;
    await expectRejected(() => drive.provider().delete("note.md", { ifVersion: "v1", ifId: "file-id" }));
    if (drive.deletes || !drive.exists) throw new Error("A rejected If-Match must keep the file");
  }
  {
    const drive = new FakeDrive();
    drive.omitTag = true;
    await expectRejected(() => drive.provider().delete("note.md", { ifVersion: "v1", ifId: "file-id" }));
    if (drive.deletes) throw new Error("Missing deletion ETag must fail closed");
  }
  console.log("Drive conditional updates and deletion: PASS (version races, missing ETags and duplicate paths)");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
