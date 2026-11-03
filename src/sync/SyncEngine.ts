import { PutResult, RemoteObject, RemoteProvider } from "../providers/RemoteProvider";
import { conflictPath, safeVaultPath } from "../util/paths";
import { sha256Hex } from "../util/hash";
import { Cryptor } from "./Cryptor";
import { LocalStore } from "./LocalStore";
import { isReservedPath } from "./reserved";
import { FileState, LocalFile, SyncReport, SyncStateData } from "./types";

/**
 * Thrown by {@link SyncEngine.sync} when a single sync would delete more files
 * than the safety guard allows — almost always a sign of a bad/empty listing
 * (auth glitch, wrong remote folder) rather than a genuine mass delete. The sync
 * is aborted with NOTHING changed, so the condition is recoverable.
 */
export class MassDeletionAbort extends Error {
  constructor(
    readonly localDeletes: number,
    readonly remoteDeletes: number,
    readonly limit: number
  ) {
    super(
      `Sync aborted for safety: it would delete ${localDeletes} local and ${remoteDeletes} remote file(s) at once ` +
        `(limit ${limit}). This usually means the other side listed empty or wrong, not a real mass delete. ` +
        `Nothing was changed — check the connection/folder, then sync again.`
    );
    this.name = "MassDeletionAbort";
  }
}

/** Default delete guard: allow up to max(10, 20% of tracked files) deletions per side, per sync. */
export const defaultDeleteGuard = (trackedCount: number): number => Math.max(10, Math.ceil(trackedCount * 0.2));

/** How many changed baseline entries between checkpoints during one sync. */
export const CHECKPOINT_EVERY = 25;

const sameRemote = (remote: RemoteObject, state: FileState): boolean =>
  remote.version === state.remoteVersion && remote.id === state.remoteId;

function isBackupFor(path: string, backup: string): boolean {
  try { if (!path || safeVaultPath(path) !== path || safeVaultPath(backup) !== backup) return false; } catch { return false; }
  const template = conflictPath(path, "");
  const marker = ".conflict-";
  const at = template.lastIndexOf(marker) + marker.length;
  const prefix = template.slice(0, at);
  const suffix = template.slice(at);
  if (!backup.startsWith(prefix) || !backup.endsWith(suffix)) return false;
  return /^\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(backup.slice(prefix.length, backup.length - suffix.length));
}

/**
 * Provider-agnostic two-way sync via a three-way merge (local vs remote vs the
 * last-synced baseline `state`). Conflict handling aims to preserve both copies,
 * but known local-write and duplicate-creation races still need fixing:
 *  - modify/modify (or new-on-both, e.g. the first sync of an already-populated
 *    vault on a new device): if both sides hold identical content it is NOT a
 *    conflict — adopt the baseline silently. Otherwise the newer side (by mtime)
 *    becomes the canonical file and the older one is kept as a recoverable
 *    `<name>.conflict-<utc>` copy. When the remote mtime is unknown the local
 *    side wins (a safe default — the remote mtime is its upload time, which can
 *    lag the real edit time).
 *  - local-deleted vs remote-modified: restore (download).
 *  - local-modified vs remote-deleted: re-upload (local wins).
 * Deletions propagate via the baseline (a path in `state` but missing on one
 * side = deleted there). Content passes through the injected `Cryptor`.
 */
export class SyncEngine {
  constructor(
    private readonly local: LocalStore,
    private readonly remote: RemoteProvider,
    private readonly cryptor: Cryptor,
    private readonly now: () => Date,
    /** Sync-root-relative prefix; remote listing is scoped to it (local is scoped by the LocalStore). */
    private readonly scope: string = "",
    /** Protect local: a file missing on the remote is re-uploaded, never deleted locally. */
    private readonly protectLocal: boolean = false,
    /** Abort the whole sync if it would delete more than this many files on either side. */
    private readonly deleteGuard: (trackedCount: number) => number = defaultDeleteGuard
  ) {}

  /**
   * `checkpoint`, if given, saves file-operation intents before any changes,
   * then receives a snapshot every {@link CHECKPOINT_EVERY} changed entries so
   * a run killed halfway can resume. Paths that needed nothing do not count: a
   * checkpoint rewrites the plugin's whole data.json, and a sync that changes
   * nothing must not write it.
   * A partial baseline is valid: each entry records work that completed, and
   * unprocessed paths keep their previous entry. A checkpoint that throws aborts
   * the run — safe, since a re-run reconciles from the last good baseline.
   */
  async sync(prev: SyncStateData, checkpoint?: (state: SyncStateData) => Promise<void>): Promise<{ state: SyncStateData; report: SyncReport }> {
    const [localList, remoteList] = await Promise.all([this.local.list(), this.remote.list(this.scope)]);
    // Pending backups are not independent sync files until recovery releases them.
    const backups = new Set<string>();
    for (const [path, entry] of Object.entries(prev)) {
      const backup = entry.pendingReplacement?.backupPath ?? entry.pendingDeletion?.backupPath;
      if (backup && isBackupFor(path, backup)) backups.add(backup);
    }
    const allLocal = new Map<string, LocalFile>(localList.filter((f) => !isReservedPath(f.path)).map((f) => [f.path, f]));
    const localMap = new Map([...allLocal].filter(([path]) => !backups.has(path)));
    const remoteMap = new Map<string, RemoteObject>(remoteList.filter((o) => !isReservedPath(o.path) && !backups.has(o.path)).map((o) => [o.path, o]));
    const previousFor = (path: string): FileState | undefined => Object.prototype.hasOwnProperty.call(prev, path) ? prev[path] : undefined;

    // Safety guard — runs BEFORE anything is applied. A correct sync deletes a
    // file only when it was synced before (present in `prev`), is unchanged on
    // the surviving side, and has vanished from the other side. If that count is
    // implausibly large it almost always means a bad/empty listing (auth glitch,
    // wrong folder), not a real mass delete — so abort the whole sync untouched.
    let plannedLocalDeletes = 0;
    let plannedRemoteDeletes = 0;
    for (const path of Object.keys(prev)) {
      const S = prev[path];
      const L = localMap.get(path);
      const R = remoteMap.get(path);
      if (S.pendingDownload || S.pendingReplacement || S.pendingDeletion || S.pendingRemoteDeletion) continue;
      if (!this.protectLocal && L && L.hash === S.localHash && !R) plannedLocalDeletes++;
      if (!L && R && sameRemote(R, S)) plannedRemoteDeletes++;
    }
    const limit = this.deleteGuard(Object.keys(prev).length);
    if (plannedLocalDeletes > limit || plannedRemoteDeletes > limit) {
      throw new MassDeletionAbort(plannedLocalDeletes, plannedRemoteDeletes, limit);
    }

    const state: SyncStateData = Object.assign(Object.create(null) as SyncStateData, prev);
    for (const [path, remote] of remoteMap) {
      try { if (!path || safeVaultPath(path) !== path) continue; } catch { continue; }
      const previous = previousFor(path);
      const local = localMap.get(path);
      if (!local && previous && !previous.pendingDownload && !previous.pendingReplacement && !previous.pendingDeletion &&
          !previous.pendingRemoteDeletion && sameRemote(remote, previous) && this.remote.conditionalDeletes) {
        state[path] = { ...previous, pendingRemoteDeletion: true };
      } else if (!local && !previous?.pendingReplacement && !previous?.pendingDeletion && !previous?.pendingRemoteDeletion &&
          (!previous || previous.pendingDownload || !sameRemote(remote, previous))) {
        state[path] = { ...(previous ?? { localHash: "", remoteVersion: "" }), pendingDownload: true };
      } else if (local && !previous?.pendingDownload && !previous?.pendingReplacement && !previous?.pendingDeletion && !previous?.pendingRemoteDeletion &&
          (!previous || !sameRemote(remote, previous)) &&
          (!path.toLowerCase().endsWith(".md") || !this.local.replaceTextIfUnchanged) && this.local.replaceBinaryIfUnchanged) {
        state[path] = {
          ...(previous ?? { localHash: "", remoteVersion: "" }),
          pendingReplacement: { backupPath: conflictPath(path, `${this.stamp()}-${crypto.randomUUID()}`), localHash: local.hash },
        };
      }
    }
    for (const [path, local] of localMap) {
      try { if (!path || safeVaultPath(path) !== path) continue; } catch { continue; }
      const previous = previousFor(path);
      if (!this.protectLocal && !remoteMap.has(path) && previous && !previous.pendingDownload &&
          !previous.pendingReplacement && !previous.pendingDeletion && !previous.pendingRemoteDeletion && local.hash === previous.localHash && this.local.deleteIfUnchanged) {
        state[path] = {
          ...previous,
          pendingDeletion: { backupPath: conflictPath(path, `${this.stamp()}-${crypto.randomUUID()}`), localHash: local.hash },
        };
      }
    }
    // shortcut: callers without a checkpoint cannot recover interrupted writes; persist one before real-vault use.
    if (checkpoint && Object.values(state).some((entry) => entry.pendingDownload || entry.pendingReplacement || entry.pendingDeletion || entry.pendingRemoteDeletion)) await checkpoint({ ...state });
    const report: SyncReport = {
      uploaded: [],
      downloaded: [],
      deletedLocal: [],
      deletedRemote: [],
      conflicts: [],
      errors: [],
    };

    const paths = new Set<string>([...localMap.keys(), ...remoteMap.keys(), ...Object.keys(prev)].filter((path) => !backups.has(path)));
    let changed = 0;
    for (const path of paths) {
      const before = state[path];
      const previous = previousFor(path);
      const backupPath = previous?.pendingReplacement?.backupPath ?? previous?.pendingDeletion?.backupPath;
      try {
        if (backupPath && !isBackupFor(path, backupPath)) throw new Error("Invalid recovery backup path.");
        let backup = backupPath ? allLocal.get(backupPath) : undefined;
        if (!backup && backupPath && await this.local.exists(backupPath)) {
          backup = { path: backupPath, hash: await sha256Hex(await this.local.read(backupPath)), mtime: 0 };
        }
        await this.reconcile(path, localMap.get(path), remoteMap.get(path), previous, backup, state, report);
      } catch (e) {
        report.errors.push({ path, error: (e as Error).message });
      }
      // reconcile replaces or deletes an entry when it changes one, so identity is enough.
      if (checkpoint && state[path] !== before && ++changed % CHECKPOINT_EVERY === 0) await checkpoint({ ...state });
    }
    return { state, report };
  }

  private async reconcile(
    path: string,
    L: LocalFile | undefined,
    R: RemoteObject | undefined,
    S: FileState | undefined,
    backup: LocalFile | undefined,
    state: SyncStateData,
    report: SyncReport
  ): Promise<void> {
    if (!path || safeVaultPath(path) !== path) throw new Error(`unsafe vault path: ${path}`);
    if (S?.pendingReplacement) {
      await this.recoverReplacement(path, L, R, S, backup, state, report);
      return;
    }
    if (S?.pendingDeletion) {
      await this.recoverDeletion(path, L, R, S, backup, state, report);
      return;
    }
    if (S?.pendingRemoteDeletion) {
      if (!L && !R) { delete state[path]; report.deletedRemote.push(path); return; }
      if (L && !R) { await this.upload(path, L, R, state, report); return; }
      state[path] = { localHash: S.localHash, remoteVersion: S.remoteVersion, remoteId: S.remoteId };
      throw new Error("Interrupted remote deletion needs another sync to reconcile.");
    }
    if (S?.pendingDownload) {
      if (!R && !L) { delete state[path]; return; }
      if (!R) throw new Error("An interrupted download needs recovery because the remote file is missing.");
      if (!L) await this.download(path, L, R, state, report);
      else await this.resolveConflict(path, L, R, state, report, true);
      return;
    }
    const localChanged = L ? !S || L.hash !== S.localHash : !!S;
    const remoteChanged = R ? !S || !sameRemote(R, S) : !!S;

    if (!localChanged && !remoteChanged) {
      if (!L && !R) delete state[path];
      return;
    }

    // modify/modify (or new-on-both, e.g. first sync of a populated vault on a new device).
    if (L && R && localChanged && remoteChanged) {
      await this.resolveConflict(path, L, R, state, report);
      return;
    }

    if (localChanged && !remoteChanged) {
      if (L) await this.upload(path, L, R, state, report);
      else if (R) await this.deleteRemote(path, R, state, report);
      return;
    }

    if (!localChanged && remoteChanged) {
      if (R) await this.download(path, L, R, state, report);
      else if (this.protectLocal && L) await this.upload(path, L, R, state, report); // protect local: keep it, restore on remote
      else if (L) await this.deleteLocal(path, L, state, report);
      return;
    }

    // delete/modify conflicts — keep the surviving content (never lose data).
    if (L && !R) {
      await this.upload(path, L, R, state, report); // local modified, remote deleted
      return;
    }
    if (!L && R) {
      await this.download(path, L, R, state, report); // local deleted, remote modified
      return;
    }
    delete state[path]; // both deleted
  }

  private async recoverDeletion(path: string, L: LocalFile | undefined, R: RemoteObject | undefined, S: FileState, backup: LocalFile | undefined, state: SyncStateData, report: SyncReport): Promise<void> {
    if (!L && backup) {
      await this.local.create(path, await this.local.read(safeVaultPath(backup.path)));
      throw new Error("Interrupted deletion restored from backup; retry sync.");
    }
    if (!L && !backup) {
      if (R) throw new Error("Interrupted deletion needs recovery because the remote file returned.");
      delete state[path];
      report.deletedLocal.push(path);
      return;
    }
    state[path] = { localHash: S.localHash, remoteVersion: S.remoteVersion, remoteId: S.remoteId };
    if (backup) report.conflicts.push({ path, conflictPath: backup.path });
    throw new Error("Interrupted deletion recovered; retry sync.");
  }

  private async recoverReplacement(path: string, L: LocalFile | undefined, R: RemoteObject | undefined, S: FileState, backup: LocalFile | undefined, state: SyncStateData, report: SyncReport): Promise<void> {
    const pending = S.pendingReplacement as NonNullable<FileState["pendingReplacement"]>;
    if (!R) throw new Error("An interrupted attachment update needs recovery because the remote file is missing.");
    if (!L) {
      if (!backup) throw new Error("An interrupted attachment update has no local file or backup.");
      await this.local.create(path, await this.local.read(safeVaultPath(backup.path)));
      throw new Error("Interrupted attachment update restored from backup; retry sync.");
    }
    if ((backup && L.hash === backup.hash) || (!backup && L.hash === pending.localHash)) {
      state[path] = { localHash: S.localHash, remoteVersion: S.remoteVersion, remoteId: S.remoteId };
      if (backup) report.conflicts.push({ path, conflictPath: backup.path });
      throw new Error("Interrupted attachment update recovered; retry sync.");
    }
    const cipher = await this.remote.get(path);
    if (cipher === null) throw new Error("An interrupted attachment update needs recovery because the remote file vanished.");
    if ((await sha256Hex(await this.cryptor.decrypt(cipher))) === L.hash) {
      state[path] = { localHash: L.hash, remoteVersion: R.version, remoteId: R.id };
      if (backup) report.conflicts.push({ path, conflictPath: backup.path });
      return;
    }
    throw new Error(`Interrupted attachment update needs manual recovery; keep the local file and ${pending.backupPath}.`);
  }

  /**
   * Both sides changed since the baseline (or there is no baseline yet). Resolve
   * without ever losing data:
   *  - identical content ⇒ not a conflict; adopt the baseline silently. This is
   *    the common case when an already-populated vault is first synced on a new
   *    device, where every co-existing file would otherwise look like a conflict.
   *  - otherwise the newer side (by mtime) becomes canonical and the older side
   *    is written as a recoverable `<name>.conflict-<utc>` copy. The remote mtime
   *    is its upload time and may be unknown; only when it is strictly newer than
   *    the local mtime does the remote win — otherwise the local side wins.
   */
  private async resolveConflict(
    path: string,
    L: LocalFile,
    R: RemoteObject,
    state: SyncStateData,
    report: SyncReport,
    afterInterruptedDownload = false
  ): Promise<void> {
    const remoteBytes = await this.remote.get(path);
    if (remoteBytes === null) {
      if (afterInterruptedDownload) throw new Error("An interrupted download needs recovery because the remote file vanished.");
      await this.upload(path, L, R, state, report); // remote vanished mid-run; next sync reconciles
      return;
    }
    const remotePlain = await this.cryptor.decrypt(remoteBytes);
    const remoteHash = await sha256Hex(remotePlain);

    if (remoteHash === L.hash) {
      state[path] = { localHash: L.hash, remoteVersion: R.version, remoteId: R.id }; // identical → adopt, no conflict
      return;
    }

    if (afterInterruptedDownload && (!path.toLowerCase().endsWith(".md") || !this.local.replaceTextIfUnchanged)) {
      throw new Error("An interrupted download needs manual recovery; both versions were kept.");
    }
    const cp = safeVaultPath(conflictPath(path, `${this.stamp()}-${crypto.randomUUID()}`));
    if (afterInterruptedDownload || (R.mtime !== undefined && R.mtime > L.mtime)) {
      // Remote is newer: it becomes canonical; back up the older local copy first.
      await this.local.create(cp, await this.local.read(path));
      await this.writeDownloaded(path, L, remotePlain, state);
      state[path] = { localHash: remoteHash, remoteVersion: R.version, remoteId: R.id };
      report.downloaded.push(path);
      report.conflicts.push({ path, conflictPath: cp });
    } else {
      // Local is newer (or remote mtime unknown): local wins; back up the older remote copy.
      await this.local.create(cp, remotePlain);
      report.conflicts.push({ path, conflictPath: cp });
      await this.upload(path, L, R, state, report);
    }
  }

  private async upload(path: string, L: LocalFile, R: RemoteObject | undefined, state: SyncStateData, report: SyncReport): Promise<void> {
    const plain = await this.local.read(path);
    if ((await sha256Hex(plain)) !== L.hash) throw new Error("Local file changed during sync; retry to upload the latest version.");
    const cipher = await this.cryptor.encrypt(plain);
    const opts = R ? (this.remote.conditionalUpdates ? { ifVersion: R.version, ifId: R.id } : undefined) : { ifAbsent: true };
    const res: PutResult = await this.remote.put(path, cipher, undefined, opts);
    state[path] = { localHash: L.hash, remoteVersion: res.version, remoteId: res.id };
    report.uploaded.push(path);
  }

  private async download(path: string, L: LocalFile | undefined, R: RemoteObject, state: SyncStateData, report: SyncReport): Promise<void> {
    const cipher = await this.remote.get(path);
    if (cipher === null) throw new Error("Remote file vanished during download; retry sync.");
    const plain = await this.cryptor.decrypt(cipher);
    const hash = await sha256Hex(plain);
    if (!L || L.hash !== hash) {
      await this.writeDownloaded(path, L, plain, state);
      report.downloaded.push(path);
    }
    state[path] = { localHash: hash, remoteVersion: R.version, remoteId: R.id };
  }

  private async writeDownloaded(path: string, L: LocalFile | undefined, plain: ArrayBuffer, state: SyncStateData): Promise<void> {
    const safePath = safeVaultPath(path);
    if (!L) {
      await this.local.create(safePath, plain);
      return;
    }
    const current = await this.local.read(safePath);
    if ((await sha256Hex(current)) !== L.hash) throw new Error("Local file changed during sync; retry to resolve the conflict.");
    if (path.toLowerCase().endsWith(".md") && this.local.replaceTextIfUnchanged) {
      if (!(await this.local.replaceTextIfUnchanged(safePath, current, plain))) {
        throw new Error("Could not replace the note safely; it changed or is not valid UTF-8.");
      }
      return;
    }
    const pending = state[path]?.pendingReplacement;
    if (!pending || !this.local.replaceBinaryIfUnchanged) throw new Error("Safe attachment replacement is unavailable.");
    if (!(await this.local.replaceBinaryIfUnchanged(safePath, L.hash, plain, safeVaultPath(pending.backupPath)))) {
      throw new Error(`Local attachment changed during sync; backup kept at ${pending.backupPath}.`);
    }
  }

  private async deleteRemote(path: string, R: RemoteObject, state: SyncStateData, report: SyncReport): Promise<void> {
    if (!state[path]?.pendingRemoteDeletion || !this.remote.conditionalDeletes) throw new Error("Safe remote deletion is unavailable.");
    if (await this.local.exists(path)) throw new Error("Local file was recreated during sync; retry to resolve the conflict.");
    await this.remote.delete(path, { ifVersion: R.version, ifId: R.id });
    if (await this.local.exists(path)) throw new Error("Local file was recreated during deletion; retry to restore it remotely.");
    delete state[path];
    report.deletedRemote.push(path);
  }

  private async deleteLocal(path: string, L: LocalFile, state: SyncStateData, report: SyncReport): Promise<void> {
    const pending = state[path]?.pendingDeletion;
    if (!pending || !this.local.deleteIfUnchanged) throw new Error("Safe local deletion is unavailable.");
    if (!(await this.local.deleteIfUnchanged(safeVaultPath(path), L.hash, safeVaultPath(pending.backupPath)))) {
      throw new Error(`Local file changed during deletion; backup kept at ${pending.backupPath}.`);
    }
    delete state[path];
    report.deletedLocal.push(path);
  }

  private stamp(): string {
    const d = this.now();
    const p = (n: number) => n.toString().padStart(2, "0");
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  }
}
