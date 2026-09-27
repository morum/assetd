import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { AssetdError } from "../core/errors.ts";
import { isWithinLogical, pathMatchKey } from "../core/paths.ts";
import type { AssetKind, AssetRecord, IndexState } from "../core/types.ts";
import { loadSqlite } from "./sqlite.ts";

/**
 * Storage strategy: one SQLite file (`.asset-index/index.db`) via Node's
 * built-in `node:sqlite`. Metadata lives in tables; vectors are little-endian
 * float32 BLOBs keyed by (content hash, embedding space), so identical files
 * share one vector and switching models never mixes spaces. Search loads the
 * vectors of one space into a contiguous Float32Array and scans it
 * (brute force is ~milliseconds for tens of thousands of assets).
 */
export const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE roots (path TEXT PRIMARY KEY, added_at INTEGER NOT NULL, last_indexed_at INTEGER);
    CREATE TABLE assets (
      path TEXT PRIMARY KEY,
      match_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      extension TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      description TEXT,
      tags TEXT,
      processor_id TEXT NOT NULL,
      processor_version TEXT NOT NULL,
      state TEXT NOT NULL,
      error TEXT,
      indexed_at INTEGER NOT NULL
    );
    CREATE INDEX assets_match_key ON assets(match_key);
    CREATE INDEX assets_content_hash ON assets(content_hash);
    CREATE TABLE embeddings (
      content_hash TEXT NOT NULL,
      space_id TEXT NOT NULL,
      input_version TEXT NOT NULL,
      dims INTEGER NOT NULL,
      vector BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (content_hash, space_id)
    );
    CREATE TABLE query_cache (
      space_id TEXT NOT NULL,
      text TEXT NOT NULL,
      vector BLOB NOT NULL,
      used_at INTEGER NOT NULL,
      PRIMARY KEY (space_id, text)
    );
  `,
};

const QUERY_CACHE_LIMIT = 1000;

interface AssetRow {
  path: string;
  kind: string;
  extension: string;
  size: number;
  mtime_ms: number;
  content_hash: string;
  metadata: string;
  description: string | null;
  tags: string | null;
  processor_id: string;
  processor_version: string;
  state: string;
  error: string | null;
  indexed_at: number;
}

export interface StoredEmbedding {
  inputVersion: string;
  vector: Float32Array;
}

export interface VectorMatrix {
  dims: number;
  count: number;
  paths: string[];
  hashes: string[];
  /** Row-major, `count * dims`, L2-normalized rows. */
  data: Float32Array;
}

function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function fromBlob(blob: Uint8Array): Float32Array {
  const out = new Float32Array(blob.byteLength / 4);
  new Uint8Array(out.buffer).set(blob);
  return out;
}

function rowToRecord(row: AssetRow): AssetRecord {
  const record: AssetRecord = {
    path: row.path,
    kind: row.kind as AssetKind,
    extension: row.extension,
    size: row.size,
    modifiedAtMs: row.mtime_ms,
    contentHash: row.content_hash,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    processorId: row.processor_id,
    processorVersion: row.processor_version,
    state: row.state as IndexState,
    indexedAtMs: row.indexed_at,
  };
  if (row.description !== null) record.description = row.description;
  if (row.tags !== null) record.tags = JSON.parse(row.tags) as string[];
  if (row.error !== null) record.error = row.error;
  return record;
}

export class IndexStore {
  private readonly db: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Opens (and creates when `create` is set) the index database. */
  static open(dbPath: string, options: { create: boolean }): IndexStore {
    if (!options.create && !fs.existsSync(dbPath)) {
      throw new AssetdError("INDEX_NOT_FOUND", `No index at ${dbPath}`);
    }
    if (options.create) {
      const dir = path.dirname(dbPath);
      fs.mkdirSync(dir, { recursive: true });
      // Keep derived data out of version control without touching the project's .gitignore.
      const gitignore = path.join(dir, ".gitignore");
      if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, "# Created by assetd: derived index data.\n*\n");
    }
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    const store = new IndexStore(db);
    store.migrate();
    return store;
  }

  close(): void {
    this.db.close();
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private migrate(): void {
    const version = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version > SCHEMA_VERSION) {
      throw new AssetdError(
        "INDEX_INCOMPATIBLE",
        `Index schema v${version} is newer than this assetd (v${SCHEMA_VERSION}). Upgrade assetd or delete .asset-index/.`,
        { indexVersion: version, supportedVersion: SCHEMA_VERSION },
      );
    }
    for (let v = version + 1; v <= SCHEMA_VERSION; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v}`);
      });
    }
    if (version === 0) this.setMeta("createdAt", new Date().toISOString());
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  get schemaVersion(): number {
    return SCHEMA_VERSION;
  }

  // --- meta ---------------------------------------------------------------

  getMeta(key: string): string | undefined {
    const row = this.stmt("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.stmt("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // --- roots --------------------------------------------------------------

  listRoots(): string[] {
    return (this.stmt("SELECT path FROM roots ORDER BY path").all() as { path: string }[]).map((r) => r.path);
  }

  /** Records a scanned root; roots nested in an existing root are folded into it. */
  addRoot(logical: string, now: number): void {
    const existing = this.listRoots();
    if (existing.some((r) => isWithinLogical(r, logical))) {
      this.stmt("UPDATE roots SET last_indexed_at = ? WHERE path = ?").run(now, existing.find((r) => isWithinLogical(r, logical))!);
      return;
    }
    for (const r of existing) if (isWithinLogical(logical, r)) this.stmt("DELETE FROM roots WHERE path = ?").run(r);
    this.stmt("INSERT INTO roots (path, added_at, last_indexed_at) VALUES (?, ?, ?)").run(logical, now, now);
  }

  // --- assets -------------------------------------------------------------

  getAsset(logical: string): AssetRecord | undefined {
    const row = this.stmt("SELECT * FROM assets WHERE path = ?").get(logical) as AssetRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** Case/Unicode-insensitive lookup. */
  findAssetsByMatchKey(logical: string): AssetRecord[] {
    return (this.stmt("SELECT * FROM assets WHERE match_key = ?").all(pathMatchKey(logical)) as unknown as AssetRow[]).map(rowToRecord);
  }

  /** Lightweight rows for change detection. */
  listAssetStats(): { path: string; size: number; mtimeMs: number; state: string; processorId: string; processorVersion: string; contentHash: string }[] {
    return (this.stmt("SELECT path, size, mtime_ms, state, processor_id, processor_version, content_hash FROM assets").all() as unknown as AssetRow[]).map((r) => ({
      path: r.path,
      size: r.size,
      mtimeMs: r.mtime_ms,
      state: r.state,
      processorId: r.processor_id,
      processorVersion: r.processor_version,
      contentHash: r.content_hash,
    }));
  }

  upsertAsset(record: AssetRecord): void {
    this.stmt(
      `INSERT INTO assets (path, match_key, kind, extension, size, mtime_ms, content_hash, metadata, description, tags,
         processor_id, processor_version, state, error, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET match_key = excluded.match_key, kind = excluded.kind, extension = excluded.extension,
         size = excluded.size, mtime_ms = excluded.mtime_ms, content_hash = excluded.content_hash, metadata = excluded.metadata,
         description = excluded.description, tags = excluded.tags, processor_id = excluded.processor_id,
         processor_version = excluded.processor_version, state = excluded.state, error = excluded.error, indexed_at = excluded.indexed_at`,
    ).run(
      record.path,
      pathMatchKey(record.path),
      record.kind,
      record.extension,
      record.size,
      record.modifiedAtMs,
      record.contentHash,
      JSON.stringify(record.metadata),
      record.description ?? null,
      record.tags ? JSON.stringify(record.tags) : null,
      record.processorId,
      record.processorVersion,
      record.state,
      record.error ?? null,
      record.indexedAtMs,
    );
  }

  /** Content unchanged but the file was touched: refresh stat info only. */
  touchAsset(logical: string, size: number, mtimeMs: number): void {
    this.stmt("UPDATE assets SET size = ?, mtime_ms = ? WHERE path = ?").run(size, mtimeMs, logical);
  }

  listContentHashes(): string[] {
    return (this.stmt("SELECT DISTINCT content_hash FROM assets WHERE content_hash <> ''").all() as { content_hash: string }[]).map((r) => r.content_hash);
  }

  deleteAsset(logical: string): void {
    this.stmt("DELETE FROM assets WHERE path = ?").run(logical);
  }

  countByKind(): Record<string, number> {
    const rows = this.stmt("SELECT kind, COUNT(*) AS n FROM assets WHERE state = 'indexed' GROUP BY kind ORDER BY kind").all() as { kind: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
  }

  countByState(): Record<string, number> {
    const rows = this.stmt("SELECT state, COUNT(*) AS n FROM assets GROUP BY state").all() as { state: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.state, Number(r.n)]));
  }

  listFailed(limit: number): { path: string; error: string }[] {
    return (this.stmt("SELECT path, error FROM assets WHERE state = 'failed' ORDER BY path LIMIT ?").all(limit) as { path: string; error: string | null }[]).map(
      (r) => ({ path: r.path, error: r.error ?? "unknown error" }),
    );
  }

  processorVersions(): { id: string; version: string; assets: number }[] {
    const rows = this.stmt(
      "SELECT processor_id AS id, processor_version AS version, COUNT(*) AS n FROM assets GROUP BY processor_id, processor_version ORDER BY id",
    ).all() as { id: string; version: string; n: number }[];
    return rows.map((r) => ({ id: r.id, version: r.version, assets: Number(r.n) }));
  }

  // --- embeddings ---------------------------------------------------------

  getEmbedding(contentHash: string, spaceId: string): StoredEmbedding | undefined {
    const row = this.stmt("SELECT input_version, vector FROM embeddings WHERE content_hash = ? AND space_id = ?").get(contentHash, spaceId) as
      | { input_version: string; vector: Uint8Array }
      | undefined;
    return row ? { inputVersion: row.input_version, vector: fromBlob(row.vector) } : undefined;
  }

  hasEmbedding(contentHash: string, spaceId: string, inputVersion: string): boolean {
    return (
      this.stmt("SELECT 1 FROM embeddings WHERE content_hash = ? AND space_id = ? AND input_version = ?").get(contentHash, spaceId, inputVersion) !==
      undefined
    );
  }

  putEmbedding(contentHash: string, spaceId: string, inputVersion: string, vector: Float32Array, now: number): void {
    this.stmt(
      `INSERT INTO embeddings (content_hash, space_id, input_version, dims, vector, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(content_hash, space_id) DO UPDATE SET input_version = excluded.input_version, dims = excluded.dims,
         vector = excluded.vector, created_at = excluded.created_at`,
    ).run(contentHash, spaceId, inputVersion, vector.length, toBlob(vector), now);
  }

  embeddingsFor(contentHash: string): { spaceId: string; dims: number; inputVersion: string }[] {
    return (this.stmt("SELECT space_id, dims, input_version FROM embeddings WHERE content_hash = ? ORDER BY space_id").all(contentHash) as {
      space_id: string;
      dims: number;
      input_version: string;
    }[]).map((r) => ({ spaceId: r.space_id, dims: Number(r.dims), inputVersion: r.input_version }));
  }

  /** Number of indexed assets of `kind` lacking a vector in `spaceId`. */
  countMissingEmbeddings(spaceId: string, kind: AssetKind): number {
    const row = this.stmt(
      `SELECT COUNT(*) AS n FROM assets a LEFT JOIN embeddings e ON e.content_hash = a.content_hash AND e.space_id = ?
       WHERE a.state = 'indexed' AND a.kind = ? AND e.content_hash IS NULL`,
    ).get(spaceId, kind) as { n: number };
    return Number(row.n);
  }

  embeddingSpaces(): { spaceId: string; dims: number; vectors: number }[] {
    return (this.stmt("SELECT space_id, dims, COUNT(*) AS n FROM embeddings GROUP BY space_id, dims ORDER BY space_id").all() as {
      space_id: string;
      dims: number;
      n: number;
    }[]).map((r) => ({ spaceId: r.space_id, dims: Number(r.dims), vectors: Number(r.n) }));
  }

  /** Removes vectors no asset references any more (derived data only). */
  pruneOrphanEmbeddings(): number {
    const res = this.stmt("DELETE FROM embeddings WHERE content_hash NOT IN (SELECT content_hash FROM assets)").run();
    return Number(res.changes);
  }

  /** All indexed assets of `kind` with a vector in `spaceId`, as one matrix. */
  loadVectors(spaceId: string, kind: AssetKind): VectorMatrix {
    const rows = this.stmt(
      `SELECT a.path, a.content_hash, e.dims, e.vector FROM assets a
       JOIN embeddings e ON e.content_hash = a.content_hash AND e.space_id = ?
       WHERE a.state = 'indexed' AND a.kind = ? ORDER BY a.path`,
    ).all(spaceId, kind) as { path: string; content_hash: string; dims: number; vector: Uint8Array }[];
    const dims = rows.length > 0 ? Number(rows[0]!.dims) : 0;
    const usable = rows.filter((r) => Number(r.dims) === dims);
    const data = new Float32Array(usable.length * dims);
    const bytes = new Uint8Array(data.buffer);
    usable.forEach((r, i) => bytes.set(r.vector, i * dims * 4));
    return { dims, count: usable.length, paths: usable.map((r) => r.path), hashes: usable.map((r) => r.content_hash), data };
  }

  // --- query cache --------------------------------------------------------

  getCachedQuery(spaceId: string, text: string, now: number): Float32Array | undefined {
    const row = this.stmt("SELECT vector FROM query_cache WHERE space_id = ? AND text = ?").get(spaceId, text) as { vector: Uint8Array } | undefined;
    if (!row) return undefined;
    try {
      this.stmt("UPDATE query_cache SET used_at = ? WHERE space_id = ? AND text = ?").run(now, spaceId, text);
    } catch {
      // Read-only or busy database: the cache is an optimization only.
    }
    return fromBlob(row.vector);
  }

  putCachedQuery(spaceId: string, text: string, vector: Float32Array, now: number): void {
    try {
      this.stmt(
        "INSERT INTO query_cache (space_id, text, vector, used_at) VALUES (?, ?, ?, ?) ON CONFLICT(space_id, text) DO UPDATE SET vector = excluded.vector, used_at = excluded.used_at",
      ).run(spaceId, text, toBlob(vector), now);
      this.stmt(
        "DELETE FROM query_cache WHERE rowid IN (SELECT rowid FROM query_cache ORDER BY used_at DESC LIMIT -1 OFFSET ?)",
      ).run(QUERY_CACHE_LIMIT);
    } catch {
      // Cache writes are best-effort.
    }
  }
}
