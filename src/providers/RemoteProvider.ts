/** A remote object the provider can store. `path` is sync-root-relative (POSIX). */
export interface RemoteObject {
  path: string;
  /** Provider-specific identity when available. */
  id?: string;
  /** Opaque version (GCS generation / ETag) for change detection. */
  version: string;
  size: number;
  /**
   * Last-modified time in epoch ms — the remote's own upload/modify time
   * (Drive `modifiedTime`, GCS `Last-Modified`). Used ONLY to pick the newer
   * side in a modify/modify conflict; never for change detection. Optional:
   * absent ⇒ treated as the oldest possible time (the other side wins).
   */
  mtime?: number;
}

export interface PutResult {
  version: string;
  id?: string;
}

export interface DeleteOptions {
  ifVersion: string;
  ifId?: string;
}

/** Minimal HTTP response shape (adapted from Obsidian `requestUrl` / Node fetch). */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

/**
 * Transport seam (DIP). Obsidian wires `requestUrl` — it bypasses CORS and lets
 * us send the `Host` + `Authorization` headers SigV4 requires (browser `fetch`
 * cannot). The Node pilot wires its own fetch/https adapter.
 */
export type HttpSend = (
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: ArrayBuffer
) => Promise<HttpResponse>;

/**
 * Backend-agnostic contract the sync engine depends on.
 * Implementations MUST NOT log credentials, signing keys, or Authorization headers.
 */
export interface RemoteProvider {
  readonly id: string;
  /** Whether `put` enforces `ifVersion` against the observed remote version. */
  readonly conditionalUpdates?: boolean;
  /** Whether `delete` enforces the observed remote version. */
  readonly conditionalDeletes?: boolean;
  /**
   * Upload bytes at a sync-root-relative path. `ifAbsent` rejects an existing
   * path; atomic creation depends on the provider. Providers advertising
   * conditionalUpdates also reject a changed `ifVersion` or `ifId`.
   */
  put(path: string, data: ArrayBuffer, contentType?: string, opts?: { ifAbsent?: boolean; ifVersion?: string; ifId?: string }): Promise<PutResult>;
  /** Download bytes; `null` if the object does not exist. */
  get(path: string): Promise<ArrayBuffer | null>;
  /** Metadata only; `null` if absent. */
  head(path: string): Promise<RemoteObject | null>;
  /** Delete an object; providers with conditionalDeletes reject a changed version or ID. */
  delete(path: string, opts?: DeleteOptions): Promise<void>;
  /** List objects under an optional prefix (handles pagination internally). */
  list(prefix?: string): Promise<RemoteObject[]>;
}

/** A remote precondition failed; a concurrent create may have left a separate file. */
export class PreconditionFailed extends Error {
  constructor(readonly path: string) {
    super(`${path} changed while syncing`);
    this.name = "PreconditionFailed";
  }
}
