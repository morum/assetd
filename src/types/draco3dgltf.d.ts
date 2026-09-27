declare module "draco3dgltf" {
  /** WASM Draco decoder used by @gltf-transform/extensions (KHR_draco_mesh_compression). */
  export function createDecoderModule(options?: Record<string, unknown>): Promise<unknown>;
  export function createEncoderModule(options?: Record<string, unknown>): Promise<unknown>;
}
