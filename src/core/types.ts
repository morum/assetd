export const ASSET_KINDS = ["image", "audio", "model3d", "video", "text", "other"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/**
 * Embedding channels. Each channel is its own vector space; scores from
 * different channels are never compared directly (see search/ranking.ts).
 */
export const EMBEDDING_CHANNELS = ["visual", "audio", "text", "geometry"] as const;
export type EmbeddingChannel = (typeof EMBEDDING_CHANNELS)[number];

/** A file found during discovery. */
export interface FileInfo {
  /** Project-relative, "/"-separated identity. */
  logicalPath: string;
  /** Absolute native path, only used for filesystem access. */
  nativePath: string;
  /** Lower-case extension without dot. */
  extension: string;
  size: number;
  modifiedAtMs: number;
}

export type AssetMetadata = Record<string, unknown>;

export type IndexState = "indexed" | "failed";

/** An asset as persisted in the index. */
export interface AssetRecord {
  path: string;
  kind: AssetKind;
  extension: string;
  size: number;
  modifiedAtMs: number;
  contentHash: string;
  metadata: AssetMetadata;
  description?: string;
  tags?: string[];
  processorId: string;
  processorVersion: string;
  state: IndexState;
  error?: string;
  indexedAtMs: number;
}

/** Identifies one vector space: provider + model + preprocessing revision. */
export interface EmbeddingSpace {
  /** Stable key, e.g. "siglip:Xenova/siglip-base-patch16-224:q8:p1". */
  id: string;
  channel: EmbeddingChannel;
  provider: string;
  model: string;
  /** Null until known (custom models report it after loading). */
  dimensions: number | null;
}
