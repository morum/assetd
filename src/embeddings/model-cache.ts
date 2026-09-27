import os from "node:os";
import path from "node:path";

/**
 * Where model weights are cached (shared by all projects on the machine):
 *   ASSETD_MODEL_DIR                         if set
 *   Windows: %LOCALAPPDATA%\assetd\models
 *   macOS:   ~/Library/Caches/assetd/models
 *   Linux:   $XDG_CACHE_HOME/assetd/models, else ~/.cache/assetd/models
 */
export function resolveModelCacheDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  if (env.ASSETD_MODEL_DIR) return path.resolve(env.ASSETD_MODEL_DIR);
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local");
    return path.win32.join(base, "assetd", "models");
  }
  if (platform === "darwin") return path.posix.join(home, "Library", "Caches", "assetd", "models");
  const base = env.XDG_CACHE_HOME || path.posix.join(home, ".cache");
  return path.posix.join(base, "assetd", "models");
}

/** Offline mode: never touch the network, fail with MODEL_UNAVAILABLE instead. */
export function isOffline(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (v: string | undefined) => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
  return flag(env.ASSETD_OFFLINE) || flag(env.HF_HUB_OFFLINE);
}
