import { DeleteOptions, HttpResponse, HttpSend, PreconditionFailed, PutResult, RemoteObject, RemoteProvider } from "../RemoteProvider";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const API_V2 = "https://www.googleapis.com/drive/v2";
const UPLOAD_V2 = "https://www.googleapis.com/upload/drive/v2";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface DriveConfig {
  /** "/"-separated sync root, e.g. "Obsidian Sync/My Vault"; created nested under the Drive root. */
  appFolderName: string;
}

/** Escape a value for use inside a Drive `q` query (single-quote delimited). */
export function escapeDriveQuery(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** RFC3339 `modifiedTime` → epoch ms; `undefined` when absent or unparseable. */
function msOf(t?: string): number | undefined {
  if (!t) return undefined;
  const n = Date.parse(t);
  return Number.isNaN(n) ? undefined : n;
}

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  version?: string;
  etag?: string;
  modifiedTime?: string;
  size?: string;
}

/**
 * Drive provider over the Drive API v3 (drive.file scope). The vault's folder
 * structure is **mirrored as real Drive folders** under a per-vault sync root,
 * so the remote layout matches the vault (no flat dump, no path-length cap).
 * A file's path is its folder location + name. Auth is an injected token getter
 * (OAuth Bearer); transport is injected.
 */
export class DriveProvider implements RemoteProvider {
  readonly id = "drive";
  readonly conditionalUpdates = true;
  readonly conditionalDeletes = true;
  private rootId: string | null = null;
  private readonly folderIds = new Map<string, string>(); // dir ("" = root) -> folder id

  constructor(
    private readonly cfg: DriveConfig,
    private readonly getToken: () => Promise<string>,
    private readonly http: HttpSend
  ) {}

  private async hdrs(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.getToken()}`, ...extra };
  }

  private async json<T>(res: HttpResponse, op: string): Promise<T> {
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new Error(`Drive ${op} ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  private dirOf(path: string): string {
    const i = path.lastIndexOf("/");
    return i < 0 ? "" : path.slice(0, i);
  }
  private baseOf(path: string): string {
    const i = path.lastIndexOf("/");
    return i < 0 ? path : path.slice(i + 1);
  }

  /** The per-vault sync root id (`appFolderName` resolved as a nested "/"-path). */
  private async root(): Promise<string> {
    if (this.rootId) return this.rootId;
    let parent = "root";
    for (const name of this.cfg.appFolderName.split("/").map((s) => s.trim()).filter(Boolean)) {
      parent = await this.findOrCreateFolder(name, parent);
    }
    this.rootId = parent;
    this.folderIds.set("", parent);
    return parent;
  }

  /** Folder id for a "/"-separated dir under the root; `create=false` → null if missing. */
  private async folderFor(dir: string, create: boolean): Promise<string | null> {
    const cached = this.folderIds.get(dir);
    if (cached) return cached;
    let parent = await this.root();
    let acc = "";
    for (const seg of dir.split("/").filter(Boolean)) {
      acc = acc ? `${acc}/${seg}` : seg;
      let id = this.folderIds.get(acc);
      if (!id) {
        const found = await this.findFolder(seg, parent);
        id = found ?? (create ? await this.createFolder(seg, parent) : undefined);
        if (!id) return null;
        this.folderIds.set(acc, id);
      }
      parent = id;
    }
    return parent;
  }

  private async findFolder(name: string, parent: string): Promise<string | undefined> {
    const q = `mimeType='${FOLDER_MIME}' and name='${escapeDriveQuery(name)}' and '${parent}' in parents and trashed=false`;
    const res = await this.http("GET", `${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent("files(id)")}&spaces=drive`, await this.hdrs());
    const files = (await this.json<{ files?: DriveFile[] }>(res, "find-folder")).files ?? [];
    if (files.length > 1) throw new Error(`Duplicate Drive folders named ${name}; resolve them before syncing`);
    if (files.length && !files[0].id) throw new Error(`Drive folder ${name} is missing an ID`);
    return files[0]?.id;
  }

  private async createFolder(name: string, parent: string): Promise<string> {
    const meta = JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] });
    const cr = await this.http("POST", `${API}/files?fields=id`, await this.hdrs({ "content-type": "application/json" }), new TextEncoder().encode(meta).buffer);
    const id = (await this.json<{ id?: string }>(cr, "create-folder")).id;
    // shortcut: a later concurrent create can still duplicate this name; use a shared identity before real-vault use.
    if (!id || (await this.findFolder(name, parent)) !== id) throw new Error(`Drive folder ${name} could not be confirmed`);
    return id;
  }

  private async findOrCreateFolder(name: string, parent: string): Promise<string> {
    return (await this.findFolder(name, parent)) ?? (await this.createFolder(name, parent));
  }

  private async locate(path: string): Promise<{ id: string; version: string; size: number; mtime?: number } | null> {
    const parent = await this.folderFor(this.dirOf(path), false);
    if (!parent) return null;
    const q = `name='${escapeDriveQuery(this.baseOf(path))}' and '${parent}' in parents and mimeType!='${FOLDER_MIME}' and trashed=false`;
    const res = await this.http("GET", `${API}/files?q=${encodeURIComponent(q)}&orderBy=createdTime&fields=${encodeURIComponent("files(id,version,modifiedTime,size)")}&spaces=drive`, await this.hdrs());
    const files = (await this.json<{ files?: DriveFile[] }>(res, "find")).files ?? [];
    if (files.length > 1) throw new Error(`Duplicate Drive files at ${path}; resolve them before syncing`);
    const f = files[0];
    if (f && !f.id) throw new Error(`Drive file ${path} is missing an ID`);
    if (f && !f.version) throw new Error(`Drive file ${path} is missing a version`);
    return f?.id && f.version ? { id: f.id, version: f.version, size: Number(f.size ?? 0), mtime: msOf(f.modifiedTime) } : null;
  }

  private async etagFor(path: string, id: string, version: string): Promise<string> {
    const current = await this.http("GET", `${API_V2}/files/${encodeURIComponent(id)}?fields=etag%2Cversion`, await this.hdrs());
    if (current.status === 404) throw new PreconditionFailed(path);
    const metadata = await this.json<DriveFile>(current, "read version");
    if (!metadata.etag || /[\r\n]/.test(metadata.etag) || metadata.version !== version) throw new PreconditionFailed(path);
    return metadata.etag;
  }

  async put(path: string, data: ArrayBuffer, contentType = "application/octet-stream", opts?: { ifAbsent?: boolean; ifVersion?: string; ifId?: string }): Promise<PutResult> {
    const fields = encodeURIComponent("id,version");
    const existing = await this.locate(path);
    if (existing && opts?.ifAbsent) throw new PreconditionFailed(path);
    if (opts?.ifId !== undefined && existing?.id !== opts.ifId) throw new PreconditionFailed(path);
    if (opts?.ifVersion !== undefined && (!existing || existing.version !== opts.ifVersion)) throw new PreconditionFailed(path);
    if (existing && opts?.ifVersion !== undefined) {
      if (opts.ifId === undefined) throw new Error(`Drive update ${path} requires an observed ID`);
      const id = encodeURIComponent(existing.id);
      const etag = await this.etagFor(path, existing.id, opts.ifVersion);
      // Drive v2 enforces If-Match on media uploads; v3 did not in our probe.
      const up = await this.http("PUT", `${UPLOAD_V2}/files/${id}?uploadType=media&fields=id%2Cversion`, await this.hdrs({ "content-type": contentType, "if-match": etag }), data);
      if (up.status === 412) throw new PreconditionFailed(path);
      const r = await this.json<DriveFile>(up, "upload");
      if (!r.version || r.id !== existing.id) throw new Error(`Drive upload ${path}: missing version or unexpected ID`);
      return { id: r.id, version: r.version };
    }
    if (existing) throw new Error(`Drive update ${path} requires an observed version`);
    // shortcut: Drive can create duplicate names concurrently; add atomic creation before real-vault use.
    // A new file is created WITH its content, in one request. Creating it empty and
    // uploading afterwards left a 0-byte file behind whenever the app died in
    // between (routine on a phone); its fresh modifiedTime then made it look newer
    // than the local note, so the next sync emptied the note and parked the real
    // content in a conflict copy.
    const parent = (await this.folderFor(this.dirOf(path), true)) as string;
    const boundary = `gsync-${crypto.randomUUID()}`;
    const body = multipartRelated(boundary, { name: this.baseOf(path), parents: [parent] }, data, contentType);
    const cr = await this.http(
      "POST",
      `${UPLOAD}/files?uploadType=multipart&fields=${fields}`,
      await this.hdrs({ "content-type": `multipart/related; boundary=${boundary}` }),
      body
    );
    const r = await this.json<DriveFile>(cr, "create");
    if (!r.id || (await this.locate(path))?.id !== r.id) throw new PreconditionFailed(path);
    if (!r.version) throw new Error(`Drive create ${path}: missing version`);
    return { id: r.id, version: r.version };
  }

  async get(path: string): Promise<ArrayBuffer | null> {
    const f = await this.locate(path);
    if (!f) return null;
    const res = await this.http("GET", `${API}/files/${f.id}?alt=media`, await this.hdrs());
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) throw new Error(`Drive GET ${path}: ${res.status}`);
    return res.arrayBuffer();
  }

  async head(path: string): Promise<RemoteObject | null> {
    const f = await this.locate(path);
    return f ? { path, id: f.id, version: f.version, size: f.size, mtime: f.mtime } : null;
  }

  async delete(path: string, opts?: DeleteOptions): Promise<void> {
    if (!opts || opts.ifId === undefined) throw new Error(`Drive trash ${path} requires an observed version and ID`);
    const f = await this.locate(path);
    if (!f) return;
    if (f.id !== opts.ifId || f.version !== opts.ifVersion) throw new PreconditionFailed(path);
    const etag = await this.etagFor(path, f.id, opts.ifVersion);
    const body = new TextEncoder().encode(JSON.stringify({ labels: { trashed: true } })).buffer;
    // v2 conditional trash was probed on synthetic files; see docs/drive-concurrency-probe.md.
    const res = await this.http("PATCH", `${API_V2}/files/${encodeURIComponent(f.id)}`, await this.hdrs({ "content-type": "application/json", "if-match": etag }), body);
    if (res.status === 404 || res.status === 412) throw new PreconditionFailed(path);
    if (res.status < 200 || res.status >= 300) throw new Error(`Drive trash ${path}: ${res.status}`);
  }

  async list(prefix = ""): Promise<RemoteObject[]> {
    const out: RemoteObject[] = [];
    await this.walk(await this.root(), "", out);
    if (!prefix) return out;
    const p = prefix.replace(/\/+$/, "");
    return out.filter((o) => o.path === p || o.path.startsWith(`${p}/`));
  }

  /** Depth-first traversal of the sync root, reconstructing each file's path from the folder chain. */
  private async walk(folderId: string, prefix: string, out: RemoteObject[]): Promise<void> {
    const names = new Set<string>();
    let pageToken: string | undefined;
    do {
      const q = `'${folderId}' in parents and trashed=false`;
      let url =
        `${API}/files?q=${encodeURIComponent(q)}` +
        `&fields=${encodeURIComponent("nextPageToken,files(id,name,mimeType,version,modifiedTime,size)")}` +
        `&pageSize=1000&spaces=drive`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
      const data = await this.json<{ files?: DriveFile[]; nextPageToken?: string }>(await this.http("GET", url, await this.hdrs()), "list");
      for (const f of data.files ?? []) {
        if (!f.name) continue;
        const childPath = prefix ? `${prefix}/${f.name}` : f.name;
        if (names.has(f.name)) throw new Error(`Duplicate Drive items at ${childPath}; resolve them before syncing`);
        if (!f.id) throw new Error(`Drive listing missing an ID for ${childPath}`);
        names.add(f.name);
        if (f.mimeType === FOLDER_MIME) {
          this.folderIds.set(childPath, f.id);
          await this.walk(f.id, childPath, out);
        } else {
          if (!f.version) throw new Error(`Drive listing missing a version for ${childPath}`);
          out.push({ path: childPath, id: f.id, version: f.version, size: Number(f.size ?? 0), mtime: msOf(f.modifiedTime) });
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }
}

/** A `multipart/related` body for files.create (RFC 2387): the JSON metadata part, then the content part. */
function multipartRelated(boundary: string, meta: object, data: ArrayBuffer, contentType: string): ArrayBuffer {
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const out = new Uint8Array(head.byteLength + data.byteLength + tail.byteLength);
  out.set(head, 0);
  out.set(new Uint8Array(data), head.byteLength);
  out.set(tail, head.byteLength + data.byteLength);
  return out.buffer;
}
