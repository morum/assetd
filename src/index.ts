/** Library entry point: the same services the CLI uses, for future adapters (SDK, MCP, editor plugins). */
export * from "./core/types.ts";
export * from "./core/errors.ts";
export * from "./core/paths.ts";
export { loadConfig, configSchema, type AssetdConfig } from "./core/config.ts";
export { findProjectRoot, openProject, type Project } from "./core/project.ts";
export { createIgnoreMatcher } from "./core/ignore.ts";
export { discoverFiles } from "./core/discovery.ts";
export type { AssetProcessor, ProcessedAsset, FileContent, EmbeddingRequest } from "./processors/types.ts";
export { ProcessorRegistry, createProcessorRegistry } from "./processors/registry.ts";
export { ImageProcessor } from "./processors/image/image-processor.ts";
export type { VisualEmbeddingProvider, ImageInput } from "./embeddings/types.ts";
export { createVisualProvider } from "./embeddings/registry.ts";
export { IndexStore } from "./storage/index-store.ts";
export { runIndex, type IndexStats } from "./indexing/indexer.ts";
export { searchByText, searchByVector, type SearchHit } from "./search/search-service.ts";
export { renderContactSheet } from "./contact-sheet/contact-sheet.ts";
export * from "./contracts/json.ts";
export { run } from "./cli/run.ts";
