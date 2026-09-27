import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssetdError } from "../core/errors.ts";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // works on Windows and POSIX; sends no signal
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Exclusive writer lock for `assetd index`. A lock left behind by a crashed or
 * killed run (dead pid on this host) is taken over automatically.
 */
export function acquireIndexLock(indexDir: string): () => void {
  fs.mkdirSync(indexDir, { recursive: true });
  const file = path.join(indexDir, "index.lock");
  const payload = JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, payload, { flag: "wx" });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // Windows may briefly deny deletion; a stale lock is recovered next run.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holder: { pid?: number; host?: string } = {};
      try {
        holder = JSON.parse(fs.readFileSync(file, "utf8")) as typeof holder;
      } catch {
        // Unreadable lock file: treat as stale.
      }
      const sameHost = !holder.host || holder.host === os.hostname();
      if (holder.pid && sameHost && isAlive(holder.pid) && holder.pid !== process.pid) {
        throw new AssetdError("INDEX_BUSY", `Another assetd index run is in progress (pid ${holder.pid}).`, { pid: holder.pid });
      }
      if (!sameHost) {
        throw new AssetdError("INDEX_BUSY", `The index is locked by assetd on host ${holder.host}. Delete ${file} if that run is gone.`);
      }
      fs.rmSync(file, { force: true });
    }
  }
  throw new AssetdError("INDEX_BUSY", "Could not acquire the index lock.");
}
