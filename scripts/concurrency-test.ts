/* Offline safety regressions using the real sync engine and Drive provider. */
import { createHash } from "node:crypto";
import { DriveProvider } from "../src/providers/drive/DriveProvider";
import { SyncEngine } from "../src/sync/SyncEngine";
import { identityCryptor } from "../src/sync/Cryptor";
import { sha256Hex } from "../src/util/hash";
import type { LocalStore } from "../src/sync/LocalStore";
import type { SyncStateData } from "../src/sync/types";
import type { HttpResponse, HttpSend } from "../src/providers/RemoteProvider";

const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;
const binary = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer;
const md5 = (data: ArrayBuffer): string => createHash("md5").update(new Uint8Array(data)).digest("hex");
const equalBytes = (a: ArrayBuffer | undefined, b: ArrayBuffer): boolean =>
  !!a && a.byteLength === b.byteLength && new Uint8Array(a).every((value, i) => value === new Uint8Array(b)[i]);
const text = (b: ArrayBuffer | undefined): string => new TextDecoder().decode(b);

class Local implements LocalStore {
  readonly files = new Map<string, ArrayBuffer>();
  readonly trash = new Map<string, ArrayBuffer>();
  binaryInterrupt: "rename" | "partial" | "copy" | "trash" | null = null;
  deleteInterrupt: "rename" | "trash" | null = null;
  listOnlyPath: string | null = null;
  mtime = 1;
  beforeReplace: (() => Promise<void>) | null = null;
  beforeWrite: ((path: string) => Promise<void>) | null = null;
  beforeCreate: ((path: string) => Promise<void>) | null = null;
  beforeRead: ((path: string) => Promise<void>) | null = null;
  beforeDelete: ((path: string) => Promise<void>) | null = null;
  async list() {
    return Promise.all([...this.files].filter(([path]) => !this.listOnlyPath || path === this.listOnlyPath)
      .map(async ([path, data]) => ({ path, hash: await sha256Hex(data), mtime: this.mtime })));
  }
  async exists(path: string) { return this.files.has(path); }
  async read(path: string) {
    if (this.beforeRead) await this.beforeRead(path);
    const data = this.files.get(path);
    if (!data) throw new Error(`Missing local file: ${path}`);
    return data;
  }
  async write(path: string, data: ArrayBuffer) {
    if (this.beforeWrite) await this.beforeWrite(path);
    this.files.set(path, data);
  }
  async create(path: string, data: ArrayBuffer) {
    if (this.beforeCreate) await this.beforeCreate(path);
    if (this.files.has(path)) throw new Error(`Local file already exists: ${path}`);
    this.files.set(path, data);
  }
  async replaceTextIfUnchanged(path: string, expected: ArrayBuffer, data: ArrayBuffer): Promise<boolean> {
    if (this.beforeReplace) await this.beforeReplace();
    if (!equalBytes(this.files.get(path), expected)) return false;
    this.files.set(path, data);
    return true;
  }
  async replaceBinaryIfUnchanged(path: string, expectedHash: string, data: ArrayBuffer, backup: string): Promise<boolean> {
    if (this.beforeWrite) await this.beforeWrite(path);
    const previous = this.files.get(path);
    if (!previous || this.files.has(backup)) throw new Error("cannot move attachment to backup");
    this.files.delete(path);
    this.files.set(backup, previous);
    if (this.binaryInterrupt === "rename") throw new Error("interrupted after rename");
    if ((await sha256Hex(previous)) !== expectedHash) {
      await this.create(path, previous);
      return false;
    }
    if (this.binaryInterrupt === "partial") {
      this.files.set(path, data.slice(0, 1));
      throw new Error("interrupted during copy");
    }
    await this.create(path, data);
    if (this.binaryInterrupt === "copy") throw new Error("interrupted after copy");
    this.trash.set(backup, previous);
    this.files.delete(backup);
    if (this.binaryInterrupt === "trash") throw new Error("interrupted after trash");
    return true;
  }
  async deleteIfUnchanged(path: string, expectedHash: string, backup: string): Promise<boolean> {
    if (this.beforeDelete) await this.beforeDelete(path);
    const previous = this.files.get(path);
    if (!previous || this.files.has(backup)) throw new Error("cannot move file to backup");
    this.files.delete(path);
    this.files.set(backup, previous);
    if (this.deleteInterrupt === "rename") throw new Error("interrupted after rename");
    if ((await sha256Hex(previous)) !== expectedHash) {
      await this.create(path, previous);
      return false;
    }
    this.trash.set(backup, previous);
    this.files.delete(backup);
    if (this.deleteInterrupt === "trash") throw new Error("interrupted after trash");
    return true;
  }
  async delete(path: string) {
    if (this.beforeDelete) await this.beforeDelete(path);
    const value = this.files.get(path);
    if (value) this.trash.set(path, value);
    this.files.delete(path);
  }
}

/** One existing Drive file; the barrier forces both devices to list the same version. */
class FakeDrive {
  constructor(readonly fileName = "note.md") {}
  id = "note-id";
  data = bytes("base");
  revision = 1;
  present = true;
  beforeTrash: (() => Promise<void>) | null = null;
  beforeVersionRead: (() => Promise<void>) | null = null;
  throwAfterTrash = false;
  vanishDuringDownload = false;
  beforeDownload: (() => Promise<void>) | null = null;
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;
  private lists = 0;
  private etagGate: Promise<void> | null = null;
  private releaseEtags: (() => void) | null = null;
  private etagReads = 0;

  armListBarrier(): void {
    this.lists = 0;
    this.etagReads = 0;
    this.gate = new Promise<void>((resolve) => { this.release = resolve; });
    this.etagGate = new Promise<void>((resolve) => { this.releaseEtags = resolve; });
  }

  private response(body: string): HttpResponse {
    return { status: 200, headers: {}, text: async () => body, arrayBuffer: async () => bytes(body) };
  }

  readonly http: HttpSend = async (method, url, headers, body) => {
    const u = new URL(url);
    const file = {
      id: this.id, name: this.fileName, mimeType: "application/octet-stream",
      md5Checksum: md5(this.data), version: `v${this.revision}`, modifiedTime: "2026-01-01T00:00:00Z", size: String(this.data.byteLength),
    };
    if (method === "GET" && u.pathname === "/drive/v3/files") {
      const snapshot = JSON.stringify({ files: this.present ? [file] : [] });
      const gate = this.gate;
      if (gate && !u.searchParams.has("orderBy")) {
        if (++this.lists === 2) { this.gate = null; this.release?.(); }
        await gate;
      }
      return this.response(snapshot);
    }
    if (method === "GET" && u.pathname === `/drive/v2/files/${this.id}`) {
      if (this.beforeVersionRead) await this.beforeVersionRead();
      const snapshot = JSON.stringify({ etag: `"v${this.revision}"`, md5Checksum: md5(this.data), version: `v${this.revision}` });
      const gate = this.etagGate;
      if (gate) {
        if (++this.etagReads === 2) { this.etagGate = null; this.releaseEtags?.(); }
        await gate;
      }
      return this.response(snapshot);
    }
    if (method === "GET" && u.pathname === `/drive/v3/files/${this.id}` && u.searchParams.get("alt") === "media") {
      if (this.vanishDuringDownload) return { status: 404, headers: {}, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
      const snapshot = this.data;
      if (this.beforeDownload) await this.beforeDownload();
      return { status: 200, headers: {}, text: async () => text(snapshot), arrayBuffer: async () => snapshot };
    }
    if (method === "POST" && u.pathname === "/upload/drive/v3/files") {
      if (!body) throw new Error("Missing created content");
      const boundary = headers["content-type"].split("boundary=")[1];
      const raw = Buffer.from(body);
      const first = raw.indexOf("\r\n\r\n") + 4;
      const start = raw.indexOf("\r\n\r\n", first) + 4;
      const end = raw.lastIndexOf(`\r\n--${boundary}--`);
      if (start < 4 || end < start) throw new Error("Invalid multipart creation");
      this.data = Uint8Array.from(raw.subarray(start, end)).buffer;
      this.present = true;
      this.revision++;
      return this.response(JSON.stringify({ id: this.id, md5Checksum: md5(this.data), version: `v${this.revision}` }));
    }
    if (method === "PUT" && u.pathname === `/upload/drive/v2/files/${this.id}`) {
      if (headers["if-match"] !== `"v${this.revision}"`) {
        return { status: 412, headers: {}, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
      }
      if (!body) throw new Error("Missing update content");
      this.data = body;
      this.revision++;
      return this.response(JSON.stringify({ id: this.id, md5Checksum: md5(this.data), version: `v${this.revision}` }));
    }
    if (method === "PATCH" && u.pathname === `/upload/drive/v3/files/${this.id}`) {
      if (!body) throw new Error("Missing update content");
      this.data = body;
      this.revision++;
      return this.response(JSON.stringify({ id: this.id, md5Checksum: md5(this.data), version: `v${this.revision}` }));
    }
    if (method === "PATCH" && u.pathname === `/drive/v2/files/${this.id}`) {
      if (this.beforeTrash) await this.beforeTrash();
      if (headers["if-match"] !== `"v${this.revision}"`) {
        return { status: 412, headers: {}, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
      }
      this.present = false;
      if (this.throwAfterTrash) throw new Error("interrupted after remote trash");
      return this.response("{}");
    }
    if (method === "PATCH" && u.pathname === `/drive/v3/files/${this.id}`) {
      if (this.beforeTrash) await this.beforeTrash();
      this.present = false;
      return this.response("{}");
    }
    throw new Error(`Unexpected fake request: ${method} ${u.pathname}`);
  };
}

function engine(local: Local, drive: FakeDrive): SyncEngine {
  const provider = new DriveProvider({ appFolderName: "" }, async () => "fake-token", drive.http);
  return new SyncEngine(local, provider, identityCryptor, () => new Date("2026-01-01T00:00:00Z"));
}

async function concurrentUploads(): Promise<void> {
  const drive = new FakeDrive(), phone = new Local(), laptop = new Local();
  await phone.write("note.md", bytes("base"));
  await laptop.write("note.md", bytes("base"));
  const phoneState = (await engine(phone, drive).sync({})).state;
  const laptopState = (await engine(laptop, drive).sync({})).state;
  await phone.write("note.md", bytes("phone edit"));
  await laptop.write("note.md", bytes("laptop edit"));
  drive.armListBarrier();
  const [p, l] = await Promise.all([engine(phone, drive).sync(phoneState), engine(laptop, drive).sync(laptopState)]);
  const winner = text(drive.data);
  const loser = winner === "phone edit" ? laptop : phone;
  const loserState = winner === "phone edit" ? l.state : p.state;
  const losingEdit = text(loser.files.get("note.md"));
  if (losingEdit === winner) throw new Error("Test did not produce competing edits");
  await engine(loser, drive).sync(loserState);
  if (![...loser.files.values()].some((data) => text(data) === losingEdit)) {
    throw new Error("A concurrent edit was overwritten without a recoverable local copy");
  }
}

async function remoteEditedAndRevertedBeforeUpload(): Promise<void> {
  const drive = new FakeDrive(), local = new Local();
  await local.write("note.md", bytes("base"));
  const state = (await engine(local, drive).sync({})).state;
  await local.write("note.md", bytes("local edit"));
  drive.beforeVersionRead = async () => {
    drive.beforeVersionRead = null;
    drive.data = bytes("remote edit");
    drive.revision++;
    drive.data = bytes("base");
    drive.revision++;
  };
  const result = await engine(local, drive).sync(state);
  if (text(drive.data) !== "base" || !result.report.errors.length) {
    throw new Error("A remote edit followed by a revert must invalidate the older observed version");
  }
}

async function remoteReplacedWithSameVersion(): Promise<void> {
  const drive = new FakeDrive(), local = new Local();
  await local.write("note.md", bytes("base"));
  const state = (await engine(local, drive).sync({})).state;
  await local.write("note.md", bytes("local edit"));
  drive.id = "replacement-id";
  drive.data = bytes("new remote file");
  drive.revision = 1;
  const result = await engine(local, drive).sync(state);
  if (text(drive.data) !== "new remote file" || ![...local.files.values()].some((data) => text(data) === "local edit") || !result.report.conflicts.length) {
    throw new Error("A replacement Drive file with the same version must be treated as a conflict");
  }
}

async function remoteReplacedAfterLocalDeletion(): Promise<void> {
  const drive = new FakeDrive(), local = new Local();
  await local.write("note.md", bytes("base"));
  const state = (await engine(local, drive).sync({})).state;
  local.files.delete("note.md");
  drive.id = "replacement-id";
  drive.data = bytes("new remote file");
  drive.revision = 1;
  const result = await engine(local, drive).sync(state);
  if (!drive.present || text(local.files.get("note.md")) !== "new remote file" || result.report.errors.length) {
    throw new Error("A replacement Drive file must be restored, not treated as the old deleted file");
  }
}

async function editBeforeUploadRead(): Promise<void> {
  const drive = new FakeDrive(), local = new Local();
  await local.write("note.md", bytes("base"));
  const state = (await engine(local, drive).sync({})).state;
  await local.write("note.md", bytes("listed edit"));
  local.beforeRead = async (path) => {
    local.beforeRead = null;
    await local.write(path, bytes("newer edit"));
  };
  const first = await engine(local, drive).sync(state);
  if (text(drive.data) !== "base" || !first.report.errors.length || first.state["note.md"]?.remoteVersion !== state["note.md"]?.remoteVersion) {
    throw new Error("An upload must not use bytes that differ from the listed local snapshot");
  }
  const retry = await engine(local, drive).sync(first.state);
  if (text(drive.data) !== "newer edit" || retry.report.errors.length) throw new Error("Retry should upload the newer edit");
}

async function editDuringDownload(): Promise<void> {
  const drive = new FakeDrive(), local = new Local();
  await local.write("note.md", bytes("base"));
  const state = (await engine(local, drive).sync({})).state;
  drive.data = bytes("remote edit");
  drive.revision++;
  drive.beforeDownload = async () => { await local.write("note.md", bytes("local edit during download")); };
  const result = await engine(local, drive).sync(state);
  if (![...local.files.values()].some((data) => text(data) === "local edit during download")) {
    throw new Error("An edit saved during download was overwritten without a recoverable local copy");
  }
  if (!result.report.errors.some((error) => error.path === "note.md")) throw new Error("The changed note must be reported for retry");
}

async function ordinaryNoteUpdate(): Promise<void> {
  const drive = new FakeDrive(), local = new Local();
  await local.write("note.md", bytes("base"));
  const state = (await engine(local, drive).sync({})).state;
  drive.data = bytes("remote edit");
  drive.revision++;
  const result = await engine(local, drive).sync(state);
  if (text(local.files.get("note.md")) !== "remote edit" || result.report.errors.length) throw new Error("An unchanged older note should update normally");
}

async function editDuringAtomicWrite(): Promise<void> {
  const drive = new FakeDrive(), local = new Local();
  await local.write("note.md", bytes("base"));
  const state = (await engine(local, drive).sync({})).state;
  drive.data = bytes("remote edit");
  drive.revision++;
  local.beforeReplace = async () => { await local.write("note.md", bytes("local edit during replacement")); };
  const result = await engine(local, drive).sync(state);
  if (text(local.files.get("note.md")) !== "local edit during replacement" || !result.report.errors.length) {
    throw new Error("A note changed immediately before replacement must be kept and reported");
  }
}

async function conflictEditedDuringReplacement(): Promise<void> {
  const drive = new FakeDrive(), local = new Local();
  await local.write("note.md", bytes("base"));
  const state = (await engine(local, drive).sync({})).state;
  await local.write("note.md", bytes("first local edit"));
  drive.data = bytes("remote edit");
  drive.revision++;
  local.beforeReplace = async () => { await local.write("note.md", bytes("later local edit")); };
  const result = await engine(local, drive).sync(state);
  if (text(local.files.get("note.md")) !== "later local edit" || !result.report.errors.length) {
    throw new Error("A note edited during conflict resolution must be kept and reported");
  }
}

async function noteCreatedDuringDownload(): Promise<void> {
  const drive = new FakeDrive(), local = new Local();
  drive.beforeDownload = async () => { await local.write("note.md", bytes("new local note")); };
  await engine(local, drive).sync({});
  if (![...local.files.values()].some((data) => text(data) === "new local note")) {
    throw new Error("A new local note created during download was overwritten");
  }
}

async function noteCreatedAtWriteBoundary(): Promise<void> {
  const drive = new FakeDrive(), local = new Local();
  local.beforeCreate = async (path) => { local.files.set(path, bytes("new local note")); };
  const result = await engine(local, drive).sync({});
  if (text(local.files.get("note.md")) !== "new local note" || !result.report.errors.length) {
    throw new Error("A new note created at the write boundary must be kept and reported");
  }
}

async function interruptedCreation(): Promise<void> {
  const drive = new FakeDrive(), local = new Local();
  drive.data = bytes("complete remote note");
  local.mtime = Date.parse("2028-01-01T00:00:00Z");
  local.beforeCreate = async (path) => {
    local.beforeCreate = null;
    local.files.set(path, bytes("partial"));
    throw new Error("simulated interrupted copy");
  };
  let saved: SyncStateData = {};
  const first = await engine(local, drive).sync({}, async (state) => { saved = state; });
  if (!first.report.errors.length || !saved["note.md"]?.pendingDownload) throw new Error("An interrupted create must be reported and its intent persisted");
  const retry = await engine(local, drive).sync(saved);
  if (text(drive.data) !== "complete remote note" || text(local.files.get("note.md")) !== "complete remote note" ||
      ![...local.files.values()].some((value) => text(value) === "partial") || !retry.report.conflicts.length) {
    throw new Error("Recovery must retain the partial file without replacing the complete remote version");
  }
}

async function completedCreationAfterRestart(): Promise<void> {
  const drive = new FakeDrive(), local = new Local();
  let saved: SyncStateData = {};
  const first = await engine(local, drive).sync({}, async (state) => { saved = state; });
  if (first.report.errors.length || !saved["note.md"]?.pendingDownload) throw new Error("Create intent must be persisted before writing");
  const retry = await engine(local, drive).sync(saved);
  if (retry.report.errors.length || retry.report.conflicts.length || retry.state["note.md"]?.pendingDownload) {
    throw new Error("A completed download must be adopted without a conflict after restart");
  }
}

async function interruptedAttachmentCreation(): Promise<void> {
  const drive = new FakeDrive("image.png"), local = new Local();
  const complete = binary(0xff, 0, 1, 2);
  const partial = binary(0xff, 0);
  drive.data = complete;
  local.beforeCreate = async (path) => { local.beforeCreate = null; local.files.set(path, partial); throw new Error("interrupted"); };
  let saved: SyncStateData = {};
  await engine(local, drive).sync({}, async (state) => { saved = state; });
  const retry = await engine(local, drive).sync(saved);
  if (!equalBytes(drive.data, complete) || !equalBytes(local.files.get("image.png"), partial) || !retry.report.errors.length || !retry.state["image.png"]?.pendingDownload) {
    throw new Error("An interrupted attachment must pause without overwriting either version");
  }
}

async function remoteVanishesDuringNewDownload(): Promise<void> {
  const drive = new FakeDrive(), local = new Local();
  drive.vanishDuringDownload = true;
  const result = await engine(local, drive).sync({});
  if (!result.report.errors.length || !result.state["note.md"]?.pendingDownload || local.files.has("note.md")) {
    throw new Error("A vanished remote file must be reported and stay pending");
  }
}

async function remoteVanishesDuringRecovery(): Promise<void> {
  const drive = new FakeDrive(), local = new Local();
  await local.write("note.md", bytes("partial"));
  drive.vanishDuringDownload = true;
  const state = { "note.md": { localHash: "", remoteVersion: "", pendingDownload: true } };
  const result = await engine(local, drive).sync(state);
  if (text(drive.data) !== "base" || text(local.files.get("note.md")) !== "partial" || !result.report.errors.length || !result.state["note.md"]?.pendingDownload) {
    throw new Error("A vanished remote file must not cause a partial local file to be uploaded");
  }
}

async function ordinaryAttachmentUpdate(): Promise<void> {
  const drive = new FakeDrive("image.png"), local = new Local();
  drive.data = binary(0xff, 0, 1);
  await local.write("image.png", drive.data);
  const state = (await engine(local, drive).sync({})).state;
  drive.data = binary(0xff, 0, 2);
  drive.revision++;
  const result = await engine(local, drive).sync(state);
  if (!equalBytes(local.files.get("image.png"), drive.data) || result.report.errors.length) {
    throw new Error("A newer remote attachment should replace an unchanged older local copy");
  }
}

async function metadataOnlyAttachmentChange(): Promise<void> {
  const drive = new FakeDrive("image.png"), local = new Local();
  drive.data = binary(0xff, 0, 1);
  await local.write("image.png", drive.data);
  const state = (await engine(local, drive).sync({})).state;
  drive.revision++;
  local.beforeWrite = async () => { throw new Error("unchanged attachment was rewritten"); };
  const result = await engine(local, drive).sync(state);
  if (result.report.errors.length || local.trash.size || !equalBytes(local.files.get("image.png"), drive.data) || result.state["image.png"]?.remoteVersion !== `v${drive.revision}`) {
    throw new Error("Metadata-only changes must not replace an identical attachment");
  }
}

async function conflictingAttachmentEdits(): Promise<void> {
  const drive = new FakeDrive("image.png"), local = new Local();
  drive.data = binary(0xff, 0, 1);
  await local.write("image.png", drive.data);
  const state = (await engine(local, drive).sync({})).state;
  const localEdit = binary(0xff, 0, 2);
  const remoteEdit = binary(0xff, 0, 3);
  await local.write("image.png", localEdit);
  drive.data = remoteEdit;
  drive.revision++;
  const result = await engine(local, drive).sync(state);
  const versions = [...local.files.values()];
  if (!result.report.conflicts.length || !versions.some((data) => equalBytes(data, localEdit)) || !versions.some((data) => equalBytes(data, remoteEdit))) {
    throw new Error("Different concurrent attachment edits must both be preserved");
  }
}

async function attachmentEditedDuringDownload(): Promise<void> {
  const drive = new FakeDrive("image.png"), local = new Local();
  drive.data = binary(0xff, 0, 1);
  await local.write("image.png", drive.data);
  const state = (await engine(local, drive).sync({})).state;
  drive.data = binary(0xff, 0, 2);
  drive.revision++;
  const localEdit = binary(0xff, 0, 3);
  drive.beforeDownload = async () => { await local.write("image.png", localEdit); };
  await engine(local, drive).sync(state);
  if (![...local.files.values()].some((data) => equalBytes(data, localEdit))) {
    throw new Error("A newer attachment edit was overwritten without a recoverable local copy");
  }
}

async function attachmentEditedAtWriteBoundary(): Promise<void> {
  const drive = new FakeDrive("image.png"), local = new Local();
  drive.data = binary(0xff, 0, 1);
  await local.write("image.png", drive.data);
  const state = (await engine(local, drive).sync({})).state;
  drive.data = binary(0xff, 0, 2);
  drive.revision++;
  const localEdit = binary(0xff, 0, 3);
  local.beforeWrite = async (path) => { if (path === "image.png") local.files.set(path, localEdit); };
  const result = await engine(local, drive).sync(state);
  if (![...local.files.values()].some((data) => equalBytes(data, localEdit)) || !result.report.errors.length) {
    throw new Error("An attachment edited at the write boundary must be preserved and reported");
  }
}

async function interruptedAttachmentReplacement(stage: "rename" | "partial" | "copy" | "trash"): Promise<void> {
  const drive = new FakeDrive("image.png"), local = new Local();
  const old = binary(0xff, 0, 1);
  const remote = binary(0xff, 0, 2);
  drive.data = old;
  await local.write("image.png", old);
  const state = (await engine(local, drive).sync({})).state;
  drive.data = remote;
  drive.revision++;
  local.binaryInterrupt = stage;
  let saved: SyncStateData = {};
  const first = await engine(local, drive).sync(state, async (snapshot) => { saved = snapshot; });
  const backup = saved["image.png"]?.pendingReplacement?.backupPath;
  if (!first.report.errors.length || !backup) throw new Error(`Intent was not persisted before ${stage}`);
  local.binaryInterrupt = null;
  const retry = await engine(local, drive).sync(saved);
  if (!equalBytes(drive.data, remote)) throw new Error(`Remote attachment was changed after ${stage}`);
  if (![...local.files.values(), ...local.trash.values()].some((value) => equalBytes(value, old))) {
    throw new Error(`Previous attachment was lost after ${stage}`);
  }
  if (stage === "rename" && (!equalBytes(local.files.get("image.png"), old) || !retry.report.errors.length)) {
    throw new Error("Interrupted rename must restore the older attachment and request a retry");
  }
  if (stage === "partial" && (!retry.report.errors.length || !retry.state["image.png"]?.pendingReplacement || !local.files.has(backup))) {
    throw new Error("Interrupted partial copy must leave recovery pending and keep the backup");
  }
  if ((stage === "copy" || stage === "trash") && (!equalBytes(local.files.get("image.png"), remote) || retry.state["image.png"]?.pendingReplacement)) {
    throw new Error(`Completed attachment must be adopted safely after ${stage}`);
  }
}

async function scopedBackupRecovery(): Promise<void> {
  const drive = new FakeDrive("image.png"), local = new Local();
  const old = binary(0xff, 0, 1);
  drive.data = old;
  await local.write("image.png", old);
  local.listOnlyPath = "image.png";
  const state = (await engine(local, drive).sync({})).state;
  drive.data = binary(0xff, 0, 2);
  drive.revision++;
  local.binaryInterrupt = "rename";
  let saved: SyncStateData = {};
  await engine(local, drive).sync(state, async (snapshot) => { saved = snapshot; });
  local.binaryInterrupt = null;
  const retry = await engine(local, drive).sync(saved);
  if (!equalBytes(local.files.get("image.png"), old) || !retry.report.errors.length || !retry.state["image.png"]?.pendingReplacement) {
    throw new Error("A backup outside a single-file scope must still be found and restored");
  }
}

async function invalidBackupPath(): Promise<void> {
  const drive = new FakeDrive(), local = new Local();
  await local.write("note.md", bytes("base"));
  await local.write("private.txt", bytes("private"));
  local.listOnlyPath = "note.md";
  let privateRead = false;
  local.beforeRead = async (path) => { if (path === "private.txt") privateRead = true; };
  const state = { "note.md": { localHash: "old", remoteVersion: "v1", remoteId: "note-id", pendingReplacement: { backupPath: "private.txt", localHash: "old" } } };
  const result = await engine(local, drive).sync(state);
  if (privateRead || !result.report.errors.length || text(local.files.get("private.txt")) !== "private") {
    throw new Error("An invalid recovery path must be rejected without reading unrelated files");
  }
}

async function editDuringLocalDeletion(): Promise<void> {
  const drive = new FakeDrive(), local = new Local();
  await local.write("note.md", bytes("base"));
  const state = (await engine(local, drive).sync({})).state;
  drive.present = false;
  local.beforeDelete = async (path) => { local.files.set(path, bytes("new local edit")); };
  const result = await engine(local, drive).sync(state);
  if (text(local.files.get("note.md")) !== "new local edit" || !result.report.errors.length) {
    throw new Error("An edit made at the local deletion boundary must remain in the vault and be reported");
  }
}

async function interruptedLocalDeletion(stage: "rename" | "trash"): Promise<void> {
  const drive = new FakeDrive(), local = new Local();
  await local.write("note.md", bytes("base"));
  const state = (await engine(local, drive).sync({})).state;
  drive.present = false;
  local.deleteInterrupt = stage;
  let saved: SyncStateData = {};
  const first = await engine(local, drive).sync(state, async (snapshot) => { saved = snapshot; });
  const backup = saved["note.md"]?.pendingDeletion?.backupPath;
  if (!first.report.errors.length || !backup) throw new Error(`Deletion intent was not saved before ${stage}`);
  local.deleteInterrupt = null;
  const retry = await engine(local, drive).sync(saved);
  if (stage === "rename" && (text(local.files.get("note.md")) !== "base" || !local.files.has(backup) || !retry.report.errors.length)) {
    throw new Error("An interrupted deletion must restore the local file and keep its backup");
  }
  if (stage === "trash" && (retry.state["note.md"] || ![...local.trash.values()].some((value) => text(value) === "base"))) {
    throw new Error("A completed deletion should be adopted with the original still in trash");
  }
}

async function editDuringRemoteDeletion(): Promise<void> {
  const drive = new FakeDrive(), local = new Local();
  await local.write("note.md", bytes("base"));
  const state = (await engine(local, drive).sync({})).state;
  local.files.delete("note.md");
  drive.beforeTrash = async () => { drive.data = bytes("new remote edit"); drive.revision++; };
  const result = await engine(local, drive).sync(state);
  if (!drive.present || text(drive.data) !== "new remote edit" || !result.report.errors.length) {
    throw new Error("A newer remote edit must not be trashed by a stale deletion");
  }
}

async function localRecreatedDuringRemoteDeletion(): Promise<void> {
  const drive = new FakeDrive(), local = new Local();
  await local.write("note.md", bytes("base"));
  const state = (await engine(local, drive).sync({})).state;
  local.files.delete("note.md");
  drive.beforeTrash = async () => { local.files.set("note.md", bytes("recreated local note")); };
  let saved: SyncStateData = {};
  const first = await engine(local, drive).sync(state, async (snapshot) => { saved = snapshot; });
  if (!first.report.errors.length || !saved["note.md"]?.pendingRemoteDeletion || text(local.files.get("note.md")) !== "recreated local note") {
    throw new Error("A recreated local file must keep the remote deletion pending");
  }
  drive.beforeTrash = null;
  const retry = await engine(local, drive).sync(saved);
  if (!drive.present || text(drive.data) !== "recreated local note" || retry.report.errors.length || retry.state["note.md"]?.pendingRemoteDeletion) {
    throw new Error("Retry must restore the recreated local note to Drive");
  }
}

async function interruptedRemoteDeletion(): Promise<void> {
  const drive = new FakeDrive(), local = new Local();
  await local.write("note.md", bytes("base"));
  const state = (await engine(local, drive).sync({})).state;
  local.files.delete("note.md");
  drive.throwAfterTrash = true;
  let saved: SyncStateData = {};
  const first = await engine(local, drive).sync(state, async (snapshot) => { saved = snapshot; });
  if (!first.report.errors.length || !saved["note.md"]?.pendingRemoteDeletion || drive.present) throw new Error("Remote deletion intent must survive an interrupted response");
  drive.throwAfterTrash = false;
  const retry = await engine(local, drive).sync(saved);
  if (retry.state["note.md"] || !retry.report.deletedRemote.includes("note.md")) throw new Error("A completed remote deletion should be adopted after restart");
}

async function main(): Promise<void> {
  let failed = 0;
  const tests = [
    ["concurrent uploads", concurrentUploads],
    ["remote edit and revert before upload", remoteEditedAndRevertedBeforeUpload],
    ["remote replacement with same version", remoteReplacedWithSameVersion],
    ["remote replacement after local deletion", remoteReplacedAfterLocalDeletion],
    ["edit before upload read", editBeforeUploadRead],
    ["ordinary note update", ordinaryNoteUpdate],
    ["ordinary attachment update", ordinaryAttachmentUpdate],
    ["metadata-only attachment change", metadataOnlyAttachmentChange],
    ["conflicting attachment edits", conflictingAttachmentEdits],
    ["edit during download", editDuringDownload],
    ["edit during atomic write", editDuringAtomicWrite],
    ["conflict edited during replacement", conflictEditedDuringReplacement],
    ["note created during download", noteCreatedDuringDownload],
    ["note created at write boundary", noteCreatedAtWriteBoundary],
    ["interrupted creation", interruptedCreation],
    ["completed creation after restart", completedCreationAfterRestart],
    ["interrupted attachment creation", interruptedAttachmentCreation],
    ["remote vanishes during new download", remoteVanishesDuringNewDownload],
    ["remote vanishes during recovery", remoteVanishesDuringRecovery],
    ["attachment edit during download", attachmentEditedDuringDownload],
    ["attachment edit at write boundary", attachmentEditedAtWriteBoundary],
    ["attachment restart after rename", () => interruptedAttachmentReplacement("rename")],
    ["attachment restart during copy", () => interruptedAttachmentReplacement("partial")],
    ["attachment restart after copy", () => interruptedAttachmentReplacement("copy")],
    ["attachment restart after trash", () => interruptedAttachmentReplacement("trash")],
    ["scoped backup recovery", scopedBackupRecovery],
    ["invalid backup path", invalidBackupPath],
    ["edit during local deletion", editDuringLocalDeletion],
    ["local deletion restart after rename", () => interruptedLocalDeletion("rename")],
    ["local deletion restart after trash", () => interruptedLocalDeletion("trash")],
    ["edit during remote deletion", editDuringRemoteDeletion],
    ["local recreation during remote deletion", localRecreatedDuringRemoteDeletion],
    ["remote deletion restart", interruptedRemoteDeletion],
  ] as const;
  for (const [name, test] of tests) {
    try {
      await test();
      console.log(`PASS ${name}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${name}: ${(e as Error).message}`);
    }
  }
  if (failed) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
