import { LocalFile } from "./types";

/**
 * The local side of a sync (a vault, or a chosen subfolder). The Obsidian
 * implementation wraps the Vault/DataAdapter API; tests use an in-memory fake.
 * Implementations apply `normalizePath()` and stay within the sync scope.
 */
export interface LocalStore {
  /** All files in scope, with content hashes. Excludes the plugin's own config. */
  list(): Promise<LocalFile[]>;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<ArrayBuffer>;
  /** Create a new file without replacing an existing destination. */
  create(path: string, data: ArrayBuffer): Promise<void>;
  write(path: string, data: ArrayBuffer): Promise<void>;
  /** Atomically replace UTF-8 text only if it still matches the supplied bytes. */
  replaceTextIfUnchanged?(path: string, expected: ArrayBuffer, data: ArrayBuffer): Promise<boolean>;
  /** Keep the old binary at backup before installing the replacement. */
  replaceBinaryIfUnchanged?(path: string, expectedHash: string, data: ArrayBuffer, backup: string): Promise<boolean>;
  /** Move an unchanged file to recoverable trash, keeping a backup if it changed. */
  deleteIfUnchanged?(path: string, expectedHash: string, backup: string): Promise<boolean>;
  delete(path: string): Promise<void>;
}
