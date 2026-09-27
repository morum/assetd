import type { AssetKind, AssetMetadata, EmbeddingChannel, FileInfo } from "../core/types.ts";
import type { AudioInput, ImageInput } from "../embeddings/types.ts";

/** What a processor asks the indexer to embed. Batched per channel by the indexer. */
export type EmbeddingRequest =
  | { channel: "visual"; input: { type: "image"; image: ImageInput } }
  /** Several renders of one asset; the indexer embeds each and stores their normalized mean. */
  | { channel: "visual"; input: { type: "views"; images: ImageInput[] } }
  | { channel: "audio"; input: { type: "audio"; audio: AudioInput } };

export interface ProcessedAsset {
  kind: AssetKind;
  metadata: AssetMetadata;
  description?: string;
  tags?: string[];
  embeddingRequests: EmbeddingRequest[];
  /** Derived preview images (PNG), stored under .asset-index/previews and deduplicated by content hash. */
  previews?: { name: string; png: Buffer }[];
}

/** File contents are read once by the indexer (hashing + decoding share the buffer). */
export interface FileContent {
  file: FileInfo;
  data: Buffer;
}

/**
 * A processor handles one family of files. Adding a new asset type means
 * implementing this interface and registering it; the indexing engine does not
 * change. Processors must be pure with respect to the source file: they never
 * modify, move or lock assets beyond reading them.
 */
export interface AssetProcessor {
  /** Stable id, persisted with every asset ("image"). */
  readonly id: string;
  /** Bump to force reprocessing of every asset this processor produced. */
  readonly version: string;
  readonly kind: AssetKind;
  /** Channels whose vectors this processor produces. */
  readonly channels: readonly EmbeddingChannel[];
  /** Cheap pre-filter used during discovery (lower-case, no dot). */
  readonly extensions: readonly string[];
  supports(file: FileInfo): boolean;
  /** Metadata only, no embedding inputs. Used by `inspect` on unindexed files. */
  extractMetadata(content: FileContent): Promise<AssetMetadata>;
  process(content: FileContent): Promise<ProcessedAsset>;
}
